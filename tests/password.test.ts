import { describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword, needsRehash, verifyPasswordOrDummy } from '../src/lib/password';

describe('password (scrypt)', () => {
  test('hash format and verify roundtrip', async () => {
    const h = await hashPassword('correct horse battery staple');
    const parts = h.split('$');
    expect(parts.length).toBe(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  test('salts are random', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  test('unicode is NFKC-normalised', async () => {
    const h = await hashPassword('café');
    expect(await verifyPassword('café', h)).toBe(true);
  });

  test('malformed or tampered encodings fail closed and never throw', async () => {
    const h = await hashPassword('pw');
    for (const bad of ['', 'x', 'scrypt$1$2$3$4', 'bcrypt$32768$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA',
      'scrypt$3$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', // N not a power of two
      'scrypt$4294967296$8$1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', // N far above the cap
      h.slice(0, -4) + 'AAAA']) {
      expect(await verifyPassword('pw', bad)).toBe(false);
    }
    expect(await verifyPassword('pw', null as unknown as string)).toBe(false);
  });

  test('rejects empty and oversized passwords', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword('x'.repeat(1025))).rejects.toThrow();
    expect(await verifyPassword('x'.repeat(1025), await hashPassword('x'))).toBe(false);
  });

  test('needsRehash flags weaker parameters', async () => {
    expect(needsRehash(await hashPassword('pw'))).toBe(false);
    expect(needsRehash('scrypt$16384$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });

  test('verifyPasswordOrDummy returns false for unknown users', async () => {
    expect(await verifyPasswordOrDummy('pw', null)).toBe(false);
    expect(await verifyPasswordOrDummy('pw', await hashPassword('pw'))).toBe(true);
  });
});
