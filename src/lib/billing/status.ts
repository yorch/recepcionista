/**
 * Pure Stripe-subscription -> business billing mapping. No I/O.
 */
import { configEnv } from '@/lib/config';
import type { BillingStatus } from '@/lib/types';

/**
 * Stripe subscription.status -> our billing_status.
 *  trialing/active/past_due/unpaid/canceled map one-to-one.
 *  incomplete / incomplete_expired: the first payment never succeeded, nothing was ever active -> 'none'.
 *  paused (trial ended without a payment method) -> 'unpaid'. Anything unknown fails closed -> 'none'.
 */
export function mapStripeStatus(status: unknown): BillingStatus {
  switch (status) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': return 'past_due';
    case 'unpaid': return 'unpaid';
    case 'canceled': return 'canceled';
    case 'paused': return 'unpaid';
    case 'incomplete':
    case 'incomplete_expired':
    default: return 'none';
  }
}

export interface StripeSubscriptionLike {
  id?: unknown;
  status?: unknown;
  customer?: unknown;
  metadata?: unknown;
  trial_end?: unknown;
  current_period_end?: unknown;
  cancel_at_period_end?: unknown;
  cancel_at?: unknown;
  items?: { data?: Array<{ current_period_end?: unknown; price?: { id?: unknown; recurring?: { interval?: unknown } | null } | null }> } | null;
}

/**
 * The billing cadence a subscription is on, from its price: the annual price id (STRIPE_PRICE_ID_ANNUAL) or any price whose recurring
 * interval is 'year' means 'year'; the configured monthly price or a monthly interval means 'month'. Null when the subscription carries no
 * price information at all (an event without items), so a thin payload never flips the stored cadence.
 */
export function intervalOfSubscription(sub: StripeSubscriptionLike, env: NodeJS.ProcessEnv = configEnv()): 'month' | 'year' | null {
  const price = sub.items?.data?.[0]?.price;
  if (!price || typeof price !== 'object') return null;
  const id = typeof price.id === 'string' ? price.id : null;
  const annual = env.STRIPE_PRICE_ID_ANNUAL?.trim();
  if (annual && id === annual) return 'year';
  const monthly = env.STRIPE_PRICE_ID?.trim();
  if (monthly && id === monthly) return 'month';
  const interval = price.recurring?.interval;
  if (interval === 'year') return 'year';
  if (interval === 'month') return 'month';
  return null;
}

/** Stripe ids appear as a string or an expanded object with an `id`. */
export function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return null;
}

/** Unix seconds -> Date (null for anything that is not a plausible timestamp). */
export function fromUnix(v: unknown): Date | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 4_102_444_800) return null;
  return new Date(n * 1000);
}

export interface SubscriptionPatch {
  billing_status: BillingStatus;
  stripe_subscription_id: string;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
}

/** The billing columns a subscription object implies. Null when it has no usable id. */
export function subscriptionPatch(sub: StripeSubscriptionLike): SubscriptionPatch | null {
  const id = idOf(sub.id);
  if (!id) return null;
  // API versions >= 2025-03 moved current_period_end onto the subscription items.
  const periodEnd = fromUnix(sub.current_period_end) ?? fromUnix(sub.items?.data?.[0]?.current_period_end);
  return {
    billing_status: mapStripeStatus(sub.status),
    stripe_subscription_id: id,
    trial_ends_at: fromUnix(sub.trial_end),
    current_period_end: periodEnd,
    cancel_at_period_end: sub.cancel_at_period_end === true || fromUnix(sub.cancel_at) !== null,
  };
}

const TERMINAL: ReadonlySet<BillingStatus> = new Set(['none', 'canceled', 'unpaid']);

/**
 * Should an event about subscription `eventSubId` be applied to a business whose current subscription is
 * `currentSubId` (status `currentStatus`)? Same subscription: yes. A different one: only when ours is
 * over/absent AND the event's subscription is not itself terminal (a late event about an old, replaced
 * subscription must not overwrite the new one).
 */
export function acceptsSubscription(
  current: { stripe_subscription_id?: string | null; billing_status?: BillingStatus },
  eventSubId: string,
  eventStatus: BillingStatus,
): boolean {
  if (!current.stripe_subscription_id || current.stripe_subscription_id === eventSubId) return true;
  return TERMINAL.has(current.billing_status ?? 'none') && eventStatus !== 'canceled' && eventStatus !== 'none';
}
