/**
 * Tiny in-memory sliding-window limiter. Per-process only: with multiple
 * instances each keeps its own window (use Redis/DB for a global limit).
 */
import { clientKey } from '@/lib/auth';

const hits = new Map<string, number[]>();
const MAX_KEYS = 10_000;
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterS: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, arr] of hits) {
      if (!arr.length || now - arr[arr.length - 1] > 3_600_000) hits.delete(k);
    }
  }
  if (!hits.has(key) && hits.size >= MAX_KEYS) {
    // Memory cap: drop the oldest key rather than grow without bound.
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) hits.delete(oldest);
  }
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { allowed: false, retryAfterS: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { allowed: true, retryAfterS: 0 };
}

/** Returns a 429 Response when over the limit, otherwise null. */
export function limitRequest(req: Request, route: string, limit: number, windowMs = 60_000): Response | null {
  // Per-client key (only meaningful behind TRUSTED_PROXY) plus a global
  // per-route cap, so spoofed/rotating client keys cannot brute-force a route.
  const r = rateLimit(`${route}:${clientKey(req)}`, limit, windowMs);
  const g = r.allowed ? rateLimit(`${route}:*global*`, limit * 5, windowMs) : r;
  if (r.allowed && g.allowed) return null;
  return Response.json(
    { ok: false, error: 'rate limit exceeded' },
    { status: 429, headers: { 'retry-after': String(r.allowed ? g.retryAfterS : r.retryAfterS) } },
  );
}
