/**
 * Voicemail (paused / forwarded-but-unanswered calls on a Twilio line): where it is stored, how the dashboard sees it, how it is
 * played back and how it is deleted.
 *
 *  - Storage: the call row keeps Twilio's recording URL in `recording_url` (written only when it is a recording of OUR account, see
 *    TWILIO_RECORDING_URL). That URL is a credentialed resource; it is NEVER sent to a browser: every API and page payload goes
 *    through `publicCall`, which drops it and says `has_voicemail` instead.
 *  - Playback: GET /api/calls/:id/voicemail (authenticated, tenant-scoped) streams the audio server-side with the account
 *    credentials (`fetchVoicemailAudio`).
 *  - Retention: purge / erase delete the provider-side recording as well (`deleteTwilioRecordings`), best effort and logged.
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
 * Fetch the recording's audio (mp3) from Twilio with the ACCOUNT credentials and hand back a streaming Response (Range is passed
 * through so the browser can seek). Only a recording of this deployment's own account is ever requested, over https to api.twilio.com,
 * and the credentials are never forwarded to a redirect target (fetch drops Authorization across origins).
 */
export async function fetchVoicemailAudio(recordingUrl: string, range: string | null, fetchImpl: typeof fetch = fetch): Promise<VoicemailAudio> {
  const ref = parseRecordingUrl(recordingUrl);
  if (!ref) return { ok: false, status: 404, error: 'no voicemail' };
  const auth = authHeader();
  if (!auth || process.env.TWILIO_ACCOUNT_SID !== ref.accountSid) return { ok: false, status: 503, error: 'voicemail playback is not configured' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ref.accountSid}/Recordings/${ref.recordingSid}.mp3`;
  try {
    const upstream = await fetchImpl(url, {
      headers: { authorization: auth, ...(range && /^bytes=\d*-\d*$/.test(range) ? { range } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (upstream.status === 404) return { ok: false, status: 404, error: 'the recording no longer exists' };
    if (!(upstream.status === 200 || upstream.status === 206) || !upstream.body) {
      log.warn('upstream_failed', { status: upstream.status });
      return { ok: false, status: 502, error: 'could not load the recording' };
    }
    const headers = new Headers({
      'content-type': 'audio/mpeg',
      'cache-control': 'private, no-store',
      'content-disposition': 'inline; filename="voicemail.mp3"',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    });
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return { ok: true, response: new Response(upstream.body, { status: upstream.status, headers }) };
  } catch (err) {
    log.warn('upstream_error', { error: (err as Error).name });
    return { ok: false, status: 502, error: 'could not load the recording' };
  }
}

/**
 * Delete provider-side recordings (retention purge, customer erasure). Best effort: a failure is logged, never thrown, and a
 * recording that is already gone (404) counts as deleted. Returns how many are gone.
 */
export async function deleteTwilioRecordings(urls: (string | null | undefined)[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const auth = authHeader();
  let deleted = 0;
  for (const u of urls) {
    const ref = parseRecordingUrl(u);
    if (!ref) continue;
    if (!auth || process.env.TWILIO_ACCOUNT_SID !== ref.accountSid) { log.warn('delete_skipped', { reason: 'no matching Twilio credentials' }); continue; }
    try {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${ref.accountSid}/Recordings/${ref.recordingSid}.json`, {
        method: 'DELETE', headers: { authorization: auth }, signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 204 || res.status === 200 || res.status === 404) deleted++;
      else log.warn('delete_failed', { status: res.status });
    } catch (err) {
      log.warn('delete_error', { error: (err as Error).name });
    }
  }
  return deleted;
}
