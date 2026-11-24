import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBooking, getBusiness } from '@/lib/db';
import { slotsForMove, type MoveSlot } from '@/lib/booking-slots';
import { isDateKey, tzOf } from '@/lib/time';

export const dynamic = 'force-dynamic';

export interface MoveSlotsResult {
  date: string;
  timezone: string;
  duration_minutes: number;
  slots: MoveSlot[];
}

/**
 * GET /api/bookings/:id/slots?date=YYYY-MM-DD   OWNER (or admin): the times this booking can move to on a local date (business zone):
 * opening hours minus every other booking. Read-only; the reschedule itself re-checks under a lock, so a slot listed here can still be
 * refused if someone took it a moment later.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    if (booking.status !== 'pending' && booking.status !== 'confirmed') return fail(`a ${booking.status} booking cannot be moved`, 409);
    const date = new URL(req.url).searchParams.get('date') ?? '';
    if (!isDateKey(date)) return fail('date must be YYYY-MM-DD', 422);
    const business = await getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);
    const slots = await slotsForMove(business, booking, date);
    return ok<MoveSlotsResult>({ date, timezone: tzOf(business), duration_minutes: booking.duration_minutes ?? 60, slots });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
