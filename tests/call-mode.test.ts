/** Call handling mode: routing decision, forward-number vetting, TwiML, and the separation of verification purposes. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { callModeLabel, callModeView, isOpenNow, maskNumber, resolveCallRoute, trustedForwardNumber } from '../src/lib/voice/call-mode';
import { forwardAllowedCountryCodes, forwardDenyAreaCodes, validateForwardNumber } from '../src/lib/voice/forward-number';
import { forwardingSupported, FORWARD_UNAVAILABLE, lineKind, lineKindMismatch } from '../src/lib/voice/line';
import { forwardCallsPerHour, forwardMaxCallSeconds, parseSeconds, voicemailsPerHour } from '../src/lib/voice/forward-metering';
import { forwardTwiml, pausedTwiml, pausedVoicemailPrompt, xmlEscape } from '../src/lib/voice/twiml';
import { pausedFirstMessage } from '../src/lib/voice/capacity';
import { createOwnerPhoneChallenge, forwardVerificationText, verifyOwnerPhoneChallenge } from '../src/lib/messaging/owner-verify';
import { zonedTimeToUtc } from '../src/lib/time';
import { hasMandatoryNotice } from '../src/lib/kb/disclosure';
import type { Business, Hours } from '../src/lib/types';

const KEY = Buffer.alloc(32, 7).toString('base64');

const HOURS: Hours = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, { open: '08:00', close: '17:00' }]),
) as unknown as Hours;
const NY = 'America/New_York';
const base = { hours: HOURS, timezone: NY, owner_phone_e164: '+13055550100', owner_phone_verified_at: '2026-11-01T00:00:00Z' } as const;
const biz = (p: Partial<Business>): Parameters<typeof resolveCallRoute>[0] => ({
  call_mode: 'ai', forward_number_e164: null, forward_number_verified_at: null, forward_during_hours: false, ...base, ...p,
}) as Parameters<typeof resolveCallRoute>[0];
// Tuesday 2026-11-24 at 10:00 and 20:00 local; Saturday 2026-11-28 at 10:00
const open = new Date(zonedTimeToUtc('2026-11-24', '10:00', NY));
const after = new Date(zonedTimeToUtc('2026-11-24', '20:00', NY));
const saturday = new Date(zonedTimeToUtc('2026-11-28', '10:00', NY));

describe('resolveCallRoute', () => {
  test('ai (default) answers; paused never does', () => {
    expect(resolveCallRoute(biz({}), open)).toEqual({ action: 'ai', why: 'mode_ai' });
    expect(resolveCallRoute(biz({ call_mode: undefined }), open)).toEqual({ action: 'ai', why: 'mode_ai' });
    expect(resolveCallRoute(biz({ call_mode: 'paused' }), open)).toEqual({ action: 'paused' });
    expect(resolveCallRoute(biz({ call_mode: 'paused' }), after)).toEqual({ action: 'paused' }); // not schedule-driven
  });

  test('forward rings a VERIFIED number only', () => {
    const verified = { call_mode: 'forward' as const, forward_number_e164: '+13055550142', forward_number_verified_at: '2026-11-02T00:00:00Z' };
    expect(resolveCallRoute(biz(verified), open)).toEqual({ action: 'forward', to: '+13055550142' });
    // an unverified number is NEVER dialled: the AI answers instead
    expect(resolveCallRoute(biz({ ...verified, forward_number_verified_at: null }), open)).toEqual({ action: 'ai', why: 'forward_number_unverified' });
    expect(resolveCallRoute(biz({ call_mode: 'forward' }), open)).toEqual({ action: 'ai', why: 'forward_number_unverified' });
    // the verified owner phone counts without a second code ...
    expect(resolveCallRoute(biz({ call_mode: 'forward', forward_number_e164: '+13055550100' }), open)).toEqual({ action: 'forward', to: '+13055550100' });
    // ... but not once the owner phone is unverified again, or when it is a different number
    expect(resolveCallRoute(biz({ call_mode: 'forward', forward_number_e164: '+13055550100', owner_phone_verified_at: null }), open).action).toBe('ai');
    expect(resolveCallRoute(biz({ call_mode: 'forward', forward_number_e164: '+13055550199' }), open).action).toBe('ai');
  });

  test('forward during business hours only: forward while open, AI after hours and on closed days', () => {
    const f = biz({ call_mode: 'forward', forward_number_e164: '+13055550142', forward_number_verified_at: '2026-11-02T00:00:00Z', forward_during_hours: true });
    expect(resolveCallRoute(f, open).action).toBe('forward');
    expect(resolveCallRoute(f, after)).toEqual({ action: 'ai', why: 'forward_outside_hours' });
    expect(resolveCallRoute(f, saturday)).toEqual({ action: 'ai', why: 'forward_outside_hours' });
    // exactly at opening: open; exactly at closing: closed (half-open window)
    expect(resolveCallRoute(f, new Date(zonedTimeToUtc('2026-11-24', '08:00', NY))).action).toBe('forward');
    expect(resolveCallRoute(f, new Date(zonedTimeToUtc('2026-11-24', '17:00', NY))).action).toBe('ai');
    // the window is in the BUSINESS zone: 3 pm Los Angeles is 6 pm New York (closed there), open in LA
    const la = { ...f, timezone: 'America/Los_Angeles' };
    const t = new Date('2026-11-24T23:00:00Z');
    expect(resolveCallRoute(f, t).action).toBe('ai');
    expect(resolveCallRoute(la, t).action).toBe('forward');
    expect(isOpenNow(HOURS, NY, open)).toBe(true);
    expect(isOpenNow({}, NY, open)).toBe(false);
  });

  test('labels and masks say what will happen', () => {
    expect(callModeLabel(biz({}), open)).toEqual({ text: 'AI is answering calls', tone: 'ok' });
    expect(callModeLabel(biz({ call_mode: 'paused' }), open).text).toMatch(/Paused/);
    const f = biz({ call_mode: 'forward', forward_number_e164: '+13055550142', forward_number_verified_at: '2026-11-02T00:00:00Z' });
    expect(callModeLabel(f, open).text).toBe('Forwarding to +1 ••• ••• 0142');
    expect(callModeLabel(biz({ call_mode: 'forward' }), open).tone).toBe('warn');
    expect(maskNumber('+521234567890')).toBe('+52 ••• 7890');
    const v = callModeView({ ...f, forward_number: '+13055550142' }, { full: false }, open);
    expect(v.forward_number).toBeNull(); // staff never get the full number
    expect(callModeView({ ...f, forward_number: '+13055550142' }, { full: true }, open).forward_number).toBe('+13055550142');
    expect(v).toMatchObject({ route_now: 'forward', forward_verified: true, forward_is_owner_phone: false });
    expect(trustedForwardNumber({ forward_number_e164: null, forward_number_verified_at: '2026-01-01T00:00:00Z', owner_phone_e164: null, owner_phone_verified_at: null })).toBeNull();
  });
});

describe('validateForwardNumber', () => {
  const ok = (raw: unknown, own: string[] = []) => validateForwardNumber(raw, 'US', { ownLines: own, codes: ['1'] });
  test('accepts a normal US mobile in several spellings and returns E.164', () => {
    for (const raw of ['+13055550142', '305 555 0142', '(305) 555-0142', '1-305-555-0142']) expect(ok(raw)).toEqual({ ok: true, e164: '+13055550142' });
  });
  test('refuses short codes, extensions, letters and junk', () => {
    for (const raw of ['911', '411', '86753', '5550142', '+1305555014', '305 555 0142 ext 5', '305-555-0142;123', '1-800-FLOWERS', '', '   ', null, undefined, 42, 'a'.repeat(60)]) {
      expect(ok(raw).ok).toBe(false);
    }
  });
  test('refuses premium-rate, Caribbean international-rate, N11 and non-geographic ranges', () => {
    for (const raw of ['+19005550142', '+19765550142', '+18095550142', '+18765550142', '+12425550142', '+15005550142', '+17005550142', '+12115550142']) {
      expect(ok(raw).ok).toBe(false);
    }
  });
  test('country allow-list applies (default US/Canada only) and can be extended', () => {
    expect(validateForwardNumber('+525512345678', 'US', { codes: ['1'] }).ok).toBe(false);
    expect(validateForwardNumber('+525512345678', 'US', { codes: ['1', '52'] })).toEqual({ ok: true, e164: '+525512345678' });
    expect(validateForwardNumber('+449005550142', 'US', { codes: ['1', '44'] }).ok).toBe(false); // UK premium even when 44 is allowed
    expect(validateForwardNumber('+8821234567', 'US', { codes: ['1', '882'] }).ok).toBe(false); // international networks
    expect(forwardAllowedCountryCodes({})).toEqual(['1']);
    expect(forwardAllowedCountryCodes({ SMS_ALLOWED_COUNTRY_CODES: '1,52' })).toEqual(['1', '52']);
    expect(forwardAllowedCountryCodes({ SMS_ALLOWED_COUNTRY_CODES: '1', FORWARD_ALLOWED_COUNTRY_CODES: '1,34' })).toEqual(['1', '34']);
  });
  test('cannot forward to the business own line (loop)', () => {
    const r = ok('+13055550142', ['+13055550142']);
    expect(r.ok).toBe(false);
    expect(ok('+13055550143', ['+13055550142']).ok).toBe(true);
  });
});

describe('TwiML', () => {
  test('forward: Dial with the number, never records, escapes everything', () => {
    const x = forwardTwiml('+13055550142', { callerId: '+13055550100', action: '/api/voice/voicemail?a=1&b=2' });
    expect(x).toContain('<Dial timeout="20" answerOnBridge="true" callerId="+13055550100" action="/api/voice/voicemail?a=1&amp;b=2" method="POST"><Number>+13055550142</Number></Dial>');
    // the allowance cap and the metering callback are optional attributes
    const capped = forwardTwiml('+13055550142', { timeLimit: 600.7, statusCallback: '/api/voice/dial-status' });
    expect(capped).toContain('timeLimit="600"');
    expect(capped).toContain('<Number statusCallback="/api/voice/dial-status" statusCallbackEvent="completed" statusCallbackMethod="POST">+13055550142</Number>');
    expect(forwardTwiml('+13055550142', { timeLimit: 0 })).not.toContain('timeLimit');
    expect(x).not.toMatch(/record/i);
    expect(() => forwardTwiml('305-555-0142')).toThrow(); // only E.164
    expect(() => forwardTwiml('+1305</Number><Number>+19005550142')).toThrow();
    expect(forwardTwiml('+13055550142', { callerId: 'x"><Hangup/>' })).not.toContain('Hangup'); // bad caller id is dropped, not injected
  });
  test('paused: says the recording notice BEFORE the beep, then records, in both languages', () => {
    const x = pausedTwiml({ name: 'Cool & Air <Co>' }, '/api/voice/voicemail');
    expect(x).toContain('Cool &amp; Air &lt;Co&gt;');
    expect(x.indexOf('will be recorded')).toBeGreaterThan(-1);
    expect(x.indexOf('<Say')).toBeLessThan(x.indexOf('<Record'));
    expect(x.indexOf('será grabado')).toBeLessThan(x.indexOf('<Record'));
    expect(x).toContain('playBeep="true"');
    expect(x).toContain('action="/api/voice/voicemail"');
    expect(pausedVoicemailPrompt({ name: 'X' }).en).toMatch(/hang up/i);
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  });
  test('native paused message carries the AI + recording notice in both languages first', () => {
    const m = pausedFirstMessage({ name: 'Cool Air', recording_disclosure_text: null } as Business);
    expect(hasMandatoryNotice(m.split(' — ')[0])).toBe(true);
    expect(m).toContain('Cool Air');
    expect(m).toMatch(/call you back|devolverá la llamada/);
  });
});

describe('verification purposes are separate', () => {
  test('a forward-number challenge cannot confirm the owner phone, nor the reverse', () => {
    const saved = process.env.APP_SECRET_KEY;
    process.env.APP_SECRET_KEY = KEY;
    try {
    const t = Date.now();
    const fwd = createOwnerPhoneChallenge('b1', '+13055550142', t, 'forward-number');
    const own = createOwnerPhoneChallenge('b1', '+13055550142', t, 'owner-phone');
    expect(verifyOwnerPhoneChallenge(fwd.challenge, 'b1', '+13055550142', fwd.code, t, 'forward-number')).toEqual({ ok: true });
    expect(verifyOwnerPhoneChallenge(own.challenge, 'b1', '+13055550142', own.code, t)).toEqual({ ok: true }); // default purpose unchanged
    expect(verifyOwnerPhoneChallenge(fwd.challenge, 'b1', '+13055550142', fwd.code, t, 'owner-phone').ok).toBe(false);
    expect(verifyOwnerPhoneChallenge(own.challenge, 'b1', '+13055550142', own.code, t, 'forward-number').ok).toBe(false);
    expect(forwardVerificationText('123456')).toContain('call-forwarding');
    expect(forwardVerificationText('123456')).toContain('123456');
    } finally {
      if (saved === undefined) delete process.env.APP_SECRET_KEY; else process.env.APP_SECRET_KEY = saved;
    }
  });
});

describe('H1: forward-number rules on every path', () => {
  const ok = (raw: unknown, opts: Parameters<typeof validateForwardNumber>[2] = {}) => validateForwardNumber(raw, 'US', { codes: ['1'], ...opts });

  test('the review repro (+1 876 Jamaica) and every territory / premium / toll-free / 976 shape is refused', () => {
    for (const n of [
      '+18765550142', // Jamaica (the repro)
      '+16705550142', '+16715550142', '+16845550142', // CNMI, Guam, American Samoa
      '+13059760142', '+12129760142', '+17869760142', // NXX 976 inside ANY area code
      '+18005550142', '+18335550142', '+18445550142', '+18555550142', '+18665550142', '+18775550142', '+18885550142', // toll-free
      '+19005550142', '+19765550142', '+15005550142', '+17005550142', '+12115550142',
      '+12425550142', '+14415550142', '+17215550142', '+18095550142',
    ]) expect([n, ok(n).ok]).toEqual([n, false]);
    expect(ok('+13055550142').ok).toBe(true);
    expect(ok('+14165550142').ok).toBe(true); // Canada is fine
    expect(ok('+17875550142').ok).toBe(true); // Puerto Rico bills as domestic
  });

  test('libphonenumber type refuses premium / shared-cost / personal numbers abroad even when the country is allowed', () => {
    for (const n of ['+447012345678', '+449005550142']) expect([n, validateForwardNumber(n, 'US', { codes: ['1', '44'] }).ok]).toEqual([n, false]);
    expect(validateForwardNumber('+442071234567', 'US', { codes: ['1', '44'] }).ok).toBe(true);
  });

  test('FORWARD_DENY_AREA_CODES adds area codes (malformed entries ignored); the defaults always apply', () => {
    const deny = forwardDenyAreaCodes({ FORWARD_DENY_AREA_CODES: ' 305, 1-212 ,abc,99,+1415 ' });
    for (const c of ['305', '212', '415', '876', '670', '671', '684', '976', '800']) expect(deny.has(c)).toBe(true);
    expect(deny.has('786')).toBe(false);
    expect(ok('+13055550142', { denyAreaCodes: deny }).ok).toBe(false);
    expect(ok('+17865550142', { denyAreaCodes: deny }).ok).toBe(true);
    expect(forwardDenyAreaCodes({}).has('305')).toBe(false);
  });

  test('a VERIFIED owner phone is not exempt: trustedForwardNumber / resolveCallRoute re-validate it', () => {
    const jm = '+18765550142';
    const owner = { call_mode: 'forward' as const, forward_number_e164: jm, forward_number_verified_at: null, owner_phone_e164: jm, owner_phone_verified_at: '2026-11-01T00:00:00Z' };
    expect(trustedForwardNumber(owner)).toBeNull();
    expect(resolveCallRoute(biz(owner), open, 'webhook')).toEqual({ action: 'ai', why: 'forward_number_rejected' });
    // verified by SMS code is not exempt either (the list may have changed since)
    expect(trustedForwardNumber({ ...owner, forward_number_verified_at: '2026-11-02T00:00:00Z' })).toBeNull();
    // the business's own line is never a target
    expect(trustedForwardNumber({ forward_number_e164: '+13055550142', forward_number_verified_at: '2026-11-02T00:00:00Z', owner_phone_e164: null, owner_phone_verified_at: null, phone_e164: '+13055550142' })).toBeNull();
    // and the view says why
    const view = callModeView({ ...biz(owner), forward_number: jm }, { full: true }, open, 'webhook');
    expect(view).toMatchObject({ forward_verified: false, route_now: 'ai' });
    expect(view.forward_blocked).toMatch(/premium|international|toll-free/);
    expect(view.label).toMatch(/not allowed/);
  });
});

describe('M2: honest forwarding by line kind', () => {
  const fwd = biz({ call_mode: 'forward', forward_number_e164: '+13055550142', forward_number_verified_at: '2026-11-02T00:00:00Z' });

  test('lineKind: native only with ElevenLabs configured (or forced); forwarding is a webhook-line feature', () => {
    expect(lineKind({})).toBe('webhook');
    expect(lineKind({ ELEVENLABS_API_KEY: 'k' })).toBe('webhook');
    expect(lineKind({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'p' })).toBe('native');
    // L5 (round 6): `webhook` contradicting a configured native line is IGNORED (the safe reading wins) and reported as a mismatch
    expect(lineKind({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'p', VOICE_LINE_KIND: 'webhook' })).toBe('native');
    expect(lineKindMismatch({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'p', VOICE_LINE_KIND: 'webhook' })).toMatch(/VOICE_LINE_KIND=webhook/);
    expect(lineKindMismatch({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'p' })).toBeNull();
    expect(lineKindMismatch({ VOICE_LINE_KIND: 'webhook' })).toBeNull();
    expect(lineKind({ VOICE_LINE_KIND: 'webhook' })).toBe('webhook'); // no native line configured: webhook is honoured
    expect(lineKind({ VOICE_LINE_KIND: ' Native ' })).toBe('native');
    expect(forwardingSupported('native')).toBe(false);
    expect(forwardingSupported('webhook')).toBe(true);
  });

  test('on the native line a due forward is the paused script, the label and view say so', () => {
    expect(resolveCallRoute(fwd, open, 'native')).toEqual({ action: 'paused', why: 'forward_unavailable_on_line' });
    expect(resolveCallRoute(fwd, open, 'webhook')).toEqual({ action: 'forward', to: '+13055550142' });
    expect(callModeLabel(fwd, open, 'native')).toEqual({ text: FORWARD_UNAVAILABLE, tone: 'warn' });
    expect(FORWARD_UNAVAILABLE).toBe('Forwarding is not available on the AI voice line — callers will hear the paused message');
    expect(callModeView(fwd, {}, open, 'native')).toMatchObject({ forward_supported: false, route_now: 'paused' });
    // after hours the AI answers on either line (the schedule is respected before the line matters)
    const sched = { ...fwd, forward_during_hours: true };
    expect(resolveCallRoute(sched, after, 'native')).toEqual({ action: 'ai', why: 'forward_outside_hours' });
    expect(resolveCallRoute(sched, open, 'native').action).toBe('paused');
  });
});

describe('H2 helpers', () => {
  test('parseSeconds accepts whole non-negative numbers only and clamps absurd values', () => {
    expect(parseSeconds('75')).toBe(75);
    expect(parseSeconds(' 3000 ')).toBe(3000);
    expect(parseSeconds('99999999')).toBeNull();
    expect(parseSeconds('9999999')).toBe(4 * 3600);
    for (const bad of ['-5', '1.5', 'abc', '', undefined, null, 5 as unknown as string]) expect(parseSeconds(bad)).toBeNull();
  });
  test('limits come from env with safe defaults', () => {
    expect(forwardMaxCallSeconds({})).toBe(3600);
    expect(forwardMaxCallSeconds({ FORWARD_MAX_CALL_SECONDS: '600' })).toBe(600);
    expect(forwardMaxCallSeconds({ FORWARD_MAX_CALL_SECONDS: '5' })).toBe(3600); // below the minimum: default
    expect(forwardCallsPerHour({ FORWARD_CALLS_PER_HOUR: 'x' })).toBe(60);
    expect(voicemailsPerHour({ VOICEMAIL_PER_HOUR: '3' })).toBe(3);
  });
});

describe('L4: the call mode buttons never become `disabled` while saving (that dropped keyboard focus to <body>)', () => {
  test('source regression: aria-disabled + a busy guard, focus restored', () => {
    const src = readFileSync(new URL('../src/components/dashboard/call-mode.tsx', import.meta.url), 'utf8');
    const buttons = src.slice(src.indexOf("aria-pressed={view.call_mode === mode}"), src.indexOf("{busy === mode ? t('common.saving')"));
    expect(buttons).toContain('aria-disabled');
    expect(buttons).not.toMatch(/\sdisabled=/);
    expect(src).toContain('buttons.current[mode]?.focus()');
    // L5: the hours checkbox sends only the field it changes
    expect(src).toContain("body: { forward_during_hours: v }");
    expect(src).not.toMatch(/mode: view\.call_mode/);
  });
});
