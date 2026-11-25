/**
 * Availability over the business's own hours + existing bookings. The internal
 * calendar is the source of truth; an optional Google Calendar mirror contributes busy
 * intervals (lib/integrations/google/busy). All maths happens in
 * the business's time zone (see lib/time.ts), whatever the process TZ is.
 */
import { listBlockingIntervals } from '@/lib/db';
import { calendarBusyIntervals } from '@/lib/integrations/google/busy';
import {
  buildSlots, clampDuration, upcomingDateKeys, validateSlot, type SlotRejection,
} from '@/lib/availability';
import { dayRange, isDateKey, tzOf } from '@/lib/time';
import type { Business, TimeSlot } from '@/lib/types';

export async function slotsForDate(
  business: Business,
  dateStr: string,
  durationMinutes = 60,
): Promise<TimeSlot[]> {
  if (!isDateKey(dateStr)) return [];
  const tz = tzOf(business);
  const duration = clampDuration(durationMinutes);
  const { gte, lt } = dayRange(dateStr, tz);
  const busy = [
    ...(await listBlockingIntervals(business.id, gte.getTime(), lt.getTime())),
    ...(await calendarBusyIntervals(business.id, gte.getTime(), lt.getTime())), // owner's Google Calendar (healthy connection + switch on)
  ];
  return buildSlots(business.hours, dateStr, tz, duration, busy, { nowMs: Date.now(), closedDates: business.closed_dates });
}

/** Next N available slots starting today, skipping past times (needs ~1h lead). */
export async function nextAvailable(business: Business, count = 3, durationMinutes = 60): Promise<TimeSlot[]> {
  const tz = tzOf(business);
  const duration = clampDuration(durationMinutes);
  const nowMs = Date.now();
  const days = upcomingDateKeys(nowMs, tz, 14);
  const from = dayRange(days[0], tz).gte.getTime();
  const to = dayRange(days[days.length - 1], tz).lt.getTime();
  const busy = [
    ...(await listBlockingIntervals(business.id, from, to)), // one query for the whole range
    ...(await calendarBusyIntervals(business.id, from, to)),
  ];

  const out: TimeSlot[] = [];
  for (const dateKey of days) {
    for (const slot of buildSlots(business.hours, dateKey, tz, duration, busy, { nowMs, leadMin: 60, closedDates: business.closed_dates })) {
      if (slot.available) {
        out.push(slot);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** Does [iso, iso+duration) fit the opening hours (ignoring other bookings)? */
export function isWithinHours(
  business: Business,
  iso: string,
  durationMinutes = 60,
): { ok: true } | { ok: false; reason: SlotRejection } {
  return validateSlot(
    business.hours, new Date(iso).getTime(), clampDuration(durationMinutes), tzOf(business), Date.now(), 0, business.closed_dates,
  );
}
