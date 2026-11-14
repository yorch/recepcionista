/**
 * WS5 self-test. Run: bun scripts/ws5-test.ts
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import fs from 'node:fs';
import path from 'node:path';
import { getBusiness } from '../src/lib/db';
import { fallbackScript, gather, wordCount, generateBriefing } from '../src/lib/briefing';
import { classifyReply, findGratitudeCandidates, runGratitudeSweep } from '../src/lib/gratitude';

const BIZ = 'biz_miami_cool_air';
let pass = 0;
let failCount = 0;

function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) {
    failCount++;
    if (detail !== undefined) console.log('       got:', JSON.stringify(detail).slice(0, 700));
  } else pass++;
}

async function main() {
  await run('bun', ['scripts/seed.ts'], { cwd: process.cwd() });

  const business = (await getBusiness(BIZ))!;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await gather(BIZ, yesterday);
  const script = fallbackScript(business, data);

  // The demo-critical facts must survive into the deterministic path.
  check('fallback mentions Marisol', /Marisol/.test(script), script);
  check('fallback mentions the 2 PM repair', /2:00 p\.m\./.test(script), script);
  check('fallback mentions 189', /189/.test(script), script);
  check('fallback opens with Hola Jorge', script.startsWith('Hola Jorge'), script.slice(0, 40));
  check('fallback ends with Eso es todo', /Eso es todo/.test(script));

  const words = wordCount(script);
  check('fallback length 90-160 words', words >= 90 && words <= 160, words);

  check('classifyReply(5) = review', classifyReply(5) === 'review');
  check('classifyReply(4) = review', classifyReply(4) === 'review');
  check('classifyReply(3) = owner', classifyReply(3) === 'owner');
  check('classifyReply(2) = owner', classifyReply(2) === 'owner');

  // Quiet-day path must not crash or sound broken.
  const quiet = fallbackScript(
    { ...business, owner_name: 'Jorge' },
    { calls: [], bookings: [], flagged: [], deposits: 0, stats: { calls: 0, bookings: 0, revenue: 0, flags: 0 } } as never,
  );
  check('quiet day still speaks', quiet.includes('tranquilo'), quiet);

  const candidates = await findGratitudeCandidates(BIZ);
  check('findGratitudeCandidates runs', Array.isArray(candidates));

  const sweep = await runGratitudeSweep(BIZ);
  check('sweep returns numbers', typeof sweep.sent === 'number' && typeof sweep.skipped === 'number', sweep);

  // Real generation: script + audio file on disk.
  const briefing = await generateBriefing(BIZ);
  check('briefing has transcript', briefing.transcript.length > 100);
  check('briefing has stats', briefing.stats.calls >= 0 && briefing.stats.bookings >= 0);

  if (briefing.audio_url) {
    const file = path.join(process.cwd(), 'public', briefing.audio_url);
    const exists = fs.existsSync(file);
    const size = exists ? fs.statSync(file).size : 0;
    check('audio file exists', exists, file);
    check('audio file > 1KB', size > 1024, size);
    console.log(`       audio: ${briefing.audio_url} (${size} bytes)`);
  } else {
    // Acceptable only on a machine with no TTS at all; flag it loudly.
    console.log('FAIL — no audio_url produced (no ElevenLabs key and no local `say`)');
    failCount++;
  }

  await run('bun', ['scripts/seed.ts'], { cwd: process.cwd() });

  console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + failCount})`);
  if (failCount > 0) process.exit(1);
}

main();
