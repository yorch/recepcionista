/** Regression tests for the hardening changelog rows closed in this pass (pure logic only). */
import { describe, expect, test } from 'bun:test';
import { parseClock, sanitizeHours } from '../src/lib/extraction';
import { extractJson } from '../src/lib/providers/llm';
import { scrub } from '../src/lib/log';
import { dayLabelET, relative } from '../src/lib/format';
import { utcDate, utcStamp } from '../src/components/dashboard/dates';
import { missingBookingFields } from '../src/lib/voice/tools';
import { clampLimit, encodeTimeCursor, parseTimeCursor, toPage } from '../src/lib/db/paging';
import { TOOL_NAMES as KB_TOOLS } from '../src/lib/kb';
import { TOOL_NAMES as TOOLS } from '../src/lib/voice/tools';
import { zonedTimeToUtc } from '../src/lib/time';

describe('M13 extraction hours parsing', () => {
  test('clock values: 24h, 12h with am/pm, noon/midnight, seconds, spacing and dots', () => {
    const cases: [unknown, string | null][] = [
      ['08:00', '08:00'], ['8:00', '08:00'], ['8', '08:00'], ['17:30:00', '17:30'], ['9am', '09:00'], ['9 AM', '09:00'], ['9:30 pm', '21:30'],
      ['12am', '00:00'], ['12pm', '12:00'], ['12:30 a.m.', '00:30'], ['noon', '12:00'], ['midnight', '24:00'], ['24:00', '24:00'],
      ['25:00', null], ['9:60', null], ['13pm', null], ['0am', null], ['', null], ['soon', null], [null, null], [900, null], ['24:30', null],
    ];
    for (const [raw, want] of cases) expect([raw, parseClock(raw)]).toEqual([raw, want]);
  });

  test('a PM closing time is not read as the morning (the old slice(0,5) bug)', () => {
    const h = sanitizeHours({ monday: { open: '8:00 AM', close: '5:00 PM' }, tuesday: { open: '9am', close: '6pm' } });
    expect(h.monday).toEqual({ open: '08:00', close: '17:00' });
    expect(h.tuesday).toEqual({ open: '09:00', close: '18:00' });
  });

  test('always seven days; bad, reversed, overnight or missing days are closed, not guessed', () => {
    const h = sanitizeHours({
      Monday: { open: '08:00', close: '17:00' }, TUE: { open: '08:00', close: '12:00' }, wed: { open: '17:00', close: '08:00' },
      thursday: { open: '22:00', close: '02:00' }, friday: { open: 'x', close: 'y' }, saturday: null, sunday: '9am - 1pm',
    });
    expect(Object.keys(h)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(h.monday).toEqual({ open: '08:00', close: '17:00' });
    expect(h.tuesday).toEqual({ open: '08:00', close: '12:00' });
    expect(h.wednesday).toBeNull(); // closes before it opens
    expect(h.thursday).toBeNull(); // overnight hours are not supported by the booking maths
    expect(h.friday).toBeNull();
    expect(h.saturday).toBeNull();
    expect(h.sunday).toEqual({ open: '09:00', close: '13:00' }); // "9am - 1pm" text form
    expect(Object.values(sanitizeHours(undefined)).every((v) => v === null)).toBe(true);
    expect(Object.values(sanitizeHours([1, 2])).every((v) => v === null)).toBe(true);
    expect(sanitizeHours({ monday: { open: '00:00', close: '24:00' } }).monday).toEqual({ open: '00:00', close: '24:00' });
    expect(sanitizeHours({ monday: { open: '24:00', close: '24:00' } }).monday).toBeNull();
  });
});

describe('M14 LLM adapter: JSON extraction', () => {
  test('plain, fenced, and surrounded by prose with brackets', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! [see note] Here it is: {"a":"x}y","b":{"c":1}} Hope that helps {not json}')).toEqual({ a: 'x}y', b: { c: 1 } });
    expect(extractJson('The list: [1,2,3]. Done.')).toEqual([1, 2, 3]);
    expect(() => extractJson('no json here')).toThrow();
    expect(() => extractJson('{"a":')).toThrow();
  });
});

describe('L1/L7 log scrubbing is value based', () => {
  test('phones keep the last four, emails the first letter; credentials are always removed', () => {
    expect(scrub('call from +13055550142', {})).toBe('call from +•••0142');
    expect(scrub('call from (305) 555-0142 now', {})).toBe('call from •••0142 now');
    expect(scrub('mail jorge@acme.com', {})).toBe('mail j•••@acme.com');
    expect(scrub('key sk_live_abcdefghijkl and Bearer abcdefghijklmnop12', {})).toBe('key «redacted» and «redacted»');
    expect(scrub('call from +13055550142', { LOG_PII: 'true' })).toBe('call from +13055550142'); // opt-in debugging
    expect(scrub('Bearer abcdefghijklmnop12', { LOG_PII: 'true' })).toBe('«redacted»'); // credentials stay masked
    expect(scrub('at 2026-11-24T10:00:00.000Z id 5cc27fb8-4973-42b1-b379-81162bb0319b', {})).toBe('at 2026-11-24T10:00:00.000Z id 5cc27fb8-4973-42b1-b379-81162bb0319b');
  });
});

describe('9/10/23 Today page and format helpers', () => {
  const NY = 'America/New_York';
  test('day labels use the BUSINESS day, not the viewer or UTC', () => {
    const now = new Date(zonedTimeToUtc('2026-11-24', '21:30', NY)); // already Nov 25 in UTC
    expect(dayLabelET(zonedTimeToUtc('2026-11-24', '09:00', NY).toISOString(), NY, now)).toBe('Today');
    expect(dayLabelET(zonedTimeToUtc('2026-11-25', '09:00', NY).toISOString(), NY, now)).toBe('Tomorrow');
    expect(dayLabelET(zonedTimeToUtc('2026-11-27', '09:00', NY).toISOString(), NY, now)).toBe('Fri, Nov 27');
    expect(dayLabelET(zonedTimeToUtc('2026-11-23', '09:00', NY).toISOString(), NY, now)).toBe('Mon, Nov 23');
  });
  test('relative time takes an injected clock (no second Date.now()) and handles the future', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    expect(relative('2026-11-24T11:59:40Z', now)).toBe('just now');
    expect(relative('2026-11-24T11:30:00Z', now)).toBe('30m ago');
    expect(relative('2026-11-24T09:00:00Z', now)).toBe('3h ago');
    expect(relative('2026-11-20T12:00:00Z', now)).toBe('4d ago');
    expect(relative('2026-11-24T13:00:00Z', now)).toBe('soon');
  });
  test('hydration-safe timestamps use a fixed locale and zone', () => {
    expect(utcStamp('2026-11-24T15:05:00Z')).toBe('Nov 24, 2026, 3:05 PM UTC');
    expect(utcDate('2026-11-24T23:59:00Z')).toBe('Nov 24, 2026');
  });
});

describe('L10 callback wording', () => {
  test('only the missing booking fields are asked for, and a phone only when caller id is withheld', () => {
    expect(missingBookingFields('en', { name: false, phone: false, service: true, scheduled_at: false })).toBe('I just need which service you need.');
    expect(missingBookingFields('en', { name: true, phone: false, service: false, scheduled_at: true })).toBe('I just need your name and which day and time works.');
    const withPhone = missingBookingFields('en', { name: true, phone: true, service: false, scheduled_at: false });
    expect(withPhone).toContain('cannot see the number you are calling from');
    expect(missingBookingFields('es', { name: true, phone: false, service: true, scheduled_at: false })).toBe('Solo necesito su nombre y qué servicio necesita.');
  });
});

describe('L4 pagination primitives', () => {
  test('limits are clamped; cursors round-trip and reject junk', () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit('7')).toBe(7);
    expect(clampLimit(0)).toBe(25);
    expect(clampLimit(-3)).toBe(25);
    expect(clampLimit(10_000)).toBe(200);
    expect(clampLimit(NaN, 5)).toBe(5);
    const at = new Date('2026-11-24T10:00:00.000Z');
    expect(parseTimeCursor(encodeTimeCursor(at, 'abc-123'))).toEqual({ at, id: 'abc-123' });
    for (const bad of [null, undefined, '', 'x', 'nope~id', '2026-11-24T10:00:00.000Z~', '2026-11-24T10:00:00.000Z~a b', `${at.toISOString()}~${'x'.repeat(80)}`, 5]) expect(parseTimeCursor(bad)).toBeNull();
  });
  test('toPage keeps `limit` rows and a cursor only when more exist', () => {
    const rows = [1, 2, 3, 4].map((n) => ({ n }));
    const p = toPage(rows, 3, (r) => r.n, (r) => `c${r.n}`);
    expect(p).toEqual({ items: [1, 2, 3], next_cursor: 'c3' });
    expect(toPage(rows.slice(0, 3), 3, (r) => r.n, (r) => `c${r.n}`)).toEqual({ items: [1, 2, 3], next_cursor: null });
    expect(toPage([], 3, (r: { n: number }) => r.n, (r) => `c${r.n}`)).toEqual({ items: [], next_cursor: null });
  });
});

describe('DRY: one tool list', () => {
  test('kb and voice tools share the same TOOL_NAMES', () => {
    expect(TOOLS).toBe(KB_TOOLS);
    expect(TOOLS.length).toBe(7);
  });
});
