/**
 * The decision point of the gratitude loop, shared by the HTTP route and the inbound-SMS handler.
 * A 4-5 gets a public review ask; a 1-3 never does: it goes straight to the owner's phone, because a bad
 * review is permanent and a callback is not.
 */
import { getBooking, getBusiness } from '@/lib/db';
import { ownerEscalationSms, reviewLinkOf, reviewRequestSms } from '@/lib/messaging/templates';
import { customerLanguage } from '@/lib/booking-changes';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export type GratitudeRoute = 'review' | 'owner';

export interface GratitudeReplyResult {
  routed: GratitudeRoute;
  sms: SmsLog | null;
  body: string;
}

export class GratitudeReplyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function routeGratitudeReply(bookingId: string, score: number): Promise<GratitudeReplyResult> {
  const booking = await getBooking(bookingId);
  if (!booking) throw new GratitudeReplyError('booking not found', 404);
  const business = await getBusiness(booking.business_id);
  if (!business) throw new GratitudeReplyError('business not found', 404);

  if (score >= 4) {
    // The business's OWN review link; with none set the text only says thanks (never a placeholder or another business's link).
    const lang = await customerLanguage(booking, business);
    const body = reviewRequestSms({ business, booking, reviewUrl: reviewLinkOf(business), language: lang === 'es' ? 'es' : 'en' });
    const { sms } = await sendAndLog({
      business_id: business.id,
      to: booking.customer_phone,
      body,
      kind: 'review_request',
      booking_id: booking.id,
      // The customer just answered our follow-up text themselves.
      consent_basis: 'customer_reply',
    });
    return { routed: 'review', sms, body };
  }

  const body = ownerEscalationSms({
    business,
    customer: `${booking.customer_name} (${booking.customer_phone})`,
    reason: `rated the ${booking.service} ${score}/5`,
  });
  // No owner number on file: still report the routing so the dashboard can act.
  if (!business.owner_phone) return { routed: 'owner', sms: null, body };

  const { sms } = await sendAndLog({
    business_id: business.id,
    to: business.owner_phone,
    body,
    kind: 'owner_alert',
    booking_id: booking.id,
  });
  return { routed: 'owner', sms, body };
}
