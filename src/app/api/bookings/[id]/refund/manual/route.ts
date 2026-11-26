import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking } from '@/lib/db';
import { recordManualRefund } from '@/lib/refund-service';
import { limitRequest } from '@/lib/ratelimit';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface ManualRefundRouteResult { booking: Booking; amount_cents: number; replayed: boolean }

/**
 * POST /api/bookings/:id/refund/manual   { amount_cents?: number }   OWNER (or admin), STEP-UP: record that the owner refunded a MANUAL deposit
 * themselves (cash, Zelle...). Bookkeeping only: no provider is called and the customer is not texted. Only a deposit marked as paid manually
 * qualifies (a card deposit is refunded through POST /api/bookings/:id/refund). Full amount when `amount_cents` is omitted. Audited
 * (`booking.refund_recorded_manual`). Idempotent for the same amount.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/refund', 10);
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
    const actor = auditActorOf(auth.principal);
    const out = await recordManualRefund({
      businessId: booking.business_id, bookingId: id, amount_cents: body.amount_cents,
      actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
    });
    if (!out.ok) return Response.json({ ok: false, error: out.error, code: out.code }, { status: out.status, headers: { 'cache-control': 'no-store' } });
    return ok<ManualRefundRouteResult>({ booking: out.booking, amount_cents: out.amount_cents, replayed: out.replayed });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
