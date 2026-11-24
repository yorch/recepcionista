/**
 * Voicemail (paused / forwarded-but-unanswered calls on a Twilio line): where it is stored, how the dashboard sees it, how it is
 * played back and how it is deleted.
 *
 *  - Storage: the call row keeps Twilio's recording URL in `recording_url` (written only when it is a recording of OUR account, see
 *    TWILIO_RECORDING_URL). That URL is a credentialed resource; it is NEVER sent to a browser: every API and page payload goes
 *    through `publicCall`, which drops it and says `has_voicemail` instead.
 *  - Playback: GET /api/calls/:id/voicemail (authenticated, tenant-scoped) streams the audio server-side with the account
 *    credentials (`fetchVoicemailAudio`).
 *  - Retention: purge / erase QUEUE the provider-side recording for deletion in the same transaction as the call-row DELETE
 *    (db/recording-deletions.ts); the jobs runner deletes it with retries (voice/recording-deletion.ts).
 */
import { logger } from '@/lib/log';
import type { Call } from '@/lib/types';

const log = logger('voice/voicemail');

/** A recording of an account (AC...), as Twilio gives it in `RecordingUrl` (no extension) or with one. Nothing else is ever stored or fetched. */
export const TWILIO_RECORDING_URL = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Recordings\/(RE[0-9a-f]{32})(\.\w+)?$/i;

export interface RecordingRef { accountSid: string; recordingSid: string }

export function parseRecordingUrl(url: string | null | undefined): RecordingRef | null {
  const m = typeof url === 'string' ? TWILIO_RECORDING_URL.exec(url) : null;
  return m ? { accountSid: m[1], recordingSid: m[2] } : null;
}

/** The dashboard/API shape of a call: no recording URL, a flag instead. */
export type PublicCall = Omit<Call, 'recording_url'> & { has_voicemail: boolean };

/** True when this call row carries a voicemail the proxy can play. */
export const hasVoicemail = (c: Pick<Call, 'recording_url'>): boolean => parseRecordingUrl(c.recording_url) !== null;

export function publicCall(c: Call): PublicCall {
  const { recording_url: _drop, ...rest } = c;
  void _drop;
  return { ...rest, has_voicemail: hasVoicemail(c) };
}

const authHeader = (): string | null => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  return sid && token ? `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` : null;
};

export type VoicemailAudio =
  | { ok: true; response: Response }
  | { ok: false; status: 404 | 502 | 503; error: string };

/**
 * Short-lived in-process cache of recording audio, so a player's burst of Range requests (every seek is one) costs ONE Twilio REST call
 * instead of one per seek. Safe because: it is only consulted AFTER the route authenticated the caller and checked the call belongs to
 * their business (fetchVoicemailAudio is never reachable without that); only a complete, small (<= CACHE_MAX_BYTES) 200 response is kept;
 * it is bounded (CACHE_MAX_ENTRIES), expires after CACHE_TTL_MS, never leaves the process (browsers still get `private, no-store`) and is
 * dropped when the recording is queued for deletion (`forgetCachedRecording`). A Range request on a cold entry is passed through unchanged.
 */
export const VOICEMAIL_CACHE_TTL_MS = 45_000;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 16;
const audioCache = new Map<string, { at: number; body: Uint8Array }>();

const cacheKey = (ref: RecordingRef) => `${ref.accountSid}/${ref.recordingSid}`.toLowerCase();
const cacheGet = (ref: RecordingRef): Uint8Array | null => {
  const hit = audioCache.get(cacheKey(ref));
  if (!hit) return null;
  if (Date.now() - hit.at > VOICEMAIL_CACHE_TTL_MS) { audioCache.delete(cacheKey(ref)); return null; }
  return hit.body;
};
const cachePut = (ref: RecordingRef, body: Uint8Array): void => {
  if (body.byteLength === 0 || body.byteLength > CACHE_MAX_BYTES) return;
  audioCache.set(cacheKey(ref), { at: Date.now(), body });
  while (audioCache.size > CACHE_MAX_ENTRIES) audioCache.delete(audioCache.keys().next().value as string);
};
/** Drop a recording from the cache (it is being deleted). */
export const forgetCachedRecording = (ref: RecordingRef): void => { audioCache.delete(cacheKey(ref)); };
/** Test seam. */
export const clearVoicemailCache = (): void => audioCache.clear();

const audioHeaders = (): Headers => new Headers({
  'content-type': 'audio/mpeg',
  'cache-control': 'private, no-store',
  'content-disposition': 'inline; filename="voicemail.mp3"',
  'x-content-type-options': 'nosniff',
  'accept-ranges': 'bytes',
});

/** Answer a (valid, single) Range request from a complete body. Null = not satisfiable here (the caller then goes upstream). */
function sliceRange(body: Uint8Array, range: string | null): Response | null {
  const headers = audioHeaders();
  if (!range) {
    headers.set('content-length', String(body.byteLength));
    return new Response(body.slice(), { status: 200, headers });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const size = body.byteLength;
  let start: number;
  let end: number;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  headers.set('content-length', String(end - start + 1));
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

/**
 * Fetch the recording's audio (mp3) from Twilio with the ACCOUNT credentials and hand back a Response (Range is honoured so the browser can
 * seek: from the short-lived cache when the whole file is there, else passed through). Only a recording of this deployment's own account is
 * ever requested, over https to api.twilio.com, and the credentials are never forwarded to a redirect target (fetch drops Authorization
 * across origins).
 */
export async function fetchVoicemailAudio(recordingUrl: string, range: string | null, fetchImpl: typeof fetch = fetch): Promise<VoicemailAudio> {
  const ref = parseRecordingUrl(recordingUrl);
  if (!ref) return { ok: false, status: 404, error: 'no voicemail' };
  const auth = authHeader();
  if (!auth || process.env.TWILIO_ACCOUNT_SID !== ref.accountSid) return { ok: false, status: 503, error: 'voicemail playback is not configured' };
  const cached = cacheGet(ref);
  if (cached) {
    const hit = sliceRange(cached, range);
    if (hit) return { ok: true, response: hit };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ref.accountSid}/Recordings/${ref.recordingSid}.mp3`;
  try {
    const upstream = await fetchImpl(url, {
      headers: { authorization: auth, ...(range && /^bytes=\d*-\d*$/.test(range) ? { range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (upstream.status === 404) { audioCache.delete(cacheKey(ref)); return { ok: false, status: 404, error: 'the recording no longer exists' }; }
    if (!(upstream.status === 200 || upstream.status === 206) || !upstream.body) {
      log.warn('upstream_failed', { status: upstream.status });
      return { ok: false, status: 502, error: 'could not load the recording' };
    }
    const headers = audioHeaders();
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    // A complete small file (no Range sent, 200, length known) is read once and kept for the next seeks.
    const length = Number(upstream.headers.get('content-length'));
    if (upstream.status === 200 && Number.isFinite(length) && length > 0 && length <= CACHE_MAX_BYTES) {
      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength === length) cachePut(ref, body);
      return { ok: true, response: new Response(body, { status: 200, headers }) };
    }
    return { ok: true, response: new Response(upstream.body, { status: upstream.status, headers }) };
  } catch (err) {
    log.warn('upstream_error', { error: (err as Error).name });
    return { ok: false, status: 502, error: 'could not load the recording' };
  }
}

export type RecordingDeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Delete ONE provider-side recording. 2xx and 404 (already gone) are success; everything else (5xx, 429, timeout, no matching
 * credentials) is a failure with a short, credential-free reason, for the retry queue (voice/recording-deletion.ts). Never throws.
 */
export async function deleteTwilioRecording(ref: RecordingRef, fetchImpl: typeof fetch = fetch): Promise<RecordingDeleteResult> {
  const auth = authHeader();
  if (!auth || process.env.TWILIO_ACCOUNT_SID !== ref.accountSid) { log.warn('delete_skipped', { reason: 'no matching Twilio credentials' }); return { ok: false, error: 'no matching Twilio credentials' }; }
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${ref.accountSid}/Recordings/${ref.recordingSid}.json`, {
      method: 'DELETE', headers: { authorization: auth }, signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 204 || res.status === 200 || res.status === 404) return { ok: true };
    log.warn('delete_failed', { status: res.status });
    return { ok: false, error: `http_${res.status}` };
  } catch (err) {
    log.warn('delete_error', { error: (err as Error).name });
    return { ok: false, error: `error_${(err as Error).name}`.slice(0, 80) };
  }
}

/**
 * Delete provider-side recordings by URL, best effort (a failure is logged, never thrown; a recording that is already gone (404)
 * counts as deleted). Returns how many are gone. Retention and erasure do NOT use this directly: they queue the recordings first
 * (db/recording-deletions.ts) so a failure is retried; this stays for ad-hoc callers.
 */
export async function deleteTwilioRecordings(urls: (string | null | undefined)[], fetchImpl: typeof fetch = fetch): Promise<number> {
  let deleted = 0;
  for (const u of urls) {
    const ref = parseRecordingUrl(u);
    if (!ref) continue;
    if ((await deleteTwilioRecording(ref, fetchImpl)).ok) deleted++;
  }
  return deleted;
}
