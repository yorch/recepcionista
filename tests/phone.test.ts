import { describe, expect, test } from 'bun:test';
import { phoneCountry, sameNumber, toE164 } from '../src/lib/phone';

describe('toE164', () => {
  test('US formats', () => {
    expect(toE164('(305) 555-0142')).toBe('+13055550142');
    expect(toE164('305.555.0142')).toBe('+13055550142');
    expect(toE164('1 305 555 0142')).toBe('+13055550142');
    expect(toE164('+1 (305) 555-0142')).toBe('+13055550142');
  });
  test('international and default country', () => {
    expect(toE164('+44 7911 123456')).toBe('+447911123456');
    expect(toE164('07911 123456', 'GB')).toBe('+447911123456');
    expect(toE164('07911 123456')).toBeNull(); // not a valid US number
  });
  test('junk is null, never throws', () => {
    for (const v of ['', '   ', 'abc', '123', '+', '911', null, undefined, '1'.repeat(80), '555-0142']) {
      expect(toE164(v as string)).toBeNull();
    }
  });
  test('a bogus default country does not throw', () => {
    expect(toE164('3055550142', 'ZZ')).toBeNull();
  });
});

describe('phoneCountry / sameNumber', () => {
  test('country of a number', () => {
    expect(phoneCountry('+13055550142')).toBe('US');
    expect(phoneCountry('+4930123456')).toBe('DE');
    expect(phoneCountry('3055550142')).toBeNull();
    expect(phoneCountry(null)).toBeNull();
  });
  test('sameNumber distinguishes countries that share the last 10 digits', () => {
    expect(sameNumber('(305) 555-0142', '+1 305-555-0142')).toBe(true);
    expect(sameNumber('+44 7911 123456', '+1 791-112-3456')).toBe(false);
    expect(sameNumber('abc', 'abc')).toBe(false);
    expect(sameNumber(null, null)).toBe(false);
  });
});
