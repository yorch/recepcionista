/** Calendar maths: ranges, week layout, block positions and overlap lanes, including DST days (America/New_York). */
import { describe, expect, test } from 'bun:test';
import {
  allowedActions, axisFor, blockBox, countsByDay, defaultWeekStart, endOfMonth, groupByDay, hourLabel, layoutLanes, monthGrid, nextDate, nowLine,
  isCalendarDateKey, previousDate, rangeFor, segmentOnDay, startOfWeek, weekDays, wallMinutes, STATUS_META, STATUS_ORDER,
} from '../src/lib/calendar';
import { dayRange, zonedTimeToUtc } from '../src/lib/time';
import type { Hours } from '../src/lib/types';

const NY = 'America/New_York';
const at = (dateKey: string, hhmm: string, tz = NY) => zonedTimeToUtc(dateKey, hhmm, tz).toISOString();
const b = (id: string, dateKey: string, hhmm: string, minutes: number, tz = NY) => ({ id, scheduled_at: at(dateKey, hhmm, tz), duration_minutes: minutes });

const HOURS: Hours = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, { open: '08:00', close: '17:00' }]),
) as unknown as Hours;

describe('week start and ranges', () => {
  test('Sunday for en-US style locales, Monday elsewhere', () => {
    expect(defaultWeekStart({ country: 'US' })).toBe(0);
    expect(defaultWeekStart({ country: 'MX' })).toBe(0);
    expect(defaultWeekStart({ country: 'GB' })).toBe(1);
    expect(defaultWeekStart({ country: 'ES' })).toBe(1);
    expect(defaultWeekStart({ timezone: 'America/Chicago' })).toBe(0);
    expect(defaultWeekStart({ timezone: 'Europe/Madrid' })).toBe(1);
    expect(defaultWeekStart({})).toBe(1);
  });

  test('weekDays for a Sunday-first and a Monday-first week', () => {
    // 2026-11-24 is a Tuesday
    expect(weekDays('2026-11-24', 0)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
    expect(weekDays('2026-11-24', 1)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    // a Sunday anchors the NEXT Sunday-first week, the PREVIOUS Monday-first one
    expect(startOfWeek('2026-11-22', 0)).toBe('2026-11-22');
    expect(startOfWeek('2026-11-22', 1)).toBe('2026-11-16');
    expect(weekDays('2026-03-30', 0)[6]).toBe('2026-04-04'); // crosses a month end
  });

  test('week range covers exactly seven local days: 7*24h normally, one hour short across spring-forward, one longer across fall-back', () => {
    const hours = (r: { from: Date; to: Date }) => (r.to.getTime() - r.from.getTime()) / 3_600_000;
    // 2026-03-08 (Sun) is the US spring-forward day: the Sunday-first week starting there has 167 hours
    expect(hours(rangeFor('week', '2026-03-08', NY, 0))).toBe(167);
    // 2026-11-01 (Sun) is fall-back: 169 hours
    expect(hours(rangeFor('week', '2026-11-01', NY, 0))).toBe(169);
    expect(hours(rangeFor('week', '2026-07-15', NY, 0))).toBe(168);
    const r = rangeFor('week', '2026-11-24', NY, 0);
    expect(r.from.toISOString()).toBe(dayRange('2026-11-22', NY).gte.toISOString());
    expect(r.to.toISOString()).toBe(dayRange('2026-11-28', NY).lt.toISOString());
  });

  test('day range is 23h / 25h on DST days and the zone decides the day, not UTC', () => {
    const len = (k: string, tz = NY) => { const r = rangeFor('day', k, tz, 0); return (r.to.getTime() - r.from.getTime()) / 3_600_000; };
    expect(len('2026-03-08')).toBe(23);
    expect(len('2026-11-01')).toBe(25);
    expect(len('2026-06-10')).toBe(24);
    // 10 pm New York on Nov 24 is Nov 25 in UTC: it must still be on the 24th
    const r = rangeFor('day', '2026-11-24', NY, 0);
    const lateEvening = new Date(at('2026-11-24', '22:00')).getTime();
    expect(lateEvening >= r.from.getTime() && lateEvening < r.to.getTime()).toBe(true);
    expect(len('2026-03-29', 'Europe/Madrid')).toBe(23); // another zone, another rule
  });

  test('month grid: whole weeks, includes neighbour days, 4-6 rows', () => {
    const g = monthGrid('2026-11-15', 0);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0][0]).toBe('2026-11-01'); // Nov 1 2026 is a Sunday
    expect(g[g.length - 1][6] >= '2026-11-30').toBe(true);
    const mon = monthGrid('2026-11-15', 1);
    expect(mon[0][0]).toBe('2026-10-26'); // Monday-first: starts in October
    expect(monthGrid('2026-02-10', 1).length).toBeGreaterThanOrEqual(4);
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-31')).toBe('2026-12-31');
    const r = rangeFor('month', '2026-11-15', NY, 0);
    expect(r.days.length).toBe(g.flat().length);
    expect(r.from.toISOString()).toBe(dayRange(g[0][0], NY).gte.toISOString());
  });

  test('previous / next step by view', () => {
    expect(previousDate('day', '2026-03-01')).toBe('2026-02-28');
    expect(nextDate('day', '2026-12-31')).toBe('2027-01-01');
    expect(previousDate('week', '2026-11-24')).toBe('2026-11-17');
    expect(nextDate('week', '2026-11-24')).toBe('2026-12-01');
    expect(previousDate('month', '2026-03-31')).toBe('2026-02-01');
    expect(nextDate('month', '2026-01-31')).toBe('2026-02-01');
    expect(previousDate('month', '2026-01-15')).toBe('2025-12-01');
    expect(() => rangeFor('week', 'nope', NY, 0)).toThrow();
  });
});

describe('positions', () => {
  test('wall-clock minutes follow the business zone (not UTC)', () => {
    expect(wallMinutes(at('2026-11-24', '09:30'), NY)).toBe(570);
    expect(wallMinutes(at('2026-07-01', '09:30'), NY)).toBe(570); // same wall time in DST
    expect(wallMinutes(at('2026-07-01', '09:30', 'America/Los_Angeles'), 'America/Los_Angeles')).toBe(570);
  });

  test('a booking is positioned by its start and duration', () => {
    const seg = segmentOnDay(b('a', '2026-11-24', '10:00', 90), '2026-11-24', NY)!;
    expect(seg).toMatchObject({ startMin: 600, endMin: 690, continuesBefore: false, continuesAfter: false });
    expect(segmentOnDay(b('a', '2026-11-24', '10:00', 90), '2026-11-25', NY)).toBeNull();
    expect(segmentOnDay(b('a', '2026-11-24', '10:00', 90), '2026-11-23', NY)).toBeNull();
    const axis = { startMin: 480, endMin: 1020 }; // 8:00-17:00 = 540 min
    expect(blockBox(seg, axis).top).toBeCloseTo((120 / 540) * 100, 6);
    expect(blockBox(seg, axis).height).toBeCloseTo((90 / 540) * 100, 6);
  });

  test('a job crossing midnight is split across the two days and never overflows', () => {
    const job = b('late', '2026-11-24', '23:00', 180); // 23:00 -> 02:00
    const d1 = segmentOnDay(job, '2026-11-24', NY)!;
    const d2 = segmentOnDay(job, '2026-11-25', NY)!;
    expect(d1).toMatchObject({ startMin: 1380, endMin: 1440, continuesAfter: true });
    expect(d2).toMatchObject({ startMin: 0, endMin: 120, continuesBefore: true });
  });

  test('DST: the same wall time sits at the same row; the day length does not skew positions', () => {
    const spring = segmentOnDay(b('s', '2026-03-08', '10:00', 60), '2026-03-08', NY)!; // the 23-hour day
    const normal = segmentOnDay(b('n', '2026-03-09', '10:00', 60), '2026-03-09', NY)!;
    const fall = segmentOnDay(b('f', '2026-11-01', '10:00', 60), '2026-11-01', NY)!; // the 25-hour day
    for (const s of [spring, normal, fall]) expect(s).toMatchObject({ startMin: 600, endMin: 660 });
    // a job straddling the spring-forward jump (01:30 EST + 90 min = 04:00 EDT) is stretched but stays inside the day
    const jump = segmentOnDay(b('j', '2026-03-08', '01:30', 90), '2026-03-08', NY)!;
    expect(jump.startMin).toBe(90);
    expect(jump.endMin).toBe(240);
    expect(jump.endMin).toBeLessThanOrEqual(1440);
    // the last-hour job on the 25-hour day still ends before midnight; one that runs past midnight is clipped
    const longFall = segmentOnDay(b('lf', '2026-11-01', '23:00', 120), '2026-11-01', NY)!;
    expect(longFall.endMin).toBe(1440);
    expect(longFall.continuesAfter).toBe(true);
  });

  test('every segment is at least 15 minutes tall even when the clock arithmetic collapses', () => {
    const seg = segmentOnDay({ id: 'x', scheduled_at: at('2026-11-24', '10:00'), duration_minutes: 1 }, '2026-11-24', NY)!;
    expect(seg.endMin - seg.startMin).toBeGreaterThanOrEqual(15);
  });

  test('axis follows the open hours of the displayed days, widens for out-of-hours jobs, falls back when closed', () => {
    const days = weekDays('2026-11-24', 0);
    expect(axisFor(HOURS, days, NY)).toEqual({ startMin: 480, endMin: 1020 });
    expect(axisFor(HOURS, days, NY, [{ startMin: 6 * 60 + 30, endMin: 7 * 60 }, { startMin: 18 * 60, endMin: 19 * 60 + 15 }])).toEqual({ startMin: 360, endMin: 1200 });
    expect(axisFor({}, days, NY)).toEqual({ startMin: 480, endMin: 1080 }); // closed week: 8-18
    const late: Hours = { ...HOURS, tuesday: { open: '09:00', close: '24:00' } } as Hours;
    expect(axisFor(late, days, NY).endMin).toBe(1440);
    expect(axisFor(HOURS, ['2026-11-22'], NY).endMin - axisFor(HOURS, ['2026-11-22'], NY).startMin).toBeGreaterThanOrEqual(120); // a closed Sunday still has a grid
  });

  test('now line: percent inside the axis, null outside', () => {
    const axis = { startMin: 480, endMin: 1020 };
    expect(nowLine(new Date(at('2026-11-24', '12:30')), NY, axis)).toBeCloseTo((270 / 540) * 100, 6);
    expect(nowLine(new Date(at('2026-11-24', '07:00')), NY, axis)).toBeNull();
    expect(nowLine(new Date(at('2026-11-24', '20:00')), NY, axis)).toBeNull();
  });

  test('overlapping blocks share lanes; back-to-back ones do not', () => {
    const lanes = layoutLanes([
      { bookingId: 'a', startMin: 600, endMin: 660 },
      { bookingId: 'b', startMin: 660, endMin: 720 }, // touches a: same lane, own cluster
      { bookingId: 'c', startMin: 630, endMin: 700 }, // overlaps a and b
      { bookingId: 'd', startMin: 900, endMin: 960 },
    ]);
    const by = Object.fromEntries(lanes.map((l) => [l.bookingId, l]));
    expect(by.a.lanes).toBe(2);
    expect(by.c.lanes).toBe(2);
    expect(by.a.lane).not.toBe(by.c.lane);
    expect(by.b.lane).not.toBe(by.c.lane);
    expect(by.d).toEqual({ bookingId: 'd', lane: 0, lanes: 1 });
    expect(layoutLanes([])).toEqual([]);
    // identical times (a cancelled and a live booking on the same slot) get separate lanes
    const same = layoutLanes([{ bookingId: 'x', startMin: 600, endMin: 660 }, { bookingId: 'y', startMin: 600, endMin: 660 }]);
    expect(new Set(same.map((l) => l.lane)).size).toBe(2);
  });

  test('groupByDay buckets by LOCAL day (a 9 pm job is not tomorrow) and sorts by start', () => {
    const days = weekDays('2026-11-24', 0);
    const g = groupByDay([b('late', '2026-11-24', '21:30', 60), b('early', '2026-11-24', '08:00', 60), b('wed', '2026-11-25', '09:00', 60)], days, NY);
    expect(g.get('2026-11-24')!.map((x) => x.booking.id)).toEqual(['early', 'late']);
    expect(g.get('2026-11-25')!.map((x) => x.booking.id)).toEqual(['wed']);
    expect(g.get('2026-11-26')).toEqual([]);
  });

  test('month counts: per start day and status', () => {
    const c = countsByDay([
      { scheduled_at: at('2026-11-24', '09:00'), status: 'confirmed' },
      { scheduled_at: at('2026-11-24', '21:00'), status: 'cancelled' },
      { scheduled_at: at('2026-11-25', '09:00'), status: 'pending' },
    ], NY);
    expect(c.get('2026-11-24')).toEqual({ total: 2, pending: 0, confirmed: 1, completed: 0, cancelled: 1 });
    expect(c.get('2026-11-25')?.pending).toBe(1);
    expect(c.get('2026-11-26')).toBeUndefined();
  });
});

describe('presentation and actions', () => {
  test('every status has a label and an icon (never colour alone), and they differ', () => {
    for (const s of STATUS_ORDER) {
      expect(STATUS_META[s].label.length).toBeGreaterThan(2);
      expect(STATUS_META[s].icon.length).toBeGreaterThan(5);
    }
    expect(new Set(STATUS_ORDER.map((s) => STATUS_META[s].icon)).size).toBe(4);
    expect(new Set(STATUS_ORDER.map((s) => STATUS_META[s].label)).size).toBe(4);
  });

  test('which actions an owner is offered', () => {
    const now = Date.parse('2026-11-24T15:00:00Z');
    expect(allowedActions('confirmed', now + 3600_000, now)).toEqual({ cancel: true, complete: false, resend: true }); // not started
    expect(allowedActions('confirmed', now - 3600_000, now)).toEqual({ cancel: true, complete: true, resend: true });
    expect(allowedActions('pending', now - 1, now).complete).toBe(true);
    expect(allowedActions('completed', now - 1, now)).toEqual({ cancel: false, complete: false, resend: false });
    expect(allowedActions('cancelled', now + 1, now)).toEqual({ cancel: false, complete: false, resend: false });
  });

  test('hour labels', () => {
    expect([hourLabel(0), hourLabel(540), hourLabel(720), hourLabel(780), hourLabel(1380)]).toEqual(['12 AM', '9 AM', '12 PM', '1 PM', '11 PM']);
  });
});

describe('round 5 regressions', () => {
  test('L1: a job that ends exactly at local midnight is drawn to the end of the day, not 15 minutes tall', () => {
    const seg = segmentOnDay(b('late', '2026-12-01', '22:00', 120), '2026-12-01', NY);
    expect(seg).toMatchObject({ startMin: 22 * 60, endMin: 24 * 60, continuesAfter: false });
    // box height: 120 minutes of a 24 h axis, never the 15 minute guard
    expect(blockBox(seg!, { startMin: 0, endMin: 24 * 60 }).height).toBeCloseTo((120 / 1440) * 100, 5);
    // a short job at 23:45-24:00 and one that really runs past midnight
    expect(segmentOnDay(b('x', '2026-12-01', '23:45', 15), '2026-12-01', NY)).toMatchObject({ startMin: 23 * 60 + 45, endMin: 24 * 60 });
    expect(segmentOnDay(b('y', '2026-12-01', '23:00', 120), '2026-12-01', NY)).toMatchObject({ endMin: 24 * 60, continuesAfter: true });
    // the day it ends on starts at 0 (touching, not overlapping)
    expect(segmentOnDay(b('late', '2026-12-01', '22:00', 120), '2026-12-02', NY)).toBeNull();
    // the DST days still work
    expect(segmentOnDay(b('dst', '2026-11-01', '22:00', 120), '2026-11-01', NY)).toMatchObject({ endMin: 24 * 60 });
  });

  test('L6: calendar dates must be real and within 50 years of today', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    for (const ok of ['2026-11-24', '2076-11-24', '1976-11-24']) expect(isCalendarDateKey(ok, now)).toBe(true);
    for (const bad of ['9999-12-15', '0001-01-01', '2077-01-01', '1975-12-31', '2026-02-30', '2026-13-01', 'x', '', null, undefined, 20261124]) expect(isCalendarDateKey(bad, now)).toBe(false);
    // 9999 really did overflow the range maths: that is why it is refused before rangeFor
    expect(() => rangeFor('month', '9999-12-15', NY, 0)).toThrow();
  });
});
