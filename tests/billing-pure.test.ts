/**
 * Pure billing logic: signature verification, Stripe status mapping, banner state, provider configuration,
 * email rendering. No database, no network.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { verifyStripeSignature } from '../src/lib/billing/signature';
import { acceptsSubscription, fromUnix, idOf, mapStripeStatus, subscriptionPatch } from '../src/lib/billing/status';
import { bannerFor, daysLeft } from '../src/lib/billing/banner-state';
import { renderBillingEmail } from '../src/lib/billing/emails';
import { assertProvisioningAllowed, BillingRequiredError } from '../src/lib/billing/gate';
import { billingMode, BillingConfigError, trialDays, createCheckoutSession, checkoutReturnPath } from '../src/lib/providers/stripe-billing';
import { AuthError, requireVerifiedEmail, type Principal } from '../src/lib/session';
import type { User } from '../src/lib/types';

const SECRET = 'whsec_pure_test';
const sign = (payload: string, t: number, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
const NOW = 1_800_000_000_000;

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  const t = NOW / 1000;
  const v = (h: string) => verifyStripeSignature(body, h, SECRET, { now: NOW });

  test('accepts a valid signature', async () => {
    expect((await v(`t=${t},v1=${sign(body, t)}`)).ok).toBe(true);
  });
  test('accepts when any of several v1 values matches (rotation), in any position', async () => {
    expect((await v(`t=${t},v1=${'0'.repeat(64)},v1=${sign(body, t)}`)).ok).toBe(true);
    expect((await v(`v1=${sign(body, t)},t=${t},v1=${'f'.repeat(64)}`)).ok).toBe(true);
  });
  test('ignores v0 and unknown schemes', async () => {
    expect((await v(`t=${t},v0=${sign(body, t)}`)).ok).toBe(false);
    expect((await v(`t=${t},v1=${sign(body, t)},v0=junk,foo=bar`)).ok).toBe(true);
  });
  test('rejects wrong secret, tampered body, missing/malformed header', async () => {
    expect((await v(`t=${t},v1=${sign(body, t, 'other')}`)).ok).toBe(false);
    expect((await verifyStripeSignature(body + ' ', `t=${t},v1=${sign(body, t)}`, SECRET, { now: NOW })).ok).toBe(false);
    expect((await verifyStripeSignature(body, null, SECRET, { now: NOW })).ok).toBe(false);
    expect((await v('garbage')).ok).toBe(false);
    expect((await v(`t=abc,v1=${sign(body, t)}`)).ok).toBe(false);
    expect((await v(`t=${t}`)).ok).toBe(false);
    expect((await verifyStripeSignature(body, `t=${t},v1=${sign(body, t)}`, '', { now: NOW })).ok).toBe(false);
  });
  test('timestamp tolerance both directions', async () => {
    const old = t - 301;
    const future = t + 301;
    expect(await v(`t=${old},v1=${sign(body, old)}`)).toEqual({ ok: false, error: 'timestamp outside tolerance' });
    expect((await v(`t=${future},v1=${sign(body, future)}`)).ok).toBe(false);
    const edge = t - 299;
    expect((await v(`t=${edge},v1=${sign(body, edge)}`)).ok).toBe(true);
  });
  test('uppercase hex is accepted', async () => {
    expect((await v(`t=${t},v1=${sign(body, t).toUpperCase()}`)).ok).toBe(true);
  });
});

describe('status mapping', () => {
  const cases: Array<[unknown, string]> = [
    ['trialing', 'trialing'], ['active', 'active'], ['past_due', 'past_due'], ['unpaid', 'unpaid'], ['canceled', 'canceled'],
    ['incomplete', 'none'], ['incomplete_expired', 'none'], ['paused', 'unpaid'], ['something_new', 'none'], [undefined, 'none'],
  ];
  for (const [from, to] of cases) test(`${String(from)} -> ${to}`, () => expect(mapStripeStatus(from)).toBe(to as never));

  test('subscriptionPatch reads classic and item-level period end, trial end and cancel flags', () => {
    const p = subscriptionPatch({ id: 'sub_1', status: 'trialing', trial_end: 1_900_000_000, current_period_end: 1_900_000_000, cancel_at_period_end: true });
    expect(p).toMatchObject({ billing_status: 'trialing', stripe_subscription_id: 'sub_1', cancel_at_period_end: true });
    expect(p?.trial_ends_at?.getTime()).toBe(1_900_000_000_000);
    const q = subscriptionPatch({ id: 'sub_2', status: 'active', items: { data: [{ current_period_end: 1_950_000_000 }] }, cancel_at: 1_950_000_000 });
    expect(q?.current_period_end?.getTime()).toBe(1_950_000_000_000);
    expect(q?.cancel_at_period_end).toBe(true);
    expect(q?.trial_ends_at).toBeNull();
    expect(subscriptionPatch({ status: 'active' })).toBeNull();
  });

  test('helpers', () => {
    expect(idOf('cus_1')).toBe('cus_1');
    expect(idOf({ id: 'cus_2' })).toBe('cus_2');
    expect(idOf({})).toBeNull();
    expect(fromUnix('x')).toBeNull();
    expect(fromUnix(0)).toBeNull();
  });

  test('a late event about an old subscription does not replace the current one', () => {
    const cur = { stripe_subscription_id: 'sub_new', billing_status: 'active' as const };
    expect(acceptsSubscription(cur, 'sub_new', 'canceled')).toBe(true);
    expect(acceptsSubscription(cur, 'sub_old', 'canceled')).toBe(false);
    expect(acceptsSubscription(cur, 'sub_old', 'active')).toBe(false);
    // after cancellation a NEW live subscription is accepted, an old canceled one is not
    const over = { stripe_subscription_id: 'sub_old', billing_status: 'canceled' as const };
    expect(acceptsSubscription(over, 'sub_new', 'trialing')).toBe(true);
    expect(acceptsSubscription(over, 'sub_older', 'canceled')).toBe(false);
    expect(acceptsSubscription({}, 'sub_x', 'active')).toBe(true);
  });
});

describe('bannerFor', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const day = 86_400_000;
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const enforced = { BILLING_ENFORCED: 'true' } as unknown as NodeJS.ProcessEnv;
  const off = {} as unknown as NodeJS.ProcessEnv;
  const base = { past_due_since: null, trial_ends_at: null, cancel_at_period_end: false, current_period_end: null };

  test('silent for legacy tenants when billing is not enforced', () => {
    expect(bannerFor({ ...base, billing_status: 'none' }, null, true, now, off)).toBeNull();
  });
  test('none/canceled/unpaid show a CTA for owners and none for staff', () => {
    const none = bannerFor({ ...base, billing_status: 'none' }, null, true, now, enforced);
    expect(none?.kind).toBe('none');
    expect(none?.cta).toBe('Start free trial');
    expect(bannerFor({ ...base, billing_status: 'none' }, null, false, now, enforced)?.cta).toBeNull();
    expect(bannerFor({ ...base, billing_status: 'canceled' }, null, true, now, enforced)?.kind).toBe('canceled');
    expect(bannerFor({ ...base, billing_status: 'unpaid' }, null, true, now, enforced)?.kind).toBe('unpaid');
  });
  test('trial ending soon only within 3 days', () => {
    const soon = bannerFor({ ...base, billing_status: 'trialing', trial_ends_at: iso(2 * day - 1000) }, null, true, now, enforced);
    expect(soon?.kind).toBe('trial_ending');
    expect(soon?.title).toBe('Your trial ends in 2 days');
    expect(bannerFor({ ...base, billing_status: 'trialing', trial_ends_at: iso(5 * day) }, null, true, now, enforced)).toBeNull();
    expect(bannerFor({ ...base, billing_status: 'trialing', trial_ends_at: iso(1000) }, null, true, now, enforced)?.title).toBe('Your trial ends in 1 day');
    expect(bannerFor({ ...base, billing_status: 'trialing', trial_ends_at: iso(-1000) }, null, true, now, enforced)?.title).toBe('Your trial ends today');
  });
  test('past due shows grace remaining, then a paused message', () => {
    const within = bannerFor({ ...base, billing_status: 'past_due', past_due_since: iso(-2 * day) }, null, true, now, enforced);
    expect(within?.kind).toBe('past_due');
    expect(within?.tone).toBe('warning');
    expect(within?.message).toContain('3 more days');
    const after = bannerFor({ ...base, billing_status: 'past_due', past_due_since: iso(-9 * day) }, null, true, now, enforced);
    expect(after?.tone).toBe('danger');
    expect(after?.message).toContain('paused');
  });
  test('over cap for active plans', () => {
    const usage = { sms_count: 500, call_seconds: 0, sms_cap: 500, call_minutes_cap: 300 };
    expect(bannerFor({ ...base, billing_status: 'active' }, usage, true, now, enforced)?.kind).toBe('over_cap');
    expect(bannerFor({ ...base, billing_status: 'active' }, { ...usage, sms_count: 10 }, true, now, enforced)).toBeNull();
    expect(bannerFor({ ...base, billing_status: 'active' }, { ...usage, sms_count: 0, call_seconds: 300 * 60 }, true, now, enforced)?.kind).toBe('over_cap');
  });
  test('daysLeft rounds up and never goes negative', () => {
    expect(daysLeft(iso(day + 1), now)).toBe(2);
    expect(daysLeft(iso(-day), now)).toBe(0);
    expect(daysLeft(null, now)).toBeNull();
  });
});

describe('billing emails', () => {
  test('render each kind with the link and escape the business name in HTML', () => {
    for (const kind of ['payment_failed', 'trial_will_end', 'canceled'] as const) {
      const m = renderBillingEmail(kind, { businessName: '<b>Acme</b>', link: 'https://app.test/dashboard/billing', trialEnd: new Date('2026-06-12T00:00:00Z') });
      expect(m.text).toContain('https://app.test/dashboard/billing');
      expect(m.html).not.toContain('<b>Acme</b>');
      expect(m.subject).not.toMatch(/[\r\n]/);
    }
    expect(renderBillingEmail('trial_will_end', { businessName: 'A', link: 'x', trialEnd: new Date('2026-06-12T00:00:00Z') }).text).toContain('2026-06-12');
  });
});

describe('gates', () => {
  const user = (verified: boolean): Principal => ({
    kind: 'user', business_id: 'b1', role: 'owner', email_verified: verified,
    user: { id: 'u1', email: 'o@x.test', business_id: 'b1', role: 'owner', created_at: '', disabled_at: null, email_verified_at: verified ? '2026-01-01T00:00:00Z' : null, phone: null, totp_enabled: false } as User,
  });
  const admin: Principal = { kind: 'admin', via: 'token', email_verified: true };
  const none = { billing_status: 'none' as const, past_due_since: null };
  const active = { billing_status: 'active' as const, past_due_since: null };

  test('provisioning: refused for a planless tenant only when enforced; admin bypasses', () => {
    const on = { BILLING_ENFORCED: 'true' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertProvisioningAllowed(user(true), none, new Date(), on)).toThrow(BillingRequiredError);
    expect(() => assertProvisioningAllowed(user(true), active, new Date(), on)).not.toThrow();
    expect(() => assertProvisioningAllowed(admin, none, new Date(), on)).not.toThrow();
    expect(() => assertProvisioningAllowed(user(true), none, new Date(), {} as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
  test('checkout needs a verified email (admins exempt)', () => {
    expect(() => requireVerifiedEmail(user(true))).not.toThrow();
    expect(() => requireVerifiedEmail(admin)).not.toThrow();
    expect(() => requireVerifiedEmail(user(false))).toThrow(AuthError);
  });
});

describe('stripe-billing provider config', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  afterEach(() => { /* env is passed explicitly */ });

  test('mock mode only outside production without a key', () => {
    expect(billingMode(env({ NODE_ENV: 'development' }))).toBe('mock');
    expect(() => billingMode(env({ NODE_ENV: 'production' }))).toThrow(BillingConfigError);
  });
  test('a key without a price is a config error in every environment', () => {
    expect(() => billingMode(env({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x' }))).toThrow(BillingConfigError);
    expect(billingMode(env({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_PRICE_ID: 'price_1' }))).toBe('live');
  });
  test('trial days: default 7, bounded, invalid falls back', () => {
    expect(trialDays(env({}))).toBe(7);
    expect(trialDays(env({ BILLING_TRIAL_DAYS: '14' }))).toBe(14);
    expect(trialDays(env({ BILLING_TRIAL_DAYS: '0' }))).toBe(0);
    expect(trialDays(env({ BILLING_TRIAL_DAYS: '-3' }))).toBe(7);
    expect(trialDays(env({ BILLING_TRIAL_DAYS: '999' }))).toBe(7);
    expect(trialDays(env({ BILLING_TRIAL_DAYS: 'abc' }))).toBe(7);
  });
  test('checkout session request carries trial, card collection, metadata and return urls', async () => {
    const real = globalThis.fetch;
    let sent: { url: string; body: URLSearchParams; auth: string } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: init.body as URLSearchParams, auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const saved = { ...process.env };
    try {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
      const e = env({ STRIPE_PRICE_ID: 'price_9', PUBLIC_BASE_URL: 'https://app.example.test/', BILLING_TRIAL_DAYS: '10', NODE_ENV: 'production' });
      const out = await createCheckoutSession({ business: { id: 'biz_1', name: 'Acme' }, customerId: 'cus_1', withTrial: true }, e);
      expect(out.url).toBe('https://checkout.stripe.test/c/1');
      const f = sent!.body;
      expect(sent!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(f.get('mode')).toBe('subscription');
      expect(f.get('line_items[0][price]')).toBe('price_9');
      expect(f.get('payment_method_collection')).toBe('always');
      expect(f.get('subscription_data[trial_period_days]')).toBe('10');
      expect(f.get('subscription_data[metadata][business_id]')).toBe('biz_1');
      expect(f.get('client_reference_id')).toBe('biz_1');
      expect(f.get('customer')).toBe('cus_1');
      expect(f.get('success_url')).toBe('https://app.example.test/dashboard/billing?checkout=success');
      expect(f.get('cancel_url')).toBe('https://app.example.test/dashboard/billing?checkout=cancel');
      expect(f.get('allow_promotion_codes')).toBeNull();
      await createCheckoutSession({ business: { id: 'biz_1', name: 'Acme' }, customerId: 'cus_1', withTrial: false }, e);
      expect(sent!.body.get('subscription_data[trial_period_days]')).toBeNull();
    } finally {
      globalThis.fetch = real;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('checkout return_path', () => {
  test('allowlist: exact same-origin paths only, anything else falls back to the billing page', () => {
    expect(checkoutReturnPath('/onboarding')).toBe('/onboarding');
    expect(checkoutReturnPath('/dashboard/billing')).toBe('/dashboard/billing');
    for (const bad of [undefined, null, 5, '', '/dashboard', '/onboarding?x=1', '/onboarding/', 'https://evil.test/onboarding', '//evil.test', '/\\evil.test', '/onboarding#a', '/onboarding/../api']) {
      expect(checkoutReturnPath(bad)).toBe('/dashboard/billing');
    }
  });

  test('success/cancel URLs honour the validated path', async () => {
    const real = globalThis.fetch;
    const forms: URLSearchParams[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      forms.push(init.body as URLSearchParams);
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.test/1' }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x', PUBLIC_BASE_URL: 'https://app.test' } as unknown as NodeJS.ProcessEnv;
      const b = { id: 'b1', name: 'B' };
      await createCheckoutSession({ business: b, customerId: 'cus_1', withTrial: true, returnPath: '/onboarding' }, env);
      await createCheckoutSession({ business: b, customerId: 'cus_1', withTrial: true }, env);
      expect(forms[0].get('success_url')).toBe('https://app.test/onboarding?checkout=success');
      expect(forms[0].get('cancel_url')).toBe('https://app.test/onboarding?checkout=cancel');
      expect(forms[1].get('success_url')).toBe('https://app.test/dashboard/billing?checkout=success');
    } finally {
      globalThis.fetch = real;
    }
  });
});
