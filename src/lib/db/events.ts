/**
 * Processed-event dedupe (webhooks that are delivered at least once, e.g. Stripe).
 * Backed by the `processed_events` table so every instance shares one view.
 */
import { prisma } from './client';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 10 * 60 * 1000;
let lastCleanup = 0;

/** How long a 'processing' claim is honoured before a retry may take it over (a crashed worker never completes). */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Atomically claim an event id. Returns true when THIS caller should process it: the first
 * caller, or a later one that finds a stale 'processing' claim (older than `leaseMs`, i.e. the
 * worker that took it died). Returns false for a duplicate: already 'done', or still being
 * processed under a live lease. Throws if the database is unreachable so the sender retries.
 *
 * Call `completeEvent` after the work succeeded and `releaseEvent` when it failed; a crash
 * between claim and either leaves a 'processing' row that expires by itself.
 */
export async function claimEvent(source: string, id: string, leaseMs: number = CLAIM_LEASE_MS): Promise<boolean> {
  const lease = Math.max(1000, Math.floor(leaseMs));
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "processed_events" ("source", "id", "status", "claimed_at", "created_at")
    VALUES (${source}, ${id}, 'processing', clock_timestamp(), clock_timestamp())
    ON CONFLICT ("source", "id") DO UPDATE
      SET "claimed_at" = clock_timestamp(), "status" = 'processing'
      WHERE "processed_events"."status" = 'processing'
        AND "processed_events"."claimed_at" < clock_timestamp() - (${lease}::float8 * interval '1 millisecond')
    RETURNING "id"`;
  void cleanupProcessedEvents();
  return rows.length === 1;
}

/** Mark a claimed event as fully processed: later deliveries are duplicates for good. Never throws. */
export async function completeEvent(source: string, id: string): Promise<void> {
  try {
    await prisma.processedEvent.updateMany({ where: { source, id }, data: { status: 'done' } });
  } catch {
    /* the claim stays 'processing' and expires; a retry would then re-run an idempotent handler */
  }
}

/**
 * Give a claim back after processing FAILED, so the sender's retry is not mistaken for a
 * duplicate. Best-effort: never throws.
 */
export async function releaseEvent(source: string, id: string): Promise<void> {
  try {
    await prisma.processedEvent.deleteMany({ where: { source, id } });
  } catch {
    /* the claim simply stays; it expires after the lease */
  }
}

/** Deletes claims older than 30 days. Opportunistic (at most every 10 min per process); never throws. */
export async function cleanupProcessedEvents(now: Date = new Date(), force = false): Promise<number> {
  const t = now.getTime();
  if (!force && t - lastCleanup < CLEANUP_EVERY_MS) return 0;
  lastCleanup = t;
  try {
    const res = await prisma.processedEvent.deleteMany({ where: { createdAt: { lt: new Date(t - RETENTION_MS) } } });
    return res.count;
  } catch {
    return 0;
  }
}
