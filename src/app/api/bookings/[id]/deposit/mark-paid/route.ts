import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, getBookingPaymentLinkId, markDepositPaidManually, recordAudit } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { deactivatePaymentLink } from '@/lib/providers/stripe';
import { limitRequest } from '@/lib/ratelimit';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The most a manual deposit can be recorded for: the same sanity cap as a price estimate ($100k). */
const MAX_MANUAL_CENTS = 10_000_000;

export interface MarkPaidResult { booking: Booking; changed: boolean; amount_cents: number }

/**
 * POST /api/bookings/:id/deposit/mark-paid   { amount_cents?: number }   OWNER (or admin), STEP-UP (recent password / 2FA): the owner says the deposit
 * arrived outside Stripe (cash, Zelle...). Stored with deposit_source = 'manual', who and when, audited (`booking.deposit_marked_manual`).
 * Never touches Stripe money: a manual deposit can never be refunded through Stripe (refund answers 409 `manual_deposit`; the owner records a manual refund).
 * The booking's open Stripe link is deactivated so the customer cannot pay twice. Idempotent for the same amount. A deposit already paid by Stripe is 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/deposit-mark', 10);
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const denied = requireRecentAuth(auth);
    if (denied) return denied;
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({} as Record<string, unknown>));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'amount_cents') return fail(`field "${k}" cannot be set here`, 422);
    let amount: number | undefined;
    if (body.amount_cents !== undefined) {
      const n = body.amount_cents;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > MAX_MANUAL_CENTS) return fail(`amount_cents must be a whole number of cents between 100 and ${MAX_MANUAL_CENTS}`, 422);
      amount = n;
    }
    const actor = auditActorOf(auth.principal);
    const out = await markDepositPaidManually(booking.business_id, id, { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req) }, { amount_cents: amount ?? null });
    if (!out.ok) {
      const map: Record<string, [number, string]> = {
        not_found: [404, 'booking not found'], cancelled: [409, 'the booking is cancelled; a deposit cannot be marked as paid'],
        already_paid: [409, 'the deposit of this booking is already paid'], invalid_amount: [422, 'enter the amount received (the booking has no deposit amount yet)'],
        not_manual: [409, 'the deposit was not paid manually'], refunded: [409, 'a refund is recorded for this deposit'],
      };
      const [status, error] = map[out.reason] ?? [409, 'could not mark the deposit as paid'];
      return fail(error, status);
    }
    if (out.changed) {
      // The open Stripe link must stop taking money (best effort, short timeout; the webhook still alerts the owner if it is paid anyway).
      const linkId = await getBookingPaymentLinkId(id).catch(() => null);
      if (linkId && await deactivatePaymentLink(linkId, fetch, 4_000)) {
        await recordAudit({ actor_kind: 'system', business_id: booking.business_id, action: 'booking.payment_link_deactivated', target: `booking:${id}`, meta: { link: linkId, reason: 'deposit_marked_manual' } });
      }
      await emitBookingChanged(id, 'updated', booking.business_id);
    }
    return ok<MarkPaidResult>({ booking: out.booking, changed: out.changed, amount_cents: out.booking.deposit_amount ?? 0 });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
