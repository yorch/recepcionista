/**
 * Refund a booking's deposit (owner action). Money moves here, so every step is defensive:
 *
 *  1. The amount is validated against what was PAID (never more), whole cents, > 0.
 *  2. A booking the policy does not refund (or one that is not cancelled) needs an explicit `override` from the owner; it is audited.
 *  3. One refund per booking at a time (a short claim) and ONE refund in total: once refunded, the booking cannot be refunded again here
 *     (the rest of a partial refund is the owner's to do in Stripe: see docs/refunds.md).
 *  4. The Stripe call carries an Idempotency-Key derived from booking + amount, so a repeated click, retry or timeout can never refund
 *     twice. A definite Stripe refusal marks the refund failed and a retry uses a NEW key; an unknown outcome (timeout) stays 'pending'
 *     and a retry reuses the SAME key.
 *  5. The result is recorded with recordRefund / markRefundFailed, audited, the booking hook fires, and the customer is texted.
 */
import { claimEvent, getBooking, getBusiness, markRefundFailed, prisma, recordAudit, recordRefund, releaseEvent } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { notifyRefund, type ChangeActor, type NoticeResult } from '@/lib/booking-changes';
import { bookingRefundEligibility, checkRefundAmount, maxRefundable, refundIdempotencyKey, type Eligibility } from '@/lib/refunds';
import { createRefund, RefundProviderError } from '@/lib/providers/stripe-refunds';
import { logger } from '@/lib/log';
import type { Booking } from '@/lib/types';

const log = logger('refund');

export type RefundFailure =
  | { ok: false; status: 404 | 409 | 422 | 502; code: 'not_found' | 'no_deposit' | 'invalid_amount' | 'already_refunded' | 'in_progress' | 'policy_ineligible' | 'provider_refused' | 'outcome_unknown' | 'no_payment_reference'; error: string; policy?: Eligibility; booking?: Booking };

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
    // An owner override on a booking the policy had closed ('not_applicable') reopens it as 'none' before the attempt is recorded.
    if (booking.refund_status === 'not_applicable') await prisma.booking.updateMany({ where: { id: booking.id, refundStatus: 'not_applicable' }, data: { refundStatus: 'none' } });
    await recordRefund(booking.id, { amount_cents: amount, status: 'pending' });

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

export { maxRefundable };
