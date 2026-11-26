import { fail, ok } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, unmarkManualDeposit } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { limitRequest } from '@/lib/ratelimit';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/bookings/:id/deposit/unmark   OWNER (or admin), STEP-UP: undo a MANUAL "deposit paid" mark (the money did not arrive after all).
 * Only a manual deposit with no refund recorded; a Stripe payment is refunded, never unmarked. Audited (`booking.deposit_unmarked_manual`).
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
    const actor = auditActorOf(auth.principal);
    const out = await unmarkManualDeposit(booking.business_id, id, { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req) });
    if (!out.ok) {
      if (out.reason === 'not_found') return fail('booking not found', 404);
      if (out.reason === 'refunded') return fail('a refund is recorded for this deposit', 409);
      if (out.reason === 'card_payment_on_file') return fail('a card payment is on file for this deposit: refund it instead of unmarking', 409);
      return fail('only a deposit marked as paid manually can be unmarked', 409);
    }
    await emitBookingChanged(id, 'updated', booking.business_id);
    return ok<{ booking: Booking }>({ booking: out.booking });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
