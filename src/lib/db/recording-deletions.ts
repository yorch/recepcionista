/**
 * Durable provider-side recording deletion (review 6, M2).
 *
 * A voicemail lives at Twilio; the only reference to it is `calls.recording_url`. Deleting the call row first and the recording
 * afterwards (fire and forget) loses the recording for good whenever the provider call fails. So every path that deletes call rows
 * (retention purge, customer erasure, demo reset) writes the recordings into `pending_recording_deletions` IN THE SAME TRANSACTION
 * as the DELETE; the jobs runner (voice/recording-deletion.ts, job `recording_deletions`) drains the queue with retries and backoff
 * and removes a row only when the provider answered 2xx or 404.
 *
 * Two providers hold copies: Twilio (voicemail recordings, only the Twilio account form of the URL, see parseRecordingUrl) and ElevenLabs
 * (the conversation's audio AND transcript, `calls.conversation_id`, deleted with DELETE /v1/convai/conversations/{id}). The ElevenLabs entries are
 * only queued when ELEVENLABS_API_KEY is set (without a key there is nothing at the provider to delete). Anything else has nothing to delete.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './client';
import { forgetCachedRecording, parseRecordingUrl } from '@/lib/voice/voicemail';
import { forgetCachedConversationAudio } from '@/lib/voice/recording-audio';

type Tx = Pick<Prisma.TransactionClient, 'pendingRecordingDeletion'>;

export interface RecordingToDelete { url?: string | null | undefined; businessId?: string | null; conversationId?: string | null }

/** The queue's account value for ElevenLabs conversations. */
export const ELEVENLABS_ACCOUNT = 'elevenlabs';
const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,128}$/;

/** Queue the recordings behind deleted call rows. Idempotent (unique per account + recording). Returns the queue ids covering these recordings. */
export async function enqueueRecordingDeletions(tx: Tx, rows: RecordingToDelete[]): Promise<string[]> {
  const refs = new Map<string, { accountSid: string; recordingSid: string; provider: string; businessId: string | null }>();
  const elevenlabs = Boolean((process.env.ELEVENLABS_API_KEY ?? '').trim());
  for (const r of rows) {
    const ref = parseRecordingUrl(r.url);
    if (ref) {
      forgetCachedRecording(ref); // never serve a recording from memory once it is queued for deletion
      refs.set(`${ref.accountSid}/${ref.recordingSid}`.toLowerCase(), { accountSid: ref.accountSid, recordingSid: ref.recordingSid, provider: 'twilio', businessId: r.businessId ?? null });
    }
    const conv = typeof r.conversationId === 'string' ? r.conversationId : '';
    if (conv && CONVERSATION_ID.test(conv)) {
      forgetCachedConversationAudio(conv); // never serve the proxied audio from memory once the call is erased
      if (elevenlabs) refs.set(`${ELEVENLABS_ACCOUNT}/${conv}`, { accountSid: ELEVENLABS_ACCOUNT, recordingSid: conv, provider: 'elevenlabs', businessId: r.businessId ?? null });
    }
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
