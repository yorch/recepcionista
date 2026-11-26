import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, auditActorOf, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { BookingRejectedError, getBooking, getBusiness, type BookingRejection } from '@/lib/db';
import { rescheduleAndNotify, type NoticeResult } from '@/lib/booking-changes';
import { parseScheduledAt, tzOf } from '@/lib/time';
import { limitRequest } from '@/lib/ratelimit';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface RescheduleRouteResult {
  booking: Booking;
  /** False when the new time equals the old one (nothing was written, nobody was texted). */
  changed: boolean;
  previous: { scheduled_at: string; duration_minutes: number };
  /** What happened to the customer's text; null when nothing changed. */
  notice: NoticeResult | null;
}

/** Owner-readable reason + status for each rejection. */
export const RESCHEDULE_REJECTIONS: Partial<Record<BookingRejection, { status: number; error: string }>> & Record<string, { status: number; error: string }> = {
  calendar_busy: { status: 409, error: 'That time is blocked on the connected calendar. Pick another.' },
  slot_taken: { status: 409, error: 'That time is no longer free. Pick another.' },
  past: { status: 422, error: 'That time is in the past.' },
  closed_day: { status: 422, error: 'The business is closed that day.' },
  closed_date: { status: 422, error: 'The business is closed that date (holiday closure).' },
  before_open: { status: 422, error: 'That is before opening time.' },
  after_close: { status: 422, error: 'The job would run past closing time.' },
  too_soon: { status: 422, error: 'That is sooner than the minimum notice the business requires.' },
  too_far: { status: 422, error: 'That is further ahead than the business takes bookings.' },
  invalid_time: { status: 422, error: 'That is not a valid date and time.' },
  not_reschedulable: { status: 409, error: 'Only a pending or confirmed booking can be moved.' },
  booking_not_found: { status: 404, error: 'booking not found' },
  business_not_found: { status: 404, error: 'business not found' },
  call_cap: { status: 422, error: 'cannot move this booking' },
  no_call: { status: 422, error: 'cannot move this booking' },
};

/**
 * POST /api/bookings/:id/reschedule   { scheduled_at: string, duration_minutes?: number, notify?: boolean }   OWNER (or admin).
 * `scheduled_at` is an instant (with Z or an offset) or LOCAL wall-clock time in the business zone (no offset), exactly like the voice tools.
 * The move is atomic (advisory lock, opening hours, overlap with every other booking, past times; see db/rescheduleBooking) and audited
 * (`booking.rescheduled`, with the previous and new time). The customer is texted unless `notify` is false; the answer reports what really
 * happened to the text (never "sent" for a blocked one). Same-origin is enforced for cookie sessions by `authenticate` (CSRF).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/reschedule', 30);
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (!['scheduled_at', 'duration_minutes', 'notify'].includes(k)) return fail(`field "${k}" cannot be set here`, 422);
    if (body.notify !== undefined && typeof body.notify !== 'boolean') return fail('notify must be true or false', 422);
    if (body.duration_minutes !== undefined && (typeof body.duration_minutes !== 'number' || !Number.isFinite(body.duration_minutes) || body.duration_minutes <= 0)) return fail('duration_minutes must be a positive number', 422);
    const business = await getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);
    const when = parseScheduledAt(body.scheduled_at, tzOf(business));
    if (!when.ok) return fail('scheduled_at must be a date and time, e.g. 2026-12-05T09:00:00', 422);

    const actor = auditActorOf(auth.principal);
    try {
      const out = await rescheduleAndNotify({
        businessId: booking.business_id, bookingId: id, scheduled_at: when.date.toISOString(),
        duration_minutes: body.duration_minutes as number | undefined, notify: body.notify as boolean | undefined,
        actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
      });
      return ok<RescheduleRouteResult>({ booking: out.booking, changed: out.result.changed, previous: out.result.previous, notice: out.notice });
    } catch (err) {
      if (err instanceof BookingRejectedError) {
        const r = RESCHEDULE_REJECTIONS[err.reason] ?? { status: 422, error: 'cannot move this booking' };
        return fail(r.error, r.status);
      }
      throw err;
    }
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
