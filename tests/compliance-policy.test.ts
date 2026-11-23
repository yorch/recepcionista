import { describe, expect, test } from 'bun:test';
import { decide, isQuietHour, withStopFooter, isGsm7, smsSegments, STOP_FOOTER } from '../src/lib/messaging/policy';
import { parseKeyword, helpReply, twiml, normalizeInbound, mentionsStopWord } from '../src/lib/messaging/keywords';

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
  test('free-text `manual` messages obey quiet hours; owner_alert is owner-only; opt-out still wins', () => {
    const b = { isOwnerRecipient: false, optedOut: false, timezone: TZ };
    expect(decide({ ...b, kind: 'manual', now: at('03:00') })).toEqual({ allow: false, reason: 'blocked_quiet_hours' });
    expect(decide({ ...b, kind: 'manual', now: at('12:00') })).toMatchObject({ allow: true, footer: true, consent_basis: 'owner_manual' });
    // a message labelled owner_alert to anyone but the owner phone is just a customer message
    expect(decide({ ...b, kind: 'owner_alert', optedOut: true, now: at('12:00') })).toEqual({ allow: false, reason: 'blocked_opt_out' });
    expect(decide({ ...b, kind: 'manual', optedOut: true, now: at('12:00') })).toEqual({ allow: false, reason: 'blocked_opt_out' });
  });

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
  test('never produces invalid UTF-16 and never forces UCS-2 on a GSM-7 message', () => {
    const emoji = withStopFooter('a'.repeat(275) + '😀'.repeat(20));
    expect(emoji.isWellFormed()).toBe(true);
    expect(emoji.endsWith(STOP_FOOTER)).toBe(true);
    expect([...emoji].length).toBeLessThanOrEqual(300);
    const gsm = withStopFooter('Hello there. '.repeat(40));
    expect(isGsm7(gsm)).toBe(true); // the cut marker is ASCII "...", not U+2026
    expect(gsm).not.toContain('\u2026');
    expect(smsSegments(gsm)).toBe(2); // 300 GSM-7 chars, not 5 UCS-2 segments
    expect(isGsm7('a \u2014 b')).toBe(false);
    expect(isGsm7('Gracias \u00bfqu\u00e9 tal? \u00f1 \u20ac [x]')).toBe(true);
    expect(smsSegments('x'.repeat(161))).toBe(2);
    expect(smsSegments('\u00e9\u20ac'.repeat(5))).toBe(1);
  });
  test('only the exact footer suppresses it (free text like "text stop" does not)', () => {
    const tenant = withStopFooter('Promo today, text stop to be funny');
    expect(tenant.endsWith(STOP_FOOTER)).toBe(true);
    expect(withStopFooter(`Promo. ${STOP_FOOTER}`)).toBe(`Promo. ${STOP_FOOTER}`);
  });
  test('the segment budget is respected for UCS-2 bodies too', () => {
    const ucs = withStopFooter('\u00bfC\u00f3mo est\u00e1? \u2014 '.repeat(60), 300, 3);
    expect(smsSegments(ucs)).toBeLessThanOrEqual(3);
    expect(ucs.endsWith(STOP_FOOTER)).toBe(true);
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
  test('revocation words (CTIA + FCC "reasonable means") with normalisation', () => {
    const stops = [
      'REVOKE', 'optout', 'Opt out', 'OPT-OUT', '"STOP"', 'STOP 🛑', 'ＳＴＯＰ', 'Stop.', 'stop!!!', '  s t o p'.replace(/ /g, ''),
      'Parar', 'ALTO', 'baja', 'stop texting me', 'Stop texting me please', 'please stop', 'PLEASE STOP MESSAGING ME NOW',
      'unsubscribe me', 'stop all', 'stopall', 'end', 'quit', 'cancel', 'STOP\n', '\u00a0STOP\u200b',
    ];
    for (const w of stops) expect([w, parseKeyword(w)]).toEqual([w, 'stop']);
    expect(normalizeInbound('"ＳＴＯＰ 🛑"')).toBe('STOP');
    expect(parseKeyword('AYUDA')).toBe('help');
    expect(mentionsStopWord('I have to end this, call me about the cancel fee')).toBe(true);
    expect(mentionsStopWord('thanks, see you at 5')).toBe(false);
  });
  test('start family and help', () => {
    for (const w of ['START', 'unstop', ' Start! ']) expect(parseKeyword(w)).toBe('start');
    for (const w of ['yes', 'YES!', 'yeah']) expect(parseKeyword(w)).toBeNull(); // a bare YES answers some other question: no re-subscribe
    expect(parseKeyword('HELP')).toBe('help');
  });
  test('ordinary messages are not keywords', () => {
    for (const w of ['5', 'please stop by tomorrow', 'C', 'stop by tomorrow at 5', 'stop by at 5', 'nonstop', 'non stop service', 'end of the month', 'cancel my appointment friday', '', undefined]) {
      expect(parseKeyword(w as string | undefined)).toBeNull();
    }
  });
  test('help text names the business; TwiML escapes it', () => {
    expect(helpReply('Acme AC', '+13055550123')).toContain('Acme AC');
    expect(twiml('A & B <x>')).toContain('A &amp; B &lt;x&gt;');
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
