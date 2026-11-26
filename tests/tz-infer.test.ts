// Run with: bun test   (pure, no database).
import { describe, expect, test } from 'bun:test';
import { AREA_CODE_TIME_ZONES, inferTimeZoneFromPhone, isIanaTimeZone, timeZoneForAreaCode } from '../src/lib/tz-infer';

describe('isIanaTimeZone', () => {
  test('accepts real IANA names', () => {
    for (const z of ['America/New_York', 'America/Chicago', 'America/Indiana/Indianapolis', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu', 'UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires']) {
      expect(isIanaTimeZone(z)).toBe(true);
    }
  });
  test('rejects abbreviations, offsets, junk and non-strings that Intl alone would take', () => {
    for (const z of ['EST', 'PST8PDT', '+01:00', 'GMT+2', 'utc', 'America/Nowhere', 'America/', '/New_York', 'America New_York', '', ' America/New_York', 'x'.repeat(80), 'America/New_York\n']) {
      expect(isIanaTimeZone(z)).toBe(false);
    }
    for (const z of [null, undefined, 5, {}, []]) expect(isIanaTimeZone(z)).toBe(false);
  });
});

describe('area code -> time zone', () => {
  test('known codes', () => {
    expect(timeZoneForAreaCode('305')).toBe('America/New_York');
    expect(timeZoneForAreaCode('312')).toBe('America/Chicago');
    expect(timeZoneForAreaCode('303')).toBe('America/Denver');
    expect(timeZoneForAreaCode('602')).toBe('America/Phoenix');
    expect(timeZoneForAreaCode('415')).toBe('America/Los_Angeles');
    expect(timeZoneForAreaCode('907')).toBe('America/Anchorage');
    expect(timeZoneForAreaCode('808')).toBe('Pacific/Honolulu');
    expect(timeZoneForAreaCode('787')).toBe('America/Puerto_Rico');
  });
  test('ambiguous / toll free / unknown / malformed are null', () => {
    for (const c of ['850', '308', '800', '555', '000', '30', '3055', 'abc', '', null, undefined]) expect(timeZoneForAreaCode(c as string)).toBeNull();
  });
  test('every mapped zone is a valid IANA zone and every key is a 3-digit NXX code', () => {
    for (const [code, zone] of Object.entries(AREA_CODE_TIME_ZONES)) {
      expect(code).toMatch(/^[2-9]\d\d$/);
      expect(isIanaTimeZone(zone)).toBe(true);
    }
  });
  test('inference from phone numbers in several formats; non US/Canada and junk give null', () => {
    expect(inferTimeZoneFromPhone('+1 (305) 555-0142')).toBe('America/New_York');
    expect(inferTimeZoneFromPhone('(312) 555-0199')).toBe('America/Chicago');
    expect(inferTimeZoneFromPhone('+14155550123')).toBe('America/Los_Angeles');
    expect(inferTimeZoneFromPhone('+442071838750')).toBeNull();
    expect(inferTimeZoneFromPhone('nonsense')).toBeNull();
    expect(inferTimeZoneFromPhone(null)).toBeNull();
  });
});
