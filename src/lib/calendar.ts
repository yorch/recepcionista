/**
 * Calendar maths for the dashboard grid: ranges, week/month layout, axis and block positions, overlap lanes and status
 * presentation. PURE (no DOM, no clock, no database) so it is unit tested across DST days; everything is computed in the
 * BUSINESS time zone via src/lib/time.ts, never the viewer's or the server's.
 *
 * Positions are WALL-CLOCK minutes since local midnight, so every column of a week lines up with the same hour labels. On a
 * DST day a block that spans the jump is stretched or squeezed by an hour (the skipped hour has no real time); blocks are
 * always clamped inside the day, so nothing overflows the grid.
 */
import { openWindow } from '@/lib/availability';
import { addDaysToDateKey, dayOfWeek, dayRange, isDateKey, localDateKey, partsInTz } from '@/lib/time';
import type { Booking, BookingStatus, Hours } from '@/lib/types';

export type CalendarView = 'week' | 'day' | 'month';
export const CALENDAR_VIEWS: readonly CalendarView[] = ['week', 'day', 'month'];
export const isCalendarView = (v: unknown): v is CalendarView => v === 'week' || v === 'day' || v === 'month';

/** 0 = Sunday ... 6 = Saturday (same as JS getDay). Only Sunday and Monday starts are offered. */
export type WeekStart = 0 | 1;

/** Countries whose calendars start the week on Sunday (US, Canada, Mexico and a few others); everywhere else: Monday. */
const SUNDAY_FIRST = new Set(['US', 'CA', 'MX', 'JP', 'BR', 'IL', 'PH', 'CO', 'PE', 'GT', 'HN', 'SV', 'DO', 'PR', 'KR']);

/** The business's default week start: Sunday for en-US style locales (by country, else by America/* zone), Monday otherwise. */
export function defaultWeekStart(opts: { country?: string | null; timezone?: string | null }): WeekStart {
  const c = (opts.country ?? '').toUpperCase();
  if (c) return SUNDAY_FIRST.has(c) ? 0 : 1;
  return (opts.timezone ?? '').startsWith('America/') ? 0 : 1;
}

export function parseWeekStart(raw: unknown, fallback: WeekStart): WeekStart {
  return raw === '0' || raw === 0 ? 0 : raw === '1' || raw === 1 ? 1 : fallback;
}

/** First day of the week containing `dateKey`. */
export function startOfWeek(dateKey: string, weekStart: WeekStart): string {
  const back = (dayOfWeek(dateKey) - weekStart + 7) % 7;
  return addDaysToDateKey(dateKey, -back);
}

/** The seven day keys of the week containing `dateKey`. */
export function weekDays(dateKey: string, weekStart: WeekStart): string[] {
  const first = startOfWeek(dateKey, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(first, i));
}

export const startOfMonth = (dateKey: string): string => `${dateKey.slice(0, 7)}-01`;

/** Last day (YYYY-MM-DD) of the month containing `dateKey`. */
export function endOfMonth(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDaysToDateKey(next, -1);
}

/** The weeks (arrays of 7 day keys) that cover the month containing `dateKey`, including the leading/trailing days of neighbours. */
export function monthGrid(dateKey: string, weekStart: WeekStart): string[][] {
  const first = startOfWeek(startOfMonth(dateKey), weekStart);
  const last = endOfMonth(dateKey);
  const weeks: string[][] = [];
  for (let d = first; d <= last; d = addDaysToDateKey(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysToDateKey(d, i)));
  }
  return weeks;
}

export interface CalendarRange {
  view: CalendarView;
  /** The anchor day (normalised: the first of the visible period is `days[0]`). */
  date: string;
  /** Every local day the view covers (month view: the whole grid, with neighbour days). */
  days: string[];
  /** UTC bounds [from, to) of the covered days: DST days are 23 or 25 hours long. */
  from: Date;
  to: Date;
}

export function previousDate(view: CalendarView, dateKey: string): string {
  if (view === 'day') return addDaysToDateKey(dateKey, -1);
  if (view === 'week') return addDaysToDateKey(dateKey, -7);
  const prevMonthLast = addDaysToDateKey(startOfMonth(dateKey), -1);
  return `${prevMonthLast.slice(0, 7)}-01`;
}

export function nextDate(view: CalendarView, dateKey: string): string {
  if (view === 'day') return addDaysToDateKey(dateKey, 1);
  if (view === 'week') return addDaysToDateKey(dateKey, 7);
  return addDaysToDateKey(endOfMonth(dateKey), 1);
}

export function rangeFor(view: CalendarView, dateKey: string, tz: string, weekStart: WeekStart): CalendarRange {
  if (!isDateKey(dateKey)) throw new RangeError(`bad date key: ${dateKey}`);
  const days = view === 'day' ? [dateKey] : view === 'week' ? weekDays(dateKey, weekStart) : monthGrid(dateKey, weekStart).flat();
  return {
    view, date: dateKey, days,
    from: dayRange(days[0], tz).gte,
    to: dayRange(days[days.length - 1], tz).lt,
  };
}

// ------------------------------------------------------------------ positions

export const MINUTES_PER_DAY = 24 * 60;

/** Wall-clock minutes since local midnight of the instant's own local day. */
export function wallMinutes(instant: Date | number | string, tz: string): number {
  const p = partsInTz(instant, tz);
  return p.hour * 60 + p.minute;
}

export interface DaySegment {
  bookingId: string;
  /** Wall-clock minutes since local midnight of THIS day. */
  startMin: number;
  endMin: number;
  /** The booking began on an earlier day / ends on a later one (it is drawn clipped). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The part of a booking that falls on local day `dateKey`, or null. Back-to-back jobs touch but never overlap. */
export function segmentOnDay(
  b: Pick<Booking, 'id' | 'scheduled_at' | 'duration_minutes'>, dateKey: string, tz: string,
): DaySegment | null {
  const startMs = new Date(b.scheduled_at).getTime();
  const durMs = Math.max(1, Math.round(b.duration_minutes ?? 60)) * 60_000;
  const endMs = startMs + durMs;
  const { gte, lt } = dayRange(dateKey, tz);
  if (endMs <= gte.getTime() || startMs >= lt.getTime()) return null;
  const continuesBefore = startMs < gte.getTime();
  const continuesAfter = endMs > lt.getTime();
  const startMin = continuesBefore ? 0 : wallMinutes(startMs, tz);
  const endMin = continuesAfter ? MINUTES_PER_DAY : wallMinutes(endMs, tz);
  // Guard against DST skew producing an empty or inverted box: always at least 15 minutes tall, never past midnight.
  const end = Math.min(MINUTES_PER_DAY, Math.max(endMin, startMin + 15));
  return { bookingId: b.id, startMin, endMin: end, continuesBefore, continuesAfter };
}

export interface Axis {
  /** Wall-clock minutes (multiples of 60) of the first and last grid line. */
  startMin: number;
  endMin: number;
}

export const DEFAULT_AXIS: Axis = { startMin: 8 * 60, endMin: 18 * 60 };

/**
 * The visible hour range: the opening hours of the displayed days (floored/ceiled to whole hours) widened to include every
 * booking segment (a job outside normal hours is never clipped off-screen). A closed week falls back to 8:00-18:00.
 */
export function axisFor(
  hours: Hours | undefined | null, days: string[], tz: string, segments: Pick<DaySegment, 'startMin' | 'endMin'>[] = [],
): Axis {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    const w = openWindow(hours, d, tz);
    if (!w) continue;
    lo = Math.min(lo, wallMinutes(w.start, tz));
    // A close of 24:00 reads as 00:00 of the next day: treat it as end of day.
    const closeMin = w.end >= dayRange(d, tz).lt.getTime() ? MINUTES_PER_DAY : wallMinutes(w.end, tz);
    hi = Math.max(hi, closeMin);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = DEFAULT_AXIS.startMin; hi = DEFAULT_AXIS.endMin; }
  for (const s of segments) { lo = Math.min(lo, s.startMin); hi = Math.max(hi, s.endMin); }
  const startMin = Math.max(0, Math.floor(lo / 60) * 60);
  const endMin = Math.min(MINUTES_PER_DAY, Math.max(startMin + 120, Math.ceil(hi / 60) * 60));
  return { startMin, endMin };
}

/** Percentages (0-100) of the axis height for a segment: where the block starts and how tall it is. */
export function blockBox(seg: Pick<DaySegment, 'startMin' | 'endMin'>, axis: Axis): { top: number; height: number } {
  const span = axis.endMin - axis.startMin;
  const start = Math.min(Math.max(seg.startMin, axis.startMin), axis.endMin);
  const end = Math.min(Math.max(seg.endMin, axis.startMin), axis.endMin);
  return { top: ((start - axis.startMin) / span) * 100, height: Math.max(((end - start) / span) * 100, 0) };
}

/** Where "now" sits in the axis as a percentage, or null when outside it. */
export function nowLine(now: Date, tz: string, axis: Axis): number | null {
  const m = wallMinutes(now, tz);
  return m >= axis.startMin && m <= axis.endMin ? ((m - axis.startMin) / (axis.endMin - axis.startMin)) * 100 : null;
}

export interface Lane { bookingId: string; lane: number; lanes: number }

/**
 * Side-by-side lanes for blocks that overlap in time (cancelled jobs may overlap live ones; live ones cannot overlap each
 * other, the database forbids it). Greedy interval partitioning; every block of an overlap cluster shares the cluster's lane count.
 */
export function layoutLanes(segs: Pick<DaySegment, 'bookingId' | 'startMin' | 'endMin'>[]): Lane[] {
  const sorted = [...segs].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.bookingId.localeCompare(b.bookingId));
  const out: Lane[] = [];
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const c of cluster) out.push({ bookingId: c.id, lane: c.lane, lanes: Math.max(1, laneEnds.length) });
    cluster = []; laneEnds = []; clusterEnd = -1;
  };
  for (const s of sorted) {
    if (cluster.length > 0 && s.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(s.endMin); } else laneEnds[lane] = s.endMin;
    cluster.push({ id: s.bookingId, lane });
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  flush();
  return out;
}

/** Bookings grouped by the local day(s) they touch, with their positioned segment. Sorted by start. */
export function groupByDay<T extends Pick<Booking, 'id' | 'scheduled_at' | 'duration_minutes'>>(
  bookings: T[], days: string[], tz: string,
): Map<string, { booking: T; segment: DaySegment }[]> {
  const out = new Map<string, { booking: T; segment: DaySegment }[]>(days.map((d) => [d, []]));
  for (const b of bookings) {
    for (const d of days) {
      const segment = segmentOnDay(b, d, tz);
      if (segment) out.get(d)!.push({ booking: b, segment });
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.segment.startMin - b.segment.startMin || a.booking.id.localeCompare(b.booking.id));
  return out;
}

export interface DayCount { total: number; pending: number; confirmed: number; completed: number; cancelled: number }

/** Month overview: how many jobs START on each local day, by status. */
export function countsByDay(bookings: Pick<Booking, 'scheduled_at' | 'status'>[], tz: string): Map<string, DayCount> {
  const out = new Map<string, DayCount>();
  for (const b of bookings) {
    const key = localDateKey(b.scheduled_at, tz);
    const c = out.get(key) ?? { total: 0, pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
    c.total++;
    c[b.status]++;
    out.set(key, c);
  }
  return out;
}

// ------------------------------------------------------------------ status presentation

export interface StatusMeta {
  label: string;
  /** Short SVG path (24x24 viewBox, stroke): the icon, so status is never conveyed by colour alone. */
  icon: string;
  /** Tailwind classes using the design tokens (border + background + text). */
  tone: string;
  /** What the status means, for the legend and screen readers. */
  hint: string;
}

export const STATUS_META: Record<BookingStatus, StatusMeta> = {
  pending: { label: 'Pending', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', tone: 'border-warn-line bg-warn-bg text-warn border-dashed', hint: 'Waiting for the deposit' },
  confirmed: { label: 'Confirmed', icon: 'M5 12.5l4.5 4.5L19 7.5', tone: 'border-sky-line bg-sky-bg text-sky-text', hint: 'Booked' },
  completed: { label: 'Completed', icon: 'M3 12.5l4 4 6-8M11 16.5l2 2 8-10', tone: 'border-mint-line bg-mint-bg text-mint-text', hint: 'Job done' },
  cancelled: { label: 'Cancelled', icon: 'M6 6l12 12M18 6 6 18', tone: 'border-danger-line bg-danger-bg text-danger line-through', hint: 'Cancelled; the time is free again' },
};

export const STATUS_ORDER: BookingStatus[] = ['pending', 'confirmed', 'completed', 'cancelled'];

/** What an owner may do to a booking in a given status. */
export function allowedActions(status: BookingStatus, startsAtMs: number, nowMs: number): { cancel: boolean; complete: boolean; resend: boolean } {
  const live = status === 'pending' || status === 'confirmed';
  return { cancel: live, complete: live && startsAtMs <= nowMs, resend: status !== 'cancelled' && status !== 'completed' };
}

/** "9 AM", "12 PM", "11 PM" for a wall-clock minute count (axis labels). */
export function hourLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'AM' : 'PM'}`;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
