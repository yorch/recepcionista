import { describe, expect, test } from 'bun:test';
import { areaCodeForBusiness, areaCodeOf, configuredAreaCode, isValidAreaCode, phoneCountry, sameNumber, toE164 } from '../src/lib/phone';

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

describe('area codes for number purchase (docs/review/08 F10)', () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
  test('isValidAreaCode: geographic NANP codes only', () => {
    for (const ok of ['305', '786', '212', '415', '647']) expect(isValidAreaCode(ok)).toBe(true);
    for (const bad of ['', '30', '3055', '055', '105', '911', '411', '555', '800', '888', '900', 'abc', ' 305']) expect(isValidAreaCode(bad)).toBe(false);
    expect(isValidAreaCode(null)).toBe(false);
  });
  test('areaCodeOf reads US/Canada numbers in any format, and nothing else', () => {
    expect(areaCodeOf('+13055550142')).toBe('305');
    expect(areaCodeOf('(786) 555-0123')).toBe('786');
    expect(areaCodeOf('1 212 555 0100')).toBe('212');
    expect(areaCodeOf('+442071838750')).toBeNull();
    expect(areaCodeOf('garbage')).toBeNull();
    expect(areaCodeOf(null)).toBeNull();
  });
  test('TWILIO_AREA_CODE configures the default, 305 when unset or invalid', () => {
    expect(configuredAreaCode(env({}))).toBe('305');
    expect(configuredAreaCode(env({ TWILIO_AREA_CODE: '415' }))).toBe('415');
    expect(configuredAreaCode(env({ TWILIO_AREA_CODE: '  212 ' }))).toBe('212');
    for (const bad of ['0', '1234', 'abc', '800', '']) expect(configuredAreaCode(env({ TWILIO_AREA_CODE: bad }))).toBe('305');
  });
  test('a business is bought a number in its own owner phone area code when valid, else the configured default', () => {
    expect(areaCodeForBusiness({ owner_phone: '+17865550123' }, env({ TWILIO_AREA_CODE: '212' }))).toBe('786');
    expect(areaCodeForBusiness({ owner_phone: null }, env({ TWILIO_AREA_CODE: '212' }))).toBe('212');
    expect(areaCodeForBusiness({ owner_phone: '+442071838750' }, env({}))).toBe('305');
    expect(areaCodeForBusiness(null, env({}))).toBe('305');
  });
});
