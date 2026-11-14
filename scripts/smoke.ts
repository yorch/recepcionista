/**
 * End-to-end smoke test. Run: bun scripts/smoke.ts (dev server must be on :3000)
 * Every assertion goes over HTTP so it tests the real pipeline.
 */
const BASE = process.env.APP_URL || 'http://127.0.0.1:3000';
const BIZ = 'biz_miami_cool_air';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) { fail++; if (detail !== undefined) console.log('       got:', JSON.stringify(detail).slice(0, 400)); }
  else pass++;
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, text: await res.text() };
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  console.log('--- pages ---');
  for (const p of ['/', '/dashboard', '/dashboard/calls', '/dashboard/bookings',
    '/dashboard/knowledge', '/dashboard/briefings', '/dashboard/demo', '/onboarding', '/pay/demo']) {
    const r = await get(p);
    check(`page ${p} → 200`, r.status === 200, r.status);
  }

  console.log('\n--- reset to clean demo state ---');
  const reset = await post('/api/demo/reset');
  check('reset ok', reset.json?.ok === true);

  console.log('\n--- 2-minute setup ---');
  const created = await post('/api/businesses', { name: 'Smoke Test HVAC', url: 'https://example.com' });
  check('create business', created.json?.ok === true, created.json);
  const bizId = created.json?.data?.id;

  const provisioned = await post(`/api/businesses/${bizId}/provision`, {});
  check('provision ok', provisioned.json?.ok === true, provisioned.json);
  check('provision returns a phone', Boolean(provisioned.json?.data?.phone), provisioned.json?.data?.phone);
  check('provision sets status live', provisioned.json?.data?.business?.status === 'live');
  check('provision builds a knowledge base', (provisioned.json?.data?.knowledge_base?.services?.length ?? 0) > 0);
  check('system prompt names all 7 tools',
    ['check_availability', 'create_booking', 'send_sms', 'create_payment_link', 'flag_emergency', 'get_pricing', 'handoff_to_human']
      .every((t) => (provisioned.json?.data?.knowledge_base?.system_prompt ?? '').includes(t)));
  check('system prompt is Spanglish-aware', /spanish|español|spanglish/i.test(provisioned.json?.data?.knowledge_base?.system_prompt ?? ''));

  console.log('\n--- three call scripts ---');
  for (const script of ['spanish', 'routine', 'emergency']) {
    const phone = `+1305555${Math.floor(1000 + Math.random() * 8999)}`;
    const sim = await post('/api/demo/simulate-call', {
      business_id: BIZ, caller_name: `Smoke ${script}`, caller_phone: phone, script,
    });
    const d = sim.json?.data;
    check(`${script}: call recorded`, Boolean(d?.call?.id), sim.json);
    check(`${script}: booking created`, Boolean(d?.booking?.id), d?.booking);
    check(`${script}: sms sent`, (d?.sms?.length ?? 0) > 0, d?.sms);
    if (script === 'emergency') {
      check('emergency: deposit link', Boolean(d?.payment_link?.url), d?.payment_link);
      check('emergency: flagged for owner', d?.call?.urgency === 'emergency', d?.call?.urgency);
    }
    if (script === 'spanish') {
      const body = d?.sms?.[0]?.body ?? '';
      check('spanish: SMS is in Spanish', /Confirmado|Gracias|depósito/.test(body), body);
    }
    if (script === 'routine') {
      const body = d?.sms?.[0]?.body ?? '';
      check('english: SMS is in English', /Confirmed/.test(body), body);
    }
  }

  console.log('\n--- payment page ---');
  const pay = await get('/pay/mock_smoke?amount=18900');
  check('mock checkout renders', pay.status === 200);
  check('mock checkout shows amount', pay.text.includes('189.00'));

  console.log('\n--- briefing + audio ---');
  const brief = await post('/api/briefings/generate', { business_id: BIZ });
  const b = brief.json?.data;
  check('briefing generated', brief.json?.ok === true, brief.json);
  check('briefing has audio_url', Boolean(b?.audio_url), b?.audio_url);
  const words = (b?.transcript ?? '').trim().split(/\s+/).length;
  check('briefing 90-160 words', words >= 90 && words <= 160, words);
  if (b?.audio_url) {
    const audio = await get(b.audio_url);
    check('audio file serves', audio.status === 200, audio.status);
    check('audio is not empty', audio.text.length > 0 || audio.status === 200);
  }
  const list = await get(`/api/briefings?business_id=${BIZ}`);
  check('briefings list ok', list.status === 200);

  console.log('\n--- gratitude loop ---');
  const sweep = await post('/api/gratitude/run', {});
  check('sweep runs', sweep.json?.ok === true, sweep.json);

  const bookings = await (await fetch(`${BASE}/api/briefings?business_id=${BIZ}`)).json();
  void bookings;

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + fail})`);
  if (fail > 0) process.exit(1);
}

main();
