/**
 * Read one ElevenLabs conversation (GET /v1/convai/conversations/{id}). Used by the metering reconciliation job and by the live transcript
 * poller. Fields used, per the API reference (VERIFIED): status in initiated | in-progress | processing | done | failed; transcript[] items
 * { role: 'user'|'agent', message?: string|null, time_in_call_secs: int }; metadata.call_duration_secs. UNVERIFIED (docs silent): that
 * `transcript` is populated while status is 'in-progress' (the live view relies on it; docs/runbook.md section 6 has the live check).
 */
import { configEnv } from '@/lib/config';
import { logger } from '@/lib/log';

const log = logger('voice/conversations');
const API = 'https://api.elevenlabs.io/v1';

export type ConversationStatus = 'initiated' | 'in-progress' | 'processing' | 'done' | 'failed' | 'unknown';
export interface ConversationTurn { role: 'user' | 'agent'; message: string; timeInCallSecs: number }
export interface ConversationSnapshot {
  status: ConversationStatus;
  durationSecs: number | null;
  startUnixSecs: number | null;
  language: string | null;
  turns: ConversationTurn[];
}
export type ConversationFetch = { ok: true; snapshot: ConversationSnapshot } | { ok: false; status: number; notFound: boolean; error: string };

const STATUSES: readonly string[] = ['initiated', 'in-progress', 'processing', 'done', 'failed'];

export function parseConversation(json: unknown): ConversationSnapshot {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const meta = (j.metadata && typeof j.metadata === 'object' ? j.metadata : {}) as Record<string, unknown>;
  const status = typeof j.status === 'string' && STATUSES.includes(j.status) ? (j.status as ConversationStatus) : 'unknown';
  const dur = Number(meta.call_duration_secs);
  const start = Number(meta.start_time_unix_secs);
  const turns: ConversationTurn[] = [];
  if (Array.isArray(j.transcript)) {
    for (const t of j.transcript as unknown[]) {
      const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      const role = o.role === 'agent' ? 'agent' : o.role === 'user' ? 'user' : null;
      if (!role || typeof o.message !== 'string' || !o.message.trim()) continue; // tool-only turns carry no speech
      turns.push({ role, message: o.message, timeInCallSecs: Number.isFinite(Number(o.time_in_call_secs)) ? Math.max(0, Math.floor(Number(o.time_in_call_secs))) : 0 });
    }
  }
  return {
    status, durationSecs: Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null, startUnixSecs: Number.isFinite(start) && start > 0 ? start : null,
    language: typeof meta.main_language === 'string' ? meta.main_language : null, turns,
  };
}

export interface FetchDeps { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; timeoutMs?: number }

export async function fetchConversation(conversationId: string, deps: FetchDeps = {}): Promise<ConversationFetch> {
  const env = deps.env ?? configEnv();
  const key = (env.ELEVENLABS_API_KEY ?? '').trim();
  if (!key) return { ok: false, status: 0, notFound: false, error: 'no ELEVENLABS_API_KEY' };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${API}/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
    });
    if (!res.ok) return { ok: false, status: res.status, notFound: res.status === 404, error: `http ${res.status}` };
    return { ok: true, snapshot: parseConversation(await res.json().catch(() => null)) };
  } catch (err) {
    log.warn('fetch_failed', { err: (err as Error).name });
    return { ok: false, status: 0, notFound: false, error: (err as Error).name };
  }
}

export type ConversationDeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Delete ONE provider conversation (audio AND transcript): DELETE /v1/convai/conversations/{id}. 2xx and 404 (already gone) are success; everything
 * else is a failure with a short, credential-free reason, for the durable retry queue (voice/recording-deletion.ts). Never throws.
 */
export async function deleteConversation(conversationId: string, deps: FetchDeps = {}): Promise<ConversationDeleteResult> {
  const env = deps.env ?? configEnv();
  const key = (env.ELEVENLABS_API_KEY ?? '').trim();
  if (!key) return { ok: false, error: 'no ELEVENLABS_API_KEY' };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${API}/convai/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (res.ok || res.status === 404) return { ok: true };
    log.warn('delete_failed', { status: res.status });
    return { ok: false, error: `http_${res.status}` };
  } catch (err) {
    log.warn('delete_error', { error: (err as Error).name });
    return { ok: false, error: `error_${(err as Error).name}`.slice(0, 80) };
  }
}
