import { describe, expect, test } from 'bun:test';
import { allowedCountryCodes, countryAllowed, validateRecipient } from '../src/lib/messaging/recipient';
import { safeText, confirmationSms } from '../src/lib/messaging/templates';
import { isPublicIp, isIP } from '../src/lib/net/ip-shape';
import { normalizeUrl } from '../src/lib/extraction/url';

describe('SMS recipient policy', () => {
  test('parses allowed country codes', () => {
    expect(allowedCountryCodes(undefined)).toEqual(['1']);
    expect(allowedCountryCodes('1, +52 ,')).toEqual(['1', '52']);
  });
  test('country check', () => {
    expect(countryAllowed('+13055550123', ['1'])).toBe(true);
    expect(countryAllowed('+447700900123', ['1'])).toBe(false);
    expect(countryAllowed('+8821234567', ['1'])).toBe(false);
  });
  test('validateRecipient', () => {
    expect(validateRecipient('305-555-0123', ['1'])).toEqual({ ok: true, to: '+13055550123' });
    expect(validateRecipient('+1 (305) 555-0123', ['1'])).toEqual({ ok: true, to: '+13055550123' });
    expect(validateRecipient('+447700900123', ['1']).ok).toBe(false);
    expect(validateRecipient('+447700900123', ['1', '44']).ok).toBe(true);
    expect(validateRecipient('12345', ['1']).ok).toBe(false);
    expect(validateRecipient('', ['1']).ok).toBe(false);
  });
});

describe('SMS body hygiene', () => {
  test('safeText strips links and odd characters', () => {
    expect(safeText('Your account is locked visit evil.example/login now')).not.toContain('evil.example');
    expect(safeText('see https://evil.test/x')).not.toContain('http');
    expect(safeText('AC repair <b>now</b>')).toBe('AC repair b now /b');
    expect(safeText('x'.repeat(200)).length).toBe(60);
  });
  test('confirmation body does not echo links from service/address', () => {
    const body = confirmationSms({
      business: { name: 'Cool Air' } as never,
      booking: { customer_name: 'Ana', service: 'visit evil.example now', address: '1 Main St http://x.co', scheduled_at: '2026-11-24T15:00:00.000Z', price_estimate: null } as never,
    });
    expect(body).not.toContain('evil.example');
    expect(body).not.toContain('http');
  });
});

describe('client-safe URL helpers', () => {
  test('normalizeUrl is usable without node modules', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('http://127.0.0.1')).toBeNull();
    expect(normalizeUrl('ftp://example.com')).toBeNull();
    expect(normalizeUrl('http://localhost')).toBeNull();
    expect(normalizeUrl('https://example.com:8080')).toBeNull();
  });
  test('ip checks incl. SIIT / local NAT64', () => {
    expect(isIP('1.2.3.4')).toBe(4);
    expect(isIP('::1')).toBe(6);
    expect(isIP('example.com')).toBe(0);
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('::ffff:0:7f00:1')).toBe(false);
    expect(isPublicIp('64:ff9b:1::a00:1')).toBe(false);
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
  });
});
