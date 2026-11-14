/**
 * WS1 self-test. Run: bun scripts/ws1-test.ts
 * Exercises lib functions directly (no HTTP server needed).
 * NOTE: this writes a real business + KB into Postgres; harmless for a demo.
 */
import { createBusiness, getBusiness, getKnowledgeBase, upsertKnowledgeBase, updateBusiness } from '../src/lib/db';
import { extractFromUrl, templateResult, normalizeUrl } from '../src/lib/extraction';
import { generateKnowledgeBase, buildSystemPrompt, buildCallScript, TOOL_NAMES } from '../src/lib/kb';
import { provisionNumber } from '../src/lib/providers/twilio';

let pass = 0;
let failCount = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (cond) pass++; else failCount++;
}

const stamp = Date.now();

// 1. extractFromUrl never throws, returns template for a bad URL
const bad = await extractFromUrl('not a url at all');
check('extractFromUrl(bad url) returns template fallback', bad.source === 'template' && bad.services.length > 0);
check('template fallback has 7 lowercase day keys', ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].every(d => d in bad.hours));

// normalizeUrl
check('normalizeUrl adds https://', normalizeUrl('example.com')?.startsWith('https://example.com') === true);
check('normalizeUrl rejects ftp', normalizeUrl('ftp://example.com') === null);
check('normalizeUrl rejects garbage', normalizeUrl('http://') === null);

// 2. create business
const biz = await createBusiness({ name: `WS1 Test Co ${stamp}`, url: null, owner_phone: '+13055550111', owner_name: 'Test Owner' });
check('createBusiness returns onboarding business', biz.status === 'onboarding' && !!biz.id);

// 3. provision (no url → template extraction path)
let extraction;
try {
  extraction = biz.url ? await extractFromUrl(biz.url) : templateResult(biz.name);
} catch {
  extraction = templateResult(biz.name);
}
const generated = generateKnowledgeBase(extraction, biz);
let kb = await upsertKnowledgeBase(biz.id, generated);
check('generateKnowledgeBase produces services + prompt + script', kb.services.length > 0 && kb.system_prompt.length > 500 && kb.call_script.includes('OPENING'));
check('system_prompt mentions all 7 tools', TOOL_NAMES.every((t) => kb.system_prompt.includes(t)));
check('system_prompt has Spanglish rule', kb.system_prompt.includes('Spanglish') && kb.system_prompt.includes('el AC'));
check('system_prompt has deposit + emergency rules', kb.system_prompt.includes('$500') && kb.system_prompt.includes('burning smell'));

const { phone } = await provisionNumber('305');
const updatedBiz = await updateBusiness(biz.id, { phone, status: 'live' });
check('provision sets phone + live', !!updatedBiz?.phone && updatedBiz.status === 'live' && phone.startsWith('+1'));

// 4. read back
const readBack = await getBusiness(biz.id);
check('getBusiness reads back the business', readBack?.id === biz.id && readBack?.status === 'live');
const kbBack = await getKnowledgeBase(biz.id);
check('getKnowledgeBase reads back the KB', kbBack?.business_id === biz.id);

// 5. patch KB and regenerate prompt
const merged = { services: kb.services, faqs: [...kb.faqs, { question: 'Do you offer warranties?', answer: 'Yes, 1 year on repairs.' }], pricing_notes: 'Repairs carry a 1-year warranty.' };
const regenerated = buildSystemPrompt(readBack!, merged);
kb = await upsertKnowledgeBase(biz.id, {
  faqs: merged.faqs,
  pricing_notes: merged.pricing_notes,
  system_prompt: regenerated,
  call_script: buildCallScript({ services: merged.services }),
});
check('KB merge + prompt regeneration keeps new FAQ', kb.faqs.some((f) => f.question.includes('warranties')) && kb.system_prompt.includes('1-year warranty'));

// cleanup: remove test business + KB is not exposed by db API; leave it (demo-safe, prefixed name)
console.log(`\n${failCount === 0 ? `ALL PASS (${pass}/${pass + failCount})` : `FAILURES: ${failCount}/${pass + failCount}`}`);
process.exit(failCount === 0 ? 0 : 1);
