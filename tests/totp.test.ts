import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import {
  appSecretKey, base32Decode, base32Encode, decryptSecret, encryptSecret, generateRecoveryCodes, generateTotp,
  generateTotpSecret, hashRecoveryCode, normalizeRecoveryCode, otpauthUri, SecretKeyError, totpStep, verifyTotp,
} from '../src/lib/totp';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

describe('TOTP', () => {
  test('RFC 6238 vectors', () => {
    for (const [t, code] of VECTORS) expect(generateTotp(RFC_SECRET, t * 1000, { digits: 8 })).toBe(code);
  });

  test('base32 round trip and RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    const raw = crypto.randomBytes(20);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(() => base32Decode('abc1')).toThrow();
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  test('verify accepts +-1 step, rejects further drift and malformed codes', () => {
    const now = 1_700_000_000_000;
    const at = (d: number) => generateTotp(RFC_SECRET, now + d * 30_000);
    expect(verifyTotp(RFC_SECRET, at(0), { nowMs: now })).toEqual({ ok: true, step: totpStep(now) });
    expect(verifyTotp(RFC_SECRET, at(-1), { nowMs: now })).toEqual({ ok: true, step: totpStep(now) - 1 });
    expect(verifyTotp(RFC_SECRET, at(1), { nowMs: now })).toEqual({ ok: true, step: totpStep(now) + 1 });
    expect(verifyTotp(RFC_SECRET, at(2), { nowMs: now }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, at(-3), { nowMs: now }).ok).toBe(false);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12345a']) expect(verifyTotp(RFC_SECRET, bad, { nowMs: now }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, `${at(0).slice(0, 3)} ${at(0).slice(3)}`, { nowMs: now }).ok).toBe(true);
    expect(verifyTotp('not base32!', at(0), { nowMs: now }).ok).toBe(false);
  });

  test('replay: a step at or below lastUsedStep is refused', () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(RFC_SECRET, now);
    const first = verifyTotp(RFC_SECRET, code, { nowMs: now });
    expect(first.ok).toBe(true);
    const step = first.ok ? first.step : 0;
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedStep: step }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now + 5_000, lastUsedStep: step }).ok).toBe(false);
    // a newer step is still fine
    expect(verifyTotp(RFC_SECRET, generateTotp(RFC_SECRET, now + 30_000), { nowMs: now, lastUsedStep: step }).ok).toBe(true);
  });

  test('otpauth URI', () => {
    const uri = new URL(otpauthUri({ secret: 'ABC234', account: 'a+b@x.com', issuer: 'Recepcionista App' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Recepcionista App:a+b@x.com');
    expect(uri.searchParams.get('secret')).toBe('ABC234');
    expect(uri.searchParams.get('issuer')).toBe('Recepcionista App');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  test('ten unique xxxxx-xxxxx codes; hashing ignores case and separators', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const c = codes[0];
    expect(hashRecoveryCode(c)).toBe(hashRecoveryCode(c.toUpperCase().replace('-', ' ')));
    expect(hashRecoveryCode(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(c)).not.toBe(hashRecoveryCode(codes[1]));
    expect(normalizeRecoveryCode(' AbC-12 ')).toBe('abc12');
  });
});

describe('secret encryption', () => {
  const key = crypto.randomBytes(32);
  test('round trip, random IV, AAD binding, tamper detection', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', 'user-1', key);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(encryptSecret('JBSWY3DPEHPK3PXP', 'user-1', key)).not.toBe(a);
    expect(decryptSecret(a, 'user-1', key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(a, 'user-2', key)).toThrow();
    expect(() => decryptSecret(a, 'user-1', crypto.randomBytes(32))).toThrow();
    const parts = a.split('.');
    parts[3] = Buffer.from('x'.repeat(16)).toString('base64url');
    expect(() => decryptSecret(parts.join('.'), 'user-1', key)).toThrow();
    expect(() => decryptSecret('garbage', undefined, key)).toThrow();
  });

  test('key from env: production fails closed, dev has a fallback, bad length throws', () => {
    const good = crypto.randomBytes(32).toString('base64');
    expect(appSecretKey({ APP_SECRET_KEY: good, NODE_ENV: 'production' } as NodeJS.ProcessEnv).length).toBe(32);
    expect(() => appSecretKey({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(SecretKeyError);
    expect(() => appSecretKey({ APP_SECRET_KEY: 'c2hvcnQ=', NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toThrow(SecretKeyError);
    expect(appSecretKey({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).length).toBe(32);
  });
});
