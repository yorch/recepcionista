/**
 * Slots a booking can be MOVED to: the business's opening hours on a local date, minus every OTHER non-cancelled booking (the
 * booking's own current time does not block itself). Pure maths in availability.ts; the one DB read is listBlockingIntervals, so anything
 * that read learns to block (busy time, buffers) applies here too. The reschedule route re-validates under the advisory lock, so a slot
 * listed here that was taken a second later is still refused there: this list is a convenience, never the guarantee.
 */
import { buildSlots, bookingInterval, clampDuration } from '@/lib/availability';
import { listBlockingIntervals } from '@/lib/db';
import { dayRange, isDateKey, tzOf } from '@/lib/time';
import type { Booking, Business, TimeSlot } from '@/lib/types';

export interface MoveSlot extends TimeSlot {
  /** This is where the booking already is. */
  current: boolean;
}

export async function slotsForMove(business: Business, booking: Booking, dateKey: string, nowMs: number = Date.now()): Promise<MoveSlot[]> {
  if (!isDateKey(dateKey)) return [];
  const tz = tzOf(business);
  const duration = clampDuration(booking.duration_minutes);
  const { gte, lt } = dayRange(dateKey, tz);
  const busy = await listBlockingIntervals(business.id, gte.getTime(), lt.getTime());
  const own = bookingInterval(booking);
  if (booking.status !== 'cancelled') {
    const i = busy.findIndex((b) => b.start === own.start && b.end === own.end);
    if (i >= 0) busy.splice(i, 1); // exactly one: the booking itself
  }
  return buildSlots(business.hours, dateKey, tz, duration, busy, { nowMs }).map((s) => ({ ...s, current: new Date(s.start).getTime() === own.start }));
}
