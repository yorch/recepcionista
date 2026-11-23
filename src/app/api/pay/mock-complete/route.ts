import { fail, ok, readJson } from '@/lib/http';
import { demoModeEnabled } from '@/lib/auth';
import { getBooking, markDepositPaid } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * The mock checkout's "Pay" button. Demo only: 404 unless DEMO_MODE=true. The amount is
 * read from the booking in the DB — never from the request — and the write goes through
 * markDepositPaid (idempotent; never reopens a cancelled/completed booking).
 */
export async function POST(req: Request) {
  if (!demoModeEnabled()) return fail('not found', 404);
  const limited = await limitRequest(req, 'pay/mock-complete', 20);
  if (limited) return limited;
  try {
    const body = await readJson<{ booking_id?: string }>(req);
    const bookingId = typeof body.booking_id === 'string' ? body.booking_id.trim() : '';
    if (!bookingId) return fail('booking_id is required', 422);

    const booking = await getBooking(bookingId);
    if (!booking) return fail('booking not found', 404);
    const amount = booking.deposit_amount;
    if (!amount || amount <= 0) return fail('booking has no deposit due', 422);

    const result = await markDepositPaid(booking.id, amount);
    return ok({ updated: result.updated, amount_cents: amount });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'mock payment failed', 500);
  }
}
