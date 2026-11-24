/**
 * Per-call facts that are not part of the conversation itself: caller trust (STIR/SHAKEN), live-transfer outcome, and usage
 * reconciliation bookkeeping. Node runtime only.
 */
import { prisma } from './client';
import { cleanStirStatus, isCallerVerified } from '@/lib/stir';
import type { Call, TransferStatus } from '@/lib/types';
import { TRANSFER_STATUSES } from '@/lib/types';

export { attestationLevel, isCallerVerified, cleanStirStatus, type Attestation } from '@/lib/stir';

/**
 * Store Twilio's StirStatus on the call and derive `caller_verified` (true only for attestation A). A malformed value is stored as
 * NULL (not evaluated). Returns false when the call does not exist.
 */
export async function setCallTrust(callId: string, stirStatus: string | null | undefined): Promise<boolean> {
  const clean = cleanStirStatus(stirStatus);
  const res = await prisma.call.updateMany({ where: { id: callId }, data: { stirStatus: clean, callerVerified: clean === null ? null : isCallerVerified(clean) } });
  return res.count === 1;
}

/** Live-transfer outcome. 'connected' is final: a late 'failed' callback never overwrites it. Returns whether the row changed. */
export async function setTransferStatus(callId: string, status: TransferStatus): Promise<boolean> {
  if (!TRANSFER_STATUSES.includes(status)) throw new Error('setTransferStatus: invalid status');
  const res = await prisma.call.updateMany({ where: { id: callId, ...(status === 'connected' ? {} : { transferStatus: { not: 'connected' } }) }, data: { transferStatus: status } });
  return res.count === 1;
}

/**
 * Atomically mark the call's usage as metered. True only for the FIRST caller (the post-call webhook and the reconcile job race for
 * it), so minutes are added exactly once.
 */
export async function claimCallMetering(callId: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.call.updateMany({ where: { id: callId, meteredAt: null }, data: { meteredAt: now } });
  return res.count === 1;
}

/** Give the metering claim back (the usage write that followed it failed) so the reconcile job can retry. */
export async function releaseCallMetering(callId: string): Promise<void> {
  await prisma.call.updateMany({ where: { id: callId }, data: { meteredAt: null } });
}

export interface UnmeteredCall {
  id: string;
  business_id: string;
  conversation_id: string | null;
  call_sid: string | null;
  started_at: string;
  reconcile_attempts: number;
}

/**
 * Calls that started before `olderThan`, were never metered, and have fewer than `maxAttempts` reconcile tries (oldest first).
 * Owner-line calls (kind 'owner') ARE listed: they use AI minutes like any other call (they are only exempt from the cap BLOCK). Calls without a
 * conversation id are skipped: there is nothing to fetch for them.
 */
export async function listCallsNeedingReconcile(opts: { olderThan: Date; maxAttempts?: number; limit?: number }): Promise<UnmeteredCall[]> {
  const rows = await prisma.call.findMany({
    where: { meteredAt: null, conversationId: { not: null }, startedAt: { lt: opts.olderThan }, reconcileAttempts: { lt: opts.maxAttempts ?? 5 } },
    orderBy: { startedAt: 'asc' }, take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
    select: { id: true, businessId: true, conversationId: true, callSid: true, startedAt: true, reconcileAttempts: true },
  });
  return rows.map((r) => ({
    id: r.id, business_id: r.businessId, conversation_id: r.conversationId, call_sid: r.callSid, started_at: r.startedAt.toISOString(),
    reconcile_attempts: r.reconcileAttempts,
  }));
}

/** Count one reconcile try; returns the new attempt count (null when the call is gone). */
export async function bumpReconcileAttempt(callId: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`UPDATE "calls" SET "reconcile_attempts" = "reconcile_attempts" + 1 WHERE "id" = ${callId} RETURNING "reconcile_attempts" AS n`;
  return rows[0]?.n ?? null;
}

export type CallTrust = Pick<Call, 'stir_status' | 'caller_verified' | 'kind' | 'transfer_status'>;
