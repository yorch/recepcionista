import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { slotsForDate } from '@/lib/scheduler';
import { isDateKey, tzOf } from '@/lib/time';
import type { TimeSlot } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface NewBookingSlotsResult {
  date: string;
  timezone: string;
  duration_minutes: number;
  slots: TimeSlot[];
}

/**
 * GET /api/bookings/slots?date=YYYY-MM-DD[&duration=60][&business_id=]   OWNER (or admin): the times a NEW booking can take on a local date, from the
 * same availability the AI offers (opening hours, closed dates, existing bookings, the connected Google calendar's busy time). Read-only convenience:
 * the create itself re-checks everything under the booking lock.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const q = new URL(req.url).searchParams;
    const businessId = scopeBusinessId(auth.principal, q.get('business_id'));
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    const date = q.get('date') ?? '';
    if (!isDateKey(date)) return fail('date must be YYYY-MM-DD', 422);
    const raw = q.get('duration');
    const duration = raw === null || raw === '' ? 60 : Number(raw);
    if (!Number.isInteger(duration) || duration < 15 || duration > 720) return fail('duration must be a whole number of minutes from 15 to 720', 422);
    return ok<NewBookingSlotsResult>({ date, timezone: tzOf(business), duration_minutes: duration, slots: await slotsForDate(business, date, duration, Date.now(), { ownerInitiated: true }) });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
