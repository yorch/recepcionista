process.env.TZ = 'UTC';
import { describe, expect, test } from 'bun:test';
import {
  blockingIntervals, bookingInterval, buildSlots, clampDuration, hasConflict, intervalsOverlap,
  openWindow, validateSlot,
} from '../src/lib/availability';
import { zonedTimeToUtc } from '../src/lib/time';
import type { Hours } from '../src/lib/types';

const NY = 'America/New_York';
const HOURS: Hours = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};
const at = (date: string, hhmm: string) => zonedTimeToUtc(date, hhmm, NY).getTime();
const MIN = 60_000;
// 2026-11-23 is a Monday; "now" is 07:00 ET that morning.
const NOW = at('2026-11-23', '07:00');

describe('overlap', () => {
  test('half-open intervals: back-to-back is fine, any intersection is not', () => {
    const a = { start: 0, end: 60 };
    expect(intervalsOverlap(a, { start: 60, end: 120 })).toBe(false);
    expect(intervalsOverlap(a, { start: 59, end: 120 })).toBe(true);
    expect(intervalsOverlap(a, { start: -30, end: 1 })).toBe(true);
    expect(intervalsOverlap(a, { start: 10, end: 20 })).toBe(true);
  });
  test('a 120-minute job at 10:00 blocks 11:00 and a 10:30 start (duration, not exact minute)', () => {
    const busy = [{ start: at('2026-11-23', '10:00'), end: at('2026-11-23', '10:00') + 120 * MIN }];
    expect(hasConflict({ start: at('2026-11-23', '11:00'), end: at('2026-11-23', '12:00') }, busy)).toBe(true);
    expect(hasConflict({ start: at('2026-11-23', '10:30'), end: at('2026-11-23', '11:30') }, busy)).toBe(true);
    expect(hasConflict({ start: at('2026-11-23', '12:00'), end: at('2026-11-23', '13:00') }, busy)).toBe(false);
    expect(hasConflict({ start: at('2026-11-23', '09:00'), end: at('2026-11-23', '10:00') }, busy)).toBe(false);
  });
  test('cancelled bookings never block; default duration is 60', () => {
    const rows = [
      { scheduled_at: '2026-11-23T15:00:00.000Z', duration_minutes: 90, status: 'confirmed' },
      { scheduled_at: '2026-11-23T18:00:00.000Z', duration_minutes: 60, status: 'cancelled' },
      { scheduled_at: '2026-11-23T20:00:00.000Z', status: 'pending' },
    ];
    const iv = blockingIntervals(rows);
    expect(iv.length).toBe(2);
    expect(iv[0].end - iv[0].start).toBe(90 * MIN);
    expect(bookingInterval(rows[2]).end - bookingInterval(rows[2]).start).toBe(60 * MIN);
  });
  test('clampDuration', () => {
    expect(clampDuration(undefined)).toBe(60);
    expect(clampDuration(-5)).toBe(60);
    expect(clampDuration('abc')).toBe(60);
    expect(clampDuration(5)).toBe(15);
    expect(clampDuration(99999)).toBe(720);
    expect(clampDuration(90)).toBe(90);
  });
});

describe('opening hours', () => {
  test('window is computed in the business zone (08:00 ET = 13:00Z in winter)', () => {
    const w = openWindow(HOURS, '2026-11-23', NY)!;
    expect(new Date(w.start).toISOString()).toBe('2026-11-23T13:00:00.000Z');
    expect(new Date(w.end).toISOString()).toBe('2026-11-23T23:00:00.000Z');
    expect(openWindow(HOURS, '2026-11-22', NY)).toBeNull(); // Sunday closed
    expect(openWindow(HOURS, '2026-11-25', NY)).toBeNull(); // Wednesday not listed
  });
  test('bad hours yield no window', () => {
    expect(openWindow({ monday: { open: '18:00', close: '08:00' } }, '2026-11-23', NY)).toBeNull();
    expect(openWindow({ monday: { open: 'x', close: '08:00' } }, '2026-11-23', NY)).toBeNull();
  });
});

describe('validateSlot', () => {
  const v = (hhmm: string, dur = 60, date = '2026-11-23', now = NOW) =>
    validateSlot(HOURS, at(date, hhmm), dur, NY, now);
  test('accepts inside hours, including a job ending exactly at close', () => {
    expect(v('10:00')).toEqual({ ok: true });
    expect(v('08:00')).toEqual({ ok: true });
    expect(v('17:00')).toEqual({ ok: true });
  });
  test('a start AT close is rejected (< not <=)', () => {
    expect(v('18:00')).toEqual({ ok: false, reason: 'after_close' });
  });
  test('a start before close whose duration runs past close is rejected', () => {
    expect(v('17:30')).toEqual({ ok: false, reason: 'after_close' });
    expect(v('16:00', 180)).toEqual({ ok: false, reason: 'after_close' });
    expect(v('15:00', 180)).toEqual({ ok: true });
  });
  test('before open / closed day / past', () => {
    expect(v('07:00')).toEqual({ ok: false, reason: 'before_open' });
    expect(v('10:00', 60, '2026-11-29')).toEqual({ ok: false, reason: 'closed_day' });
    expect(v('10:00', 60, '2026-11-23', at('2026-11-23', '10:00') + 1)).toEqual({ ok: false, reason: 'past' });
    expect(v('10:00', 60, '2026-11-16')).toEqual({ ok: false, reason: 'past' });
  });
  test('a UTC-looking 10:00Z (5 AM ET) is correctly seen as before open', () => {
    expect(validateSlot(HOURS, Date.parse('2026-11-23T10:00:00Z'), 60, NY, Date.parse('2026-11-23T05:00:00Z'))).toEqual({ ok: false, reason: 'before_open' });
  });
  test('lead time', () => {
    expect(validateSlot(HOURS, at('2026-11-23', '08:00'), 60, NY, NOW, 120)).toEqual({ ok: false, reason: 'too_soon' }); // later than now, inside the notice
    expect(validateSlot(HOURS, NOW - 1, 60, NY, NOW, 120)).toEqual({ ok: false, reason: 'past' });
  });
});

describe('buildSlots', () => {
  test('hourly grid inside hours, in business zone, ending by close', () => {
    const slots = buildSlots(HOURS, '2026-11-23', NY, 60, []);
    expect(slots.length).toBe(10);
    expect(slots[0].start).toBe('2026-11-23T13:00:00.000Z');
    expect(slots[slots.length - 1].end).toBe('2026-11-23T23:00:00.000Z');
  });
  test('longer jobs drop trailing slots that would run past close', () => {
    const slots = buildSlots(HOURS, '2026-11-23', NY, 180, []);
    expect(slots.length).toBe(8);
    expect(slots[slots.length - 1].end).toBe('2026-11-23T23:00:00.000Z');
  });
  test('existing bookings block by overlap; cancelled ones free the slot', () => {
    const busy = blockingIntervals([
      { scheduled_at: new Date(at('2026-11-23', '10:00')).toISOString(), duration_minutes: 120, status: 'confirmed' },
      { scheduled_at: new Date(at('2026-11-23', '14:00')).toISOString(), duration_minutes: 60, status: 'cancelled' },
    ]);
    const slots = buildSlots(HOURS, '2026-11-23', NY, 60, busy);
    const avail = (hhmm: string) => slots.find((s) => s.start === new Date(at('2026-11-23', hhmm)).toISOString())!.available;
    expect(avail('09:00')).toBe(true);
    expect(avail('10:00')).toBe(false);
    expect(avail('11:00')).toBe(false); // covered by the 120-minute job
    expect(avail('12:00')).toBe(true);
    expect(avail('14:00')).toBe(true); // cancelled
  });
  test('past slots are unavailable when now is given', () => {
    const slots = buildSlots(HOURS, '2026-11-23', NY, 60, [], { nowMs: at('2026-11-23', '12:30') });
    expect(slots.filter((s) => s.available)[0].start).toBe(new Date(at('2026-11-23', '13:00')).toISOString());
  });
  test('DST day keeps wall-clock hours (Sunday 2026-11-01 closed -> use a custom day)', () => {
    const hours: Hours = { sunday: { open: '08:00', close: '12:00' } };
    const slots = buildSlots(hours, '2026-11-01', NY, 60, []);
    expect(slots.length).toBe(4);
    expect(slots[0].start).toBe('2026-11-01T13:00:00.000Z'); // 08:00 EST (UTC-5) after fall-back
  });
  test('closed day has no slots', () => {
    expect(buildSlots(HOURS, '2026-11-22', NY, 60, [])).toEqual([]);
  });
});
