/** Pure policy pieces: owner-alert trust, positive keywords, country exemption, E.164 identity helpers. */
import { describe, expect, test } from 'bun:test';
import { isOwnerNumber, ownerAlertStatus } from '../src/lib/messaging/owner';
import { isPositiveKeyword, parseKeyword } from '../src/lib/messaging/keywords';
import { validateRecipient } from '../src/lib/messaging/recipient';
import { legacyNanpPhone, phoneIdent } from '../src/lib/db/compliance';

describe('owner alert trust', () => {
  const base = { owner_phone: '+13055550111', owner_phone_e164: '+13055550111', phone_e164: null };
  test('alerts need a verified owner phone; OWNER_PHONE_GRANDFATHER=true is the only rollout bypass', () => {
    expect(ownerAlertStatus({ owner_phone: null, owner_phone_verified_at: null }, {})).toBe('no_owner_phone');
    expect(ownerAlertStatus({ owner_phone: '+13055550111', owner_phone_verified_at: null }, {})).toBe('unverified');
    expect(ownerAlertStatus({ owner_phone: '+13055550111', owner_phone_verified_at: null }, { OWNER_PHONE_GRANDFATHER: 'false' })).toBe('unverified');
    expect(ownerAlertStatus({ owner_phone: '+13055550111', owner_phone_verified_at: null }, { OWNER_PHONE_GRANDFATHER: 'true' })).toBe('ok');
    expect(ownerAlertStatus({ owner_phone: '+13055550111', owner_phone_verified_at: '2026-11-23T00:00:00Z' }, {})).toBe('ok');
    expect(ownerAlertStatus({ owner_phone: null, owner_phone_verified_at: '2026-11-23T00:00:00Z' }, { OWNER_PHONE_GRANDFATHER: 'true' })).toBe('no_owner_phone');
  });
  test('owner number is compared as E.164, never by trailing digits', () => {
    expect(isOwnerNumber(base, '(305) 555-0111', 'US')).toBe(true);
    expect(isOwnerNumber(base, '+443055550111', 'US')).toBe(false);
    expect(isOwnerNumber({ ...base, owner_phone_e164: null }, '+13055550111', 'US')).toBe(true);
    expect(isOwnerNumber({ ...base, owner_phone: null, owner_phone_e164: null }, '+13055550111', 'US')).toBe(false);
  });
});

describe('positive keywords', () => {
  test('only whole-message YES / Y / SI / START', () => {
    for (const w of ['yes', 'YES', 'Y', 'y.', 'Sí', 'si', 'SI!', 'START', ' start ']) expect([w, isPositiveKeyword(w)]).toEqual([w, true]);
    for (const w of ['yes please', 'no', 'yesterday', '', 'stop', 'y n']) expect([w, isPositiveKeyword(w)]).toEqual([w, false]);
  });
  test('a bare YES is still not a re-subscribe (only START is)', () => {
    expect(parseKeyword('YES')).toBeNull();
    expect(parseKeyword('START')).toBe('start');
  });
});

describe('recipient country exemption', () => {
  test('allow-list applies unless anyCountry (owner verified number)', () => {
    expect(validateRecipient('+442079460958', ['1']).ok).toBe(false);
    expect(validateRecipient('+442079460958', ['1'], { anyCountry: true })).toEqual({ ok: true, to: '+442079460958' });
    expect(validateRecipient('not a number', ['1'], { anyCountry: true }).ok).toBe(false);
  });
});

describe('phone identity', () => {
  test('+1 numbers key on 10 digits, other countries on the full E.164', () => {
    expect(phoneIdent('(207) 946-0958', 'US')).toEqual({ e164: '+12079460958', key: '2079460958', nanp: true });
    expect(phoneIdent('+442079460958', 'US')).toEqual({ e164: '+442079460958', key: '+442079460958', nanp: false });
    expect(phoneIdent('garbage', 'US').e164).toBeNull();
  });
  test('legacy fallback shape: US/CA spellings only', () => {
    const us = '+12079460958';
    for (const raw of ['2079460958', '12079460958', '(207) 946-0958', '+1 207 946 0958']) expect([raw, legacyNanpPhone(raw, us)]).toEqual([raw, true]);
    for (const raw of ['+44 20 7946 0958', '+442079460958', '442079460958', '', null]) expect([raw, legacyNanpPhone(raw, us)]).toEqual([raw, false]);
    expect(legacyNanpPhone('2079460958', '+442079460958')).toBe(false);
  });
});
