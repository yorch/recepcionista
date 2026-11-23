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
 */
export async function withLease<T>(
  key: string,
  ttlMs: number,
  fn: (lease: Lease) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lease = await acquireLease(key, ttlMs);
  if (!lease) return { acquired: false };
  const timer = setInterval(() => {
    renewLease(lease, ttlMs).catch(() => { /* next beat retries; expiry is the backstop */ });
  }, Math.max(500, Math.floor(ttlMs / 3)));
  timer.unref?.();
  try {
    return { acquired: true, value: await fn(lease) };
  } finally {
    clearInterval(timer);
    await releaseLease(lease);
  }
}
