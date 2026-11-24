/** Pure logic of the phase-2 features: refund policy matrix, readiness, voice allowlist, recording ranges, annual plan mapping, SMS templates. */
import { describe, expect, test } from 'bun:test';
import { bookingRefundEligibility, checkRefundAmount, maxRefundable, policySentence, refundEligibility, refundIdempotencyKey } from '../src/lib/refunds';
import { kbReadiness, readinessOfDraft } from '../src/lib/kb/readiness';
import { parseAllowlist, listAllowedVoices, clearVoicesCache, findAllowedVoice } from '../src/lib/voice/voices';
import { callHasRecording, serveBody } from '../src/lib/voice/recording-audio';
import { intervalOfSubscription } from '../src/lib/billing/status';
import { annualAvailable, parseInterval } from '../src/lib/providers/stripe-billing';
import { cancelSms, paymentLinkSms, refundSms, rescheduleSms, SMS_LIMIT } from '../src/lib/messaging/templates';
import { smsSegments } from '../src/lib/messaging/policy';
import type { Booking, Business } from '../src/lib/types';

const H = 3_600_000;
const start = '2027-03-10T15:00:00.000Z';
const at = (ms: number) => new Date(new Date(start).getTime() + ms);

describe('refund eligibility matrix', () => {
  const e = (policy: Parameters<typeof refundEligibility>[0]['policy'], cancelledOffsetMs: number, paid = 5000) =>
    refundEligibility({ policy, scheduled_at: start, cancelled_at: at(cancelledOffsetMs), deposit_paid_cents: paid });
  test('none never refunds', () => { expect(e('none', -100 * H).eligible).toBe(false); expect(e('none', -100 * H).reason).toBe('policy_none'); });
  test('full_always refunds even after the start', () => { expect(e('full_always', +5 * H).eligible).toBe(true); expect(e('full_always', +5 * H).amount_cents).toBe(5000); });
  test('24h boundary is inclusive: exactly 24h yes, 1 ms later no', () => {
    expect(e('full_24h', -24 * H).eligible).toBe(true);
    expect(e('full_24h', -24 * H + 1).eligible).toBe(false);
    expect(e('full_24h', -24 * H + 1).reason).toBe('too_late');
    expect(e('full_24h', -24 * H - 1).eligible).toBe(true);
  });
  test('48h boundary is inclusive', () => {
    expect(e('full_48h', -48 * H).eligible).toBe(true);
    expect(e('full_48h', -48 * H + 1).eligible).toBe(false);
    expect(e('full_48h', -30 * H).eligible).toBe(false); // 30h: fine for 24h, not for 48h
    expect(e('full_24h', -30 * H).eligible).toBe(true);
  });
  test('after the job started is never within a notice window', () => { expect(e('full_24h', +1 * H).eligible).toBe(false); expect(e('full_24h', +1 * H).hours_before).toBe(-1); });
  test('no paid deposit: nothing to refund whatever the policy', () => {
    expect(e('full_always', -100 * H, 0).reason).toBe('no_deposit');
    expect(refundEligibility({ policy: 'full_always', scheduled_at: start, deposit_paid_cents: null }).eligible).toBe(false);
  });
  test('unset policy defaults to full_24h; booking helper uses cancelled_at and the paid flag', () => {
    const b = { scheduled_at: start, cancelled_at: at(-25 * H).toISOString(), deposit_amount: 4000, deposit_paid: true };
    expect(bookingRefundEligibility(b, undefined).eligible).toBe(true);
    expect(bookingRefundEligibility({ ...b, deposit_paid: false }, 'full_24h').reason).toBe('no_deposit');
  });
  test('policy sentences exist in both languages', () => {
    for (const p of ['none', 'full_24h', 'full_48h', 'full_always'] as const) { expect(policySentence(p, 'en').length).toBeGreaterThan(10); expect(policySentence(p, 'es').length).toBeGreaterThan(10); }
  });
});

describe('refund amounts and keys', () => {
  test('amount rules', () => {
    expect(checkRefundAmount(undefined, 5000)).toEqual({ ok: true, amount_cents: 5000 });
    expect(checkRefundAmount(2500, 5000)).toEqual({ ok: true, amount_cents: 2500 });
    expect(checkRefundAmount(5001, 5000).ok).toBe(false);
    expect(checkRefundAmount(0, 5000).ok).toBe(false);
    expect(checkRefundAmount(-5, 5000).ok).toBe(false);
    expect(checkRefundAmount(10.5, 5000).ok).toBe(false);
    expect(checkRefundAmount('100', 5000).ok).toBe(false);
    expect(checkRefundAmount(NaN, 5000).ok).toBe(false);
    expect(checkRefundAmount(null, 5000).ok).toBe(false);
    expect(checkRefundAmount(100, 0).ok).toBe(false);
  });
  test('maxRefundable', () => {
    expect(maxRefundable({ deposit_amount: 5000, deposit_paid: true, refund_status: 'none' })).toBe(5000);
    expect(maxRefundable({ deposit_amount: 5000, deposit_paid: true, refund_status: 'refunded' })).toBe(0);
    expect(maxRefundable({ deposit_amount: 5000, deposit_paid: false, refund_status: 'none' })).toBe(0);
  });
  test('idempotency key is stable per booking+amount and changes with amount or attempt', () => {
    expect(refundIdempotencyKey('b1', 100)).toBe(refundIdempotencyKey('b1', 100));
    expect(refundIdempotencyKey('b1', 100)).not.toBe(refundIdempotencyKey('b1', 200));
    expect(refundIdempotencyKey('b1', 100)).not.toBe(refundIdempotencyKey('b2', 100));
    expect(refundIdempotencyKey('b1', 100, 1)).not.toBe(refundIdempotencyKey('b1', 100));
  });
});

describe('kb readiness', () => {
  const svc = (n: number, priced = true) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, base_price: priced ? 100 + i : null }));
  const faq = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }));
  const hours = { monday: { open: '08:00', close: '17:00' }, tuesday: null };
  test('complete: ready, perfect score', () => {
    const r = kbReadiness({ services: svc(5), faqs: faq(3) }, { hours, service_area: ['Miami'], owner_name: 'Jorge' });
    expect(r.ready).toBe(true); expect(r.blockers).toEqual([]); expect(r.warnings).toEqual([]); expect(r.score).toBe(100);
  });
  test('blockers: <3 priced services, no hours, no FAQ', () => {
    const r = kbReadiness({ services: [...svc(2), { name: 'Free quote', base_price: null }], faqs: [{ question: 'q', answer: ' ' }] }, { hours: { monday: null }, service_area: [], owner_name: '' });
    expect(r.ready).toBe(false);
    expect(r.blockers.map((b) => b.key).sort()).toEqual(['faqs', 'hours', 'services']);
    expect(r.warnings.map((b) => b.key).sort()).toEqual(['owner_name', 'service_area']);
    expect(r.score).toBeLessThan(50);
  });
  test('3 services and 1 FAQ pass the gate but warn', () => {
    const r = kbReadiness({ services: svc(3), faqs: faq(1) }, { hours });
    expect(r.ready).toBe(true);
    expect(r.warnings.map((w) => w.key).sort()).toEqual(['faqs', 'services']);
  });
  test('zero price does not count; null kb is not ready', () => {
    expect(kbReadiness({ services: [{ name: 'a', base_price: 0 }, ...svc(2)], faqs: faq(1) }, { hours }).ready).toBe(false);
    expect(kbReadiness(null).ready).toBe(false);
  });
  test('onboarding draft adapter', () => {
    const d = {
      ownerName: 'J', serviceArea: 'Miami, Hialeah', hours: { monday: { open: true, from: '08:00', to: '17:00' }, sunday: { open: false, from: '08:00', to: '17:00' } },
      services: [{ name: 'a', price: '$99' }, { name: 'b', price: '150' }, { name: 'c', price: '' }], faqs: [{ question: 'q', answer: 'a' }],
    };
    const r = readinessOfDraft(d);
    expect(r.blockers.map((b) => b.key)).toEqual(['services']);
    d.services[2].price = '10';
    expect(readinessOfDraft(d).ready).toBe(true);
  });
});

describe('voice allowlist', () => {
  test('parseAllowlist keeps valid ids, names, drops junk and duplicates', () => {
    expect(parseAllowlist('abcdefghij12:Maria, ZZZZZZZZZZ99 ,bad id,short,abcdefghij12')).toEqual([{ id: 'abcdefghij12', name: 'Maria' }, { id: 'ZZZZZZZZZZ99', name: null }]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
  test('no key -> no voices; allowlist decides which ids are valid; premade fallback; arbitrary id refused', async () => {
    clearVoicesCache();
    expect(await listAllowedVoices({} as NodeJS.ProcessEnv)).toEqual([]);
    const fake = (async () => new Response(JSON.stringify({ voices: [
      { voice_id: 'premade00001', name: 'Rachel', category: 'premade', preview_url: 'https://x.test/a.mp3', labels: { gender: 'female' } },
      { voice_id: 'cloned000001', name: 'Mine', category: 'cloned' },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const env = { ELEVENLABS_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv;
    const premade = await listAllowedVoices(env, fake);
    expect(premade.map((v) => v.voice_id)).toEqual(['premade00001']);
    expect((await findAllowedVoice('cloned000001', env, fake))).toBeNull();
    expect((await findAllowedVoice('premade00001', env, fake))?.name).toBe('Rachel');
    clearVoicesCache();
    const env2 = { ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ALLOWLIST: 'cloned000001:Custom' } as unknown as NodeJS.ProcessEnv;
    expect((await listAllowedVoices(env2, fake)).map((v) => v.name)).toEqual(['Custom']);
    expect(await findAllowedVoice('premade00001', env2, fake)).toBeNull();
    expect(await findAllowedVoice('../etc/passwd', env2, fake)).toBeNull();
    expect(await findAllowedVoice(42, env2, fake)).toBeNull();
    clearVoicesCache();
  });
});

describe('recording rules and ranges', () => {
  const ok = { consent_status: 'disclosed', conversation_id: 'conv_abc123XYZ', kind: 'customer', status: 'completed' } as const;
  test('only disclosed, customer, finished calls with a conversation play', () => {
    expect(callHasRecording(ok)).toBe(true);
    expect(callHasRecording({ ...ok, consent_status: 'declined' })).toBe(false);
    expect(callHasRecording({ ...ok, consent_status: 'unknown' })).toBe(false);
    expect(callHasRecording({ ...ok, conversation_id: null })).toBe(false);
    expect(callHasRecording({ ...ok, conversation_id: '../x' })).toBe(false);
    expect(callHasRecording({ ...ok, kind: 'owner' })).toBe(false);
    expect(callHasRecording({ ...ok, status: 'in_progress' })).toBe(false);
  });
  const body = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
  test('serveBody: whole, range, suffix, open-ended, unsatisfiable', async () => {
    const full = serveBody(body, 'audio/mpeg', null);
    expect(full.status).toBe(200); expect(full.headers.get('accept-ranges')).toBe('bytes'); expect(full.headers.get('cache-control')).toContain('no-store');
    const r = serveBody(body, 'audio/mpeg', 'bytes=10-19');
    expect(r.status).toBe(206); expect(r.headers.get('content-range')).toBe('bytes 10-19/100'); expect((await r.arrayBuffer()).byteLength).toBe(10);
    expect(serveBody(body, 'audio/mpeg', 'bytes=-5').headers.get('content-range')).toBe('bytes 95-99/100');
    expect(serveBody(body, 'audio/mpeg', 'bytes=90-').headers.get('content-range')).toBe('bytes 90-99/100');
    expect(serveBody(body, 'audio/mpeg', 'bytes=500-600').status).toBe(416);
    expect(serveBody(body, 'audio/mpeg', 'bytes=5-2').status).toBe(416);
    expect(serveBody(body, 'audio/mpeg', 'garbage').status).toBe(200);
  });
});

describe('annual plan mapping', () => {
  const env = { STRIPE_PRICE_ID: 'price_month', STRIPE_PRICE_ID_ANNUAL: 'price_year', STRIPE_SECRET_KEY: 'sk' } as unknown as NodeJS.ProcessEnv;
  const sub = (price: Record<string, unknown>) => ({ items: { data: [{ price }] } });
  test('by configured price id', () => {
    expect(intervalOfSubscription(sub({ id: 'price_year' }), env)).toBe('year');
    expect(intervalOfSubscription(sub({ id: 'price_month' }), env)).toBe('month');
  });
  test('by recurring interval when the id is unknown; null without price info', () => {
    expect(intervalOfSubscription(sub({ id: 'price_other', recurring: { interval: 'year' } }), env)).toBe('year');
    expect(intervalOfSubscription(sub({ id: 'price_other', recurring: { interval: 'month' } }), env)).toBe('month');
    expect(intervalOfSubscription(sub({ id: 'price_other' }), env)).toBeNull();
    expect(intervalOfSubscription({}, env)).toBeNull();
  });
  test('annual is offered only when its price is set AND billing works (the Stripe key, or the non-production mock checkout); interval parsing is strict', () => {
    expect(annualAvailable(env)).toBe(true);
    expect(annualAvailable({ STRIPE_PRICE_ID_ANNUAL: 'p', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(false); // production never mocks
    expect(annualAvailable({ STRIPE_PRICE_ID_ANNUAL: 'p', NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toBe(true); // demo: mock checkout can exercise the choice
    expect(annualAvailable({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toBe(false); // no annual price configured
    expect(annualAvailable({ STRIPE_SECRET_KEY: 'sk' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(parseInterval(undefined)).toBe('month'); expect(parseInterval('year')).toBe('year'); expect(parseInterval('week')).toBe('invalid'); expect(parseInterval(1)).toBe('invalid');
  });
});

describe('customer texts', () => {
  const business = { id: 'b', name: 'Cool Air', timezone: 'America/New_York', refund_policy: 'full_24h' } as unknown as Business;
  const booking = { id: 'k', customer_name: 'Ana Pérez', customer_phone: '+13055550123', service: 'AC repair', scheduled_at: '2027-03-10T15:00:00.000Z', address: '12 Main St', deposit_paid: false } as unknown as Booking;
  test('reschedule: explicit date in the business zone, both languages, one segment-safe length', () => {
    const en = rescheduleSms({ business, booking });
    expect(en).toContain('Wed, Mar 10 at 10:00 AM'); // 15:00Z is 10:00 EST (US DST starts Mar 14 2027)
    expect(rescheduleSms({ business, booking, language: 'es' })).toContain('se cambió a');
  });
  test('cancel: refundable / not refundable / no deposit', () => {
    expect(cancelSms({ business, booking })).not.toContain('deposit');
    expect(cancelSms({ business, booking, deposit: { state: 'refundable', amount_cents: 5000 } })).toContain('$50 deposit is eligible for a refund');
    expect(cancelSms({ business, booking, deposit: { state: 'not_refundable', amount_cents: 5000 } })).toContain('not refunded');
    expect(cancelSms({ business, booking, language: 'es', deposit: { state: 'refundable', amount_cents: 5000 } })).toContain('reembolsable');
    expect(cancelSms({ business, booking, deposit: { state: 'refundable', amount_cents: 5000 } })).not.toMatch(/has been refunded|was refunded/);
  });
  test('refund text says it takes days', () => { expect(refundSms({ business, amount_cents: 2500 })).toContain('5-10 business days'); });
  test('payment link carries the policy and the whole link, within one text budget', () => {
    const url = 'https://pay.example.test/pay/0f2c9d2e-1111-4222-8333-444455556666';
    const t = paymentLinkSms({ business, amount_cents: 5000, url, service: 'AC repair' });
    expect(t).toContain('refundable if you cancel 24+ hours ahead'); expect(t.endsWith(url)).toBe(true); expect(t.length).toBeLessThanOrEqual(SMS_LIMIT);
    const long = paymentLinkSms({ business: { ...business, name: 'N'.repeat(120) } as Business, amount_cents: 5000, url, service: 'x'.repeat(60) });
    expect(long.endsWith(url)).toBe(true); expect(long).not.toContain('refundable'); // the policy is dropped before the link is ever cut
    expect(smsSegments(t)).toBeLessThanOrEqual(3);
  });
});
