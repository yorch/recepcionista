/**
 * Restores the seeded demo state and clears generated audio. Kept separate from
 * the seed script so the dashboard can reset without leaving the browser.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

const run = promisify(execFile);

export async function POST() {
  try {
    const root = process.cwd();
    await run(process.execPath, [path.join(root, 'scripts/seed.ts')], { cwd: root, timeout: 30_000 });
    const audioDir = path.join(root, 'public/audio');
    if (fs.existsSync(audioDir)) {
      for (const f of fs.readdirSync(audioDir)) {
        if (/^briefing-/.test(f)) fs.unlinkSync(path.join(audioDir, f));
      }
    }
    return ok({ reset: true });
  } catch (err) {
    return fail(err, 500);
  }
}
