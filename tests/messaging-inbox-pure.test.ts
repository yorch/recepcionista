/** Inbox wording and limits (pure): auto-reply language / assistant name / trade word, owner forward text, review link policy, template sign-offs. */
import { describe, expect, test } from 'bun:test';
import { autoReplyText, inboxLanguage, ownerForwardText, safeForward } from '../src/lib/messaging/inbox-copy';
import { assistantNameOf, DEFAULT_ASSISTANT_NAME, gratitudeSms, reviewLinkOf, reviewRequestSms, SMS_LIMIT } from '../src/lib/messaging/templates';
import { inboxForwardHourlyLimit, isTrivialAck } from '../src/lib/messaging/inbox';
import { clampAlertBody } from '../src/lib/voice/owner-alert';
import { isGsm7, smsSegments, withStopFooter } from '../src/lib/messaging/policy';
import { MANUAL_TEXT_MAX } from '../src/lib/messaging/manual-limits';
import { ERASE_CONFIRM_WORD } from '../src/lib/messaging/privacy-words';
import type { Booking, Business } from '../src/lib/types';

const biz = (over: Partial<Business> = {}): Business => ({
  id: 'b1', name: 'Cool Air', phone: '+13055550123', vertical: 'hvac', locale_default: 'en', timezone: 'America/New_York', ...over,
} as unknown as Business);
const booking = { id: 'bk', customer_name: 'Ana Perez', service: 'AC repair' } as unknown as Booking;

describe('inboxLanguage', () => {
  test('follows what the customer wrote, else the business default', () => {
    expect(inboxLanguage(biz(), 'Hola, necesito una cita mañana')).toBe('es');
    expect(inboxLanguage(biz({ locale_default: 'es' }), 'Can you come at 3 please')).toBe('en');
    expect(inboxLanguage(biz({ locale_default: 'es' }), '1234')).toBe('es');
    expect(inboxLanguage(biz(), '1234')).toBe('en');
  });
});

describe('auto-reply copy', () => {
  test('English: business name, assistant name (default Maria), the phone, one segment-ish, no URL', () => {
    const t = autoReplyText(biz(), 'can you come at 3?');
    expect(t).toContain('Cool Air');
    expect(t).toContain(DEFAULT_ASSISTANT_NAME);
    expect(t).toContain('(305) 555-0123');
    expect(t).not.toMatch(/https?:/);
    expect(t.length).toBeLessThanOrEqual(SMS_LIMIT);
  });
  test('uses the configured assistant name and the trade word; Spanish for a Spanish text', () => {
    const t = autoReplyText(biz({ assistant_name: 'Sofia', vertical: 'plumbing' }), 'hola, tengo una fuga');
    expect(t).toContain('Sofia');
    expect(t).toContain('plomería');
    expect(t).toContain('Recibimos su mensaje');
    expect(autoReplyText(biz({ vertical: 'dental' }), 'is the office open?')).toContain('appointment');
  });
  test('without a business phone it still says what to do', () => {
    expect(autoReplyText(biz({ phone: null as unknown as string }), 'hello')).toMatch(/urgent/);
  });
  test('with the STOP footer it stays within the segments budget', () => {
    const t = withStopFooter(autoReplyText(biz({ name: 'A very long business name LLC' }), 'hello there'));
    expect(smsSegments(t)).toBeLessThanOrEqual(3);
    expect(t).toContain('Reply STOP to opt out');
  });
});

describe('owner forward text', () => {
  test('never carries a link, shows only the last 4, and survives the alert clamp as GSM-7', () => {
    const t = ownerForwardText(biz(), { last4: '0199' }, 'gate code 1234 http://evil.example/x and www.evil.example "quoted"\nline');
    expect(t).not.toMatch(/evil/);
    expect(t).toContain('[link]');
    expect(t).toContain('...0199');
    expect(t).not.toContain('"quoted"');
    expect(isGsm7(clampAlertBody(t))).toBe(true);
  });
  test('a long text is cut, Spanish owner gets Spanish', () => {
    const t = ownerForwardText(biz({ locale_default: 'es' }), { last4: '1' }, 'x'.repeat(2000));
    expect(t.length).toBeLessThan(260);
    expect(t).toMatch(/Mensaje de un cliente/);
    expect(safeForward('a  b\n\nc', 50)).toBe('a b c');
  });
});

describe('review link policy (#8)', () => {
  test('only the business\'s own https link; never a placeholder, never http', () => {
    expect(reviewLinkOf({ review_url: null })).toBeNull();
    expect(reviewLinkOf({ review_url: undefined })).toBeNull();
    expect(reviewLinkOf({ review_url: 'http://insecure.example/r' })).toBeNull();
    expect(reviewLinkOf({ review_url: 'https://g.page/r/abc/review' })).toBe('https://g.page/r/abc/review');
  });
  test('review request: link when set, a thank-you without it otherwise, signed by the assistant', () => {
    const withLink = reviewRequestSms({ business: biz(), booking, reviewUrl: 'https://g.page/r/abc/review' });
    expect(withLink).toContain('https://g.page/r/abc/review');
    expect(withLink).toContain('Maria, Cool Air');
    const without = reviewRequestSms({ business: biz({ assistant_name: 'Sofia' }), booking, reviewUrl: null });
    expect(without).not.toMatch(/https?:|g\.page|demo/);
    expect(without).toContain('Sofia, Cool Air');
    expect(reviewRequestSms({ business: biz(), booking, reviewUrl: '', language: 'es' })).toMatch(/Gracias/);
  });
  test('gratitude text is signed with the assistant name (null name -> Maria)', () => {
    expect(assistantNameOf({ assistant_name: null })).toBe('Maria');
    expect(assistantNameOf({ assistant_name: '  Lucia ' })).toBe('Lucia');
    expect(gratitudeSms({ business: biz(), booking })).toContain('Maria, Cool Air');
    expect(gratitudeSms({ business: biz({ assistant_name: 'Lucia' }), booking, language: 'es' })).toContain('Lucia, Cool Air');
  });
});

describe('limits', () => {
  test('INBOX_FORWARD_HOURLY_LIMIT: default 10, positive integers only', () => {
    expect(inboxForwardHourlyLimit({} as NodeJS.ProcessEnv)).toBe(10);
    expect(inboxForwardHourlyLimit({ INBOX_FORWARD_HOURLY_LIMIT: '3' } as unknown as NodeJS.ProcessEnv)).toBe(3);
    for (const bad of ['0', '-1', 'x', '1.5', '']) expect(inboxForwardHourlyLimit({ INBOX_FORWARD_HOURLY_LIMIT: bad } as unknown as NodeJS.ProcessEnv)).toBe(10);
  });
  test('a 320-character owner text keeps every word once the STOP footer is added (max_chars)', () => {
    const body = 'word '.repeat(64).trim().slice(0, MANUAL_TEXT_MAX);
    const out = withStopFooter(body, MANUAL_TEXT_MAX + 30);
    expect(out).toContain('Reply STOP to opt out');
    expect(out.startsWith(body.slice(0, 300))).toBe(true);
    expect(out).not.toContain('...');
    expect(ERASE_CONFIRM_WORD).toBe('ERASE');
  });
});

describe('trivial acknowledgements', () => {
  test('ok / yes / thanks / emoji only are acknowledgements; questions and details are not', () => {
    for (const t of ['ok', ' OK. ', 'Yes', 'si', 'Thanks!', 'gracias', 'Thank you', '👍', '👍🏽 ', 'k']) expect(isTrivialAck(t)).toBe(true);
    for (const t of ['ok but can you come at 3?', 'no gate code', '1234', 'yes please call me', '', '   ']) expect(isTrivialAck(t)).toBe(false);
  });
});
