/**
 * The plan's real price and caps, for the pages that show them (billing, onboarding plan step, landing).
 *
 * Price: read from Stripe (GET /v1/prices/{STRIPE_PRICE_ID | STRIPE_PRICE_ID_ANNUAL}), cached in memory with a TTL (10 min; a failure is
 * remembered for 60 s so a Stripe outage costs one call a minute, not one per page view) and FAIL-SOFT: when Stripe is not configured or does not
 * answer, the pages fall back to the operator's display text (NEXT_PUBLIC_PLAN_PRICE_DISPLAY*), then to the generic default. A price this module
 * shows is the price Stripe will charge; the free text can only ever be a fallback. Server only (the key never reaches the browser).
 * Caps: the same functions the metering uses (smsCapFor / callMinutesCapFor / ...), so the numbers shown are the numbers enforced.
 */
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
import { intlTag } from '@/lib/i18n/core';
import { annualPriceId, trialDays } from '@/lib/providers/stripe-billing';
import { callMinutesCapFor, forwardMinutesCapFor, smsCapFor, voicemailMinutesCap } from '@/lib/db/usage';
import { logger } from '@/lib/log';

const log = logger('billing.price');

export interface PlanPriceInfo {
  amount_cents: number;
  currency: string;
  interval: 'month' | 'year';
  interval_count: number;
}

const TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
const TIMEOUT_MS = 4_000;
const cache = new Map<string, { at: number; value: PlanPriceInfo | null }>();

/** Test seam. */
export function resetPlanPriceCache(): void { cache.clear(); }

const isId = (id: string | null | undefined): id is string => typeof id === 'string' && /^price_[A-Za-z0-9]{6,100}$/.test(id);

/** One Stripe price, cached; null when Stripe is not configured, the id is not a price id, the price is not recurring monthly / yearly, or Stripe failed. */
export async function fetchPlanPrice(priceId: string | null | undefined, opts: { fetchImpl?: typeof fetch; now?: number; secretKey?: string } = {}): Promise<PlanPriceInfo | null> {
  const key = (opts.secretKey ?? process.env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key || !isId(priceId)) return null;
  const now = opts.now ?? Date.now();
  const hit = cache.get(priceId);
  if (hit && now - hit.at < (hit.value ? TTL_MS : FAIL_TTL_MS)) return hit.value;
  let value: PlanPriceInfo | null = null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store',
    });
    if (res.ok) {
      const j = (await res.json()) as { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null };
      const interval = j.recurring?.interval;
      const count = typeof j.recurring?.interval_count === 'number' ? j.recurring.interval_count : 1;
      if (typeof j.unit_amount === 'number' && Number.isInteger(j.unit_amount) && j.unit_amount >= 0 && typeof j.currency === 'string' && /^[a-z]{3}$/i.test(j.currency)
        && (interval === 'month' || interval === 'year') && Number.isInteger(count) && count >= 1) {
        value = { amount_cents: j.unit_amount, currency: j.currency.toUpperCase(), interval, interval_count: count };
      } else log.warn('price.unusable', { id: priceId });
    } else log.warn('price.failed', { status: res.status });
  } catch (err) {
    log.warn('price.error', { err });
  }
  cache.set(priceId, { at: now, value });
  return value;
}

/** "$99 / month", "$990 / year", "$30 every 3 months" (Intl currency; whole amounts without decimals). Pure. */
export function formatPlanPrice(p: PlanPriceInfo, locale: Locale = 'en'): string {
  const whole = p.amount_cents % 100 === 0;
  const amount = new Intl.NumberFormat(intlTag(locale), { style: 'currency', currency: p.currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(p.amount_cents / 100);
  const t = makeT(locale);
  if (p.interval_count === 1) return t(p.interval === 'month' ? 'plan.price.month' : 'plan.price.year', { amount });
  return t(p.interval === 'month' ? 'plan.price.months' : 'plan.price.years', { amount, count: p.interval_count });
}

export interface PlanPrices { monthly: PlanPriceInfo | null; annual: PlanPriceInfo | null }

export async function planPrices(env: NodeJS.ProcessEnv = process.env, opts: { fetchImpl?: typeof fetch } = {}): Promise<PlanPrices> {
  const [monthly, annual] = await Promise.all([
    fetchPlanPrice(env.STRIPE_PRICE_ID?.trim(), { ...opts, secretKey: env.STRIPE_SECRET_KEY }),
    fetchPlanPrice(annualPriceId(env), { ...opts, secretKey: env.STRIPE_SECRET_KEY }),
  ]);
  return { monthly, annual };
}

/** The text to show for the monthly / annual price: Stripe's real price when it can be read, else the operator's display text (callers pass it). */
export async function planPriceTexts(locale: Locale, fallback: { monthly: string; annual: string | null }, env: NodeJS.ProcessEnv = process.env): Promise<{ monthly: string; annual: string | null; fromStripe: boolean }> {
  const p = await planPrices(env);
  return {
    monthly: p.monthly ? formatPlanPrice(p.monthly, locale) : fallback.monthly,
    annual: p.annual ? formatPlanPrice(p.annual, locale) : fallback.annual,
    fromStripe: Boolean(p.monthly || p.annual),
  };
}

export interface PlanCaps {
  sms: number; callMinutes: number; forwardMinutes: number; voicemailMinutes: number;
  trial: { days: number; sms: number; callMinutes: number; forwardMinutes: number };
}

/** The caps the metering enforces (plan, and while trialing), read from the same functions. */
export function planCaps(env: NodeJS.ProcessEnv = process.env): PlanCaps {
  return {
    sms: smsCapFor({ billing_status: 'active' }, env),
    callMinutes: callMinutesCapFor({ billing_status: 'active' }, env),
    forwardMinutes: forwardMinutesCapFor({ billing_status: 'active' }, env),
    voicemailMinutes: voicemailMinutesCap(env),
    trial: {
      days: trialDays(env),
      sms: smsCapFor({ billing_status: 'trialing' }, env),
      callMinutes: callMinutesCapFor({ billing_status: 'trialing' }, env),
      forwardMinutes: forwardMinutesCapFor({ billing_status: 'trialing' }, env),
    },
  };
}

/** The "what's included" lines about volume, from the real caps (plain text in the caller's language). */
export function planCapLines(locale: Locale, caps: PlanCaps = planCaps()): string[] {
  const t = makeT(locale);
  const n = (v: number) => new Intl.NumberFormat(intlTag(locale)).format(v);
  const lines = [
    t('plan.caps.ai', { minutes: n(caps.callMinutes) }),
    t('plan.caps.sms', { sms: n(caps.sms) }),
    t('plan.caps.forward', { minutes: n(caps.forwardMinutes) }),
  ];
  if (caps.trial.days > 0) lines.push(t('plan.caps.trial', { days: caps.trial.days, sms: n(caps.trial.sms), minutes: n(caps.trial.callMinutes) }));
  return lines;
}
