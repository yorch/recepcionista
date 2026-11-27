/**
 * Call recording playback (ElevenLabs conversation audio), proxied. The browser never sees the provider URL or key: GET /api/calls/:id/audio
 * authenticates, checks the call belongs to the caller's business and that the recording may be played (consent was disclosed), then fetches
 * the audio SERVER-SIDE (`GET /v1/convai/conversations/{conversation_id}/audio`, header xi-api-key) and serves it with Range support.
 *
 * UNVERIFIED provider behaviour (the docs page lists the endpoint only): the response content type and whether the provider honours Range.
 * So the whole file is read once and Range requests are answered from memory (as voice/voicemail does). Memory is bounded: the body is
 * streamed with a hard byte cap (whatever the headers say), parallel requests for one recording share one download, at most
 * MAX_CONCURRENT_DOWNLOADS run at once (503 + Retry-After beyond), and the TTL cache is capped by TOTAL BYTES. Nothing is written to disk.
 * The cache is only reachable after the route's checks, and is dropped on erasure (`forgetCachedConversationAudio`).
 */
import { configEnv } from '@/lib/config';
import { logger } from '@/lib/log';
import type { Call } from '@/lib/types';

const log = logger('voice/recording-audio');
const API = 'https://api.elevenlabs.io/v1';

export const RECORDING_CACHE_TTL_MS = 60_000;
/** Hard ceiling for ONE recording, enforced while streaming (whatever the headers claim). */
export const MAX_BYTES = 40 * 1024 * 1024;
/** The cache holds at most this many bytes in total across all tenants (not an entry count); an entry larger than this is never cached. */
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Upstream downloads running at once in this process; beyond it a request gets 503 + Retry-After instead of queueing memory. */
export const MAX_CONCURRENT_DOWNLOADS = 4;
const cache = new Map<string, { at: number; body: Uint8Array<ArrayBuffer>; type: string }>();
let cachedBytes = 0;
const inflight = new Map<string, Promise<Downloaded>>();
let running = 0;

function dropEntry(id: string): void {
  const e = cache.get(id);
  if (e) { cachedBytes -= e.body.byteLength; cache.delete(id); }
}
export const clearRecordingCache = (): void => { cache.clear(); cachedBytes = 0; };
export const recordingCacheStats = () => ({ entries: cache.size, bytes: cachedBytes, inflight: inflight.size, running });
/** Drop a conversation's audio from the cache (called when its provider conversation is erased). */
export const forgetCachedConversationAudio = (conversationId: string): void => { dropEntry(conversationId); };

function remember(id: string, body: Uint8Array<ArrayBuffer>, type: string): void {
  dropEntry(id);
  if (body.byteLength > CACHE_MAX_BYTES) return;
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.at > RECORDING_CACHE_TTL_MS) dropEntry(k); // expired entries first
  while (cachedBytes + body.byteLength > CACHE_MAX_BYTES && cache.size > 0) dropEntry(cache.keys().next().value as string); // then oldest first
  cache.set(id, { at: now, body, type });
  cachedBytes += body.byteLength;
}

const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,128}$/;

/** May this call's audio be played at all? Customer calls whose recording disclosure was given and that have a provider conversation. */
export function callHasRecording(c: Pick<Call, 'consent_status' | 'conversation_id' | 'kind' | 'status'>): boolean {
  return c.consent_status === 'disclosed' && (c.kind ?? 'customer') === 'customer' && c.status !== 'in_progress'
    && typeof c.conversation_id === 'string' && CONVERSATION_ID.test(c.conversation_id);
}

export type RecordingAudio = { ok: true; response: Response } | { ok: false; status: 404 | 502 | 503; error: string; retryAfterS?: number };
type Downloaded = { ok: true; body: Uint8Array<ArrayBuffer>; type: string } | { ok: false; status: 404 | 502 | 503; error: string; retryAfterS?: number };

const headers = (type: string): Headers => new Headers({
  'content-type': type, 'cache-control': 'private, no-store', 'content-disposition': 'inline; filename="call-recording"',
  'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
});

/** Answer from a complete body (200, or 206 for a valid single range, or 416 for an unsatisfiable one). */
export function serveBody(body: Uint8Array<ArrayBuffer>, type: string, range: string | null): Response {
  const h = headers(type);
  const size = body.byteLength;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) { h.set('content-length', String(size)); return new Response(body, { status: 200, headers: h }); }
  let start: number; let end: number;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size || n0(start)) { h.set('content-range', `bytes */${size}`); return new Response(null, { status: 416, headers: h }); }
  h.set('content-length', String(end - start + 1));
  h.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body.subarray(start, end + 1), { status: 206, headers: h });
}
const n0 = (n: number) => !Number.isFinite(n) || n < 0;

/** Read the body as a stream and give up the moment it passes MAX_BYTES (a chunked response has no content-length to trust). */
async function readCapped(res: Response, signal: AbortController): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { signal.abort(); await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function download(conversationId: string, key: string, fetchImpl: typeof fetch): Promise<Downloaded> {
  if (running >= MAX_CONCURRENT_DOWNLOADS) return { ok: false, status: 503, error: 'recording playback is busy; try again in a moment', retryAfterS: 3 };
  running++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetchImpl(`${API}/convai/conversations/${encodeURIComponent(conversationId)}/audio`, { headers: { 'xi-api-key': key }, signal: ctl.signal });
    if (res.status === 404 || res.status === 400) return { ok: false, status: 404, error: 'the recording is not available' };
    if (!res.ok || !res.body) { log.warn('upstream_failed', { status: res.status }); return { ok: false, status: 502, error: 'could not load the recording' }; }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) { ctl.abort(); return { ok: false, status: 502, error: 'the recording is too large to play here' }; }
    const body = await readCapped(res, ctl);
    if (!body) return { ok: false, status: 502, error: 'the recording is too large to play here' };
    if (body.byteLength === 0) return { ok: false, status: 404, error: 'the recording is not available' };
    const upstreamType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const type = /^audio\/[a-z0-9.+-]+$/.test(upstreamType) ? upstreamType : 'audio/mpeg';
    remember(conversationId, body, type);
    return { ok: true, body, type };
  } catch (err) {
    log.warn('upstream_error', { error: (err as Error).name });
    return { ok: false, status: 502, error: 'could not load the recording' };
  } finally {
    clearTimeout(timer);
    running--;
  }
}

export async function fetchConversationAudio(conversationId: string, range: string | null, fetchImpl: typeof fetch = fetch): Promise<RecordingAudio> {
  if (!CONVERSATION_ID.test(conversationId)) return { ok: false, status: 404, error: 'no recording' };
  const hit = cache.get(conversationId);
  if (hit && Date.now() - hit.at <= RECORDING_CACHE_TTL_MS) return { ok: true, response: serveBody(hit.body, hit.type, range) };
  dropEntry(conversationId);
  const key = configEnv().ELEVENLABS_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'recording playback is not configured' };
  // Single flight: parallel requests (seeks, metadata probes) for the same recording share ONE upstream download.
  let p = inflight.get(conversationId);
  if (!p) {
    p = download(conversationId, key, fetchImpl).finally(() => { inflight.delete(conversationId); });
    inflight.set(conversationId, p);
  }
  const r = await p;
  return r.ok ? { ok: true, response: serveBody(r.body, r.type, range) } : r;
}
