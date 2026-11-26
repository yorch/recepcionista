/**
 * Briefing audio: ElevenLabs text-to-speech with the BUSINESS'S voice (the voice the owner picked in Settings; else ELEVENLABS_VOICE_ID; else the
 * platform default voice id), returned as bytes for `saveBriefingAudio` (the database is the only store: nothing is written to disk).
 *
 * Fails closed: without ELEVENLABS_API_KEY, or when the provider errors or answers with something that is not audio, the result is
 * `{ ok: false, reason }` and the briefing simply has no audio (the dashboard says so). There is no local-voice fallback and no placeholder audio.
 * Provider shape (UNVERIFIED against the live API, documented in docs/known-limitations.md): POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
 * with { text, model_id, voice_settings } -> audio/mpeg bytes.
 */
import { logger } from '@/lib/log';
import { BRIEFING_AUDIO_MAX_BYTES } from '@/lib/business-config';
import { DEFAULT_VOICE_ID } from '@/lib/voice/elevenlabs';

const log = logger('tts');

const MIN_BYTES = 1024;
const MAX_TEXT_CHARS = 2_500; // a 45-second note is ~900 characters; refuse a runaway script instead of paying for it
const TIMEOUT_MS = 30_000;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type TtsFailure = 'not_configured' | 'text_too_long' | 'provider_failed' | 'bad_audio' | 'store_failed';

export type TtsResult =
  | { ok: true; bytes: Buffer; content_type: 'audio/mpeg'; voice_id: string }
  | { ok: false; reason: Exclude<TtsFailure, 'store_failed'> };

export function hasElevenLabsTts(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

/** The voice used for a business: its own choice, else the platform ELEVENLABS_VOICE_ID, else the default id. Ids that are not plain tokens are skipped. */
export function briefingVoiceId(business: { voice_id?: string | null } | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  for (const v of [business?.voice_id, env.ELEVENLABS_VOICE_ID, DEFAULT_VOICE_ID]) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (VOICE_ID_RE.test(id)) return id;
  }
  return DEFAULT_VOICE_ID;
}

export async function synthesizeBriefing(text: string, opts: { voiceId?: string | null } = {}): Promise<TtsResult> {
  if (!hasElevenLabsTts()) {
    log.warn('not_configured', { note: 'ELEVENLABS_API_KEY is not set: the briefing has no audio' });
    return { ok: false, reason: 'not_configured' };
  }
  const script = text.trim();
  if (!script || script.length > MAX_TEXT_CHARS) return { ok: false, reason: 'text_too_long' };
  const voiceId = briefingVoiceId({ voice_id: opts.voiceId });
  const started = Date.now();
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY as string, accept: 'audio/mpeg' },
      body: JSON.stringify({ text: script, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('provider_failed', { status: res.status, voice: voiceId, ms: Date.now() - started }); // the provider's body can echo the text: not logged
      return { ok: false, reason: 'provider_failed' };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength < MIN_BYTES || bytes.byteLength > BRIEFING_AUDIO_MAX_BYTES) {
      log.warn('bad_audio', { bytes: bytes.byteLength, voice: voiceId });
      return { ok: false, reason: 'bad_audio' };
    }
    log.info('synthesized', { voice: voiceId, chars: script.length, bytes: bytes.byteLength, ms: Date.now() - started });
    return { ok: true, bytes, content_type: 'audio/mpeg', voice_id: voiceId };
  } catch (err) {
    log.warn('provider_failed', { err, voice: voiceId, ms: Date.now() - started });
    return { ok: false, reason: 'provider_failed' };
  }
}
