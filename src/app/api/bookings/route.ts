import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { countryForBusiness, getBusiness, listAllBookingsInRange, listBookingsPage } from '@/lib/db';
import { defaultWeekStart, isCalendarDateKey, isCalendarView, parseWeekStart, rangeFor, type CalendarView, type WeekStart } from '@/lib/calendar';
import { localDateKey, tzOf } from '@/lib/time';
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
