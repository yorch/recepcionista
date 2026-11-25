/**
 * Slots a booking can be MOVED to: the business's opening hours on a local date, minus every OTHER non-cancelled booking (the
 * booking's own current time does not block itself). Pure maths in availability.ts; the one DB read is listBlockingIntervals, so anything
 * that read learns to block (busy time, buffers) applies here too. The reschedule route re-validates under the advisory lock, so a slot
 * listed here that was taken a second later is still refused there: this list is a convenience, never the guarantee.
 */
import { buildSlots, bookingInterval, clampDuration } from '@/lib/availability';
import { listBlockingIntervalsByCrew } from '@/lib/db';
import { calendarBusyIntervals } from '@/lib/integrations/google/busy';
import { schedulingOf } from '@/lib/business-config';
import { addDaysToDateKey, dayRange, isDateKey, localDateKey, tzOf } from '@/lib/time';
import type { Booking, Business, TimeSlot } from '@/lib/types';

export interface MoveSlot extends TimeSlot {
  /** This is where the booking already is. */
  current: boolean;
}

export async function slotsForMove(business: Business, booking: Booking, dateKey: string, nowMs: number = Date.now(), opts: { customer?: boolean } = {}): Promise<MoveSlot[]> {
  if (!isDateKey(dateKey)) return [];
  const tz = tzOf(business);
  const duration = clampDuration(booking.duration_minutes);
  const { gte, lt } = dayRange(dateKey, tz);
  const cfg = schedulingOf(business);
  // A customer-initiated move (the voice agent) obeys the same lead and horizon as a new booking; the owner's own move does not.
  if (opts.customer && dateKey >= addDaysToDateKey(localDateKey(nowMs, tz), cfg.horizon_days)) return [];
  const pad = cfg.buffer_minutes * 60_000;
  const crewBusy = await listBlockingIntervalsByCrew(business.id, gte.getTime() - pad, lt.getTime() + pad);
  const blocks = await calendarBusyIntervals(business.id, gte.getTime() - pad, lt.getTime() + pad);
  const own = bookingInterval(booking);
  if (booking.status !== 'cancelled') {
    const i = crewBusy.findIndex((b) => b.start === own.start && b.end === own.end && b.crew === (booking.crew ?? 1));
    const j = i >= 0 ? i : crewBusy.findIndex((b) => b.start === own.start && b.end === own.end);
    if (j >= 0) crewBusy.splice(j, 1); // exactly one: the booking itself
  }
  return buildSlots(business.hours, dateKey, tz, duration, blocks, {
    nowMs, leadMin: opts.customer ? cfg.min_lead_minutes : 0, closedDates: business.closed_dates, stepMin: cfg.slot_minutes, bufferMin: cfg.buffer_minutes, crews: cfg.crews, crewBusy,
  }).map((s) => ({ ...s, current: new Date(s.start).getTime() === own.start }));
}
