/**
 * Dashboard bookings, deposits and plan price: the pure parts (no database).
 * Deposit amount resolution (the AI can never choose the amount), booking field validation, the public pay page's link lookup and copy,
 * the Stripe plan price reader (cache, fail-soft) and the caps shown to customers.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AI_DEPOSIT_CAP_CENTS, depositBounds, resolveDepositAmount } from '../src/lib/payments/deposit';
import { DEFAULT_DEPOSIT_POLICY, type DepositPolicy } from '../src/lib/business-config';
import { validateBookingFields, rejectionResponse, BOOKING_REJECTIONS } from '../src/lib/booking-manual';
import { isStripeBuyUrl, lookupPaymentLink, resetLinkLookupCache } from '../src/lib/payments/link-lookup';
import { fetchPlanPrice, formatPlanPrice, planCapLines, planCaps, planPriceTexts, resetPlanPriceCache } from '../src/lib/billing/price';
import { PaymentReceived } from '../src/app/pay/[id]/received';
import { PayUnavailable } from '../src/app/pay/[id]/unavailable';
import { makeT } from '../src/lib/i18n';
import { API_ERROR_SLUGS } from '../src/lib/i18n/catalog/error-keys';
import { en } from '../src/lib/i18n/en';

const policy = (p: Partial<DepositPolicy>): DepositPolicy => ({ ...DEFAULT_DEPOSIT_POLICY, ...p });
const fixed5000 = policy({ enabled: true, mode: 'fixed', fixed_cents: 5000 });
const pct25 = policy({ enabled: true, mode: 'percent', percent: 25, min_cents: 2000, max_cents: 30_000 });

describe('deposit amount resolution', () => {
  test('AI: with no policy there is no deposit, whatever amount the model asks for', () => {
    const r = resolveDepositAmount({ policy: DEFAULT_DEPOSIT_POLICY, requestedCents: 5000, priceEstimateCents: 20_000, actor: 'ai' });
    expect(r).toMatchObject({ ok: false, reason: 'disabled' });
  });
  test('AI: the amount is the policy\'s; the requested amount is ignored', () => {
    expect(resolveDepositAmount({ policy: fixed5000, requestedCents: 99_999, actor: 'ai' })).toEqual({ ok: true, cents: 5000, source: 'policy', capped: false });
    expect(resolveDepositAmount({ policy: pct25, requestedCents: 1, priceEstimateCents: 40_000, actor: 'ai' })).toMatchObject({ ok: true, cents: 10_000 });
  });
  test('AI: a percentage policy without a price estimate gives no amount; min / max clamp', () => {
    expect(resolveDepositAmount({ policy: pct25, priceEstimateCents: null, actor: 'ai' })).toMatchObject({ ok: false, reason: 'no_amount' });
    expect(resolveDepositAmount({ policy: pct25, priceEstimateCents: 4000, actor: 'ai' })).toMatchObject({ ok: true, cents: 2000 }); // 25% = 1000 -> min 2000
    expect(resolveDepositAmount({ policy: pct25, priceEstimateCents: 400_000, actor: 'ai' })).toMatchObject({ ok: true, cents: 30_000 }); // max
  });
  test('AI: the call script cap still applies on top of a bigger policy', () => {
    const big = policy({ enabled: true, mode: 'fixed', fixed_cents: 80_000 });
    expect(resolveDepositAmount({ policy: big, actor: 'ai' })).toEqual({ ok: true, cents: AI_DEPOSIT_CAP_CENTS, source: 'policy', capped: true });
  });
  test('owner: an explicit amount must be a whole number inside the policy range (platform limits without a policy)', () => {
    expect(depositBounds(DEFAULT_DEPOSIT_POLICY)).toEqual({ min: 100, max: 100_000 });
    expect(depositBounds(pct25)).toEqual({ min: 2000, max: 30_000 });
    expect(resolveDepositAmount({ policy: DEFAULT_DEPOSIT_POLICY, requestedCents: 100, actor: 'owner' })).toMatchObject({ ok: true, cents: 100, source: 'owner' });
    expect(resolveDepositAmount({ policy: DEFAULT_DEPOSIT_POLICY, requestedCents: 99, actor: 'owner' })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(resolveDepositAmount({ policy: DEFAULT_DEPOSIT_POLICY, requestedCents: 100_001, actor: 'owner' })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(resolveDepositAmount({ policy: pct25, requestedCents: 1999, actor: 'owner' })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    expect(resolveDepositAmount({ policy: pct25, requestedCents: 30_001, actor: 'owner' })).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    for (const bad of [12.5, '5000', NaN, Infinity, {}, [], true]) expect(resolveDepositAmount({ policy: fixed5000, requestedCents: bad, actor: 'owner' })).toMatchObject({ ok: false, reason: 'invalid_amount' });
  });
  test('owner: no amount = the stored one (a resend), else the computed one, else a request to type one', () => {
    expect(resolveDepositAmount({ policy: fixed5000, storedCents: 7500, actor: 'owner' })).toMatchObject({ ok: true, cents: 7500, source: 'stored' });
    expect(resolveDepositAmount({ policy: fixed5000, storedCents: null, actor: 'owner' })).toMatchObject({ ok: true, cents: 5000, source: 'policy' });
    expect(resolveDepositAmount({ policy: pct25, priceEstimateCents: null, actor: 'owner' })).toMatchObject({ ok: false, reason: 'no_amount' });
    expect(resolveDepositAmount({ policy: DEFAULT_DEPOSIT_POLICY, actor: 'owner' })).toMatchObject({ ok: false, reason: 'disabled' });
  });
});

describe('booking field validation', () => {
  const biz = { phone_e164: '+13055550142' };
  test('create needs a name and a service; a phone is optional but must be real; price is whole cents', () => {
    expect(validateBookingFields({ customer_name: ' Ana  Pérez ', service: 'AC repair', customer_phone: '(305) 555-0199', price_estimate: 15_000 }, biz, false))
      .toEqual({ ok: true, value: { customer_name: 'Ana Pérez', service: 'AC repair', customer_phone: '+13055550199', price_estimate: 15_000 } });
    expect(validateBookingFields({ customer_name: 'Ana', service: 'x', customer_phone: '' }, biz, false)).toMatchObject({ ok: true, value: { customer_phone: '' } });
    for (const bad of [{ customer_name: '', service: 'x' }, { customer_name: 'a', service: '  ' }, { customer_name: 'a', service: 'x', customer_phone: 'abc' }, { customer_name: 'a', service: 'x', customer_phone: 5 },
      { customer_name: 'a', service: 'x', price_estimate: 1.5 }, { customer_name: 'a', service: 'x', price_estimate: -1 }, { customer_name: 'a', service: 'x', price_estimate: 99_999_999_999 },
      { customer_name: 'x'.repeat(121), service: 'x' }, { customer_name: 'a', service: 'x', address: 'y'.repeat(201) }, { customer_name: 5, service: 'x' }]) {
      expect(validateBookingFields(bad as never, biz, false).ok).toBe(false);
    }
  });
  test('edit validates only the keys present; control characters become spaces; null clears the price / address', () => {
    expect(validateBookingFields({ address: 'Line 1\nLine 2' }, biz, true)).toEqual({ ok: true, value: { address: 'Line 1 Line 2' } });
    expect(validateBookingFields({ price_estimate: null, address: null }, biz, true)).toEqual({ ok: true, value: { price_estimate: null, address: null } });
    expect(validateBookingFields({}, biz, true)).toEqual({ ok: true, value: {} });
    expect(validateBookingFields({ service: '' }, biz, true).ok).toBe(false);
  });
  test('every rejection maps to an HTTP status and an owner-readable sentence', () => {
    for (const [k, v] of Object.entries(BOOKING_REJECTIONS)) { expect(v.status).toBeGreaterThanOrEqual(400); expect(v.error.length).toBeGreaterThan(5); expect(rejectionResponse(k)).toEqual(v); }
    expect(rejectionResponse('made_up').status).toBe(422);
    expect(rejectionResponse('slot_taken').status).toBe(409);
  });
  test('every error sentence the new routes can return is localized (mapped to a catalog message)', () => {
    for (const v of Object.values(BOOKING_REJECTIONS)) {
      if (['booking not found', 'business not found'].includes(v.error)) continue;
      const slug = API_ERROR_SLUGS[v.error];
      expect([v.error, slug && (`err.${slug}` in en)]).toEqual([v.error, true]);
    }
  });
});

describe('Stripe payment-link lookup for /pay/<bookingId>', () => {
  beforeEach(() => resetLinkLookupCache());
  const link = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'plink_abc123456', active: true, url: 'https://buy.stripe.com/test_abc', ...over });
  const fake = (res: () => Response | Promise<Response>) => { const calls: string[] = []; return { calls, impl: (async (u: unknown) => { calls.push(String(u)); return res(); }) as typeof fetch }; };

  test('only an https buy.stripe.com url is ever trusted', () => {
    expect(isStripeBuyUrl('https://buy.stripe.com/test_abc')).toBe(true);
    for (const bad of ['http://buy.stripe.com/x', 'https://evil.example/x', 'https://buy.stripe.com.evil.example/x', 'https://user:pw@buy.stripe.com/x', 'javascript:alert(1)', '', null, 5]) expect(isStripeBuyUrl(bad)).toBe(false);
  });
  test('active link -> its url; inactive / 404 -> inactive; off-host url -> inactive; no key or bad id -> unknown with no call', async () => {
    const ok = fake(() => new Response(link()));
    expect(await lookupPaymentLink('plink_abc123456', { fetchImpl: ok.impl, secretKey: 'sk_test_x' })).toEqual({ state: 'active', url: 'https://buy.stripe.com/test_abc' });
    expect(ok.calls[0]).toBe('https://api.stripe.com/v1/payment_links/plink_abc123456');
    resetLinkLookupCache();
    expect(await lookupPaymentLink('plink_abc123456', { fetchImpl: fake(() => new Response(link({ active: false }))).impl, secretKey: 'sk' })).toEqual({ state: 'inactive' });
    resetLinkLookupCache();
    expect(await lookupPaymentLink('plink_abc123456', { fetchImpl: fake(() => new Response('{}', { status: 404 })).impl, secretKey: 'sk' })).toEqual({ state: 'inactive' });
    resetLinkLookupCache();
    expect(await lookupPaymentLink('plink_abc123456', { fetchImpl: fake(() => new Response(link({ url: 'https://evil.example/pay' }))).impl, secretKey: 'sk' })).toEqual({ state: 'inactive' });
    const none = fake(() => new Response(link()));
    expect(await lookupPaymentLink('plink_abc123456', { fetchImpl: none.impl, secretKey: '' })).toEqual({ state: 'unknown' });
    expect(await lookupPaymentLink('../etc', { fetchImpl: none.impl, secretKey: 'sk' })).toEqual({ state: 'unknown' });
    expect(await lookupPaymentLink(null, { fetchImpl: none.impl, secretKey: 'sk' })).toEqual({ state: 'unknown' });
    expect(none.calls).toEqual([]);
  });
  test('answers are cached briefly; a Stripe failure is unknown (and not retried at once); the per-minute budget is bounded', async () => {
    const ok = fake(() => new Response(link()));
    await lookupPaymentLink('plink_abc123456', { fetchImpl: ok.impl, secretKey: 'sk', now: 1_000 });
    await lookupPaymentLink('plink_abc123456', { fetchImpl: ok.impl, secretKey: 'sk', now: 30_000 });
    expect(ok.calls.length).toBe(1);
    await lookupPaymentLink('plink_abc123456', { fetchImpl: ok.impl, secretKey: 'sk', now: 70_000 });
    expect(ok.calls.length).toBe(2);
    resetLinkLookupCache();
    const down = fake(() => { throw new Error('boom'); });
    expect(await lookupPaymentLink('plink_zzzzzz1234', { fetchImpl: down.impl, secretKey: 'sk', now: 1 })).toEqual({ state: 'unknown' });
    expect(await lookupPaymentLink('plink_zzzzzz1234', { fetchImpl: down.impl, secretKey: 'sk', now: 5_000 })).toEqual({ state: 'unknown' });
    expect(down.calls.length).toBe(1);
    resetLinkLookupCache();
    const spam = fake(() => new Response(link()));
    for (let i = 0; i < 80; i++) await lookupPaymentLink(`plink_spam${String(i).padStart(6, '0')}`, { fetchImpl: spam.impl, secretKey: 'sk', now: 10 });
    expect(spam.calls.length).toBe(60);
  });
});

describe('public pay page copy', () => {
  test('the receipt never claims a text and shows no card', () => {
    for (const locale of ['en', 'es'] as const) {
      const html = renderToStaticMarkup(createElement(PaymentReceived, { reference: 'bk1', amountCents: 5000, label: 'AC repair deposit', businessName: 'Cool Air', t: makeT(locale), locale }));
      expect(html).not.toMatch(/texted|text message|mensaje de texto|tech|técnico|••••|----/i);
      expect(html).toContain('$50.00');
    }
    expect(renderToStaticMarkup(createElement(PaymentReceived, { reference: 'bk1', amountCents: 5000, label: 'x', businessName: 'Cool Air', t: makeT('en'), locale: 'en' }))).toContain('your appointment is confirmed');
  });
  test('the unavailable page is honest, has no form and offers to call', () => {
    const html = renderToStaticMarkup(createElement(PayUnavailable, { businessName: 'Cool Air', businessPhone: '+13055550142', t: makeT('en') }));
    expect(html).toContain('not available');
    expect(html).toContain('Cool Air');
    expect(html).toContain('tel:+13055550142');
    expect(html).not.toMatch(/<input|<form|card number/i);
    expect(renderToStaticMarkup(createElement(PayUnavailable, { businessName: 'Cool Air', t: makeT('es') }))).toContain('no está disponible');
  });
});

describe('plan price from Stripe', () => {
  beforeEach(() => resetPlanPriceCache());
  const price = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'price_abc123456', unit_amount: 9900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, ...over });
  const fake = (res: () => Response) => { const calls: string[] = []; return { calls, impl: (async (u: unknown) => { calls.push(String(u)); return res(); }) as typeof fetch }; };

  test('reads amount / currency / interval, caches it, formats per language', async () => {
    const f = fake(() => new Response(price()));
    const p = await fetchPlanPrice('price_abc123456', { fetchImpl: f.impl, secretKey: 'sk', now: 0 });
    expect(p).toEqual({ amount_cents: 9900, currency: 'USD', interval: 'month', interval_count: 1 });
    await fetchPlanPrice('price_abc123456', { fetchImpl: f.impl, secretKey: 'sk', now: 60_000 });
    expect(f.calls.length).toBe(1);
    expect(formatPlanPrice(p!, 'en')).toBe('$99 / month');
    expect(formatPlanPrice(p!, 'es')).toContain('/ mes');
    expect(formatPlanPrice({ ...p!, amount_cents: 99_050, interval: 'year' }, 'en')).toBe('$990.50 / year');
    expect(formatPlanPrice({ ...p!, interval_count: 3 }, 'en')).toBe('$99 every 3 months');
  });
  test('fail-soft: no key, a bad id, an error, a non-recurring or odd price all give null (the pages fall back to the display text)', async () => {
    const f = fake(() => new Response(price()));
    expect(await fetchPlanPrice('price_abc123456', { fetchImpl: f.impl, secretKey: '' })).toBeNull();
    expect(await fetchPlanPrice('prod_nope', { fetchImpl: f.impl, secretKey: 'sk' })).toBeNull();
    expect(await fetchPlanPrice(null, { fetchImpl: f.impl, secretKey: 'sk' })).toBeNull();
    expect(f.calls).toEqual([]);
    expect(await fetchPlanPrice('price_abc123456', { fetchImpl: fake(() => new Response('{}', { status: 500 })).impl, secretKey: 'sk', now: 0 })).toBeNull();
    resetPlanPriceCache();
    expect(await fetchPlanPrice('price_abc123456', { fetchImpl: fake(() => new Response(price({ recurring: null }))).impl, secretKey: 'sk', now: 0 })).toBeNull();
    resetPlanPriceCache();
    expect(await fetchPlanPrice('price_abc123456', { fetchImpl: fake(() => new Response(price({ unit_amount: null }))).impl, secretKey: 'sk', now: 0 })).toBeNull();
    resetPlanPriceCache();
    expect(await fetchPlanPrice('price_abc123456', { fetchImpl: fake(() => { throw new Error('down'); }).impl, secretKey: 'sk', now: 0 })).toBeNull();
    const t = await planPriceTexts('en', { monthly: 'Simple pricing', annual: null }, { NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(t).toEqual({ monthly: 'Simple pricing', annual: null, fromStripe: false });
  });
  test('the caps shown are the caps the metering enforces (env aware), the trial included', () => {
    const env = { PLAN_SMS_CAP: '800', PLAN_CALL_MINUTES_CAP: '400', FORWARD_MINUTES_CAP: '700', TRIAL_SMS_CAP: '20', TRIAL_CALL_MINUTES_CAP: '10', BILLING_TRIAL_DAYS: '14' } as unknown as NodeJS.ProcessEnv;
    const caps = planCaps(env);
    expect(caps).toMatchObject({ sms: 800, callMinutes: 400, forwardMinutes: 700, trial: { days: 14, sms: 20, callMinutes: 10 } });
    const lines = planCapLines('en', caps);
    expect(lines.join('|')).toContain('400 minutes of AI calls');
    expect(lines.join('|')).toContain('800 text segments');
    expect(lines.join('|')).toContain('14 days');
    expect(lines.join('|')).toContain('20 text segments');
    expect(planCapLines('es', caps).join('|')).toContain('14 días');
    expect(planCapLines('en', planCaps({ BILLING_TRIAL_DAYS: '0' } as unknown as NodeJS.ProcessEnv)).length).toBe(3);
  });
});
