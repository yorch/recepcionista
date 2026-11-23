/**
 * Postgres-backed rate limiter shared by every instance (table `rate_limit_buckets`).
 *
 * Algorithm: fixed windows with a sliding-window estimate. One atomic
 * `INSERT .. ON CONFLICT DO UPDATE SET count = count + 1 RETURNING` bumps the current window;
 * the previous window's count is weighted by how much of it still overlaps the sliding window:
 *   estimate = current + previous * (1 - elapsed/window).
 * Rejected attempts still count, so a client that keeps hammering stays blocked.
 * Time comes from the database clock, so instance clock skew is irrelevant.
 *
 * Handler-level only (Node runtime, uses Prisma). src/proxy.ts must NOT import this file.
 *
 * Database failure policy: `failClosed` routes (login) answer 503; all others log and allow.
 * There is deliberately no in-memory fallback: a per-process limiter would silently weaken the
 * limit exactly when the shared store is unhealthy.
 */
import { prisma } from '@/lib/db/client';
import { clientKey } from '@/lib/auth';
import { logger } from '@/lib/log';

const log = logger('ratelimit');

const CLEANUP_EVERY_MS = 60_000;
const CLEANUP_HORIZON_MS = 3 * 60 * 60 * 1000;
export const MAX_WINDOW_MS = 60 * 60 * 1000;
let lastCleanup = 0;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterS: number;
  /** True when the store was unreachable (the decision came from the failure policy). */
  error?: boolean;
}

export interface RateLimitOptions {
  /** Deny (instead of allow) when the database is unreachable. Use for credential/sensitive routes. */
  failClosed?: boolean;
  /**
   * Optional route-wide circuit breaker shared by ALL clients/tenants (max requests per window). Off by default:
   * a shared bucket is a lockout switch for everyone, so only paid-provider routes should opt in, with a ceiling
   * far above legitimate traffic. Never use it for credential checks (see login-throttle).
   */
  globalLimit?: number;
}

/** Opportunistic cleanup of long-expired buckets (at most once a minute per process). Never throws. */
async function cleanupExpired(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now;
  try {
    await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(now - CLEANUP_HORIZON_MS) } } });
  } catch (err) {
    log.warn('cleanup_failed', { err });
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const w = Math.min(MAX_WINDOW_MS, Math.max(1000, Math.floor(windowMs)));
  try {
    const rows = await prisma.$queryRaw<{ cur: number; prev: number; elapsed_ms: number }[]>`
      WITH t AS (
        SELECT clock_timestamp() AS now,
               to_timestamp(floor(extract(epoch FROM clock_timestamp()) * 1000 / ${w}::float8) * ${w}::float8 / 1000.0) AS ws
      ), cur AS (
        INSERT INTO "rate_limit_buckets" ("key", "window_start", "count")
        SELECT ${key}, t.ws, 1 FROM t
        ON CONFLICT ("key", "window_start") DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1
        RETURNING "count", "window_start"
      )
      SELECT cur."count"::int AS cur,
             COALESCE((SELECT p."count" FROM "rate_limit_buckets" p
                        WHERE p."key" = ${key}
                          AND p."window_start" >= cur."window_start" - (${w}::float8 * 1.5 * interval '1 millisecond')
                          AND p."window_start" <  cur."window_start" - (${w}::float8 * 0.5 * interval '1 millisecond')), 0)::int AS prev,
             (extract(epoch FROM (t.now - cur."window_start")) * 1000)::float8 AS elapsed_ms
        FROM cur, t`;
    const { cur, prev, elapsed_ms } = rows[0];
    const frac = Math.min(1, Math.max(0, elapsed_ms / w));
    const estimate = cur + prev * (1 - frac);
    void cleanupExpired();
    if (estimate <= limit) return { allowed: true, retryAfterS: 0 };
    // Conservative: wait for the next window boundary (the estimate only decays then).
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((w - elapsed_ms) / 1000)) };
  } catch (err) {
    log.error('store_unavailable', { key, fail_closed: Boolean(opts.failClosed), err });
    return opts.failClosed
      ? { allowed: false, retryAfterS: 5, error: true }
      : { allowed: true, retryAfterS: 0, error: true };
  }
}

/** Returns a 429 (or 503 when a failClosed route cannot reach the store) Response, otherwise null. Always `await` it. */
export async function limitRequest(
  req: Request,
  route: string,
  limit: number,
  windowMs = 60_000,
  opts: RateLimitOptions = {},
): Promise<Response | null> {
  // Per-client key (only meaningful behind TRUSTED_PROXY). A route-wide bucket exists only on request.
  const r = await rateLimit(`${route}:${clientKey(req)}`, limit, windowMs, opts);
  const g = r.allowed && opts.globalLimit
    ? await rateLimit(`${route}:*global*`, opts.globalLimit, windowMs, opts)
    : r;
  if (r.allowed && g.allowed) return null;
  const blocked = r.allowed ? g : r;
  if (blocked.error) {
    return Response.json(
      { ok: false, error: 'service temporarily unavailable' },
      { status: 503, headers: { 'retry-after': String(blocked.retryAfterS) } },
    );
  }
  return Response.json(
    { ok: false, error: 'rate limit exceeded' },
    { status: 429, headers: { 'retry-after': String(blocked.retryAfterS) } },
  );
}
