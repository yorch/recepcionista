/**
 * Briefing audio. ElevenLabs when configured, macOS `say` + `afconvert`
 * otherwise — the local path is what makes the demo audible with no key.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '@/lib/log';

const log = logger('tts');

const run = promisify(execFile);

const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');
const MIN_BYTES = 1024;
const SAY_TIMEOUT_MS = 25_000;

export interface TtsResult {
  audio_url: string | null;
  mock: boolean;
  bytes?: number;
}

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

export function hasElevenLabsTts(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

async function elevenLabs(text: string, base: string): Promise<TtsResult> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID as string;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': process.env.ELEVENLABS_API_KEY as string,
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength < MIN_BYTES) throw new Error('elevenlabs returned a tiny file');

  const file = path.join(AUDIO_DIR, `${base}.mp3`);
  fs.writeFileSync(file, buffer);
  return { audio_url: `/audio/${base}.mp3`, mock: false, bytes: buffer.byteLength };
}

/**
 * `say` takes the text as one argv element. Interpolating it into a shell string
 * would break on the quotes and accents every Spanglish briefing contains.
 */
async function localSay(text: string, base: string): Promise<TtsResult> {
  const aiff = path.join(AUDIO_DIR, `${base}.aiff`);
  const m4a = path.join(AUDIO_DIR, `${base}.m4a`);

  try {
    await run('say', ['-o', aiff, '-v', 'Paulina', text], { timeout: SAY_TIMEOUT_MS });
    await run('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, m4a], { timeout: SAY_TIMEOUT_MS });
  } finally {
    if (fs.existsSync(aiff)) fs.unlinkSync(aiff);
  }

  const stat = fs.statSync(m4a);
  if (stat.size < MIN_BYTES) throw new Error(`say produced ${stat.size} bytes`);
  return { audio_url: `/audio/${base}.m4a`, mock: true, bytes: stat.size };
}

export async function synthesizeBriefing(
  text: string,
  opts: { businessId: string; date: string },
): Promise<TtsResult> {
  // These flow into a file path: refuse anything that is not a plain id/date.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.businessId)) {
    throw new Error('invalid businessId or date for briefing audio');
  }
  ensureAudioDir();
  const base = `briefing-${opts.businessId}-${opts.date}`;
  const started = Date.now();
  const fields = { business: opts.businessId, date: opts.date, chars: text.length };

  if (hasElevenLabsTts()) {
    try {
      const out = await elevenLabs(text, base);
      log.info('synthesized', { ...fields, provider: 'elevenlabs', bytes: out.bytes, ms: Date.now() - started });
      return out;
    } catch (err) {
      log.warn('elevenlabs.fallback_to_local', { ...fields, err });
    }
  } else {
    log.debug('elevenlabs.skipped', { ...fields, reason: 'key or voice id missing' });
  }

  try {
    const out = await localSay(text, base);
    log.info('synthesized', { ...fields, provider: 'local-say', bytes: out.bytes, ms: Date.now() - started });
    return out;
  } catch (err) {
    log.error('local.failed', { ...fields, err, ms: Date.now() - started });
    return { audio_url: null, mock: true };
  }
}
