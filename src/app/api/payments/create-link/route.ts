import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBooking, getBusiness, setBookingPaymentLink, updateBooking } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { appUrl, createPaymentLink } from '@/lib/providers/stripe';
import { checkoutRefundNote } from '@/lib/refunds';
import type { PaymentLink } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const MIN_CENTS = 100; // $1 — Stripe's floor
export const MAX_CENTS = 50_000; // $500 — the deposit cap in the call script

export interface CreateLinkResult extends PaymentLink {
  mock: boolean;
  booking_id: string | null;
}

export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // money: owner+
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'payments/create-link', 20);
  if (limited) return limited;
  try {
    const body = await readJson<{
      business_id?: string;
      amount_cents?: number;
      description?: string;
      booking_id?: string;
    }>(req);

    const scoped = scopeBusinessId(auth.principal, body.business_id);
    if (scoped) requireBusinessAccess(auth.principal, scoped);
    const business = scoped ? await getBusiness(scoped) : null;
    if (!business) return fail('business not found', 404);

    const amountCents = Number(body.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
      return fail(`amount_cents must be between ${MIN_CENTS} and ${MAX_CENTS}`, 422);
    }

    const found = body.booking_id ? await getBooking(body.booking_id) : null;
    if (body.booking_id && (!found || found.business_id !== business.id)) return fail('booking not found', 404);

    const cents = Math.round(amountCents);
    const link = await createPaymentLink(
      cents,
      body.description?.trim() || `${business.name} deposit`,
      business.name,
      { bookingId: found?.id ?? null, businessId: business.id, refundNote: checkoutRefundNote(business, appUrl()) },
    );
    if (found && !found.deposit_paid) await updateBooking(found.id, { deposit_amount: cents });
    if (found && !link.mock) await setBookingPaymentLink(found.id, link.id);

    return ok<CreateLinkResult>({ ...link, booking_id: found?.id ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
