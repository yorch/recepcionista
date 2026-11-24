import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, getBusiness, getCall, recordAudit, transitionBooking } from '@/lib/db';
import { cancelBooking, type NoticeResult } from '@/lib/booking-changes';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { bookingRefundEligibility, POLICY_LABEL, type Eligibility } from '@/lib/refunds';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface BookingDetail {
  booking: Booking;
  /** The call that produced the booking (its summary doubles as the job's notes), or null. */
  call: { id: string; summary: string | null; flagged_reason: string | null; caller_name: string | null; started_at: string } | null;
  /** What the business's refund policy says about this booking's PAID deposit right now (null: no paid deposit). */
  refund: (Eligibility & { policy_label: string }) | null;
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
    const business = booking.deposit_paid ? await getBusiness(booking.business_id) : null;
    const eligibility = business ? bookingRefundEligibility(booking, business.refund_policy) : null;
    return ok<BookingDetail>({
      refund: eligibility ? { ...eligibility, policy_label: POLICY_LABEL[eligibility.policy] } : null,
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
  /** Set when a cancelled booking has a paid deposit that the owner can still refund (the app never refunds on its own): see `refund`. */
  deposit_refund_needed: boolean;
  /** Cancelled only: what the refund policy says about the paid deposit at the moment of cancellation. */
  refund: Eligibility | null;
  /** Cancelled only: what happened to the customer's text (null: nothing was sent or asked). */
  notice: NoticeResult | null;
}

/**
 * PATCH /api/bookings/:id   { status: 'cancelled' | 'completed', notify?: boolean, reason?: string }   OWNER (or admin) only; staff are read-only.
 * Cancel: pending/confirmed only (frees the slot). Complete: pending/confirmed, and only after the job has started.
 * Idempotent (repeating the same change is a 200 with changed:false). Audited: booking.cancelled / booking.completed.
 * Same-origin is enforced for cookie sessions by `authenticate`. Cancelling texts the customer (policy-aware: a paid deposit is described as
 * refundable or not by the business's refund policy; opt-outs, quiet hours and the SMS cap apply; `notify:false` skips the text) and
 * answers with the policy verdict. It never refunds by itself: POST /api/bookings/:id/refund does, on an explicit owner action.
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
    for (const k of Object.keys(body)) if (k !== 'status' && k !== 'notify' && k !== 'reason') return fail(`field "${k}" cannot be updated here`, 422);
    if (body.status !== 'cancelled' && body.status !== 'completed') return fail('status must be "cancelled" or "completed"', 422);
    if (body.notify !== undefined && typeof body.notify !== 'boolean') return fail('notify must be true or false', 422);
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) return fail('reason must be text of at most 500 characters', 422);
    const actor = auditActorOf(auth.principal);

    if (body.status === 'cancelled') {
      const out = await cancelBooking({
        businessId: booking.business_id, bookingId: id, notify: body.notify as boolean | undefined, reason: (body.reason as string | undefined) ?? null,
        actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
      });
      if (!out.ok) {
        if (out.reason === 'not_found') return fail('booking not found', 404);
        return fail(`a ${out.current ?? 'closed'} booking cannot be cancelled`, 409);
      }
      return ok<BookingPatchResult>({
        booking: out.booking, changed: out.changed, refund: out.refund, notice: out.notice,
        deposit_refund_needed: out.booking.deposit_paid && out.refund.eligible && out.booking.refund_status !== 'refunded',
      });
    }

    const result = await transitionBooking(booking.business_id, id, 'completed');
    if (!result.ok) {
      if (result.reason === 'not_found') return fail('booking not found', 404);
      if (result.reason === 'not_started') return fail('this job has not started yet; it can be marked completed once it has', 409);
      return fail(`a ${result.current ?? 'closed'} booking cannot be marked completed`, 409);
    }
    if (result.changed) {
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: booking.business_id,
        action: 'booking.completed', target: `booking:${id}`, ip: clientKey(req), meta: { ...actor.meta, from: result.previous, deposit_paid: result.booking.deposit_paid },
      });
      await emitBookingChanged(id, 'completed', booking.business_id);
    }
    return ok<BookingPatchResult>({ booking: result.booking, changed: result.changed, deposit_refund_needed: false, refund: null, notice: null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
