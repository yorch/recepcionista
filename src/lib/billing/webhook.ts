/**
 * Stripe billing event handling (after signature verification and event dedupe, which the route does).
 * Node runtime only. Every handler is idempotent: replaying an event converges to the same state.
 *
 * Resolving the business is the security-sensitive part. Metadata (business_id) is ours, but we never trust it
 * alone: a business that already has a different stripe_customer_id refuses the event, and a customer id that
 * belongs to one business cannot be claimed by another through metadata.
 */
import { configEnv } from '@/lib/config';
import { getBusiness, getBusinessByStripeCustomer, recordAudit, setBillingState, updateBusiness } from '@/lib/db';
import { endTrialNow, planName, retrieveCardFingerprint, retrieveSubscription, type RetrievedSubscription } from '@/lib/providers/stripe-billing';
import { cardFingerprint, claimTrial } from './trial';
import { notifyOwners } from './emails';
import { acceptsSubscription, fromUnix, idOf, intervalOfSubscription, subscriptionPatch, type StripeSubscriptionLike } from './status';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('billing.webhook');

export interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

export type Outcome = { handled: true; business_id: string; detail?: string } | { handled: false; reason: string };

export const HANDLED_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const metaBusinessId = (o: Record<string, unknown>): string | null => {
  const m = o.metadata;
  return m && typeof m === 'object' ? str((m as Record<string, unknown>).business_id) : null;
};

type Resolved = { ok: true; business: Business; link: boolean } | { ok: false; reason: string };

/** Find the business an event is about, or say why not. `link` = the customer id still has to be stored. */
async function resolveBusiness(customerId: string | null, hintedId: string | null, event: StripeEvent): Promise<Resolved> {
  const byCustomer = customerId ? await getBusinessByStripeCustomer(customerId) : null;
  const byHint = hintedId ? await getBusiness(hintedId) : null;

  if (byCustomer && byHint && byCustomer.id !== byHint.id) {
    await refuse(event, 'customer_belongs_to_other_business', byHint.id, { customer: customerId, owner: byCustomer.id });
    return { ok: false, reason: 'business/customer mismatch' };
  }
  if (byCustomer) return { ok: true, business: byCustomer, link: false };
  if (byHint) {
    if (byHint.stripe_customer_id && byHint.stripe_customer_id !== customerId) {
      await refuse(event, 'business_has_other_customer', byHint.id, { customer: customerId, existing: byHint.stripe_customer_id });
      return { ok: false, reason: 'business/customer mismatch' };
    }
    if (!customerId) return { ok: false, reason: 'no customer on event' };
    return { ok: true, business: byHint, link: true };
  }
  return { ok: false, reason: hintedId ? 'unknown business' : 'unknown customer' };
}

async function refuse(event: StripeEvent, why: string, businessId: string, meta: Record<string, unknown>): Promise<void> {
  log.warn('event.refused', { id: event.id ?? null, type: event.type ?? null, why, business: businessId });
  await recordAudit({
    actor_kind: 'webhook', business_id: businessId, action: 'billing.webhook_refused',
    target: `stripe:${event.id ?? 'unknown'}`, meta: { why, type: event.type, ...meta },
  });
}

async function audit(event: StripeEvent, business: Business, action: string, meta: Record<string, unknown>): Promise<void> {
  await recordAudit({
    actor_kind: 'webhook', business_id: business.id, action,
    target: `stripe:${event.id ?? 'unknown'}`, meta: { type: event.type, ...meta },
  });
}

/** Apply a subscription object to a business (shared by the subscription.* events and checkout completion). */
async function applySubscription(
  event: StripeEvent, business: Business, link: boolean, customerId: string, sub: StripeSubscriptionLike,
): Promise<Outcome> {
  const patch = subscriptionPatch(sub);
  if (!patch) return { handled: false, reason: 'subscription without id' };
  if (!acceptsSubscription(business, patch.stripe_subscription_id, patch.billing_status)) {
    log.info('subscription.stale_ignored', { business: business.id, sub: patch.stripe_subscription_id, current: business.stripe_subscription_id ?? null });
    return { handled: false, reason: 'stale subscription' };
  }
  const updated = await setBillingState(business.id, {
    ...patch,
    plan: planName(),
    ...(link ? { stripe_customer_id: customerId } : {}),
  });
  if (!updated) return { handled: false, reason: 'business vanished' };
  const interval = intervalOfSubscription(sub);
  if (interval && interval !== (business.billing_interval ?? 'month')) {
    await updateBusiness(business.id, { billing_interval: interval });
    await audit(event, business, 'billing.interval_changed', { from: business.billing_interval ?? 'month', to: interval });
  }
  await audit(event, business, 'billing.subscription_updated', {
    from: business.billing_status ?? 'none', to: patch.billing_status, subscription: patch.stripe_subscription_id,
  });
  const becameCanceled = patch.billing_status === 'canceled' && business.billing_status !== 'canceled';
  if (becameCanceled) await notifyOwners(business, 'canceled');
  return { handled: true, business_id: business.id, detail: patch.billing_status };
}

function subscriptionIdOfInvoice(inv: Record<string, unknown>): string | null {
  const direct = idOf(inv.subscription);
  if (direct) return direct;
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } } | undefined; // newer API versions
  return idOf(parent?.subscription_details?.subscription);
}

export async function processBillingEvent(event: StripeEvent): Promise<Outcome> {
  const type = event.type ?? '';
  const obj = event.data?.object;
  if (!obj || typeof obj !== 'object') return { handled: false, reason: 'no object' };
  if (!HANDLED_TYPES.has(type)) return { handled: false, reason: `ignored ${type}` };

  if (type === 'checkout.session.completed') return onCheckoutCompleted(event, obj);
  if (type.startsWith('customer.subscription.')) return onSubscription(event, type, obj);
  return onInvoice(event, type, obj);
}

async function onCheckoutCompleted(event: StripeEvent, session: Record<string, unknown>): Promise<Outcome> {
  if (session.mode !== 'subscription') return { handled: false, reason: 'not a subscription checkout' }; // deposits use the payments webhook
  const customerId = idOf(session.customer);
  const subId = idOf(session.subscription);
  if (!customerId || !subId) return { handled: false, reason: 'session without customer/subscription' };
  const hinted = str(session.client_reference_id) ?? metaBusinessId(session);
  const res = await resolveBusiness(customerId, hinted, event);
  if (!res.ok) return { handled: false, reason: res.reason };
  const { business } = res;
  if (!acceptsSubscription(business, subId, 'trialing')) return { handled: false, reason: 'stale subscription' };

  // Link first (so later subscription.* events resolve by customer), then take the authoritative state from Stripe.
  let sub: RetrievedSubscription | null = null;
  if (configEnv().STRIPE_SECRET_KEY) {
    try { sub = await retrieveSubscription(subId); } catch (err) {
      log.warn('subscription.retrieve_failed', { sub: subId, error: (err as Error).name }); // subscription.* events will follow
    }
  }
  if (sub && idOf(sub.customer) === customerId) {
    const outcome = await applySubscription(event, business, res.link, customerId, sub as StripeSubscriptionLike);
    if (outcome.handled && sub.trial_end && sub.status === 'trialing') await enforceOneTrialPerCard(event, business, subId);
    return outcome;
  }
  await setBillingState(business.id, { stripe_customer_id: customerId, stripe_subscription_id: subId, plan: planName() });
  await audit(event, business, 'billing.checkout_completed', { subscription: subId });
  return { handled: true, business_id: business.id, detail: 'linked' };
}

/**
 * One free trial per physical card (L1): a card whose fingerprint was already used for a trial by ANOTHER business ends this
 * trial now (the first invoice is charged). Best-effort: a Stripe failure here never fails the webhook (Stripe would retry
 * and re-apply the state); the denial is audited either way.
 */
async function enforceOneTrialPerCard(event: StripeEvent, business: Business, subId: string): Promise<void> {
  try {
    const raw = await retrieveCardFingerprint(subId);
    if (!raw) return;
    const verdict = await claimTrial('card', cardFingerprint(raw), business.id);
    if (verdict !== 'taken') return;
    await endTrialNow(subId);
    await audit(event, business, 'billing.trial_denied', { reason: 'card_used_for_another_trial', subscription: subId });
    log.warn('trial.denied_card_seen', { business: business.id, sub: subId });
  } catch (err) {
    log.warn('trial.card_check_failed', { business: business.id, error: (err as Error).name });
  }
}

async function onSubscription(event: StripeEvent, type: string, sub: Record<string, unknown>): Promise<Outcome> {
  const customerId = idOf(sub.customer);
  if (!customerId) return { handled: false, reason: 'subscription without customer' };
  const res = await resolveBusiness(customerId, metaBusinessId(sub), event);
  if (!res.ok) return { handled: false, reason: res.reason };
  const { business } = res;

  if (type === 'customer.subscription.trial_will_end') {
    const subId = idOf(sub.id);
    if (business.stripe_subscription_id && subId && business.stripe_subscription_id !== subId) return { handled: false, reason: 'stale subscription' };
    const trialEnd = fromUnix(sub.trial_end);
    await notifyOwners(business, 'trial_will_end', { trialEnd });
    return { handled: true, business_id: business.id, detail: 'trial_will_end' };
  }
  if (type === 'customer.subscription.deleted') {
    // A deleted subscription is canceled whatever its payload status says.
    return applySubscription(event, business, res.link, customerId, { ...sub, status: 'canceled' });
  }
  return applySubscription(event, business, res.link, customerId, sub);
}

async function onInvoice(event: StripeEvent, type: string, inv: Record<string, unknown>): Promise<Outcome> {
  const customerId = idOf(inv.customer);
  const subId = subscriptionIdOfInvoice(inv);
  if (!customerId || !subId) return { handled: false, reason: 'invoice without customer/subscription' }; // one-off invoices are not ours
  // Invoices carry no business metadata we trust: the customer id must already be linked to a business.
  const res = await resolveBusiness(customerId, null, event);
  if (!res.ok) return { handled: false, reason: res.reason };
  const { business } = res;
  if (business.stripe_subscription_id && business.stripe_subscription_id !== subId) return { handled: false, reason: 'stale subscription' };
  const status = business.billing_status ?? 'none';

  if (type === 'invoice.payment_failed') {
    // Only a subscription that was in service can go past due: 'none' (never paid) and 'canceled' must not gain a grace period.
    if (status !== 'trialing' && status !== 'active' && status !== 'past_due') return { handled: false, reason: `ignored in ${status}` };
    const wasPastDue = status === 'past_due';
    await setBillingState(business.id, { billing_status: 'past_due', stripe_subscription_id: subId });
    await audit(event, business, 'billing.payment_failed', { from: status });
    if (!wasPastDue) await notifyOwners(business, 'payment_failed'); // retries of the same invoice do not re-email
    return { handled: true, business_id: business.id, detail: 'past_due' };
  }

  // invoice.paid: recovers a past-due / unpaid account. The $0 invoice that starts a trial must not end the trial,
  // and a paid invoice never resurrects a canceled subscription (subscription.updated says so if it should).
  const lines = (inv.lines as { data?: Array<{ period?: { end?: unknown } }> } | undefined)?.data;
  const periodEnd = fromUnix(lines?.[0]?.period?.end);
  if (status === 'past_due' || status === 'unpaid') {
    await setBillingState(business.id, { billing_status: 'active', stripe_subscription_id: subId, ...(periodEnd ? { current_period_end: periodEnd } : {}) });
    await audit(event, business, 'billing.invoice_paid', { from: status });
    return { handled: true, business_id: business.id, detail: 'active' };
  }
  if (status === 'active' && periodEnd) await setBillingState(business.id, { current_period_end: periodEnd });
  return { handled: true, business_id: business.id, detail: 'no_change' };
}
