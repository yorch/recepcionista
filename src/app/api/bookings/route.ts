import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { limitRequest } from '@/lib/ratelimit';
import { createDashboardBooking, rejectionResponse, validateBookingFields } from '@/lib/booking-manual';
import type { NoticeResult } from '@/lib/booking-changes';
import { BookingRejectedError, countryForBusiness, getBusiness, listAllBookingsInRange, listBookingsPage } from '@/lib/db';
import { defaultWeekStart, isCalendarDateKey, isCalendarView, parseWeekStart, rangeFor, type CalendarView, type WeekStart } from '@/lib/calendar';
import { localDateKey, parseScheduledAt, tzOf } from '@/lib/time';
import type { Booking } from '@/lib/types';
import type { Page } from '@/lib/db/paging';

export const dynamic = 'force-dynamic';

export interface BookingsRangeResult {
  view: CalendarView;
  date: string;
  days: string[];
  /** ISO instants of the covered range (the local days in the business zone). */
  from: string;
  to: string;
  timezone: string;
  week_start: WeekStart;
  items: Booking[];
  /** True when the (very large) range hit the server cap: narrow the view. */
  truncated: boolean;
}

/**
 * GET /api/bookings   Staff+ (read-only), scoped to the caller's business (admins pass business_id).
 *  - calendar:  ?view=week|day|month&date=YYYY-MM-DD[&ws=0|1]  -> every booking overlapping the visible range (business time zone, DST-correct)
 *  - agenda:    ?agenda=upcoming|past[&cursor=...&limit=...]    -> cursor-paginated list ({ items, next_cursor })
 */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const q = new URL(req.url).searchParams;
    const businessId = scopeBusinessId(auth.principal, q.get('business_id'));
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    const tz = tzOf(business);

    const agenda = q.get('agenda');
    if (agenda !== null) {
      if (agenda !== 'upcoming' && agenda !== 'past') return fail('agenda must be "upcoming" or "past"', 422);
      return ok<Page<Booking>>(await listBookingsPage(businessId, {
        direction: agenda, cursor: q.get('cursor'), limit: Number(q.get('limit') ?? '') || undefined,
      }));
    }

    const view = q.get('view') ?? 'week';
    if (!isCalendarView(view)) return fail('view must be "week", "day" or "month"', 422);
    const date = q.get('date') ?? localDateKey(new Date(), tz);
    if (!isCalendarDateKey(date)) return fail('date must be YYYY-MM-DD within 50 years of today', 422);
    const ws = parseWeekStart(q.get('ws'), defaultWeekStart({ country: countryForBusiness(business), timezone: tz }));
    const range = rangeFor(view, date, tz, ws);
    const { items, truncated } = await listAllBookingsInRange(businessId, range.from, range.to);
    return ok<BookingsRangeResult>({
      view, date, days: range.days, from: range.from.toISOString(), to: range.to.toISOString(),
      timezone: tz, week_start: ws, items, truncated,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

export interface BookingCreateResult {
  booking: Booking;
  /** What happened to the optional confirmation text (null: none was asked for). */
  notice: NoticeResult | null;
}

const CREATE_FIELDS = ['business_id', 'customer_name', 'customer_phone', 'service', 'scheduled_at', 'duration_minutes', 'address', 'price_estimate', 'crew', 'notify'];

/**
 * POST /api/bookings   OWNER (or admin): a booking the owner takes themselves (phone-in, walk-in), with the SAME engine and checks as the AI:
 *   { business_id?, customer_name, customer_phone?, service, scheduled_at, duration_minutes?, address?, price_estimate? (cents), crew?, notify? }
 * `scheduled_at` is an instant (Z / offset) or LOCAL wall-clock time in the business zone. Refused when the slot is taken (per crew), outside
 * hours / on a closed date / too soon, blocked on the connected Google calendar, or in the past. Stored with created_via 'dashboard', audited
 * (`booking.created_dashboard`), pushed to Google through the booking hook. The customer is texted only with `notify: true` (quiet hours apply).
 * Same-origin is enforced for cookie sessions by `authenticate` (CSRF). Staff are read-only.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/create', 30);
  if (limited) return limited;
  try {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (!CREATE_FIELDS.includes(k)) return fail(`field "${k}" cannot be set here`, 422);
    const businessId = scopeBusinessId(auth.principal, typeof body.business_id === 'string' ? body.business_id : null);
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    if (body.notify !== undefined && typeof body.notify !== 'boolean') return fail('notify must be true or false', 422);
    if (body.duration_minutes !== undefined && (typeof body.duration_minutes !== 'number' || !Number.isFinite(body.duration_minutes) || body.duration_minutes <= 0)) return fail('duration_minutes must be a positive number', 422);
    if (body.crew !== undefined && (typeof body.crew !== 'number' || !Number.isInteger(body.crew) || body.crew < 1 || body.crew > 20)) return fail('crew must be a whole number from 1 to 20', 422);
    const fields = validateBookingFields(body, business, false);
    if (!fields.ok) return fail(fields.error, 422);
    const when = parseScheduledAt(body.scheduled_at, tzOf(business));
    if (!when.ok) return fail('scheduled_at must be a date and time, e.g. 2026-12-05T09:00:00', 422);
    const actor = auditActorOf(auth.principal);
    try {
      const out = await createDashboardBooking({
        business, customer_name: fields.value.customer_name!, customer_phone: fields.value.customer_phone ?? '', service: fields.value.service!,
        scheduled_at: when.date.toISOString(), duration_minutes: body.duration_minutes as number | undefined, address: fields.value.address ?? null,
        price_estimate: fields.value.price_estimate ?? null, crew: (body.crew as number | undefined) ?? null, notify: body.notify === true,
        actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
      });
      return ok<BookingCreateResult>({ booking: out.booking, notice: out.notice }, 201);
    } catch (err) {
      if (err instanceof BookingRejectedError) { const r = rejectionResponse(err.reason); return fail(r.error, r.status); }
      throw err;
    }
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
