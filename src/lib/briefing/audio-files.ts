/**
 * Briefing audio lives on disk (public/audio/briefing-<business>-<date>.mp3|m4a), outside the database, so it
 * must be deleted explicitly whenever its briefing row is (retention purge, erasure, demo reset).
 * Paths are rebuilt from the stored URL and refused unless they match the exact generated name: a tampered
 * `audio_url` can never delete anything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/log';

const log = logger('audio-files');

export const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');
const NAME = /^\/audio\/(briefing-[A-Za-z0-9_-]{1,64}-\d{4}-\d{2}-\d{2}\.(?:mp3|m4a))$/;

/** Delete the files behind these `audio_url`s. Returns how many files were removed. Never throws. */
export function removeBriefingAudio(urls: ReadonlyArray<string | null | undefined>): number {
  let removed = 0;
  for (const url of urls) {
    const m = url ? NAME.exec(url) : null;
    if (!m) continue;
    const file = path.join(AUDIO_DIR, m[1]);
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('unlink_failed', { file: m[1], err });
    }
  }
  return removed;
}

/** Delete every generated briefing file (demo reset). Returns the number removed. */
export function removeAllBriefingAudio(): number {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (/^briefing-/.test(f)) { fs.unlinkSync(path.join(AUDIO_DIR, f)); removed++; }
    }
  } catch { /* no audio dir yet */ }
  return removed;
}
