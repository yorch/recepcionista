/**
 * Generates a briefing (script + audio) outside the browser.
 * Usage: bun scripts/gen-audio.ts <business_id> [YYYY-MM-DD]
 */
import { generateBriefing } from '../src/lib/briefing';

const businessId = process.argv[2] ?? 'biz_miami_cool_air';
const date = process.argv[3];

const briefing = await generateBriefing(businessId, date);

const words = briefing.transcript.trim().split(/\s+/).length;
console.log(`date:      ${briefing.date}`);
console.log(`words:     ${words}`);
console.log(`audio_url: ${briefing.audio_url ?? '(none)'}`);
console.log(`stats:     ${JSON.stringify(briefing.stats)}`);
console.log('\n--- transcript ---');
console.log(briefing.transcript);
