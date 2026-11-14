import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import {
  ownerEscalationSms, reviewRequestSms, reviewUrl,
} from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';

export const dynamic = 'force-dynamic';

/**
 * The gratitude loop's decision point: a happy customer is asked for a review,
 * an unhappy one never is — they go straight to the owner.
 */
export async function POST(req: Request) {
  try {
    const { booking_id, rating } = await readJson<{ booking_id: string; rating: number | string }>(req);
    if (!booking_id) return fail('booking_id is required', 422);

    const score = Number(rating);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return fail('rating must be 1-5', 422);
    }

    const booking = getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    const business = getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    if (score >= 4) {
      const body = reviewRequestSms({ business, booking, reviewUrl: reviewUrl() });
      const result = await sendAndLog({
        business_id: business.id,
        to: booking.customer_phone,
        body,
        kind: 'review_request',
      });
      return ok({ routed: 'review' as const, sms: result.sms, body });
    }

    const reason = `Rated the ${booking.service} ${score}/5`;
    if (business.owner_phone) {
      await sendAndLog({
        business_id: business.id,
        to: business.owner_phone,
        body: ownerEscalationSms({
          business,
          customer: booking.customer_name,
          reason,
        }),
        kind: 'owner_alert',
      });
    }
    return ok({ routed: 'owner' as const, reason });
  } catch (err) {
    return fail(err, 500);
  }
}
