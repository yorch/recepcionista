import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, auditActorOf, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking } from '@/lib/db';
import { checkPendingRefund } from '@/lib/refund-service';
import { limitRequest } from '@/lib/ratelimit';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface RefundCheckRouteResult {
  /** 'adopted_refunded' | 'adopted_pending': Stripe already had the refund; 'marked_failed': it never reached Stripe (or failed) and may be sent again; 'unchanged'. */
  result: 'adopted_refunded' | 'adopted_pending' | 'marked_failed' | 'unchanged';
  booking: Booking;
  refund_id: string | null;
}

/**
 * POST /api/bookings/:id/refund/check   OWNER (or admin), step-up (recent password / 2FA): "Check with Stripe" for a refund that stayed pending.
 * Lists Stripe's refunds for the booking's payment and resolves the pending one: adopts the refund Stripe has, or marks it failed (so it can be
 * sent again with a new key) when Stripe has none and the attempt is old enough. It never creates a refund. Audited. 409 `too_early` while the
 * attempt is younger than 30 minutes, 502 `unavailable` when Stripe cannot be reached.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/refund-check', 10);
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const denied = requireRecentAuth(auth);
    if (denied) return denied;
    const actor = auditActorOf(auth.principal);
    const out = await checkPendingRefund({
      businessId: booking.business_id, bookingId: id,
      actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
    });
    if (!out.ok) return Response.json({ ok: false, error: out.error, code: out.code }, { status: out.status, headers: { 'cache-control': 'no-store' } });
    return ok<RefundCheckRouteResult>({ result: out.result, booking: out.booking, refund_id: out.refund_id ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
