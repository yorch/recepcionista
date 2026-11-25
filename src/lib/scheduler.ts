/**
 * Availability over the business's own hours + existing bookings. The internal
 * calendar is the source of truth; an optional Google Calendar mirror contributes busy
 * intervals (lib/integrations/google/busy). All maths happens in
 * the business's time zone (see lib/time.ts), whatever the process TZ is.
 */
import { listBlockingIntervalsByCrew } from '@/lib/db';
import { calendarBusyIntervals } from '@/lib/integrations/google/busy';
import {
  buildSlots, clampDuration, upcomingDateKeys, validateSlot, type SlotRejection,
} from '@/lib/availability';
import { schedulingOf } from '@/lib/business-config';
import { addDaysToDateKey, dayRange, isDateKey, localDateKey, tzOf } from '@/lib/time';
import type { Business, TimeSlot } from '@/lib/types';

/**
 * Slots of one local date, per the business's scheduling configuration (slot grid, minimum lead, horizon, buffer, crews):
 * a slot is available while it starts after now + lead, falls inside the booking horizon, keeps `buffer` minutes clear of the owner's Google
 * Calendar blocks and has at least one free crew (each crew's own bookings, buffer included). The same lead and horizon are applied by
 * `nextAvailable` and by `validateSlot` inside createBooking, so what is offered is what can be booked.
 */
export async function slotsForDate(
  business: Business,
  dateStr: string,
  durationMinutes = 60,
  nowMs: number = Date.now(),
): Promise<TimeSlot[]> {
  if (!isDateKey(dateStr)) return [];
  const tz = tzOf(business);
  const cfg = schedulingOf(business);
  const duration = clampDuration(durationMinutes);
  if (dateStr >= addDaysToDateKey(localDateKey(nowMs, tz), cfg.horizon_days)) return []; // beyond the booking horizon: nothing is offered
  const { gte, lt } = dayRange(dateStr, tz);
  const pad = cfg.buffer_minutes * 60_000;
  const from = gte.getTime() - pad;
  const to = lt.getTime() + pad;
  const crewBusy = await listBlockingIntervalsByCrew(business.id, from, to);
  const blocks = await calendarBusyIntervals(business.id, from, to); // owner's Google Calendar (healthy connection + switch on): stops every crew
  return buildSlots(business.hours, dateStr, tz, duration, blocks, {
    nowMs, leadMin: cfg.min_lead_minutes, closedDates: business.closed_dates,
    stepMin: cfg.slot_minutes, bufferMin: cfg.buffer_minutes, crews: cfg.crews, crewBusy,
  });
}

/** Next N available slots starting today, within the booking horizon, skipping past times and the minimum lead. */
export async function nextAvailable(business: Business, count = 3, durationMinutes = 60, nowMs: number = Date.now()): Promise<TimeSlot[]> {
  const tz = tzOf(business);
  const cfg = schedulingOf(business);
  const duration = clampDuration(durationMinutes);
  const days = upcomingDateKeys(nowMs, tz, cfg.horizon_days);
  const pad = cfg.buffer_minutes * 60_000;
  const from = dayRange(days[0], tz).gte.getTime() - pad;
  const to = dayRange(days[days.length - 1], tz).lt.getTime() + pad;
  const crewBusy = await listBlockingIntervalsByCrew(business.id, from, to); // one query for the whole range
  const blocks = await calendarBusyIntervals(business.id, from, to);

  const out: TimeSlot[] = [];
  for (const dateKey of days) {
    for (const slot of buildSlots(business.hours, dateKey, tz, duration, blocks, {
      nowMs, leadMin: cfg.min_lead_minutes, closedDates: business.closed_dates,
      stepMin: cfg.slot_minutes, bufferMin: cfg.buffer_minutes, crews: cfg.crews, crewBusy,
    })) {
      if (slot.available) {
        out.push(slot);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/**
 * Does [iso, iso+duration) fit the opening hours, the minimum lead and the booking horizon (ignoring other bookings)?
 * `ownerInitiated` skips the lead and the horizon (the owner may book anything their hours allow).
 */
export function isWithinHours(
  business: Business,
  iso: string,
  durationMinutes = 60,
  opts: { ownerInitiated?: boolean; nowMs?: number } = {},
): { ok: true } | { ok: false; reason: SlotRejection } {
  const cfg = schedulingOf(business);
  return validateSlot(
    business.hours, new Date(iso).getTime(), clampDuration(durationMinutes), tzOf(business), opts.nowMs ?? Date.now(),
    opts.ownerInitiated ? 0 : cfg.min_lead_minutes, business.closed_dates,
    { horizonDays: opts.ownerInitiated ? null : cfg.horizon_days },
  );
}
