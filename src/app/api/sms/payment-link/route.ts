import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import { paymentLinkSms, type Lang } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import { createPaymentLink } from '@/lib/providers/stripe';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface PaymentLinkSmsResult {
  sms: SmsLog;
  link: { url: string; id: string; amount_cents: number; mock: boolean };
  body: string;
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{
      business_id?: string;
      booking_id?: string;
      to?: string;
      amount_cents?: number;
      description?: string;
      language?: Lang;
      /** Pre-built link from the voice tool's create_payment_link — reuse it. */
      url?: string;
    }>(req);

    const business = body.business_id ? getBusiness(body.business_id) : null;
    if (!business) return fail('business not found', 404);
    if (!body.to) return fail('to is required', 422);

    const amountCents = Number(body.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 50000) {
      return fail('amount_cents must be between 100 and 50000', 422);
    }

    const booking = body.booking_id ? getBooking(body.booking_id) : null;
    const description = body.description?.trim()
      || `${business.name} deposit${booking ? ` — ${booking.service}` : ''}`;

    const link = body.url
      ? { url: body.url, id: '', amount_cents: amountCents, mock: true }
      : await createPaymentLink(amountCents, description, business.name);

    const text = paymentLinkSms({
      business,
      amount_cents: amountCents,
      url: link.url,
      service: booking?.service ?? description,
      language: body.language ?? 'en',
    });

    const { sms } = await sendAndLog({
      business_id: business.id,
      to: body.to,
      body: text,
      kind: 'payment_link',
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
