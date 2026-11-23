/**
 * Stateless owner-phone verification challenge. Nothing is stored server-side between "start" and "confirm":
 * the challenge is a signed token the client echoes back with the code the owner received by SMS.
 *
 *   challenge = base64url(JSON{ b: business_id, p: phone_e164, exp: epoch_ms, n: nonce, h: code_hash }) + '.' + hmac
 *   code_hash = HMAC(key, "code|b|p|exp|n|code")   (the code cannot be recovered from the token without the server key)
 *   hmac      = HMAC(key, payload_b64)
 *
 * `key` is derived from APP_SECRET_KEY (src/lib/totp.ts appSecretKey) with a purpose label, so the verification key
 * is never the raw secret. Both comparisons are constant time. Attempt limiting (5 per challenge, keyed on its verified nonce, plus per business+phone and per business caps) and the SMS rate
 * limit live in the routes (Postgres limiter), because a stateless token cannot count attempts by itself.
 */
import crypto from 'node:crypto';
import { appSecretKey } from '@/lib/totp';

export const OWNER_PHONE_CODE_TTL_MS = 10 * 60 * 1000;
export const OWNER_PHONE_CODE_DIGITS = 6;

const PURPOSE = 'recepcionista/owner-phone-verification/v1';

function key(): Buffer {
  return crypto.createHmac('sha256', appSecretKey()).update(PURPOSE).digest();
}

const hmac = (data: string): Buffer => crypto.createHmac('sha256', key()).update(data).digest();

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function codeHash(businessId: string, phoneE164: string, exp: number, nonce: string, code: string): Buffer {
  return hmac(`code|${businessId}|${phoneE164}|${exp}|${nonce}|${code}`);
}

export interface OwnerPhoneChallenge {
  code: string;
  challenge: string;
  expires_at: string;
}

/** A fresh 6-digit code and the signed challenge that binds it to (business, phone, expiry). */
export function createOwnerPhoneChallenge(businessId: string, phoneE164: string, now: number = Date.now()): OwnerPhoneChallenge {
  const code = String(crypto.randomInt(0, 10 ** OWNER_PHONE_CODE_DIGITS)).padStart(OWNER_PHONE_CODE_DIGITS, '0');
  const exp = now + OWNER_PHONE_CODE_TTL_MS;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    b: businessId, p: phoneE164, exp, n: nonce, h: codeHash(businessId, phoneE164, exp, nonce, code).toString('base64url'),
  })).toString('base64url');
  return { code, challenge: `${payload}.${hmac(payload).toString('base64url')}`, expires_at: new Date(exp).toISOString() };
}

export type ChallengeVerdict = { ok: true } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'mismatch' | 'wrong_code' };

const B64URL = /^[A-Za-z0-9_-]+$/;

export interface ParsedChallenge { b: string; p: string; exp: number; n: string; h: string }

/**
 * Parse a challenge and check that it is EXACTLY what the server issued: the canonical `payload.signature` form
 * (base64url alphabet only, so padding/whitespace/other malleable encodings are rejected instead of being silently
 * ignored by the decoder) and a signature that equals the recomputed HMAC as a string. Returns null otherwise.
 * The code is NOT checked here.
 */
export function parseOwnerPhoneChallenge(challenge: unknown): ParsedChallenge | null {
  if (typeof challenge !== 'string' || challenge.length > 2000) return null;
  const parts = challenge.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!B64URL.test(payload) || !B64URL.test(sig)) return null;
  const expected = hmac(payload).toString('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let p: { b?: unknown; p?: unknown; exp?: unknown; n?: unknown; h?: unknown };
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof p.b !== 'string' || typeof p.p !== 'string' || typeof p.exp !== 'number' || typeof p.n !== 'string' || typeof p.h !== 'string') return null;
  return { b: p.b, p: p.p, exp: p.exp, n: p.n, h: p.h };
}

/** Verify signature, expiry, binding to (business, phone) and the code. Constant-time comparisons throughout. */
export function verifyOwnerPhoneChallenge(
  challenge: unknown, businessId: string, phoneE164: string, code: unknown, now: number = Date.now(),
): ChallengeVerdict {
  if (typeof challenge !== 'string' || challenge.length > 2000) return { ok: false, reason: 'malformed' };
  const p = parseOwnerPhoneChallenge(challenge);
  if (!p) return { ok: false, reason: challenge.split('.').length === 2 ? 'bad_signature' : 'malformed' };
  if (now > p.exp) return { ok: false, reason: 'expired' };
  if (p.b !== businessId || p.p !== phoneE164) return { ok: false, reason: 'mismatch' };
  const given = typeof code === 'string' ? code.trim() : '';
  if (!/^\d{6}$/.test(given)) return { ok: false, reason: 'wrong_code' };
  return safeEqual(codeHash(p.b, p.p, p.exp, p.n, given), Buffer.from(p.h, 'base64url')) ? { ok: true } : { ok: false, reason: 'wrong_code' };
}

/**
 * Stable, non-reversible id of a SERVER-ISSUED challenge for attempt counting, derived from its verified nonce (not from
 * the string the client sent): every spelling of one challenge maps to the same id. Null when the challenge is not
 * authentic (the caller then counts the attempt against the business/phone instead).
 */
export function challengeId(challenge: unknown): string | null {
  const p = parseOwnerPhoneChallenge(challenge);
  return p ? crypto.createHash('sha256').update(`${p.b}|${p.p}|${p.exp}|${p.n}`).digest('hex').slice(0, 32) : null;
}

/** The only text an owner-verification SMS ever contains: a fixed template, no tenant-controlled characters. */
export const ownerVerificationText = (code: string): string =>
  `Recepcionista verification code: ${code}. It expires in ${OWNER_PHONE_CODE_TTL_MS / 60_000} minutes. If you did not request it, ignore this message.`;
