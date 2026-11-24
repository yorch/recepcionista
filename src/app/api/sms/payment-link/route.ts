import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
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
  const auth = await authenticate(req, { role: 'owner' }); // money + SMS: owner+
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'sms/payment-link', 10, 60_000, { globalLimit: 500 });
  if (limited) return limited;
  try {
    const body = await readJson<{
      business_id?: string;
      booking_id?: string;
      amount_cents?: number;
      language?: Lang;
      to?: unknown;
      description?: unknown;
    }>(req);
    // The recipient and the wording are server-decided: the link goes only to the booking's own number and the
    // text is built from the booking (no caller-supplied free text, no caller-supplied number).
    if (body.to !== undefined || body.description !== undefined) {
      return fail('to and description cannot be set: the link is texted to the booking\'s own number', 422);
    }

    const scoped = scopeBusinessId(auth.principal, body.business_id);
    if (scoped) requireBusinessAccess(auth.principal, scoped);
    const business = scoped ? await getBusiness(scoped) : null;
    if (!business) return fail('business not found', 404);
    if (!body.booking_id || typeof body.booking_id !== 'string') return fail('booking_id is required', 422);

    const amountCents = Number(body.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 50000) {
      return fail('amount_cents must be between 100 and 50000', 422);
    }

    // Always generate the link server-side; any caller-supplied `url` is ignored
    // (otherwise this route is an open "SMS arbitrary link" primitive).
    const booking = await getBooking(body.booking_id);
    if (!booking || booking.business_id !== business.id) return fail('booking not found', 404);
    if (booking.anonymized_at || !booking.customer_phone) return fail('booking has no customer phone on file', 422);
    if (booking.status === 'cancelled') return fail('the booking is cancelled; a deposit link cannot be created for it', 409);
    const { sms, body: text, link } = await createAndSendPaymentLink({
      business,
      booking,
      to: booking.customer_phone,
      amountCents,
      language: body.language,
    });

    return ok<PaymentLinkSmsResult>({
      sms,
      link: { url: link.url, id: link.id, amount_cents: link.amount_cents, mock: link.mock },
      body: text,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
