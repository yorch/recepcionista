import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBooking, getBusiness, updateBooking } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { appUrl, createPaymentLink } from '@/lib/providers/stripe';
import { checkoutRefundNote } from '@/lib/refunds';
import { rememberPaymentLink } from '@/lib/payments/link-store';
import { depositPolicyOf } from '@/lib/business-config';
import { resolveDepositAmount } from '@/lib/payments/deposit';
import type { PaymentLink } from '@/lib/types';

export const dynamic = 'force-dynamic';


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

    const found = body.booking_id ? await getBooking(body.booking_id) : null;
    if (body.booking_id && (!found || found.business_id !== business.id)) return fail('booking not found', 404);

    if (found?.status === 'cancelled') return fail('the booking is cancelled; a deposit link cannot be created for it', 409);
    if (found?.deposit_paid) return fail('the deposit of this booking is already paid', 409);
    // Policy-bound: an explicit amount must lie inside the business's deposit policy (or the platform limits without one);
    // without an amount the stored / computed one is used.
    const decision = resolveDepositAmount({
      policy: depositPolicyOf(business), priceEstimateCents: found?.price_estimate ?? null, requestedCents: body.amount_cents,
      storedCents: found?.deposit_amount ?? null, actor: 'owner',
    });
    if (!decision.ok) return fail(decision.error, 422);
    const cents = decision.cents;
    const link = await createPaymentLink(
      cents,
      body.description?.trim() || `${business.name} deposit`,
      business.name,
      { bookingId: found?.id ?? null, businessId: business.id, refundNote: checkoutRefundNote(business, appUrl()) },
    );
    if (found && !found.deposit_paid) await updateBooking(found.id, { deposit_amount: cents });
    if (found && !link.mock) await rememberPaymentLink(found.id, link.id);

    return ok<CreateLinkResult>({ ...link, booking_id: found?.id ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
