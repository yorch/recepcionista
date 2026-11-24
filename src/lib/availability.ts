/**
 * Pure availability maths (no DB, no clock reads): opening windows, slot grids,
 * overlap and slot validation. Everything is computed in the business time zone.
 */
import { isClosedDate } from './closures';
import { addDaysToDateKey, dayOfWeek, localDateKey, parseHhmm, zonedTimeToUtc } from './time';
import type { Hours, TimeSlot } from './types';

export const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const DEFAULT_DURATION_MIN = 60;
export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 720;
export const SLOT_STEP_MIN = 60;

export interface Interval { start: number; end: number }

export function clampDuration(raw: unknown, fallback = DEFAULT_DURATION_MIN): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, n));
}

/** Half-open overlap: [a.start, a.end) vs [b.start, b.end). Back-to-back does not overlap. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function hasConflict(candidate: Interval, busy: Interval[]): boolean {
  return busy.some((b) => intervalsOverlap(candidate, b));
}

export function bookingInterval(b: { scheduled_at: string; duration_minutes?: number | null }): Interval {
  const start = new Date(b.scheduled_at).getTime();
  return { start, end: start + clampDuration(b.duration_minutes) * 60_000 };
}

/** Cancelled bookings never block anything. */
export function blockingIntervals(
  bookings: { scheduled_at: string; duration_minutes?: number | null; status: string }[],
): Interval[] {
  return bookings.filter((b) => b.status !== 'cancelled').map(bookingInterval);
}

/** The [open, close) instants for a local date, or null if closed / hours invalid / the date is a listed holiday closure. */
export function openWindow(hours: Hours | undefined | null, dateKey: string, tz: string, closedDates?: readonly string[] | null): Interval | null {
  if (isClosedDate(closedDates, dateKey)) return null;
  const day = hours?.[DAY_KEYS[dayOfWeek(dateKey)]];
  if (!day) return null;
  const open = parseHhmm(day.open);
  const close = parseHhmm(day.close);
  if (!open || !close) return null;
  const start = zonedTimeToUtc(dateKey, open, tz).getTime();
  const end = zonedTimeToUtc(dateKey, close, tz).getTime();
  return end > start ? { start, end } : null;
}

export type SlotRejection = 'past' | 'closed_day' | 'closed_date' | 'before_open' | 'after_close';

/**
 * Is [start, start+duration) a legal appointment? It must start now-or-later (plus
 * optional lead), start at/after opening, and END by closing — so a start at (or
 * after) close, or a job that would run past close, is rejected.
 */
export function validateSlot(
  hours: Hours | undefined | null,
  startMs: number,
  durationMin: number,
  tz: string,
  nowMs: number,
  leadMin = 0,
  closedDates?: readonly string[] | null,
): { ok: true } | { ok: false; reason: SlotRejection } {
  if (!Number.isFinite(startMs) || startMs < nowMs + leadMin * 60_000) return { ok: false, reason: 'past' };
  const dateKey = localDateKey(startMs, tz);
  if (isClosedDate(closedDates, dateKey)) return { ok: false, reason: 'closed_date' };
  const window = openWindow(hours, dateKey, tz);
  if (!window) return { ok: false, reason: 'closed_day' };
  if (startMs < window.start) return { ok: false, reason: 'before_open' };
  if (startMs + durationMin * 60_000 > window.end) return { ok: false, reason: 'after_close' };
  return { ok: true };
}

export function buildSlots(
  hours: Hours | undefined | null,
  dateKey: string,
  tz: string,
  durationMin: number,
  busy: Interval[],
  opts: { stepMin?: number; nowMs?: number; leadMin?: number; closedDates?: readonly string[] | null } = {},
): TimeSlot[] {
  const window = openWindow(hours, dateKey, tz, opts.closedDates);
  if (!window) return [];
  const step = (opts.stepMin ?? SLOT_STEP_MIN) * 60_000;
  const dur = durationMin * 60_000;
  const earliest = opts.nowMs != null ? opts.nowMs + (opts.leadMin ?? 0) * 60_000 : -Infinity;
  const slots: TimeSlot[] = [];
  for (let t = window.start; t + dur <= window.end; t += step) {
    slots.push({
      start: new Date(t).toISOString(),
      end: new Date(t + dur).toISOString(),
      available: t >= earliest && !hasConflict({ start: t, end: t + dur }, busy),
    });
  }
  return slots;
}

/** Date keys covering today and the next `days - 1` days in the zone. */
export function upcomingDateKeys(nowMs: number, tz: string, days: number): string[] {
  const today = localDateKey(nowMs, tz);
  return Array.from({ length: days }, (_, i) => addDaysToDateKey(today, i));
}
