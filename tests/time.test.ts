// Run with: bun test   (pure, no database). The process zone is forced to UTC to prove
// nothing depends on it.
process.env.TZ = 'UTC';
import { describe, expect, test } from 'bun:test';
import {
  addDaysToDateKey, dayOfWeek, dayRange, describeNow, isDateKey, localDateKey, parseScheduledAt,
  partsInTz, tzOffsetMs, zonedTimeToUtc, tzOf, DEFAULT_TIMEZONE,
} from '../src/lib/time';

const NY = 'America/New_York';
const iso = (d: Date) => d.toISOString();

describe('zonedTimeToUtc', () => {
  test('EST (winter) and EDT (summer)', () => {
    expect(iso(zonedTimeToUtc('2026-11-23', '10:00', NY))).toBe('2026-11-23T15:00:00.000Z');
    expect(iso(zonedTimeToUtc('2026-07-15', '08:00', NY))).toBe('2026-07-15T12:00:00.000Z');
  });
  test('spring-forward gap resolves forward (02:30 does not exist on 2026-03-08)', () => {
    expect(iso(zonedTimeToUtc('2026-03-08', '02:30', NY))).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(iso(zonedTimeToUtc('2026-03-08', '01:59', NY))).toBe('2026-03-08T06:59:00.000Z'); // EST
    expect(iso(zonedTimeToUtc('2026-03-08', '03:00', NY))).toBe('2026-03-08T07:00:00.000Z'); // EDT
  });
  test('fall-back ambiguity picks the earlier instant (2026-11-01 01:30)', () => {
    expect(iso(zonedTimeToUtc('2026-11-01', '01:30', NY))).toBe('2026-11-01T05:30:00.000Z'); // EDT
    expect(iso(zonedTimeToUtc('2026-11-01', '02:30', NY))).toBe('2026-11-01T07:30:00.000Z'); // EST
  });
  test('other zones, including half-hour offsets and southern hemisphere', () => {
    expect(iso(zonedTimeToUtc('2026-11-23', '09:00', 'Asia/Kolkata'))).toBe('2026-11-23T03:30:00.000Z');
    expect(iso(zonedTimeToUtc('2026-07-01', '09:00', 'America/Los_Angeles'))).toBe('2026-07-01T16:00:00.000Z');
    expect(iso(zonedTimeToUtc('2026-01-15', '09:00', 'Australia/Sydney'))).toBe('2026-01-14T22:00:00.000Z');
    expect(iso(zonedTimeToUtc('2026-11-23', '09:00', 'UTC'))).toBe('2026-11-23T09:00:00.000Z');
  });
});

describe('dayRange', () => {
  test('is DST-correct, not a fixed UTC-5', () => {
    const jul = dayRange('2026-07-15', NY);
    expect(iso(jul.gte)).toBe('2026-07-15T04:00:00.000Z'); // old code gave 05:00Z
    expect(iso(jul.lt)).toBe('2026-07-16T04:00:00.000Z');
    const winter = dayRange('2026-01-15', NY);
    expect(iso(winter.gte)).toBe('2026-01-15T05:00:00.000Z');
  });
  test('23-hour spring-forward day and 25-hour fall-back day', () => {
    const spring = dayRange('2026-03-08', NY);
    expect(iso(spring.gte)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(spring.lt)).toBe('2026-03-09T04:00:00.000Z');
    expect((spring.lt.getTime() - spring.gte.getTime()) / 3_600_000).toBe(23);
    const fall = dayRange('2026-11-01', NY);
    expect(iso(fall.gte)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(fall.lt)).toBe('2026-11-02T05:00:00.000Z');
    expect((fall.lt.getTime() - fall.gte.getTime()) / 3_600_000).toBe(25);
  });
  test('11 PM EDT belongs to its local day, not the next', () => {
    const night = new Date('2026-07-16T03:30:00Z'); // 23:30 EDT on the 15th
    const r = dayRange('2026-07-15', NY);
    expect(night >= r.gte && night < r.lt).toBe(true);
    expect(localDateKey(night, NY)).toBe('2026-07-15');
  });
});

describe('helpers', () => {
  test('partsInTz and offsets', () => {
    const p = partsInTz('2026-11-23T15:05:00Z', NY);
    expect([p.dateKey, p.hour, p.minute, p.weekday]).toEqual(['2026-11-23', 10, 5, 1]);
    expect(tzOffsetMs(new Date('2026-07-01T12:00:00Z'), NY)).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(new Date('2026-12-01T12:00:00Z'), NY)).toBe(-5 * 3_600_000);
  });
  test('midnight is hour 0, not 24', () => {
    expect(partsInTz('2026-11-23T05:00:00Z', NY).hour).toBe(0);
  });
  test('date keys', () => {
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-1-5')).toBe(false);
    expect(addDaysToDateKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayOfWeek('2026-11-23')).toBe(1); // Monday
  });
  test('tzOf falls back for missing/invalid zones', () => {
    expect(tzOf(null)).toBe(DEFAULT_TIMEZONE);
    expect(tzOf({ timezone: 'Not/AZone' })).toBe(DEFAULT_TIMEZONE);
    expect(tzOf({ timezone: 'America/Chicago' })).toBe('America/Chicago');
  });
  test('describeNow states date, time and zone', () => {
    const text = describeNow({ timezone: NY }, new Date('2026-11-23T15:05:00Z'));
    expect(text).toContain('Monday, November 23, 2026');
    expect(text).toContain('10:05 AM');
    expect(text).toContain('America/New_York');
    expect(text).toContain('2026-11-24T10:00:00');
  });
});

describe('parseScheduledAt (agent input)', () => {
  const ok = (raw: string, tz = NY) => {
    const r = parseScheduledAt(raw, tz);
    if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.reason}`);
    return r;
  };
  test('offset-less ISO is wall-clock in the BUSINESS zone, not UTC', () => {
    const r = ok('2026-11-23T10:00:00');
    expect(iso(r.date)).toBe('2026-11-23T15:00:00.000Z');
    expect(r.assumedZone).toBe(true);
    expect(iso(ok('2026-11-23T10:00').date)).toBe('2026-11-23T15:00:00.000Z');
    expect(iso(ok('2026-11-23 10:00').date)).toBe('2026-11-23T15:00:00.000Z');
    expect(iso(ok('2026-07-15T10:00:00').date)).toBe('2026-07-15T14:00:00.000Z');
  });
  test('uses each business zone', () => {
    expect(iso(ok('2026-11-23T10:00:00', 'America/Los_Angeles').date)).toBe('2026-11-23T18:00:00.000Z');
  });
  test('explicit offsets are honoured', () => {
    expect(iso(ok('2026-11-23T10:00:00Z').date)).toBe('2026-11-23T10:00:00.000Z');
    expect(iso(ok('2026-11-23T10:00:00-05:00').date)).toBe('2026-11-23T15:00:00.000Z');
    expect(iso(ok('2026-11-23T10:00:00-0500').date)).toBe('2026-11-23T15:00:00.000Z');
    expect(iso(ok('2026-11-23T10:00:00+05:30').date)).toBe('2026-11-23T04:30:00.000Z');
    expect(ok('2026-11-23T10:00:00-05:00').assumedZone).toBe(false);
  });
  test('rejects garbage instead of guessing', () => {
    for (const bad of ['', 'tomorrow at 10', 'March 5', '2026-13-01T10:00:00', '2026-02-30T10:00:00', '2026-11-23T25:00:00', '2026-11-23T10:61:00']) {
      expect(parseScheduledAt(bad, NY).ok).toBe(false);
    }
    const dateOnly = parseScheduledAt('2026-11-23', NY);
    expect(dateOnly.ok).toBe(false);
    if (!dateOnly.ok) expect(dateOnly.reason).toBe('missing_time');
    expect(parseScheduledAt(undefined, NY).ok).toBe(false);
  });
});
