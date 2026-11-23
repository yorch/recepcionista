import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import type { Lang } from '@/lib/messaging/templates';
import { createAndSendPaymentLink } from '@/lib/messaging/actions';
import { limitRequest } from '@/lib/ratelimit';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface PaymentLinkSmsResult {
  sms: SmsLog;
  link: { url: string; id: string; amount_cents: number; mock: boolean };
  body: string;
}

export async function POST(req: Request) {
  const limited = limitRequest(req, 'sms/payment-link', 10);
  if (limited) return limited;
  try {
    const body = await readJson<{
      business_id?: string;
      booking_id?: string;
      to?: string;
      amount_cents?: number;
      description?: string;
      language?: Lang;
    }>(req);

    const business = body.business_id ? await getBusiness(body.business_id) : null;
    if (!business) return fail('business not found', 404);
    if (!body.to) return fail('to is required', 422);

    const amountCents = Number(body.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 50000) {
      return fail('amount_cents must be between 100 and 50000', 422);
    }

    // Always generate the link server-side; any caller-supplied `url` is ignored
    // (otherwise this route is an open "SMS arbitrary link" primitive).
    const booking = body.booking_id ? await getBooking(body.booking_id) : null;
    if (booking && booking.business_id !== business.id) return fail('booking not found', 404);
    const { sms, body: text, link } = await createAndSendPaymentLink({
      business,
      booking,
      to: body.to,
      amountCents,
      description: body.description,
      language: body.language,
    });

    return ok<PaymentLinkSmsResult>({
      sms,
      link: { url: link.url, id: link.id, amount_cents: link.amount_cents, mock: link.mock },
      body: text,
    });
  } catch (err) {
    return fail(err, 500);
  }
}
