/**
 * Brute-force protection for POST /api/auth/login that cannot be turned into a platform-wide lockout.
 *
 * Three layers, none of them shared by every tenant:
 *  1. per-client-IP ATTEMPT cap (cheap, checked before any password hashing): bounds how much scrypt CPU
 *     one client can burn. Anonymous junk from one address only ever exhausts ITS OWN bucket.
 *  2. per-(account, client-IP) FAILURE backoff: after a few wrong passwords from one address for one
 *     account, further attempts from that address wait 15s, 30s, 1m ... up to 15m. Only failures count and
 *     a success clears the pair, so the real user is never penalised for a typo streak elsewhere, and an
 *     attacker guessing from another address cannot lock the real user out (their pair is different).
 *  3. a high per-account failure counter (all addresses) that only ALERTS (log): it deliberately never blocks,
 *     because blocking on it would hand any attacker a lockout switch for any account.
 *
 * The break-glass ADMIN_TOKEN has its own pair key. State lives in `rate_limit_buckets` (shared by every
 * instance); the store failing closes the route (503), exactly like the old limiter.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { clientKey } from '@/lib/auth';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';

const log = logger('login-throttle');

/** Per-IP attempts per 5 minutes. Without a trusted proxy every client shares one key, so the breaker is loose. */
export const IP_ATTEMPTS = 60;
export const IP_ATTEMPTS_UNTRUSTED = 600;
export const IP_WINDOW_MS = 5 * 60_000;
/** Failures from one (account, IP) pair before backoff starts. */
export const FREE_FAILURES = 3;
export const MAX_BACKOFF_S = 15 * 60;
export const UNTRUSTED_FREE_FAILURES = 20;
export const UNTRUSTED_MAX_BACKOFF_S = 60;
/** A pair's failure streak is forgotten after this long without a failure. */
export const STREAK_RESET_MS = 30 * 60_000;
const ACCOUNT_ALERT_FAILURES = 100;

export type Verdict =
  | { ok: true }
  | { ok: false; status: 429 | 503; retryAfterS: number };

/**
 * Seconds a pair must wait after `failures` consecutive failures: 0, 0, 0, 15, 30, 60, ... capped at 15 min.
 * Without a trusted proxy every client is the same "untrusted" address, so the pair is effectively the account
 * for everyone: there the streak allowance is far larger and the cap only a minute, so guessing is still
 * slowed but an attacker cannot keep the real user out for long.
 */
export function backoffSeconds(failures: number, untrusted = false): number {
  const free = untrusted ? UNTRUSTED_FREE_FAILURES : FREE_FAILURES;
  if (failures <= free) return 0;
  return Math.min(untrusted ? UNTRUSTED_MAX_BACKOFF_S : MAX_BACKOFF_S, 15 * 2 ** (failures - free - 1));
}

const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);

/** Opaque, bounded identifier for an account: never the raw email. */
export const accountId = (email: string) => hash(email);
/** The key the break-glass token path uses. */
export const ADMIN_TOKEN_ACCOUNT = 'admin-token';

export function pairKey(account: string, req: Request): string {
  return `auth/login:pair:${account}:${clientKey(req)}`;
}

/** Same backoff, separate counters, for the second login step (6-digit codes / recovery codes). */
export function mfaPairKey(userId: string, req: Request): string {
  return `auth/mfa:pair:${accountId(userId)}:${clientKey(req)}`;
}

/** Layer 1. Counts every attempt from this client; call before touching credentials. */
export async function checkClientAttempts(req: Request): Promise<Verdict> {
  const ip = clientKey(req);
  const limit = ip === 'untrusted' ? IP_ATTEMPTS_UNTRUSTED : IP_ATTEMPTS;
  const r = await rateLimit(`auth/login:ip:${ip}`, limit, IP_WINDOW_MS, { failClosed: true });
  if (r.allowed) return { ok: true };
  return { ok: false, status: r.error ? 503 : 429, retryAfterS: r.retryAfterS };
}

export interface PairState { failures: number; retryAfterS: number }

async function readPair(key: string): Promise<PairState> {
  const rows = await prisma.$queryRaw<{ count: number; age_ms: number }[]>`
    SELECT "count"::int AS count, (extract(epoch FROM (clock_timestamp() - "window_start")) * 1000)::float8 AS age_ms
      FROM "rate_limit_buckets" WHERE "key" = ${key} ORDER BY "window_start" DESC LIMIT 1`;
  const row = rows[0];
  if (!row || row.age_ms > STREAK_RESET_MS) return { failures: 0, retryAfterS: 0 };
  const wait = backoffSeconds(row.count, key.endsWith(':untrusted'));
  return { failures: row.count, retryAfterS: Math.max(0, Math.ceil(wait - row.age_ms / 1000)) };
}

/** Current failure streak and wait for a key (does not count anything). Zeros when the store is unreachable. */
export async function peekPair(key: string): Promise<PairState> {
  try {
    return await readPair(key);
  } catch (err) {
    log.error('store_unavailable', { err });
    return { failures: 0, retryAfterS: 0 };
  }
}

/** Layer 2 gate: is this (account, IP) pair currently backing off? Does not count anything. */
export async function checkPair(key: string): Promise<Verdict> {
  try {
    const st = await readPair(key);
    return st.retryAfterS > 0 ? { ok: false, status: 429, retryAfterS: st.retryAfterS } : { ok: true };
  } catch (err) {
    log.error('store_unavailable', { err });
    return { ok: false, status: 503, retryAfterS: 5 };
  }
}

/** Count one failed attempt for the pair (atomic: serialised per key). Never throws. */
export async function recordFailure(key: string, account: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const rows = await tx.$queryRaw<{ count: number; age_ms: number }[]>`
        SELECT "count"::int AS count, (extract(epoch FROM (clock_timestamp() - "window_start")) * 1000)::float8 AS age_ms
          FROM "rate_limit_buckets" WHERE "key" = ${key} ORDER BY "window_start" DESC LIMIT 1`;
      const prev = rows[0] && rows[0].age_ms <= STREAK_RESET_MS ? rows[0].count : 0;
      await tx.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ${key}`;
      await tx.$executeRaw`INSERT INTO "rate_limit_buckets" ("key", "window_start", "count") VALUES (${key}, clock_timestamp(), ${prev + 1})`;
    });
    // Layer 3: distributed guessing shows up here; alert, never block.
    const acct = await rateLimit(`auth/login:acct-failures:${account}`, ACCOUNT_ALERT_FAILURES, 60 * 60_000);
    if (!acct.allowed) log.warn('distributed_guessing', { acct: account.slice(0, 8) });
  } catch (err) {
    log.error('record_failed', { err });
  }
}

/** A successful sign-in clears the pair's streak. Never throws. */
export async function clearFailures(key: string): Promise<void> {
  try {
    await prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = ${key}`;
  } catch (err) {
    log.warn('clear_failed', { err });
  }
}

export function verdictResponse(v: Extract<Verdict, { ok: false }>): Response {
  return Response.json(
    { ok: false, error: v.status === 503 ? 'service temporarily unavailable' : 'rate limit exceeded' },
    { status: v.status, headers: { 'retry-after': String(v.retryAfterS) } },
  );
}
