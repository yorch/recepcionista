import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import { ownerEscalationSms, reviewRequestSms, reviewUrl } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export type GratitudeRoute = 'review' | 'owner';

export interface GratitudeReplyResult {
  routed: GratitudeRoute;
  sms: SmsLog | null;
  body: string;
}

/**
 * The decision point of the gratitude loop. A 4–5 gets a public review ask; a
 * 1–3 never does — it goes straight to the owner's phone, because a bad review
 * is permanent and a callback is not.
 */
export async function POST(req: Request) {
  try {
    const { booking_id, rating } = await readJson<{
      booking_id?: string;
      rating?: number | string;
    }>(req);
    if (!booking_id) return fail('booking_id is required', 422);

    const score = Number(rating);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return fail('rating must be a number from 1 to 5', 422);
    }

    const booking = await getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    const business = await getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    if (score >= 4) {
      const body = reviewRequestSms({ business, booking, reviewUrl: reviewUrl() });
      const { sms } = await sendAndLog({
        business_id: business.id,
        to: booking.customer_phone,
        body,
        kind: 'review_request',
      booking_id: booking?.id ?? null,
      });
      return ok<GratitudeReplyResult>({ routed: 'review', sms, body });
    }

    const body = ownerEscalationSms({
      business,
      customer: `${booking.customer_name} (${booking.customer_phone})`,
      reason: `rated the ${booking.service} ${score}/5`,
    });

    // No owner number on file: still report the routing so the dashboard can act.
    if (!business.owner_phone) {
      return ok<GratitudeReplyResult>({ routed: 'owner', sms: null, body });
    }

    const { sms } = await sendAndLog({
      business_id: business.id,
      to: business.owner_phone,
      body,
      kind: 'owner_alert',
      booking_id: booking?.id ?? null,
    });
    return ok<GratitudeReplyResult>({ routed: 'owner', sms, body });
  } catch (err) {
    return fail(err, 500);
  }
}
