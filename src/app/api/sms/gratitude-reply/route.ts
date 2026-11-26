import { fail, ok } from '@/lib/http';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { resolveInboundRoute } from '@/lib/messaging/sender';
import { handleAmbiguousInbound } from '@/lib/messaging/inbound-ambiguous';
import { mockSmsAllowed } from '@/lib/messaging/delivery';
import { getBooking, getBusiness, getBusinessByPhone } from '@/lib/db';
import { applyInboundKeyword } from '@/lib/messaging/inbound';
import { routeGratitudeReply, GratitudeReplyError } from '@/lib/gratitude/reply';
import type { GratitudeReplyResult, GratitudeRoute } from '@/lib/gratitude/reply';

export const dynamic = 'force-dynamic';

export type { GratitudeReplyResult, GratitudeRoute };

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });

/**
 * Rating replies (1-5) to the gratitude text. Kept for deployments whose Twilio number still points here:
 * STOP-class keywords are honoured FIRST (same handling as /api/sms/inbound, which is the URL to configure),
 * only then is the body read as a rating.
 */
export async function POST(req: Request) {
  try {
    // Twilio posts form-encoded (signed). JSON is accepted only where the signature check is skipped (dev).
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    const fields: Record<string, string> = {};
    let jsonBody: { booking_id?: string; rating?: number | string } = {};
    if (isJson) {
      jsonBody = await req.json().catch(() => ({}));
    } else {
      (await req.formData().catch(() => new FormData())).forEach((v, k) => {
        if (typeof v === 'string') fields[k] = v;
      });
    }
    const verdict = verifyTwilioSignature(req, fields);
    if (!verdict.ok) return fail('forbidden', 403);

    const query = new URL(req.url).searchParams;
    const booking_id = isJson ? jsonBody.booking_id : (fields.booking_id ?? query.get('booking_id') ?? undefined);

    if (!isJson && fields.From) {
      // Opt-out keywords first: a STOP must never be answered with "rating must be a number".
      const booking = booking_id ? await getBooking(booking_id) : null;
      let business = booking ? await getBusiness(booking.business_id) : null;
      // No booking in the request: the number the text was sent to decides, exactly as in /api/sms/inbound (a tenant's own number, else the recorded sender only).
      if (!business && fields.To) {
        const route = await resolveInboundRoute(await getBusinessByPhone(fields.To), fields.To, fields.From, new Date(), mockSmsAllowed() ? ['sent', 'mock'] : ['sent']);
        if (route.kind === 'ambiguous') return xml(await handleAmbiguousInbound(route.candidates, fields.From, fields.Body));
        business = route.business;
      }
      if (business) {
        const reply = await applyInboundKeyword(business, fields.From, fields.Body);
        if (reply) return xml(reply);
      }
    }

    const rating = isJson ? jsonBody.rating : (fields.rating ?? fields.Body ?? query.get('rating') ?? undefined);
    if (!booking_id) return fail('booking_id is required', 422);

    const score = Number(rating);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return fail('rating must be a number from 1 to 5', 422);
    }
    return ok<GratitudeReplyResult>(await routeGratitudeReply(booking_id, score));
  } catch (err) {
    if (err instanceof GratitudeReplyError) return fail(err.message, err.status);
    return fail(err, 500);
  }
}
