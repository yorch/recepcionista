import { describe, expect, test } from 'bun:test';
import { decide, isQuietHour, withStopFooter, STOP_FOOTER } from '../src/lib/messaging/policy';
import { parseKeyword, helpReply, twiml } from '../src/lib/messaging/keywords';

const TZ = 'America/New_York';
// 2026-07-01 is EDT (UTC-4)
const at = (hhmmEt: string) => new Date(`2026-07-01T${hhmmEt}:00-04:00`);

describe('quiet hours (business timezone)', () => {
  test('9pm-8am is quiet, daytime is not', () => {
    expect(isQuietHour(at('21:00'), TZ)).toBe(true);
    expect(isQuietHour(at('23:59'), TZ)).toBe(true);
    expect(isQuietHour(at('07:59'), TZ)).toBe(true);
    expect(isQuietHour(at('08:00'), TZ)).toBe(false);
    expect(isQuietHour(at('20:59'), TZ)).toBe(false);
  });
  test('uses the business zone, not UTC', () => {
    // 02:00 UTC = 22:00 ET (quiet) but 19:00 in Los Angeles (not quiet)
    const t = new Date('2026-07-02T02:00:00Z');
    expect(isQuietHour(t, 'America/New_York')).toBe(true);
    expect(isQuietHour(t, 'America/Los_Angeles')).toBe(false);
  });
});

describe('send policy', () => {
  const base = { isOwnerRecipient: false, optedOut: false, timezone: TZ, now: at('12:00') };

  test('owner alerts ignore opt-out lists and quiet hours', () => {
    const d = decide({ ...base, kind: 'owner_alert', isOwnerRecipient: true, optedOut: true, now: at('23:00') });
    expect(d).toEqual({ allow: true, consent_basis: 'owner_alert', footer: false });
  });
  test('owner_alert kind to a non-owner is treated as a customer text', () => {
    const d = decide({ ...base, kind: 'owner_alert', optedOut: true });
    expect(d).toEqual({ allow: false, reason: 'blocked_opt_out' });
  });
  test('transactional customer text: blocked when opted out, else allowed with footer', () => {
    expect(decide({ ...base, kind: 'confirmation', optedOut: true })).toEqual({ allow: false, reason: 'blocked_opt_out' });
    expect(decide({ ...base, kind: 'payment_link' })).toEqual({ allow: true, consent_basis: 'transactional_booking', footer: true });
    expect(decide({ ...base, kind: 'other' })).toEqual({ allow: true, consent_basis: 'caller_initiated', footer: true });
  });
  test('transactional texts are not held for quiet hours', () => {
    expect(decide({ ...base, kind: 'confirmation', now: at('22:00') }).allow).toBe(true);
  });
  test('marketing needs a recorded consent basis', () => {
    expect(decide({ ...base, kind: 'gratitude' })).toEqual({ allow: false, reason: 'blocked_no_consent' });
    expect(decide({ ...base, kind: 'review_request', consentBasis: 'because' })).toEqual({ allow: false, reason: 'blocked_no_consent' });
    expect(decide({ ...base, kind: 'gratitude', consentBasis: 'booking_followup' }).allow).toBe(true);
  });
  test('marketing: opt-out and quiet hours block', () => {
    const m = { ...base, kind: 'gratitude' as const, consentBasis: 'express_opt_in' };
    expect(decide({ ...m, optedOut: true })).toEqual({ allow: false, reason: 'blocked_opt_out' });
    expect(decide({ ...m, now: at('21:30') })).toEqual({ allow: false, reason: 'blocked_quiet_hours' });
    expect(decide({ ...m, now: at('06:00') })).toEqual({ allow: false, reason: 'blocked_quiet_hours' });
  });
});

describe('STOP footer', () => {
  test('appended once and idempotent', () => {
    const once = withStopFooter('Acme: Confirmed — AC repair, tomorrow at 9:00 AM. Reply C to cancel.');
    expect(once.endsWith(`. ${STOP_FOOTER}`)).toBe(true);
    expect(withStopFooter(once)).toBe(once);
  });
  test('trims the body, never the footer, to fit the budget', () => {
    const long = withStopFooter('x'.repeat(400), 300);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith(STOP_FOOTER)).toBe(true);
  });
  test('short message fits in 160', () => {
    expect(withStopFooter('Acme: your 9am visit is confirmed.', 160).length).toBeLessThanOrEqual(160);
  });
});

describe('inbound keywords', () => {
  test('stop family', () => {
    for (const w of ['STOP', 'stop', ' Stop. ', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'QUIT']) {
      expect(parseKeyword(w)).toBe('stop');
    }
  });
  test('start family and help', () => {
    for (const w of ['START', 'yes', 'UNSTOP']) expect(parseKeyword(w)).toBe('start');
    expect(parseKeyword('HELP')).toBe('help');
  });
  test('ordinary messages are not keywords', () => {
    for (const w of ['5', 'please stop by tomorrow', 'C', 'stop texting me', '', undefined]) {
      expect(parseKeyword(w as string | undefined)).toBeNull();
    }
  });
  test('help text names the business; TwiML escapes it', () => {
    expect(helpReply('Acme AC', '+13055550123')).toContain('Acme AC');
    expect(twiml('A & B <x>')).toContain('A &amp; B &lt;x&gt;');
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
