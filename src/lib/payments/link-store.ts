/**
 * Remember the Payment Link texted for a booking's deposit (the booking stores ONE id, the latest) and keep exactly that one payable:
 *  - the link it replaces is deactivated (a voice-tool link and a dashboard link, or two dashboard clicks, must not leave two live links),
 *  - a link made for a booking that was cancelled meanwhile (cancel raced the creation) is deactivated at once.
 * Best effort and never throws: the payments webhook still alerts the owner if a deactivated-too-late link is paid.
 */
import { getBooking, getBookingPaymentLinkId, recordAudit, replaceBookingPaymentLink } from '@/lib/db';
import { logger } from '@/lib/log';
import { deactivatePaymentLink, findActivePaymentLinksForBooking } from '@/lib/providers/stripe';

const log = logger('payments.link-store');

/** Thrown when a payment link is asked for a cancelled booking (the caller answers 409). */
export class BookingCancelledError extends Error {
  constructor() { super('the booking is cancelled; a deposit link cannot be created for it'); this.name = 'BookingCancelledError'; }
}

export async function rememberPaymentLink(bookingId: string, linkId: string): Promise<void> {
  try {
    const { stored, previous } = await replaceBookingPaymentLink(bookingId, linkId);
    if (!stored) return;
    const booking = await getBooking(bookingId);
    const stale = [previous, booking?.status === 'cancelled' && !booking.deposit_paid ? linkId : null].filter((x): x is string => Boolean(x));
    for (const id of stale) {
      if (await deactivatePaymentLink(id) && booking) {
        await recordAudit({ actor_kind: 'system', business_id: booking.business_id, action: 'booking.payment_link_deactivated', target: `booking:${bookingId}`, meta: { link: id, reason: id === linkId ? 'booking_cancelled' : 'replaced' } });
      }
    }
  } catch (err) {
    log.warn('remember.failed', { booking: bookingId, err });
  }
}

/**
 * A booking was cancelled: stop its deposit link from taking money. The stored link id is deactivated; when NONE is stored (a link texted
 * before the id was stored) the booking's links are looked up in Stripe by their `booking_id` metadata and deactivated too. Best effort, each
 * deactivation audited (`booking.payment_link_deactivated`, with `via: 'stripe_lookup'` for the lookup), never throws; a payment that still
 * arrives for a cancelled booking alerts the owner and reopens the refund (payments webhook).
 */
export async function deactivateLinksForCancelledBooking(booking: { id: string; business_id: string }, opts: { fetchImpl?: typeof fetch } = {}): Promise<{ deactivated: number; via: 'stored' | 'lookup' | 'none' }> {
  try {
    const stored = await getBookingPaymentLinkId(booking.id);
    const ids = stored ? [stored] : await findActivePaymentLinksForBooking(booking.id, { fetchImpl: opts.fetchImpl });
    const via = stored ? 'stored' as const : ids.length > 0 ? 'lookup' as const : 'none' as const;
    let deactivated = 0;
    for (const id of ids) {
      if (!(await deactivatePaymentLink(id, opts.fetchImpl))) continue;
      deactivated++;
      await recordAudit({ actor_kind: 'system', business_id: booking.business_id, action: 'booking.payment_link_deactivated', target: `booking:${booking.id}`, meta: { link: id, ...(via === 'lookup' ? { via: 'stripe_lookup' } : {}) } });
    }
    return { deactivated, via };
  } catch (err) {
    log.warn('cancel_deactivate.failed', { booking: booking.id, err });
    return { deactivated: 0, via: 'none' };
  }
}
