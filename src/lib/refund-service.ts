/**
 * Refund a booking's deposit (owner action). Money moves here, so every step is defensive:
 *
 *  1. The amount is validated against what was PAID (never more), whole cents, > 0.
 *  2. A booking the policy does not refund (or one that is not cancelled) needs an explicit `override` from the owner; it is audited.
 *  3. One refund per booking at a time (a short claim) and ONE refund in total: once refunded, the booking cannot be refunded again here
 *     (the rest of a partial refund is the owner's to do in Stripe: see docs/refunds.md).
 *  4. The Stripe call carries an Idempotency-Key derived from booking + amount (+ the number of failed attempts), so a repeated click, retry
 *     or timeout can never refund twice; while a refund is 'pending' only the SAME amount may be re-sent (a different amount would be a different
 *     key, i.e. a second refund), and asynchronous failures (webhook) count as failed attempts too. A definite Stripe refusal marks the refund failed and a retry uses a NEW key; an unknown outcome (timeout) stays 'pending'
 *     and a retry reuses the SAME key.
 *  5. The result is recorded with recordRefund / markRefundFailed, audited, the booking hook fires, and the customer is texted.
 */
import { configEnv } from '@/lib/config';
import { claimEvent, getBooking, getBusiness, markRefundFailed, prisma, recordAudit, recordRefund, releaseEvent } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { notifyRefund, type ChangeActor, type NoticeResult } from '@/lib/booking-changes';
import { bookingRefundEligibility, checkRefundAmount, maxRefundable, refundIdempotencyKey, type Eligibility } from '@/lib/refunds';
import { createRefund, listRefundsForPaymentIntent, paymentIntentOfSession, RefundProviderError, type ListedRefund } from '@/lib/providers/stripe-refunds';
import { logger } from '@/lib/log';
import type { Booking } from '@/lib/types';

const log = logger('refund');

export type RefundFailure =
  | { ok: false; status: 404 | 409 | 422 | 502; code: 'not_found' | 'no_deposit' | 'invalid_amount' | 'already_refunded' | 'in_progress' | 'policy_ineligible' | 'provider_refused' | 'outcome_unknown' | 'no_payment_reference' | 'manual_deposit'; error: string; policy?: Eligibility; booking?: Booking };

export type RefundResult =
  | { ok: true; booking: Booking; amount_cents: number; status: 'refunded' | 'pending'; replayed: boolean; override: boolean; policy: Eligibility; partial: boolean; notice: NoticeResult | null }
  | RefundFailure;

export async function refundDeposit(input: {
  businessId: string; bookingId: string; amount_cents?: unknown; override?: boolean; actor: ChangeActor; fetchImpl?: typeof fetch; now?: Date;
}): Promise<RefundResult> {
  const now = input.now ?? new Date();
  const first = await getBooking(input.bookingId);
  if (!first || first.business_id !== input.businessId) return { ok: false, status: 404, code: 'not_found', error: 'booking not found' };
  const business = await getBusiness(input.businessId);
  if (!business) return { ok: false, status: 404, code: 'not_found', error: 'business not found' };

  // A deposit the owner marked as paid manually (cash, Zelle...) never went through Stripe: there is nothing to refund there. The owner refunds it
  // the way it was taken and records that with recordManualRefund (never a Stripe call, never a customer text claiming a card refund).
  if (first.deposit_paid && first.deposit_source === 'manual') {
    return { ok: false, status: 409, code: 'manual_deposit', error: 'this deposit was marked as paid manually: refund it the way you received it, then record the manual refund', booking: first };
  }
  const paid = first.deposit_paid && first.deposit_amount ? Math.round(first.deposit_amount) : 0;
  const amountCheck = checkRefundAmount(input.amount_cents, paid > 0 ? paid : 0);
  if (!amountCheck.ok) return { ok: false, status: paid > 0 ? 422 : 409, code: paid > 0 ? 'invalid_amount' : 'no_deposit', error: amountCheck.error };
  const amount = amountCheck.amount_cents;
  const partial = amount < paid;

  // Idempotent replay: the same refund was already made.
  if (first.refund_status === 'refunded') {
    if (first.refund_amount_cents === amount) {
      return { ok: true, booking: first, amount_cents: amount, status: 'refunded', replayed: true, override: false, policy: bookingRefundEligibility(first, business.refund_policy, now), partial, notice: null };
    }
    return { ok: false, status: 409, code: 'already_refunded', error: 'this deposit was already refunded; a second refund must be made in Stripe', booking: first };
  }

  const policy = bookingRefundEligibility(first, business.refund_policy, now);
  const policyAllows = first.status === 'cancelled' && policy.eligible;
  if (!policyAllows && !input.override) {
    return {
      ok: false, status: 422, code: 'policy_ineligible', policy, booking: first,
      error: first.status === 'cancelled' ? 'the refund policy does not refund this deposit; confirm the override to refund anyway' : 'the booking is not cancelled; confirm the override to refund its deposit anyway',
    };
  }

  const claim = `${first.id}`;
  if (!(await claimEvent('deposit_refund', claim, 45_000))) return { ok: false, status: 409, code: 'in_progress', error: 'a refund for this booking is already being processed' };
  try {
    // Re-read under the claim: a concurrent refund may have finished while we waited.
    const booking = (await getBooking(first.id)) as Booking;
    if (booking.refund_status === 'refunded') {
      return booking.refund_amount_cents === amount
        ? { ok: true, booking, amount_cents: amount, status: 'refunded', replayed: true, override: false, policy, partial, notice: null }
        : { ok: false, status: 409, code: 'already_refunded', error: 'this deposit was already refunded; a second refund must be made in Stripe', booking };
    }
    // While a refund is 'pending' (Stripe said processing / needs action, or the call timed out) only an EXACT replay of it may go out (same
    // amount = same Idempotency-Key = Stripe returns the same refund). A different amount would get a different key and create a SECOND refund.
    // The owner can change the amount once the pending refund failed (webhook) or finished.
    if (booking.refund_status === 'pending' && booking.refund_amount_cents != null && booking.refund_amount_cents !== amount) {
      return { ok: false, status: 409, code: 'in_progress', error: `a refund of ${(booking.refund_amount_cents / 100).toFixed(2)} is still processing; wait for it to finish or fail before refunding a different amount`, booking };
    }
    // A pending refund whose Stripe id was NOT made by this app (a refund made in the Stripe dashboard, adopted from its webhook) is processing there:
    // a request with this app's key would be a SECOND refund. The webhook (or "check with Stripe") finishes it. A refund this app made itself is
    // replayed as before (same amount = same Idempotency-Key = Stripe returns the same refund).
    if (booking.refund_status === 'pending' && booking.stripe_refund_id && !(await weMadeRefund(booking.id, booking.stripe_refund_id))) {
      return { ok: false, status: 409, code: 'in_progress', error: 'a refund already exists at Stripe for this deposit (it was not made here) and is still processing; wait for it to finish, or check it in your Stripe dashboard', booking };
    }
    // An owner override on a booking the policy had closed ('not_applicable') reopens it as 'none' before the attempt is recorded.
    if (booking.refund_status === 'not_applicable') await prisma.booking.updateMany({ where: { id: booking.id, refundStatus: 'not_applicable' }, data: { refundStatus: 'none' } });
    await recordRefund(booking.id, { amount_cents: amount, status: 'pending', fresh_attempt: booking.refund_status !== 'pending' });

    const failedBefore = await prisma.auditEvent.count({ where: { target: `booking:${booking.id}`, action: 'booking.refund_failed' } });
    const key = refundIdempotencyKey(booking.id, amount, failedBefore);
    const auditBase = { actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: booking.business_id, target: `booking:${booking.id}`, ip: input.actor.ip ?? null };
    const meta = { ...(input.actor.meta ?? {}), amount_cents: amount, partial, deposit_cents: paid, override: !policyAllows, policy: policy.policy, policy_reason: policy.reason, hours_before: policy.hours_before };

    let refund;
    try {
      refund = await createRefund({
        paymentIntentId: booking.stripe_payment_intent_id ?? null, checkoutSessionId: booking.stripe_checkout_session_id ?? null,
        amountCents: amount, idempotencyKey: key, metadata: { booking_id: booking.id, business_id: booking.business_id },
      }, input.fetchImpl);
    } catch (err) {
      if (err instanceof RefundProviderError && err.definite) {
        await markRefundFailed(booking.id, err.message);
        await recordAudit({ ...auditBase, action: 'booking.refund_failed', meta: { ...meta, status: err.status ?? null, code: err.code ?? null } });
        log.warn('refund.refused', { booking: booking.id, status: err.status, code: err.code });
        const noRef = err.code === 'no_payment_reference';
        return { ok: false, status: noRef ? 409 : 502, code: noRef ? 'no_payment_reference' : 'provider_refused', error: noRef ? err.message : `Stripe refused the refund: ${err.message}`, booking: (await getBooking(booking.id)) ?? booking };
      }
      // Outcome unknown: the booking stays 'pending'. A retry reuses the same key, so it can never refund twice.
      await recordAudit({ ...auditBase, action: 'booking.refund_unknown', meta });
      log.warn('refund.unknown_outcome', { booking: booking.id });
      return { ok: false, status: 502, code: 'outcome_unknown', error: 'Stripe did not answer, so the refund may or may not have gone through. Check again in a minute: retrying is safe and cannot refund twice.', booking: (await getBooking(booking.id)) ?? booking };
    }

    if (refund.status === 'failed' || refund.status === 'canceled') {
      await markRefundFailed(booking.id, `refund ${refund.status}`);
      await recordAudit({ ...auditBase, action: 'booking.refund_failed', meta: { ...meta, stripe_status: refund.status, refund: refund.id } });
      return { ok: false, status: 502, code: 'provider_refused', error: `Stripe could not complete the refund (${refund.status})`, booking: (await getBooking(booking.id)) ?? booking };
    }
    const done = refund.status === 'succeeded';
    await recordRefund(booking.id, { amount_cents: amount, stripe_refund_id: refund.id, status: done ? 'refunded' : 'pending' });
    await recordAudit({ ...auditBase, action: 'booking.refunded', meta: { ...meta, refund: refund.id, stripe_status: refund.status, mock: refund.mock } });
    await emitBookingChanged(booking.id, 'refunded', booking.business_id);
    const notice = done ? await notifyRefund(booking.id, amount, now) : null;
    return { ok: true, booking: (await getBooking(booking.id)) ?? booking, amount_cents: amount, status: done ? 'refunded' : 'pending', replayed: false, override: !policyAllows, policy, partial, notice };
  } finally {
    await releaseEvent('deposit_refund', claim);
  }
}

/** Did THIS app create (or adopt after creating) the Stripe refund `refundId` of the booking? Read from our own audit trail: `booking.refunded` / `booking.refund_checked` carry the refund id. */
async function weMadeRefund(bookingId: string, refundId: string): Promise<boolean> {
  const row = await prisma.auditEvent.findFirst({ where: { target: `booking:${bookingId}`, action: { in: ['booking.refunded', 'booking.refund_checked'] }, meta: { path: ['refund'], equals: refundId } }, select: { id: true } });
  return row !== null;
}

export { maxRefundable };

// ── "check with Stripe": recovery of a refund that stayed pending ─────────────────────────────────────────────

/** A pending refund is only treated as "never reached Stripe" once it is this old (an in-flight request has long finished by then). */
export const REFUND_CHECK_MIN_AGE_MS = 30 * 60_000;
/** The reconcile job looks at pending refunds older than this (hours, env REFUND_RECONCILE_AFTER_HOURS, default 6, 1..720). */
export const refundReconcileAfterMs = (env: Record<string, string | undefined> = configEnv()): number => {
  const n = Number((env.REFUND_RECONCILE_AFTER_HOURS ?? '').trim());
  return (Number.isInteger(n) && n >= 1 && n <= 720 ? n : 6) * 3_600_000;
};

export type RefundCheckOutcome =
  | { ok: true; result: 'adopted_refunded' | 'adopted_pending' | 'marked_failed' | 'unchanged'; booking: Booking; refund_id?: string }
  | { ok: false; status: 404 | 409 | 502; code: 'not_found' | 'not_pending' | 'too_early' | 'in_progress' | 'unavailable' | 'no_payment_reference' | 'foreign_refund'; error: string; booking?: Booking };

/** Clock slack when comparing Stripe's `created` with our own `refund_requested_at`. */
const REFUND_CLOCK_SLACK_MS = 5 * 60_000;
const refundRank = (st: string): number => (st === 'succeeded' ? 0 : st === 'pending' || st === 'requires_action' ? 1 : 2);
const isDeadRefund = (st: string): boolean => st === 'failed' || st === 'canceled';

/**
 * Pure: which Stripe refund (if any) is THIS booking's CURRENT pending one.
 *  1. the refund whose id the booking already holds (`stripe_refund_id`: adopted from the webhook, including a refund made in the Stripe
 *     dashboard, which carries no metadata and may have any amount);
 *  2. else a refund this app made for this booking and amount, and (when the attempt time is known) created at or after the attempt: an
 *     OLDER failed attempt of the same amount is not the current attempt. Best status first.
 */
export function pickBookingRefund(
  refunds: ListedRefund[], bookingId: string, amountCents: number, opts: { storedRefundId?: string | null; requestedAtMs?: number | null } = {},
): ListedRefund | null {
  if (opts.storedRefundId) {
    const stored = refunds.find((r) => r.id === opts.storedRefundId);
    if (stored) return stored;
  }
  const notBefore = opts.requestedAtMs != null ? opts.requestedAtMs - REFUND_CLOCK_SLACK_MS : null;
  const mine = refunds
    .filter((r) => r.booking_id === bookingId && r.amount_cents === amountCents && (notBefore === null || r.created == null || r.created * 1000 >= notBefore))
    .sort((a, b) => refundRank(a.status) - refundRank(b.status));
  return mine[0] ?? null;
}

/** Pure: refunds Stripe lists for the payment that are live (not failed / canceled) and are NOT the booking's current one: someone else's money movement. */
export function unknownLiveRefunds(refunds: ListedRefund[], current: ListedRefund | null): ListedRefund[] {
  return refunds.filter((r) => !isDeadRefund(r.status) && r.id !== current?.id);
}

/**
 * Resolve a refund that has been `pending` for a long time (the Stripe call timed out and the answer never came back). Read-only towards
 * Stripe: it LISTS the payment intent's refunds and then, under the same per-booking claim a refund uses:
 *  - finds this booking's refund and it succeeded -> adopt its id, mark refunded, text the customer (like a normal success);
 *  - finds it still processing -> adopt its id (the webhook finishes it);
 *  - finds it failed / canceled -> mark failed (the retry then uses a NEW idempotency key);
 *  - finds NONE and the attempt is at least REFUND_CHECK_MIN_AGE_MS old -> the request never reached Stripe: mark failed, so the owner may send
 *    it again (a new key; Stripe has no refund to duplicate). Younger than that: answers `too_early`, changes nothing.
 * It never creates a refund. Idempotent (a resolved booking is `not_pending`), audited (`booking.refund_checked`, and `booking.refund_failed`
 * when it marks failed, which the retry counter reads). The manual action is owner + step-up (route); the reconcile job calls it as the system.
 */
export async function checkPendingRefund(input: {
  businessId: string; bookingId: string; actor: ChangeActor; fetchImpl?: typeof fetch; now?: Date; minAgeMs?: number;
}): Promise<RefundCheckOutcome> {
  const now = input.now ?? new Date();
  const first = await getBooking(input.bookingId);
  if (!first || first.business_id !== input.businessId) return { ok: false, status: 404, code: 'not_found', error: 'booking not found' };
  if (first.refund_status !== 'pending') return { ok: false, status: 409, code: 'not_pending', error: 'this booking has no pending refund to check', booking: first };
  const claim = `${first.id}`;
  if (!(await claimEvent('deposit_refund', claim, 45_000))) return { ok: false, status: 409, code: 'in_progress', error: 'a refund for this booking is already being processed' };
  try {
    const booking = (await getBooking(first.id)) as Booking;
    if (booking.refund_status !== 'pending' || !booking.refund_amount_cents) return { ok: false, status: 409, code: 'not_pending', error: 'this booking has no pending refund to check', booking };
    const amount = booking.refund_amount_cents;
    const auditBase = { actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: booking.business_id, target: `booking:${booking.id}`, ip: input.actor.ip ?? null };
    let refunds: ListedRefund[] | null;
    try {
      let pi = booking.stripe_payment_intent_id ?? null;
      if (!pi && booking.stripe_checkout_session_id) pi = await paymentIntentOfSession(booking.stripe_checkout_session_id, input.fetchImpl);
      if (!pi) return { ok: false, status: 409, code: 'no_payment_reference', error: 'no Stripe payment is recorded for this deposit: check it in your Stripe dashboard', booking };
      refunds = await listRefundsForPaymentIntent(pi, input.fetchImpl);
    } catch (err) {
      if (err instanceof RefundProviderError && err.code === 'no_payment_reference') return { ok: false, status: 409, code: 'no_payment_reference', error: err.message, booking };
      log.warn('refund.check_unavailable', { booking: booking.id, err: (err as Error).name });
      return { ok: false, status: 502, code: 'unavailable', error: 'Stripe could not be reached, so nothing was changed. Try again in a minute.', booking };
    }
    if (refunds === null) return { ok: false, status: 502, code: 'unavailable', error: 'Stripe is not configured here, so there is nothing to check.', booking };
    const meta = { ...(input.actor.meta ?? {}), amount_cents: amount, found: refunds.length };
    const row = await prisma.booking.findUnique({ where: { id: booking.id }, select: { refundRequestedAt: true } });
    const requestedAt = row?.refundRequestedAt ?? null;
    const found = pickBookingRefund(refunds, booking.id, amount, { storedRefundId: booking.stripe_refund_id ?? null, requestedAtMs: requestedAt ? requestedAt.getTime() : null });
    if (found && found.status === 'succeeded') {
      await recordRefund(booking.id, { amount_cents: amount, stripe_refund_id: found.id, status: 'refunded' });
      await recordAudit({ ...auditBase, action: 'booking.refund_checked', meta: { ...meta, result: 'adopted_refunded', refund: found.id } });
      await emitBookingChanged(booking.id, 'refunded', booking.business_id);
      await notifyRefund(booking.id, amount, now);
      return { ok: true, result: 'adopted_refunded', booking: (await getBooking(booking.id)) ?? booking, refund_id: found.id };
    }
    if (found && found.status !== 'failed' && found.status !== 'canceled') {
      if (booking.stripe_refund_id === found.id) return { ok: true, result: 'unchanged', booking, refund_id: found.id }; // already adopted: Stripe is still processing it
      await recordRefund(booking.id, { amount_cents: amount, stripe_refund_id: found.id, status: 'pending' });
      await recordAudit({ ...auditBase, action: 'booking.refund_checked', meta: { ...meta, result: 'adopted_pending', refund: found.id, stripe_status: found.status } });
      return { ok: true, result: 'adopted_pending', booking: (await getBooking(booking.id)) ?? booking, refund_id: found.id };
    }
    if (found) { // this booking's own current refund failed / was canceled at Stripe
      await markRefundFailed(booking.id, `refund ${found.status}`);
      await recordAudit({ ...auditBase, action: 'booking.refund_failed', meta: { ...meta, via: 'check', stripe_status: found.status, refund: found.id } });
      await recordAudit({ ...auditBase, action: 'booking.refund_checked', meta: { ...meta, result: 'marked_failed', refund: found.id, stripe_status: found.status } });
      return { ok: true, result: 'marked_failed', booking: (await getBooking(booking.id)) ?? booking, refund_id: found.id };
    }
    // None of this booking's own refunds is at Stripe. If the payment still has a LIVE refund this app did not make for this attempt (a dashboard refund,
    // an older partial, another amount), the money may already have moved: never conclude "never reached Stripe" (the retry would refund again).
    const unknown = unknownLiveRefunds(refunds, null);
    if (unknown.length > 0) {
      await recordAudit({ ...auditBase, action: 'booking.refund_checked', meta: { ...meta, result: 'foreign_refund', refunds: unknown.map((r) => r.id).slice(0, 5) } });
      return { ok: false, status: 409, code: 'foreign_refund', error: 'Stripe lists another refund on this payment that was not made for this request, so nothing was changed. Check it in your Stripe dashboard before sending a refund again.', booking };
    }
    // Nothing live at Stripe for this payment: only conclude "never sent" once the attempt is old enough.
    const ageMs = requestedAt ? now.getTime() - requestedAt.getTime() : Infinity; // NULL = recorded before the column existed
    if (ageMs < (input.minAgeMs ?? REFUND_CHECK_MIN_AGE_MS)) {
      return { ok: false, status: 409, code: 'too_early', error: 'The refund was requested a moment ago and Stripe shows nothing yet. Check again in a few minutes.', booking };
    }
    await markRefundFailed(booking.id, 'never reached Stripe');
    await recordAudit({ ...auditBase, action: 'booking.refund_failed', meta: { ...meta, via: 'check', reason: 'never_reached_stripe' } });
    await recordAudit({ ...auditBase, action: 'booking.refund_checked', meta: { ...meta, result: 'marked_failed' } });
    return { ok: true, result: 'marked_failed', booking: (await getBooking(booking.id)) ?? booking };
  } finally {
    await releaseEvent('deposit_refund', claim);
  }
}

export interface StuckRefundReport { considered: number; resolved: number; items: { booking_id: string; outcome: string }[] }

/**
 * Reconcile-job pass: every refund that has been pending for REFUND_RECONCILE_AFTER_HOURS (default 6) is checked with Stripe (checkPendingRefund,
 * as the system). Never throws; bounded (20 per pass). A refund Stripe is still processing is only re-adopted, so this is cheap to repeat.
 */
export async function reconcileStuckRefunds(opts: { now?: Date; dryRun?: boolean; fetchImpl?: typeof fetch; limit?: number; env?: Record<string, string | undefined> } = {}): Promise<StuckRefundReport> {
  const now = opts.now ?? new Date();
  const out: StuckRefundReport = { considered: 0, resolved: 0, items: [] };
  try {
    if (!configEnv().STRIPE_SECRET_KEY?.trim() && !opts.fetchImpl) return out; // mock / dev: nothing at Stripe to compare with
    const cutoff = new Date(now.getTime() - refundReconcileAfterMs(opts.env));
    // Least recently looked-at first, and rows looked at within the last hour are left out IN SQL (not after the LIMIT): refunds Stripe keeps
    // processing come back unchanged and must not fill the window for good while newer stuck refunds starve.
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const lookedAfter = new Date(now.getTime() - 3_600_000);
    const rows = await prisma.$queryRaw<{ id: string; businessId: string }[]>`
      SELECT b."id" AS "id", b."business_id" AS "businessId"
        FROM "bookings" b
        LEFT JOIN "processed_events" pe ON pe."source" = 'refund-reconcile' AND pe."id" = b."id"
       WHERE b."refund_status" = 'pending'
         AND (b."refund_requested_at" IS NULL OR b."refund_requested_at" < ${cutoff})
         AND (${opts.fetchImpl ? true : false}::boolean OR pe."claimed_at" IS NULL OR pe."claimed_at" < ${lookedAfter})
       ORDER BY pe."claimed_at" ASC NULLS FIRST, b."created_at" ASC, b."id" ASC
       LIMIT ${limit}`;
    out.considered = rows.length;
    if (opts.dryRun) return out;
    for (const r of rows) {
      // At most one look per booking per hour (the claim is never released): a refund Stripe is still processing is not listed every tick.
      if (opts.fetchImpl) await prisma.processedEvent.upsert({ where: { source_id: { source: 'refund-reconcile', id: r.id } }, create: { source: 'refund-reconcile', id: r.id, status: 'processing' }, update: { claimedAt: new Date() } });
      else if (!(await claimEvent('refund-reconcile', r.id, 3_600_000))) continue;
      const res = await checkPendingRefund({ businessId: r.businessId, bookingId: r.id, actor: { kind: 'system', user_id: null, meta: { via: 'reconcile' } }, fetchImpl: opts.fetchImpl, now });
      out.items.push({ booking_id: r.id, outcome: res.ok ? res.result : res.code });
      if (res.ok && res.result !== 'unchanged') out.resolved++;
    }
  } catch (err) {
    log.error('refund.reconcile_failed', { err });
  }
  return out;
}


// ── manual deposits: record a refund made OFF-platform ───────────────────────────────────────────────────────

export type ManualRefundResult =
  | { ok: true; booking: Booking; amount_cents: number; replayed: boolean }
  | { ok: false; status: 404 | 409 | 422; code: 'not_found' | 'not_manual' | 'invalid_amount' | 'already_refunded'; error: string };

/**
 * Record that the owner refunded a MANUAL deposit themselves (cash back, Zelle...). No provider is called and the customer is not texted:
 * this is bookkeeping only. Only a booking whose deposit was marked paid manually qualifies (a Stripe deposit is refunded through Stripe:
 * refundDeposit). One record per booking; the same amount again is an idempotent replay. Audited (`booking.refund_recorded_manual`).
 */
export async function recordManualRefund(input: { businessId: string; bookingId: string; amount_cents?: unknown; actor: ChangeActor; now?: Date }): Promise<ManualRefundResult> {
  const now = input.now ?? new Date();
  const first = await getBooking(input.bookingId);
  if (!first || first.business_id !== input.businessId) return { ok: false, status: 404, code: 'not_found', error: 'booking not found' };
  if (!first.deposit_paid || first.deposit_source !== 'manual') return { ok: false, status: 409, code: 'not_manual', error: 'only a deposit marked as paid manually can be recorded as refunded manually; a card deposit is refunded through Stripe' };
  const paid = first.deposit_amount && first.deposit_amount > 0 ? Math.round(first.deposit_amount) : 0;
  const check = checkRefundAmount(input.amount_cents, paid);
  if (!check.ok) return { ok: false, status: 422, code: 'invalid_amount', error: check.error };
  if (first.refund_status === 'refunded') {
    return first.refund_amount_cents === check.amount_cents
      ? { ok: true, booking: first, amount_cents: check.amount_cents, replayed: true }
      : { ok: false, status: 409, code: 'already_refunded', error: 'a manual refund was already recorded for this deposit' };
  }
  if (first.refund_status === 'not_applicable') await prisma.booking.updateMany({ where: { id: first.id, refundStatus: 'not_applicable' }, data: { refundStatus: 'none' } });
  const rec = await recordRefund(first.id, { amount_cents: check.amount_cents, status: 'refunded', at: now });
  if (!rec.updated) return { ok: false, status: 409, code: 'already_refunded', error: 'a refund is already recorded for this deposit' };
  await recordAudit({
    actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: first.business_id, action: 'booking.refund_recorded_manual',
    target: `booking:${first.id}`, ip: input.actor.ip ?? null, meta: { ...(input.actor.meta ?? {}), amount_cents: check.amount_cents, deposit_cents: paid, partial: check.amount_cents < paid },
  });
  await emitBookingChanged(first.id, 'refunded', first.business_id);
  return { ok: true, booking: (await getBooking(first.id)) ?? first, amount_cents: check.amount_cents, replayed: false };
}
