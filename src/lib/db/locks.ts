/**
 * Expiring lease locks in Postgres (`provision_locks`), for critical sections that do slow
 * network IO (buying a phone number, creating a voice agent).
 *
 * Why a lease row and not pg_advisory_xact_lock: an advisory xact lock lives only as long as an
 * open interactive transaction, which would pin a pooled connection (and an idle-in-transaction
 * session) across seconds of third-party IO and hit Prisma's transaction timeout. Session-level
 * advisory locks do not work with a connection pool (the unlock may land on another connection),
 * and are silently dropped by PgBouncer in transaction mode. A lease row holds no connection,
 * survives pool/bouncer topologies, and self-heals when an instance crashes (it just expires).
 */
import crypto from 'node:crypto';
import { prisma } from './client';

export interface Lease {
  key: string;
  holder: string;
}

/** Try to take the lease. Resolves to a Lease on success, null when someone else holds an unexpired one. */
export async function acquireLease(key: string, ttlMs: number): Promise<Lease | null> {
  const holder = crypto.randomUUID();
  const ttl = Math.max(1000, Math.floor(ttlMs));
  // Single atomic statement: insert, or take over only an EXPIRED row. Time is the DB's clock
  // so instance clock skew cannot shorten or extend a lease.
  const rows = await prisma.$queryRaw<{ holder: string }[]>`
    INSERT INTO "provision_locks" ("key", "holder", "acquired_at", "expires_at")
    VALUES (${key}, ${holder}, clock_timestamp(), clock_timestamp() + (${ttl}::float8 * interval '1 millisecond'))
    ON CONFLICT ("key") DO UPDATE
      SET "holder" = EXCLUDED."holder", "acquired_at" = EXCLUDED."acquired_at", "expires_at" = EXCLUDED."expires_at"
      WHERE "provision_locks"."expires_at" <= clock_timestamp()
    RETURNING "holder"`;
  return rows.length === 1 && rows[0].holder === holder ? { key, holder } : null;
}

/** Extend a lease you still hold. False if it expired and was taken over (stop what you are doing). */
export async function renewLease(lease: Lease, ttlMs: number): Promise<boolean> {
  const ttl = Math.max(1000, Math.floor(ttlMs));
  const n = await prisma.$executeRaw`
    UPDATE "provision_locks"
       SET "expires_at" = clock_timestamp() + (${ttl}::float8 * interval '1 millisecond')
     WHERE "key" = ${lease.key} AND "holder" = ${lease.holder}`;
  return n === 1;
}

/** Release a lease; only the holder can (a stale holder cannot free a successor's lock). Never throws. */
export async function releaseLease(lease: Lease): Promise<void> {
  try {
    await prisma.provisionLock.deleteMany({ where: { key: lease.key, holder: lease.holder } });
  } catch {
    /* expires on its own */
  }
}

/**
 * Run `fn` under the lease. `{ acquired: false }` when another holder has it. The lease is
 * always released, even when `fn` throws. The lease is auto-renewed every ttlMs/3 while `fn`
 * runs, so ttlMs only needs to exceed a missed-heartbeat window, not the whole duration: if the
 * instance dies, the lease frees itself within ttlMs.
 *
 * `fn` receives an AbortSignal that fires as soon as the lease is known to be LOST (a renewal found another
 * holder, or renewals kept failing for a full ttl, so the lease has expired underneath us). Long critical
 * sections must check `signal.aborted` before each paid or irreversible step (buying a number, creating an
 * agent) so a stalled holder cannot act after a successor took over.
 */
export async function withLease<T>(
  key: string,
  ttlMs: number,
  fn: (lease: Lease, signal: AbortSignal) => Promise<T>,
  opts: { renewEveryMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lease = await acquireLease(key, ttlMs);
  if (!lease) return { acquired: false };
  const controller = new AbortController();
  /** Renewal cadence: ttl/3 (never faster than 500 ms), or `opts.renewEveryMs` (tests). */
  const every = opts.renewEveryMs ? Math.max(50, opts.renewEveryMs) : Math.max(500, Math.floor(ttlMs / 3));
  let lastRenewed = Date.now();
  const timer = setInterval(() => {
    renewLease(lease, ttlMs).then((renewed) => {
      if (renewed) lastRenewed = Date.now();
      else controller.abort(new Error(`lease ${key} lost`));
    }).catch(() => {
      // The store is unreachable: the next beat retries, but once a full ttl passed without a renewal the lease has expired.
      if (Date.now() - lastRenewed >= ttlMs) controller.abort(new Error(`lease ${key} expired (renewal failing)`));
    });
  }, every);
  timer.unref?.();
  try {
    return { acquired: true, value: await fn(lease, controller.signal) };
  } finally {
    clearInterval(timer);
    await releaseLease(lease);
  }
}
