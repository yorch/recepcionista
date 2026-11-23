/**
 * Processed-event dedupe (webhooks that are delivered at least once, e.g. Stripe).
 * Backed by the `processed_events` table so every instance shares one view.
 */
import { prisma } from './client';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 10 * 60 * 1000;
let lastCleanup = 0;

/**
 * Atomically claim an event id. Returns true for the FIRST caller (go ahead and process),
 * false for every later one (duplicate). Throws if the database is unreachable: callers
 * should let that surface as a 5xx so the sender retries instead of losing the event.
 * Implemented as INSERT .. ON CONFLICT DO NOTHING on the (source, id) primary key.
 */
export async function claimEvent(source: string, id: string): Promise<boolean> {
  const res = await prisma.processedEvent.createMany({ data: [{ source, id }], skipDuplicates: true });
  void cleanupProcessedEvents();
  return res.count === 1;
}

/**
 * Give a claim back after processing FAILED, so the sender's retry is not mistaken for a
 * duplicate. Best-effort: never throws.
 */
export async function releaseEvent(source: string, id: string): Promise<void> {
  try {
    await prisma.processedEvent.deleteMany({ where: { source, id } });
  } catch {
    /* the claim simply stays; retention will expire it */
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
