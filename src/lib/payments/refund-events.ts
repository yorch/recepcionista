/**
 * Stripe refund and dispute events for DEPOSIT payments (the payments webhook; after signature verification and claimEvent dedupe).
 * Every handler is idempotent and monotonic: recordRefund never moves a 'refunded' booking, so a replayed or reordered event converges.
 *
 *  - charge.refunded / refund.created / refund.updated / refund.failed: reconcile the booking's refund_status with Stripe's truth, including
 *    refunds the owner made in the Stripe dashboard (audited as `booking.refund_reconciled`, never texted: the customer hears from Stripe).
 *  - charge.dispute.created / updated / closed / funds_*: bookings.dispute_status (none | open | won | lost; monotonic) is set, shown in the
 *    dashboard; `created` is audited (`payment.dispute_created`) and the owner is alerted (text to a verified phone), a loss is alerted too;
 *    nothing is refunded or contested automatically (answering a dispute is the owner's job in Stripe).
 * The booking is found by the payment intent / checkout session stored when the deposit was paid, else by the metadata the payment link
 * carried; a booking of another business than the metadata names is never touched.
 */
import { getBooking, getBookingByStripeRef, getBusiness, markRefundFailed, recordAudit, recordRefund, setDisputeStatus } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { sendAndLog } from '@/lib/messaging';
import { ownerAlertSms } from '@/lib/messaging/templates';
import { formatCents } from '@/lib/money';
import { logger } from '@/lib/log';
import type { Booking } from '@/lib/types';

const log = logger('stripe.refund-events');

export const DISPUTE_EVENT_TYPES = ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'] as const;
export const REFUND_EVENT_TYPES = new Set(['charge.refunded', 'refund.created', 'refund.updated', 'refund.failed', ...DISPUTE_EVENT_TYPES]);

/**
 * Stripe's dispute `status` (and the event type, for funds events) -> the booking's dispute_status. 'won' / 'warning_closed' /
 * 'charge_refunded' end without a loss; 'lost' is final; everything else is still open (needs a response / under review).
 */
export function disputeStatusOf(type: string, stripeStatus: string | null): 'open' | 'won' | 'lost' {
  if (stripeStatus === 'lost') return 'lost';
  if (stripeStatus === 'won' || stripeStatus === 'warning_closed' || stripeStatus === 'charge_refunded') return 'won';
  if (type === 'charge.dispute.funds_reinstated') return 'won';
  return 'open';
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as Obj).id) : null);
const cents = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

async function findBooking(obj: Obj): Promise<Booking | null> {
  const meta = (obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}) as Obj;
  const pi = idOf(obj.payment_intent);
  let booking = pi ? await getBookingByStripeRef({ payment_intent_id: pi }) : null;
  const metaBooking = str(meta.booking_id) ?? str(meta.bookingId);
  if (!booking && metaBooking) booking = await getBooking(metaBooking);
  const metaBusiness = str(meta.business_id) ?? str(meta.businessId);
  if (booking && metaBusiness && booking.business_id !== metaBusiness) {
    log.warn('booking.business_mismatch', { booking: booking.id });
    return null;
  }
  return booking;
}

async function alertOwner(businessId: string, bookingId: string | undefined, text: string): Promise<void> {
  const business = await getBusiness(businessId);
  if (!business?.owner_phone) return;
  await sendAndLog({ business_id: business.id, to: business.owner_phone, body: ownerAlertSms({ business, text }), kind: 'owner_alert', booking_id: bookingId ?? null }).catch((err) => log.warn('alert.failed', { err }));
}

export async function handleRefundEvent(
  event: { id?: string; type?: string; data?: { object?: Obj } }, type: string,
): Promise<{ received: true; booking_id?: string; ignored?: string; refund_status?: string; dispute?: boolean }> {
  const obj = event.data?.object ?? {};
  const booking = await findBooking(obj);
  if (!booking) {
    log.info('refund_event.unmatched', { type, id: event.id ?? null });
    return { received: true, ignored: 'no matching booking' };
  }
  const actor = { actor_kind: 'webhook' as const, business_id: booking.business_id, target: `booking:${booking.id}` };

  if ((DISPUTE_EVENT_TYPES as readonly string[]).includes(type)) {
    const amount = cents(obj.amount);
    const next = disputeStatusOf(type, str(obj.status));
    const changed = await setDisputeStatus(booking.id, next); // monotonic: a settled dispute is never reopened by a late event
    if (type === 'charge.dispute.created') {
      await recordAudit({ ...actor, action: 'payment.dispute_created', meta: { stripe_event: event.id ?? null, dispute: idOf(obj.id), amount_cents: amount, reason: str(obj.reason), status: str(obj.status), refund_status: booking.refund_status ?? 'none' } });
      await alertOwner(booking.business_id, booking.id, `A customer disputed ${formatCents(amount)} (${booking.customer_name}, ${booking.service}). Answer it in Stripe before the deadline.`);
      log.warn('dispute.created', { booking: booking.id, amount_cents: amount });
    } else if (changed) {
      await recordAudit({ ...actor, action: 'payment.dispute_updated', meta: { stripe_event: event.id ?? null, type, dispute: idOf(obj.id), status: str(obj.status), dispute_status: next } });
      if (next === 'lost') await alertOwner(booking.business_id, booking.id, `You lost the ${formatCents(amount)} dispute for ${booking.customer_name}. The funds were returned to the cardholder.`);
    }
    if (changed) await emitBookingChanged(booking.id, 'updated', booking.business_id);
    return { received: true, booking_id: booking.id, dispute: true };
  }

  let updated = false;
  let before = booking.refund_status ?? 'none';
  if (type === 'charge.refunded') {
    const refunded = cents(obj.amount_refunded);
    const list = (obj.refunds as { data?: Obj[] } | undefined)?.data;
    if (refunded > 0) updated = (await recordRefund(booking.id, { amount_cents: refunded, status: 'refunded', stripe_refund_id: list?.[0] ? idOf(list[0].id) : null })).updated;
  } else {
    const status = str(obj.status);
    const amount = cents(obj.amount);
    const refundId = str(obj.id);
    if (type === 'refund.failed' || status === 'failed' || status === 'canceled') {
      updated = (await markRefundFailed(booking.id, `stripe ${status ?? 'failed'}`)).updated;
      // The app's own retry counter (refund-service: attempt suffix of the Idempotency-Key) counts `booking.refund_failed` rows. A failure that
      // Stripe reports ASYNCHRONOUSLY must count too, or the next retry reuses the first key and Stripe replays the cached first response
      // (the refund that already failed) for 24 h instead of creating a new refund.
      if (updated) await recordAudit({ ...actor, action: 'booking.refund_failed', meta: { via: 'webhook', stripe_event: event.id ?? null, type, status: status ?? null } });
      if (updated) await alertOwner(booking.business_id, booking.id, `A refund of ${formatCents(amount)} for ${booking.customer_name} failed in Stripe. Check it in your Stripe dashboard.`);
    } else if (status === 'succeeded' && amount > 0) {
      updated = (await recordRefund(booking.id, { amount_cents: amount, status: 'refunded', stripe_refund_id: refundId })).updated;
    } else if (amount > 0) {
      updated = (await recordRefund(booking.id, { amount_cents: amount, status: 'pending', stripe_refund_id: refundId })).updated;
    }
  }
  const fresh = (await getBooking(booking.id)) ?? booking;
  if (updated) {
    // The app already audits the refund it made itself (booking.refunded); this row is the webhook's confirmation or a dashboard-made refund.
    await recordAudit({ ...actor, action: 'booking.refund_reconciled', meta: { stripe_event: event.id ?? null, type, from: before, to: fresh.refund_status ?? 'none', amount_cents: fresh.refund_amount_cents ?? null } });
    await emitBookingChanged(booking.id, 'refunded', booking.business_id);
  }
  before = fresh.refund_status ?? 'none';
  return { received: true, booking_id: booking.id, refund_status: before };
}
