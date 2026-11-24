/**
 * The jobs-runner side of durable recording deletion (db/recording-deletions.ts holds the queue and the enqueue).
 *
 * `drainRecordingDeletions` takes the due rows (a short claim: `next_attempt_at` moves 5 minutes ahead, so two runners never delete
 * the same recording at once), asks the provider to delete each, and:
 *   - 2xx / 404 -> the row is removed (the recording is gone);
 *   - anything else -> `attempts + 1`, the short reason in `last_error`, and the next attempt after an exponential backoff
 *     (1 min, 2, 4 ... capped at 6 h). From RECORDING_DELETE_ALERT_ATTEMPTS failed attempts one loud alert fires per row (log.error
 *     + an audit row `recordings.deletion_stuck`), because a recording that cannot be deleted is a privacy problem someone must look at
 *     (for example TWILIO_ACCOUNT_SID no longer matches the account that owns the recording).
 * Rows carry a `provider`: 'twilio' (voicemail recording) or 'elevenlabs' (the call's conversation: audio + transcript, DELETE /v1/convai/conversations/{id}).
 * Never throws; a database error ends the pass and the next tick retries.
 */
import { prisma, recordAudit } from '@/lib/db';
import { logger } from '@/lib/log';
import { deleteConversation } from '@/lib/voice/conversations';
import { deleteTwilioRecording } from '@/lib/voice/voicemail';

const log = logger('voice/recording-deletion');

export const RECORDING_DELETE_ALERT_ATTEMPTS = 5;
export const RECORDING_DELETE_CLAIM_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** Wait before attempt number `failedAttempts + 1`: 1 min after the first failure, doubling, capped at 6 h. Pure. */
export const recordingDeleteBackoffMs = (failedAttempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failedAttempts - 1));

export interface DrainOptions {
  now?: Date;
  /** At most this many recordings per pass. */
  limit?: number;
  /** Only these queue rows (the ones a purge / erasure just queued): tried immediately, whatever their schedule. */
  ids?: string[];
  fetchImpl?: typeof fetch;
}

export interface DrainResult {
  attempted: number;
  deleted: number;
  failed: number;
  /** Rows that raised the "not draining" alert in this pass. */
  alerted: number;
  /** Rows of `ids` still queued afterwards (0 when `ids` was not given). */
  pending_of_requested: number;
  /** The whole queue after this pass. */
  pending_total: number;
}

type Claimed = { id: string; account_sid: string; recording_sid: string; provider: string; attempts: number; business_id: string | null };

export async function drainRecordingDeletions(opts: DrainOptions = {}): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const out: DrainResult = { attempted: 0, deleted: 0, failed: 0, alerted: 0, pending_of_requested: 0, pending_total: 0 };
  try {
    const claimUntil = new Date(now.getTime() + RECORDING_DELETE_CLAIM_MS);
    const rows = opts.ids
      ? await prisma.$queryRaw<Claimed[]>`
          UPDATE "pending_recording_deletions" SET "next_attempt_at" = ${claimUntil}::timestamptz
           WHERE "id" IN (SELECT "id" FROM "pending_recording_deletions" WHERE "id" = ANY(${opts.ids}::text[]) ORDER BY "created_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
          RETURNING "id", "account_sid", "recording_sid", "provider", "attempts", "business_id"`
      : await prisma.$queryRaw<Claimed[]>`
          UPDATE "pending_recording_deletions" SET "next_attempt_at" = ${claimUntil}::timestamptz
           WHERE "id" IN (SELECT "id" FROM "pending_recording_deletions" WHERE "next_attempt_at" <= ${now}::timestamptz ORDER BY "next_attempt_at" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
          RETURNING "id", "account_sid", "recording_sid", "provider", "attempts", "business_id"`;
    for (const row of rows) {
      out.attempted++;
      const res = row.provider === 'elevenlabs'
        ? await deleteConversation(row.recording_sid, { fetchImpl: opts.fetchImpl })
        : await deleteTwilioRecording({ accountSid: row.account_sid, recordingSid: row.recording_sid }, opts.fetchImpl);
      if (res.ok) {
        await prisma.pendingRecordingDeletion.deleteMany({ where: { id: row.id } });
        out.deleted++;
        continue;
      }
      out.failed++;
      const attempts = row.attempts + 1;
      const stuck = attempts >= RECORDING_DELETE_ALERT_ATTEMPTS;
      const claimed = stuck
        ? await prisma.pendingRecordingDeletion.updateMany({
          where: { id: row.id, alertedAt: null },
          data: { attempts, lastError: res.error, nextAttemptAt: new Date(now.getTime() + recordingDeleteBackoffMs(attempts)), alertedAt: now },
        })
        : { count: 0 };
      if (!stuck || claimed.count === 0) {
        await prisma.pendingRecordingDeletion.updateMany({
          where: { id: row.id }, data: { attempts, lastError: res.error, nextAttemptAt: new Date(now.getTime() + recordingDeleteBackoffMs(attempts)) },
        });
      }
      if (claimed.count > 0) {
        out.alerted++;
        log.error('recording_deletion_stuck', { recording: row.recording_sid, business: row.business_id, attempts, last_error: res.error, action: row.provider === 'elevenlabs'
          ? 'a call conversation (audio + transcript) could not be deleted at ElevenLabs; check ELEVENLABS_API_KEY / ElevenLabs status (docs/runbook.md)'
          : 'a voicemail recording could not be deleted at the provider; check TWILIO_ACCOUNT_SID / Twilio status (docs/runbook.md)' });
        await recordAudit({
          actor_kind: 'system', business_id: row.business_id, action: 'recordings.deletion_stuck', target: `recording:${row.recording_sid}`,
          meta: { attempts, last_error: res.error, provider: row.provider },
        });
      }
    }
    out.pending_total = await prisma.pendingRecordingDeletion.count();
    if (opts.ids) out.pending_of_requested = await prisma.pendingRecordingDeletion.count({ where: { id: { in: opts.ids } } });
  } catch (err) {
    log.error('drain_failed', { err });
    if (opts.ids) out.pending_of_requested = opts.ids.length - out.deleted;
  }
  return out;
}
