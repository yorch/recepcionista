import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, getBusiness, recordAudit, setDepositAmountIfUnpaid } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { depositPolicyOf } from '@/lib/business-config';
import { resolveDepositAmount } from '@/lib/payments/deposit';
import { createAndSendPaymentLink } from '@/lib/messaging/actions';
import { smsDelivered } from '@/lib/messaging/delivery';
import { BookingCancelledError, rememberPaymentLink } from '@/lib/payments/link-store';
import { appUrl, createPaymentLink, hasStripe } from '@/lib/providers/stripe';
import { checkoutRefundNote } from '@/lib/refunds';
import type { Booking, SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface DepositRequestResult {
  booking: Booking;
  amount_cents: number;
  /** 'policy' (computed from the business's deposit policy), 'stored' (a resend keeps what was agreed), 'owner' (an amount the owner typed, inside the policy's range). */
  source: 'policy' | 'stored' | 'owner';
  /** True when the booking already had a deposit amount requested: this is a re-send (the older link is deactivated). */
  resent: boolean;
  link: { id: string; url: string; mock: boolean };
  /** What happened to the text (null: `send: false`, the owner copies the link). */
  sms: { status: SmsLog['status']; delivered: boolean } | null;
}

/**
 * POST /api/bookings/:id/deposit   { amount_cents?: number, send?: boolean }   OWNER (or admin). Requests a deposit (or re-sends it) with the
 * existing payment-link logic, policy-bound: with no `amount_cents` the amount is the booking's stored deposit (a re-send) or the policy's computed
 * amount; an explicit amount must lie inside the policy's min/max (the platform limits when the business has no policy). `send: false` only creates the
 * link and returns it. Refused for a cancelled booking or an already-paid deposit. In production a missing Stripe key answers 503 (never a demo link).
 * The previous link of the booking is deactivated (link-store). Audited (`booking.deposit_requested`).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/deposit', 10, 60_000, { globalLimit: 500 });
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({} as Record<string, unknown>));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'amount_cents' && k !== 'send') return fail(`field "${k}" cannot be set here`, 422);
    if (body.send !== undefined && typeof body.send !== 'boolean') return fail('send must be true or false', 422);
    const send = body.send !== false;
    const business = await getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    if (booking.status === 'cancelled') return fail('the booking is cancelled; a deposit link cannot be created for it', 409);
    if (booking.deposit_paid) return fail('the deposit of this booking is already paid', 409);
    if (send && (booking.anonymized_at || !booking.customer_phone)) return fail('booking has no customer phone on file', 422);
    if (process.env.NODE_ENV === 'production' && !hasStripe()) return fail('payments_not_configured', 503);

    const decision = resolveDepositAmount({
      policy: depositPolicyOf(business), priceEstimateCents: booking.price_estimate ?? null, requestedCents: body.amount_cents,
      storedCents: booking.deposit_amount ?? null, actor: 'owner', plan: business.plan ?? null,
    });
    if (!decision.ok) return fail(decision.error, 422);
    const resent = (booking.deposit_amount ?? 0) > 0;

    let link: { id: string; url: string; mock: boolean };
    let sms: DepositRequestResult['sms'] = null;
    try {
      if (send) {
        const sent = await createAndSendPaymentLink({ business, booking, to: booking.customer_phone, amountCents: decision.cents });
        link = { id: sent.link.id, url: sent.link.url, mock: sent.link.mock };
        sms = { status: sent.sms.status, delivered: smsDelivered(sent.sms.status) };
      } else {
        const made = await createPaymentLink(decision.cents, `${business.name} deposit — ${booking.service}`, business.name, {
          bookingId: booking.id, businessId: business.id, refundNote: checkoutRefundNote(business, appUrl()),
        });
        await setDepositAmountIfUnpaid(booking.id, decision.cents);
        if (!made.mock) await rememberPaymentLink(booking.id, made.id);
        link = { id: made.id, url: made.url, mock: made.mock };
      }
    } catch (err) {
      if (err instanceof BookingCancelledError) return fail(err.message, 409);
      throw err;
    }
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: booking.business_id, action: 'booking.deposit_requested',
      target: `booking:${booking.id}`, ip: clientKey(req),
      meta: { ...actor.meta, amount_cents: decision.cents, source: decision.source, resent, send, sms_status: sms?.status ?? null },
    });
    return ok<DepositRequestResult>({ booking: (await getBooking(booking.id)) ?? booking, amount_cents: decision.cents, source: decision.source, resent, link, sms });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
