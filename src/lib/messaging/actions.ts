/**
 * Library-level SMS actions shared by the HTTP routes (/api/sms/*) and in-process
 * callers (voice tools, gratitude sweep). Calling these directly avoids an
 * authenticated HTTP hop to ourselves and guarantees ONE side effect per call.
 */
import { claimEvent, countryForBusiness, findRecentSms, getBooking, getBusiness, releaseEvent, updateBooking } from '@/lib/db';
import { confirmationSms, FOLLOWUP_NOTICE_RE, gratitudeSms, paymentLinkSms, type Lang } from '@/lib/messaging/templates';
import { sameNumber } from '@/lib/phone';
import { sendAndLog } from '@/lib/messaging';
import { appUrl, createPaymentLink } from '@/lib/providers/stripe';
import { checkoutRefundNote } from '@/lib/refunds';
import { BookingCancelledError, rememberPaymentLink } from '@/lib/payments/link-store';
import type { Business, Booking, SmsLog } from '@/lib/types';

/** A voice tool can fire twice in one turn; the customer should only get one text. */
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const CLAIM_SOURCE = 'sms_send';
/** A crashed sender's claim expires on its own after this. */
const CLAIM_LEASE_MS = 60 * 1000;

export class ActionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function load(bookingId: string): Promise<{ booking: Booking; business: Business }> {
  const booking = await getBooking(bookingId);
  if (!booking) throw new ActionError('booking not found', 404);
  const business = await getBusiness(booking.business_id);
  if (!business) throw new ActionError('business not found', 404);
  return { booking, business };
}

/** Where a recorded follow-up consent came from. */
export const FOLLOWUP_CONSENT_SOURCE = 'confirmation_sms_notice';

/**
 * Text the booking confirmation. By default it goes to the booking's own number (dashboard / API use);
 * voice tools pass `to` = the VERIFIED caller number. The follow-up-text consent is recorded on the booking
 * ONLY when the confirmation, carrying the follow-up notice, was actually delivered to the booking's own
 * number: that is the sole thing that later lets a gratitude text go to that number.
 */
export async function sendConfirmation(
  bookingId: string, language: Lang = 'en', opts: { to?: string } = {},
): Promise<{ sms: SmsLog; body: string; deduped: boolean }> {
  const { booking, business } = await load(bookingId);
  const to = opts.to ?? booking.customer_phone;
  const recentOf = () => findRecentSms(business.id, { kind: 'confirmation', bookingId: booking.id, withinMs: DEDUPE_WINDOW_MS });

  // Exactly one sender per booking at a time: an atomic claim (shared Postgres row) closes the check-then-send race of two
  // concurrent calls. The claim only covers the send itself; the 2-minute "recently sent" lookup below covers sequential repeats.
  const claim = `confirmation:${booking.id}`;
  if (!(await claimEvent(CLAIM_SOURCE, claim, CLAIM_LEASE_MS))) {
    // Another request is sending right now: wait briefly for its logged row instead of sending a second text.
    for (let i = 0; i < 20; i++) {
      const done = await recentOf();
      if (done) return { sms: done, body: done.body, deduped: true };
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new ActionError('a confirmation for this booking is already being sent', 409);
  }
  try {
    const recent = await recentOf();
    if (recent) return { sms: recent, body: recent.body, deduped: true };

    const body = confirmationSms({ business, booking, language });
    const { sms } = await sendAndLog({
      business_id: business.id, to, body, kind: 'confirmation', booking_id: booking.id,
    });
    const delivered = sms.status === 'sent' || sms.status === 'mock';
    if (delivered && FOLLOWUP_NOTICE_RE.test(body) && sameNumber(to, booking.customer_phone, countryForBusiness(business))
      && !booking.followup_consent_at) {
      await updateBooking(booking.id, { followup_consent_at: new Date().toISOString(), followup_consent_source: FOLLOWUP_CONSENT_SOURCE });
    }
    return { sms, body: sms.body, deduped: false };
  } finally {
    await releaseEvent(CLAIM_SOURCE, claim);
  }
}

export async function sendGratitude(
  bookingId: string, language: Lang = 'en',
): Promise<{ sms: SmsLog; body: string }> {
  const { booking, business } = await load(bookingId);
  const body = gratitudeSms({ business, booking, language });
  // The consent basis is DERIVED from what was recorded, never asserted: no recorded follow-up consent => blocked_no_consent.
  const { sms } = await sendAndLog({
    business_id: business.id, to: booking.customer_phone, body, kind: 'gratitude', booking_id: booking.id,
    consent_basis: booking.followup_consent_at ? 'booking_followup' : null,
  });
  return { sms, body: sms.body };
}

export interface PaymentLinkInput {
  business: Business;
  booking?: Booking | null;
  to: string;
  amountCents: number;
  description?: string;
  language?: Lang;
}

/** Creates exactly one payment link, records the deposit (cents) on the booking, and texts it. */
export async function createAndSendPaymentLink(input: PaymentLinkInput) {
  const { business, booking } = input;
  if (booking && ((await getBooking(booking.id))?.status ?? booking.status) === 'cancelled') throw new BookingCancelledError();
  const amountCents = Math.round(input.amountCents);
  const description = input.description?.trim()
    || `${business.name} deposit${booking ? ` — ${booking.service}` : ''}`;

  const link = await createPaymentLink(amountCents, description, business.name, {
    bookingId: booking?.id ?? null,
    businessId: business.id,
    refundNote: checkoutRefundNote(business, appUrl()),
  });
  // Remember what is owed so the pay page and dashboard read it from the DB (cents).
  if (booking && !booking.deposit_paid) await updateBooking(booking.id, { deposit_amount: amountCents });
  if (booking && !link.mock) await rememberPaymentLink(booking.id, link.id);

  const text = paymentLinkSms({
    business, amount_cents: amountCents, url: link.url,
    service: booking?.service ?? description, language: input.language ?? 'en',
  });
  const { sms } = await sendAndLog({
    business_id: business.id, to: input.to, body: text, kind: 'payment_link', booking_id: booking?.id ?? null,
  });
  return { sms, body: sms.body, link };
}
