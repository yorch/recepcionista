/**
 * Password hashing with node:crypto scrypt. Node runtime only (never import from proxy.ts).
 * Encoded as `scrypt$N$r$p$salt$hash` (salt/hash base64url) so parameters can be raised later;
 * needsRehash() tells a login handler when to upgrade a stored hash.
 */
import crypto from 'node:crypto';

const N = 2 ** 15; // 32768 — ~32 MiB, ~80-150 ms per hash on a modern core
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD_CHARS = 1024; // bound work an attacker can force
// Upper bounds on parameters read back from storage (defence against a tampered row).
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) throw new Error('password required');
  if (password.length > MAX_PASSWORD_CHARS) throw new Error('password too long');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface Parsed { n: number; r: number; p: number; salt: Buffer; hash: Buffer }

function parse(encoded: string): Parsed | null {
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const okInt = (v: number, max: number) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!okInt(n, MAX_N) || (n & (n - 1)) !== 0 || n < 2 || !okInt(r, MAX_R) || !okInt(p, MAX_P)) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || hash.length < 16) return null;
  return { n, r, p, salt, hash };
}

/** Constant-time verification. Malformed/unsupported encodings and bad inputs return false (never throw). */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_CHARS) return false;
  const parsed = parse(encoded);
  if (!parsed) return false;
  try {
    const key = await scrypt(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.hash.length);
    return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current ones (rehash after a successful login). */
export function needsRehash(encoded: string): boolean {
  const parsed = parse(encoded);
  return !parsed || parsed.n < N || parsed.r < R || parsed.p < P || parsed.hash.length < KEYLEN;
}

let dummy: Promise<string> | null = null;
/**
 * Spend the same time as a real check when the email is unknown, so response time does not reveal
 * which emails have accounts: `await verifyPasswordOrDummy(pw, user?.password_hash)`.
 */
export async function verifyPasswordOrDummy(password: string, encoded: string | null | undefined): Promise<boolean> {
  if (encoded) return verifyPassword(password, encoded);
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummy);
  return false;
}
