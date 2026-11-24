/**
 * Call recording playback (ElevenLabs conversation audio), proxied. The browser never sees the provider URL or key: GET /api/calls/:id/audio
 * authenticates, checks the call belongs to the caller's business and that the recording may be played (consent was disclosed), then fetches
 * the audio SERVER-SIDE (`GET /v1/convai/conversations/{conversation_id}/audio`, header xi-api-key) and serves it with Range support.
 *
 * UNVERIFIED provider behaviour (the docs page lists the endpoint only): the response content type and whether the provider honours Range.
 * So the whole file is read once and Range requests are answered from memory (as voice/voicemail does), under a short TTL and size cap.
 * Nothing is written to disk. The cache is only reachable after the route's checks, and is dropped on erasure (`forgetCachedConversationAudio`).
 */
import { logger } from '@/lib/log';
import type { Call } from '@/lib/types';

const log = logger('voice/recording-audio');
const API = 'https://api.elevenlabs.io/v1';

export const RECORDING_CACHE_TTL_MS = 60_000;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 4;
const cache = new Map<string, { at: number; body: Uint8Array; type: string }>();
export const clearRecordingCache = (): void => cache.clear();
export const forgetCachedConversationAudio = (conversationId: string): void => { cache.delete(conversationId); };

const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,128}$/;

/** May this call's audio be played at all? Customer calls whose recording disclosure was given and that have a provider conversation. */
export function callHasRecording(c: Pick<Call, 'consent_status' | 'conversation_id' | 'kind' | 'status'>): boolean {
  return c.consent_status === 'disclosed' && (c.kind ?? 'customer') === 'customer' && c.status !== 'in_progress'
    && typeof c.conversation_id === 'string' && CONVERSATION_ID.test(c.conversation_id);
}

export type RecordingAudio = { ok: true; response: Response } | { ok: false; status: 404 | 502 | 503; error: string };

const headers = (type: string): Headers => new Headers({
  'content-type': type, 'cache-control': 'private, no-store', 'content-disposition': 'inline; filename="call-recording"',
  'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
});

/** Answer from a complete body (200, or 206 for a valid single range, or 416 for an unsatisfiable one). */
export function serveBody(body: Uint8Array, type: string, range: string | null): Response {
  const h = headers(type);
  const size = body.byteLength;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) { h.set('content-length', String(size)); return new Response(body.slice(), { status: 200, headers: h }); }
  let start: number; let end: number;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size || n0(start)) { h.set('content-range', `bytes */${size}`); return new Response(null, { status: 416, headers: h }); }
  h.set('content-length', String(end - start + 1));
  h.set('content-range', `bytes ${start}-${end}/${size}`);
  return new Response(body.slice(start, end + 1), { status: 206, headers: h });
}
const n0 = (n: number) => !Number.isFinite(n) || n < 0;

export async function fetchConversationAudio(conversationId: string, range: string | null, fetchImpl: typeof fetch = fetch): Promise<RecordingAudio> {
  if (!CONVERSATION_ID.test(conversationId)) return { ok: false, status: 404, error: 'no recording' };
  const hit = cache.get(conversationId);
  if (hit && Date.now() - hit.at <= RECORDING_CACHE_TTL_MS) return { ok: true, response: serveBody(hit.body, hit.type, range) };
  cache.delete(conversationId);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'recording playback is not configured' };
  try {
    const res = await fetchImpl(`${API}/convai/conversations/${encodeURIComponent(conversationId)}/audio`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404 || res.status === 400) return { ok: false, status: 404, error: 'the recording is not available' };
    if (!res.ok || !res.body) { log.warn('upstream_failed', { status: res.status }); return { ok: false, status: 502, error: 'could not load the recording' }; }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { ok: false, status: 502, error: 'the recording is too large to play here' };
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return { ok: false, status: 404, error: 'the recording is not available' };
    const upstreamType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const type = /^audio\/[a-z0-9.+-]+$/.test(upstreamType) ? upstreamType : 'audio/mpeg';
    cache.set(conversationId, { at: Date.now(), body, type });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return { ok: true, response: serveBody(body, type, range) };
  } catch (err) {
    log.warn('upstream_error', { error: (err as Error).name });
    return { ok: false, status: 502, error: 'could not load the recording' };
  }
}
