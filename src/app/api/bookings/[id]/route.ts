import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, getCall, recordAudit, transitionBooking } from '@/lib/db';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface BookingDetail {
  booking: Booking;
  /** The call that produced the booking (its summary doubles as the job's notes), or null. */
  call: { id: string; summary: string | null; flagged_reason: string | null; caller_name: string | null; started_at: string } | null;
}

/** GET /api/bookings/:id  Staff+ (read-only). A booking of another business is a 404. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const call = booking.call_id ? await getCall(booking.call_id) : null;
    return ok<BookingDetail>({
      booking,
      call: call && call.business_id === booking.business_id
        ? { id: call.id, summary: call.summary ?? null, flagged_reason: call.flagged_reason ?? null, caller_name: call.caller_name ?? null, started_at: call.started_at }
        : null,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

export interface BookingPatchResult {
  booking: Booking;
  /** False when the booking was already in the requested status (nothing was written, no audit row). */
  changed: boolean;
  /** Set when a cancelled booking had a paid deposit: refunds are not automatic (see docs/runbook.md). */
  deposit_refund_needed: boolean;
}

/**
 * PATCH /api/bookings/:id   { status: 'cancelled' | 'completed' }   OWNER (or admin) only; staff are read-only.
 * Cancel: pending/confirmed only (frees the slot). Complete: pending/confirmed, and only after the job has started.
 * Idempotent (repeating the same change is a 200 with changed:false). Audited: booking.cancelled / booking.completed.
 * Same-origin is enforced for cookie sessions by `authenticate`. Cancelling does NOT refund a paid deposit; the response flags it.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'status') return fail(`field "${k}" cannot be updated here`, 422);
    if (body.status !== 'cancelled' && body.status !== 'completed') return fail('status must be "cancelled" or "completed"', 422);

    const result = await transitionBooking(booking.business_id, id, body.status);
    if (!result.ok) {
      if (result.reason === 'not_found') return fail('booking not found', 404);
      if (result.reason === 'not_started') return fail('this job has not started yet; it can be marked completed once it has', 409);
      return fail(`a ${result.current ?? 'closed'} booking cannot be ${body.status === 'cancelled' ? 'cancelled' : 'marked completed'}`, 409);
    }
    if (result.changed) {
      await recordAudit({
        actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token',
        actor_user_id: auth.principal.user?.id ?? null,
        business_id: booking.business_id,
        action: body.status === 'cancelled' ? 'booking.cancelled' : 'booking.completed',
        target: `booking:${id}`,
        ip: clientKey(req),
        meta: { from: result.previous, deposit_paid: result.booking.deposit_paid },
      });
    }
    return ok<BookingPatchResult>({
      booking: result.booking,
      changed: result.changed,
      deposit_refund_needed: body.status === 'cancelled' && result.booking.deposit_paid,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
