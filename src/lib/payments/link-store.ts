/**
 * Remember the Payment Link texted for a booking's deposit (the booking stores ONE id, the latest) and keep exactly that one payable:
 *  - the link it replaces is deactivated (a voice-tool link and a dashboard link, or two dashboard clicks, must not leave two live links),
 *  - a link made for a booking that was cancelled meanwhile (cancel raced the creation) is deactivated at once.
 * Best effort and never throws: the payments webhook still alerts the owner if a deactivated-too-late link is paid.
 */
import { getBooking, recordAudit, replaceBookingPaymentLink } from '@/lib/db';
import { logger } from '@/lib/log';
import { deactivatePaymentLink } from '@/lib/providers/stripe';

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
