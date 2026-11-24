/**
 * Live-forward leases (review 6, M1): a per-business cap on SIMULTANEOUS forwarded calls and a reservation of the minutes they may
 * still use, so N calls placed at the same moment cannot each be handed the whole remaining allowance (N times the cap).
 *
 * One `forward_leases` row per live forward (business, parent CallSid, reserved seconds, expiry = reserved seconds + a grace, so a lost
 * callback frees the slot by itself). Taking one is a short transaction under a per-business advisory lock (no network IO inside, so it
 * never pins a pooled connection for long). `releaseForwardLease` runs when the call is metered (meterForwardedCall), AFTER the seconds
 * were recorded: a moment of double counting (conservative), never a window where the minutes are neither reserved nor counted.
 */
import { prisma } from './client';

/** Seconds past the <Dial timeLimit> a lease is kept before it expires on its own (ringing + callback delay). */
export const FORWARD_LEASE_GRACE_SECONDS = 180;

export type ForwardLease =
  | { ok: true; timeLimit: number; reused: boolean }
  | { ok: false; why: 'concurrent_limit' | 'cap_reached' };

export interface ForwardLeaseOptions {
  businessId: string;
  callSid: string;
  /** Most forwarded calls in progress at once for this business. */
  maxConcurrent: number;
  /** A known customer (see caller-limits.ts)? Strangers may hold at most `maxConcurrent - 1` slots (when that is at least 1): the last one is reserved. */
  known?: boolean;
  maxCallSeconds: number;
  /** Below this many seconds a forward is not started. */
  minSeconds: number;
  /** The forwarded-minutes cap this period in SECONDS, or null when billing is not enforced (counting only). */
  capSeconds: number | null;
}

export async function acquireForwardLease(opts: ForwardLeaseOptions): Promise<ForwardLease> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`forward-lease:${opts.businessId}`}))`;
    // A Twilio retry of the same call keeps the lease it already holds (and its time limit).
    const mine = await tx.forwardLease.findUnique({ where: { businessId_callSid: { businessId: opts.businessId, callSid: opts.callSid } }, select: { reservedSeconds: true, expiresAt: true } });
    if (mine && mine.expiresAt.getTime() > Date.now()) return { ok: true, timeLimit: mine.reservedSeconds, reused: true } as const;
    await tx.$executeRaw`DELETE FROM "forward_leases" WHERE "expires_at" < clock_timestamp() - interval '1 day'`; // sweep long-dead rows (also tenants that are gone)

    // RESERVED first, then USED (the order makes a race with a finishing call err on the conservative side).
    const live = await tx.$queryRaw<{ reserved_seconds: number }[]>`
      SELECT "reserved_seconds" FROM "forward_leases"
       WHERE "business_id" = ${opts.businessId} AND "call_sid" <> ${opts.callSid} AND "expires_at" > clock_timestamp()`;
    const slots = opts.known || opts.maxConcurrent < 2 ? opts.maxConcurrent : opts.maxConcurrent - 1;
    if (live.length >= slots) return { ok: false, why: 'concurrent_limit' } as const;
    let limit = opts.maxCallSeconds;
    if (opts.capSeconds !== null) {
      const used = (await tx.$queryRaw<{ s: number }[]>`
        SELECT COALESCE(u."forward_seconds", 0)::int AS s FROM "businesses" b
          LEFT JOIN "usage_counters" u ON u."business_id" = b."id"
           AND u."period_start" = date_trunc('month', timezone(b."timezone", clock_timestamp()))::date
         WHERE b."id" = ${opts.businessId}`)[0]?.s ?? 0;
      const reserved = live.reduce((n, r) => n + r.reserved_seconds, 0);
      const remaining = opts.capSeconds - used - reserved;
      if (remaining < opts.minSeconds) return { ok: false, why: 'cap_reached' } as const;
      limit = Math.min(limit, remaining);
    }
    const timeLimit = Math.max(opts.minSeconds, Math.floor(limit));
    const expiresInSeconds = timeLimit + FORWARD_LEASE_GRACE_SECONDS;
    await tx.$executeRaw`
      INSERT INTO "forward_leases" ("business_id", "call_sid", "reserved_seconds", "expires_at", "created_at")
      VALUES (${opts.businessId}, ${opts.callSid}, ${timeLimit}, clock_timestamp() + (${expiresInSeconds}::float8 * interval '1 second'), clock_timestamp())
      ON CONFLICT ("business_id", "call_sid") DO UPDATE
        SET "reserved_seconds" = EXCLUDED."reserved_seconds", "expires_at" = EXCLUDED."expires_at", "created_at" = EXCLUDED."created_at"`;
    return { ok: true, timeLimit, reused: false } as const;
  });
}

/** Free the slot and the reserved minutes of a finished forward. Never throws (the lease expires on its own anyway). */
export async function releaseForwardLease(businessId: string, callSid: string): Promise<void> {
  try {
    await prisma.forwardLease.deleteMany({ where: { businessId, callSid } });
  } catch {
    /* expires by itself */
  }
}

/** Forwards in progress right now (for diagnostics and tests). */
export async function liveForwardCount(businessId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "forward_leases" WHERE "business_id" = ${businessId} AND "expires_at" > clock_timestamp()`;
  return rows[0]?.n ?? 0;
}
