/**
 * TOTP (RFC 6238, SHA-1, 30 s step, 6 digits) plus the helpers the 2FA flow needs: base32, otpauth://
 * URIs, one-time recovery codes and AES-256-GCM encryption of the stored secret.
 * Node runtime only (node:crypto). No database access: persistence lives in src/lib/db/users.ts.
 *
 * Replay protection: verifyTotp() reports the matching time step; the caller must store it with
 * claimTotpStep() (an atomic "only if greater" update) and reject codes whose step is not newer than
 * the last accepted one.
 */
import crypto from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

// ── base32 (RFC 4648, no padding on output) ─────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (case-insensitive; spaces, dashes and '=' padding ignored). Throws on other characters. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** A new random 160-bit secret, base32 encoded (32 characters). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────────

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The time step (counter) containing `nowMs`. */
export const totpStep = (nowMs: number = Date.now(), stepSeconds = TOTP_STEP_SECONDS): number =>
  Math.floor(nowMs / 1000 / stepSeconds);

/** The code for a secret at a time. `digits` is only configurable for the RFC 6238 test vectors (8). */
export function generateTotp(
  secretBase32: string,
  nowMs: number = Date.now(),
  opts: { digits?: number; stepSeconds?: number } = {},
): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs, opts.stepSeconds), opts.digits ?? TOTP_DIGITS);
}

export type TotpVerification = { ok: true; step: number } | { ok: false };

/**
 * Check a user-entered code against steps now-window..now+window (default ±1 = ±30 s of clock drift).
 * Every candidate step is compared in constant time with no early exit. A step <= `lastUsedStep`
 * never matches (replay protection). On success returns the matched step: persist it with claimTotpStep().
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {},
): TotpVerification {
  const digits = TOTP_DIGITS;
  const cleaned = String(code ?? '').replace(/[\s-]/g, '');
  if (!new RegExp(`^[0-9]{${digits}}$`).test(cleaned)) return { ok: false };
  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return { ok: false };
  }
  if (key.length === 0) return { ok: false };
  const window = opts.window ?? 1;
  const current = totpStep(opts.nowMs ?? Date.now());
  const last = opts.lastUsedStep ?? -1;
  const given = Buffer.from(cleaned);
  let matched = -1;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, digits));
    const equal = crypto.timingSafeEqual(expected, given);
    if (equal && step > last && step > matched) matched = step;
  }
  return matched >= 0 ? { ok: true, step: matched } : { ok: false };
}

/** `otpauth://totp/...` URI for authenticator apps (render it as a QR code client side). */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const q = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** No 0/o/1/l/i: easy to read out and type. 31 symbols. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

function randomChars(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return s;
}

/** `count` (default 10) fresh codes formatted `xxxxx-xxxxx` (~49 bits each). Show them once; store only hashRecoveryCode(). */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(`${randomChars(5)}-${randomChars(5)}`);
  return [...out];
}

/** Lowercase, drop everything but letters/digits ("ABCDE 12345" and "abcde-12345" are the same code). */
export const normalizeRecoveryCode = (code: string): string => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** sha256 hex of the normalised code. The codes are high-entropy random strings, so a plain hash is sufficient. */
export const hashRecoveryCode = (code: string): string =>
  crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

export const looksLikeRecoveryCode = (code: string): boolean => /^[a-z0-9]{10}$/.test(normalizeRecoveryCode(code));

// ── Secret encryption (AES-256-GCM) ─────────────────────────────────────────

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

let warnedDevKey = false;

/**
 * 32-byte key from APP_SECRET_KEY (base64 or base64url). In production an unset/invalid key throws
 * (fail closed: we never store 2FA secrets under a guessable key). Outside production a fixed,
 * INSECURE key is derived, with a one-time warning, so local development works out of the box.
 * Generate one with: openssl rand -base64 32
 */
export function appSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (env.APP_SECRET_KEY ?? '').trim();
  if (raw) {
    const key = Buffer.from(raw, /[-_]/.test(raw) ? 'base64url' : 'base64');
    if (key.length !== 32) throw new SecretKeyError('APP_SECRET_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
    return key;
  }
  if (env.NODE_ENV === 'production') throw new SecretKeyError('APP_SECRET_KEY is required in production');
  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn('[totp] APP_SECRET_KEY is unset: using an INSECURE development key. Never do this in production.');
  }
  return crypto.createHash('sha256').update('recepcionista-insecure-dev-key').digest();
}

const ENVELOPE_PREFIX = 'v1';

/** Encrypt a short secret. Output `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` (e.g. the user id) binds it to its owner. */
export function encryptSecret(plain: string, aad?: string, key: Buffer = appSecretKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [ENVELOPE_PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Inverse of encryptSecret. Throws on a wrong key, a different `aad`, or any tampering. */
export function decryptSecret(envelope: string, aad?: string, key: Buffer = appSecretKey()): string {
  const parts = String(envelope ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) throw new Error('invalid secret envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
}
