import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import { paymentLinkSms, type Lang } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import { createPaymentLink } from '@/lib/providers/stripe';

export const dynamic = 'force-dynamic';

/**
 * Accepts a pre-built url from the voice tool (createPaymentLink already made
 * the link) or creates one here. Creating twice would mean two Stripe objects
 * for one deposit, so the provided url always wins.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<{
      business_id: string;
      booking_id?: string;
      to: string;
      amount_cents: number;
      description?: string;
      language?: Lang;
      url?: string;
    }>(req);

    if (!body.business_id || !body.to || !body.amount_cents) {
      return fail('business_id, to and amount_cents are required', 422);
    }
    const business = getBusiness(body.business_id);
    if (!business) return fail('business not found', 404);

    const booking = body.booking_id ? getBooking(body.booking_id) : null;
    const description = body.description ?? `${business.name} emergency deposit`;

    let link = { url: body.url ?? '', id: '', amount_cents: body.amount_cents, mock: true };
    if (!body.url) {
      const created = await createPaymentLink(body.amount_cents, description, business.name);
      link = { url: created.url, id: created.id, amount_cents: created.amount_cents, mock: created.mock };
    }

    const text = paymentLinkSms({
      business,
      amount_cents: body.amount_cents,
      url: link.url,
      service: booking?.service,
      language: body.language ?? 'en',
    });

    const result = await sendAndLog({
      business_id: business.id,
      to: body.to,
      body: text,
      kind: 'payment_link',
    });

    return ok({ sms: result.sms, link, body: text });
  } catch (err) {
    return fail(err, 500);
  }
}
