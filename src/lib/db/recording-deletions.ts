/**
 * Durable provider-side recording deletion (review 6, M2).
 *
 * A voicemail lives at Twilio; the only reference to it is `calls.recording_url`. Deleting the call row first and the recording
 * afterwards (fire and forget) loses the recording for good whenever the provider call fails. So every path that deletes call rows
 * (retention purge, customer erasure, demo reset) writes the recordings into `pending_recording_deletions` IN THE SAME TRANSACTION
 * as the DELETE; the jobs runner (voice/recording-deletion.ts, job `recording_deletions`) drains the queue with retries and backoff
 * and removes a row only when the provider answered 2xx or 404.
 *
 * Only recordings of the Twilio account form (see parseRecordingUrl) are queued; anything else has nothing to delete.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { forgetCachedRecording, parseRecordingUrl } from '@/lib/voice/voicemail';

type Tx = Pick<Prisma.TransactionClient, 'pendingRecordingDeletion'>;

export interface RecordingToDelete { url: string | null | undefined; businessId?: string | null }

/** Queue the recordings behind deleted call rows. Idempotent (unique per account + recording). Returns the queue ids covering these recordings. */
export async function enqueueRecordingDeletions(tx: Tx, rows: RecordingToDelete[]): Promise<string[]> {
  const refs = new Map<string, { accountSid: string; recordingSid: string; businessId: string | null }>();
  for (const r of rows) {
    const ref = parseRecordingUrl(r.url);
    if (!ref) continue;
    forgetCachedRecording(ref); // never serve a recording from memory once it is queued for deletion
    refs.set(`${ref.accountSid}/${ref.recordingSid}`.toLowerCase(), { accountSid: ref.accountSid, recordingSid: ref.recordingSid, businessId: r.businessId ?? null });
  }
  if (refs.size === 0) return [];
  const list = [...refs.values()];
  await tx.pendingRecordingDeletion.createMany({ data: list, skipDuplicates: true });
  const found = await tx.pendingRecordingDeletion.findMany({
    where: { OR: list.map((r) => ({ accountSid: r.accountSid, recordingSid: r.recordingSid })) }, select: { id: true },
  });
  return found.map((f) => f.id);
}

export interface RecordingDeletionStatus {
  pending: number;
  /** Rows that failed enough times to have raised the alert. */
  stuck: number;
  oldest_at: string | null;
}

/** Queue depth (all tenants, or one). */
export async function recordingDeletionStatus(businessId?: string): Promise<RecordingDeletionStatus> {
  const where = businessId ? { businessId } : {};
  const [pending, stuck, oldest] = await Promise.all([
    prisma.pendingRecordingDeletion.count({ where }),
    prisma.pendingRecordingDeletion.count({ where: { ...where, alertedAt: { not: null } } }),
    prisma.pendingRecordingDeletion.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  return { pending, stuck, oldest_at: oldest?.createdAt.toISOString() ?? null };
}

/** How many of these queue rows are still waiting (i.e. not yet confirmed deleted at the provider). */
export async function countPendingByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return prisma.pendingRecordingDeletion.count({ where: { id: { in: ids } } });
}
