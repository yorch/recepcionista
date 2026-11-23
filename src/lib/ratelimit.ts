/**
 * Tiny in-memory sliding-window limiter. Per-process only: with multiple
 * instances each keeps its own window (use Redis/DB for a global limit).
 */
import { clientKey } from '@/lib/auth';

const hits = new Map<string, number[]>();
let lastSweep = 0;

export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterS: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, arr] of hits) {
      if (!arr.length || now - arr[arr.length - 1] > 3_600_000) hits.delete(k);
    }
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
  const r = rateLimit(`${route}:${clientKey(req)}`, limit, windowMs);
  if (r.allowed) return null;
  return Response.json(
    { ok: false, error: 'rate limit exceeded' },
    { status: 429, headers: { 'retry-after': String(r.retryAfterS) } },
  );
}
