/**
 * The voices an owner may pick for the receptionist. A SAFE SET only: the operator's allowlist (ELEVENLABS_VOICE_ALLOWLIST: comma
 * separated voice ids, each optionally `id:Display Name`), else the provider's own premade voices (GET /v1/voices, category 'premade').
 * A voice id that is not in this set is never accepted, so an owner cannot point the agent at an arbitrary (cloned, third-party) voice.
 *
 * Provider shape used (ElevenLabs GET /v1/voices -> { voices: [{ voice_id, name, category, preview_url, labels }] }); UNVERIFIED: the
 * exact `category` values and `preview_url` hosts, so the preview is fetched server-side with a size/time cap and only over https.
 */
import { logger } from '@/lib/log';

const log = logger('voice/voices');
const API = 'https://api.elevenlabs.io/v1';

export interface VoiceOption { voice_id: string; name: string; description: string | null; preview_url: string | null }

export const VOICE_ID_RE = /^[A-Za-z0-9]{10,40}$/;
const MAX_VOICES = 30;
export const VOICES_TTL_MS = 10 * 60_000;
let cached: { at: number; key: string; voices: VoiceOption[] } | null = null;
export const clearVoicesCache = (): void => { cached = null; };

/** Parse ELEVENLABS_VOICE_ALLOWLIST. Invalid ids are dropped. */
export function parseAllowlist(raw: string | undefined): { id: string; name: string | null }[] {
  const out: { id: string; name: string | null }[] = [];
  for (const part of (raw ?? '').split(',')) {
    const [id, ...rest] = part.trim().split(':');
    if (!id || !VOICE_ID_RE.test(id.trim()) || out.some((o) => o.id === id.trim())) continue;
    out.push({ id: id.trim(), name: rest.join(':').trim().slice(0, 60) || null });
  }
  return out.slice(0, MAX_VOICES);
}

const labelText = (labels: unknown): string | null => {
  if (!labels || typeof labels !== 'object') return null;
  const l = labels as Record<string, unknown>;
  const parts = [l.gender, l.age, l.accent, l.description, l.use_case].filter((v): v is string => typeof v === 'string' && v.length > 0).map((v) => v.replace(/_/g, ' '));
  return parts.length ? parts.join(', ').slice(0, 120) : null;
};

/** The selectable voices ([] when no provider key). Cached ten minutes. Never throws. */
export async function listAllowedVoices(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<VoiceOption[]> {
  if (!env.ELEVENLABS_API_KEY) return [];
  const allow = parseAllowlist(env.ELEVENLABS_VOICE_ALLOWLIST);
  const key = allow.map((a) => a.id).join(',');
  if (cached && cached.key === key && Date.now() - cached.at < VOICES_TTL_MS) return cached.voices;
  let provider: Record<string, unknown>[] = [];
  try {
    const res = await fetchImpl(`${API}/voices`, { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) provider = ((await res.json()) as { voices?: Record<string, unknown>[] }).voices ?? [];
    else log.warn('list_failed', { status: res.status });
  } catch (err) {
    log.warn('list_error', { error: (err as Error).name });
  }
  const byId = new Map(provider.filter((v) => typeof v.voice_id === 'string').map((v) => [v.voice_id as string, v]));
  let voices: VoiceOption[];
  if (allow.length > 0) {
    // The allowlist decides WHICH voices; the provider only supplies names and previews (an allowlisted id the provider does not list stays selectable by id).
    voices = allow.map((a) => {
      const p = byId.get(a.id);
      return { voice_id: a.id, name: a.name ?? (typeof p?.name === 'string' ? p.name : a.id), description: p ? labelText(p.labels) : null, preview_url: typeof p?.preview_url === 'string' ? p.preview_url : null };
    });
  } else {
    voices = provider
      .filter((v) => v.category === 'premade' && typeof v.voice_id === 'string' && VOICE_ID_RE.test(v.voice_id as string))
      .slice(0, MAX_VOICES)
      .map((v) => ({ voice_id: v.voice_id as string, name: typeof v.name === 'string' ? v.name.slice(0, 60) : (v.voice_id as string), description: labelText(v.labels), preview_url: typeof v.preview_url === 'string' ? v.preview_url : null }));
  }
  if (provider.length > 0 || allow.length > 0) cached = { at: Date.now(), key, voices };
  return voices;
}

/** The option for `voiceId`, or null when it is not in the safe set. */
export async function findAllowedVoice(voiceId: unknown, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<VoiceOption | null> {
  if (typeof voiceId !== 'string' || !VOICE_ID_RE.test(voiceId)) return null;
  return (await listAllowedVoices(env, fetchImpl)).find((v) => v.voice_id === voiceId) ?? null;
}

/** Fetch a voice's preview sample (mp3), https only, 2 MB / 10 s caps. Null when none. */
export async function fetchPreview(url: string | null, fetchImpl: typeof fetch = fetch): Promise<{ body: Uint8Array; type: string } | null> {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  try {
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!res.ok) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > 2 * 1024 * 1024) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    return { body, type: /^audio\/[a-z0-9.+-]+$/.test(type) ? type : 'audio/mpeg' };
  } catch {
    return null;
  }
}
