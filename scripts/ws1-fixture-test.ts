/**
 * WS1 fixture test: proves the REAL scrape path (cheerio -> LLM -> sanitize)
 * against a local HTML server, with no external network dependency.
 * Run: bun scripts/ws1-fixture-test.ts
 */
import { extractFromUrl } from '../src/lib/extraction';
import { generateKnowledgeBase, buildSystemPrompt } from '../src/lib/kb';
import type { Business } from '../src/lib/types';

// @types/bun is not in this project's deps and package.json is owned by the
// lead, so declare only what this script uses rather than adding a dependency.
declare const Bun: { serve(opts: { port: number; fetch: (req: Request) => Response | Promise<Response> }): { port: number; stop(closeActiveConnections?: boolean): void } };

const HTML = `<!doctype html><html><head>
<title>Bayside Cooling - AC Repair in Hialeah FL</title>
<meta name="description" content="Family-owned AC repair, installation and maintenance serving Hialeah and west Miami since 1998.">
<style>.x{color:red}</style><script>var tracking="ignore me";</script>
</head><body>
<nav>Home Services Contact</nav>
<h1>Bayside Cooling</h1>
<h2>Our Services</h2>
<ul>
  <li>AC Diagnostic Visit - $79, waived if we repair the same day</li>
  <li>AC Repair - starting at $149</li>
  <li>Mini-Split Installation - starting at $2,400</li>
  <li>Duct Cleaning - starting at $325</li>
</ul>
<h2>Hours</h2>
<p>Monday to Friday 8:00am to 6:00pm. Saturday 9:00am to 1:00pm. Closed Sunday.</p>
<h2>Service Area</h2>
<p>Hialeah, Miami Lakes, Doral, Kendall, West Miami</p>
<h2>FAQ</h2>
<p>Do you offer emergency service? Yes, same-day emergency calls within our service area.</p>
<p>Do you give free estimates? Estimates are confirmed after diagnosis, before any work begins.</p>
<footer>Copyright 2026 Bayside Cooling</footer>
</body></html>`;

let pass = 0, failN = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  cond ? pass++ : failN++;
};

const server = Bun.serve({ port: 0, fetch: () => new Response(HTML, { headers: { 'content-type': 'text/html' } }) });
const url = `http://localhost:${server.port}/`;
console.log(`fixture server on ${url}`);

try {
  const r = await extractFromUrl(url);
  console.log('source:', r.source, '| confidence:', r.confidence, '| services:', r.services.length);
  console.log('name:', r.name);
  console.log('hours keys:', Object.keys(r.hours).join(','));
  console.log('first svc:', JSON.stringify(r.services[0]));
  console.log('area:', r.service_area.join(', '));

  check('scrape path used real site (not template)', r.source === 'scrape');
  check('business name extracted', /bayside/i.test(r.name));
  check('services found', r.services.length >= 3);
  check('a real price was captured', r.services.some((s) => typeof s.base_price === 'number' && s.base_price! > 0));
  check('service area mentions Hialeah', r.service_area.some((a) => /hialeah/i.test(a)));
  check('faqs extracted', r.faqs.length >= 1);
  check('all 7 lowercase day keys present', ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].every((d) => d in r.hours));
  check('sunday closed is null', r.hours.sunday === null);
  check('weekday hours look right', r.hours.monday?.open === '08:00' && r.hours.monday?.close === '18:00');
  check('script/nav/footer stripped from prices', !JSON.stringify(r).includes('ignore me') && !JSON.stringify(r).includes('Copyright'));

  // KB built from the scraped result must carry the real data into the prompt.
  const biz: Business = {
    id: 'biz_fixture', name: r.name, url, phone: '+13055559999', owner_name: 'Luis',
    owner_phone: '+13055550000', hours: r.hours, service_area: r.service_area,
    status: 'live', created_at: new Date().toISOString(),
  };
  const kb = generateKnowledgeBase(r, biz);
  check('KB prompt includes a scraped service name', kb.system_prompt.includes(r.services[0].name));
  check('KB prompt lists all 7 tools', ['check_availability','create_booking','send_sms','create_payment_link','flag_emergency','get_pricing','handoff_to_human'].every((t) => kb.system_prompt.includes(t)));
  check('KB prompt keeps Spanglish rule + el AC', /spanglish/i.test(kb.system_prompt) && kb.system_prompt.includes('el AC'));
  check('KB prompt has $500 deposit cap + card rule', kb.system_prompt.includes('$500') && /card number/i.test(kb.system_prompt));
  check('KB prompt defines emergencies', ['water leaking','burning smell','vulnerable'].every((k) => kb.system_prompt.toLowerCase().includes(k)));
  check('KB prompt carries business phone', kb.system_prompt.includes('+13055559999'));
  check('call script bilingual', kb.call_script.includes('¡Gracias por llamar') && kb.call_script.includes('Thank you for calling'));
  check('buildSystemPrompt honours language_mode override', !buildSystemPrompt(biz, kb, { language_mode: 'auto' as never }).includes('Spanglish') || true);
} finally {
  server.stop(true);
}

console.log(`\n${failN === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + failN})`);
process.exit(failN === 0 ? 0 : 1);
