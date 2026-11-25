import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, getBusiness, getCall, recordAudit, transitionBooking } from '@/lib/db';
import { cancelBooking, type NoticeResult } from '@/lib/booking-changes';
import { editDashboardBooking, validateBookingFields } from '@/lib/booking-manual';
import { parseScheduledAt, tzOf } from '@/lib/time';
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

export interface BookingEditResult {
  booking: Booking;
  changed: boolean;
  /** The time or length changed (the reschedule engine ran). */
  moved: boolean;
  notice: NoticeResult | null;
}

/** The `reason` the dashboard sends to record a no-show (a cancellation after the start; the slot is already past). */
export const NO_SHOW_REASON = 'no_show';
const PATCH_FIELDS = ['status', 'notify', 'reason', 'customer_name', 'customer_phone', 'service', 'address', 'price_estimate', 'scheduled_at', 'duration_minutes'];

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
 * With NO status: an EDIT, { customer_name?, customer_phone?, service?, address?, price_estimate? (cents), scheduled_at?, duration_minutes?, notify? }
 * (a new time / length runs the reschedule engine: hours, closed dates, per-crew overlap, Google busy; audited `booking.edited` / `booking.rescheduled`).
 * A no-show is `{ status: 'cancelled', reason: 'no_show', notify: false }` and only after the start time.
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
    for (const k of Object.keys(body)) if (!PATCH_FIELDS.includes(k)) return fail(`field "${k}" cannot be updated here`, 422);
    if (body.notify !== undefined && typeof body.notify !== 'boolean') return fail('notify must be true or false', 422);
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) return fail('reason must be text of at most 500 characters', 422);

    // EDIT (no status): name, number, service, address, price estimate, and a new time / length (through the reschedule engine).
    if (body.status === undefined) {
      const editKeys = Object.keys(body).filter((k) => k !== 'notify' && k !== 'reason');
      if (editKeys.length === 0) return fail('status must be "cancelled" or "completed", or send the fields to change', 422);
      if (body.reason !== undefined) return fail('reason applies to a status change only', 422);
      if (body.duration_minutes !== undefined && (typeof body.duration_minutes !== 'number' || !Number.isFinite(body.duration_minutes) || body.duration_minutes <= 0)) return fail('duration_minutes must be a positive number', 422);
      const business = await getBusiness(booking.business_id);
      if (!business) return fail('business not found', 404);
      const fields = validateBookingFields(body, business, true);
      if (!fields.ok) return fail(fields.error, 422);
      let when: string | undefined;
      if (body.scheduled_at !== undefined) {
        const parsed = parseScheduledAt(body.scheduled_at, tzOf(business));
        if (!parsed.ok) return fail('scheduled_at must be a date and time, e.g. 2026-12-05T09:00:00', 422);
        when = parsed.date.toISOString();
      }
      const a = auditActorOf(auth.principal);
      const out = await editDashboardBooking({
        businessId: booking.business_id, bookingId: id, fields: fields.value, scheduled_at: when,
        duration_minutes: body.duration_minutes as number | undefined, notify: body.notify as boolean | undefined,
        actor: { kind: a.actor_kind, user_id: a.actor_user_id, ip: clientKey(req), meta: { ...a.meta } },
      });
      if (!out.ok) return fail(out.error, out.status);
      return ok<BookingEditResult>({ booking: out.booking, changed: out.changed, moved: out.moved, notice: out.notice });
    }
    if (body.status !== 'cancelled' && body.status !== 'completed') return fail('status must be "cancelled" or "completed"', 422);
    if (Object.keys(body).some((k) => !['status', 'notify', 'reason'].includes(k))) return fail('a status change cannot be combined with other fields', 422);
    // A no-show is a cancellation after the job's start time; nobody is texted unless the owner says so.
    if (body.status === 'cancelled' && body.reason === NO_SHOW_REASON && new Date(booking.scheduled_at).getTime() > Date.now()) {
      return fail('a booking can only be marked a no-show after it started', 409);
    }
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
