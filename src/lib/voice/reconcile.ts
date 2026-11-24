/**
 * Metering reconciliation: a call whose post-call webhook never arrived (dropped, failed signature, provider outage) would otherwise never
 * count against the AI-minutes cap. For calls (customer AND owner-line: owner calls use AI minutes too, they are only never BLOCKED by the cap) older than RECONCILE_AFTER_MINUTES (default 20; a call is capped at 15 min) with no
 * `metered_at`, fetch the conversation duration/status from ElevenLabs and add it ONCE. Shares `claimCallMetering` with the post-call
 * webhook (voice/postcall.ts), so a late webhook and this job can never both add the minutes. Only AI seconds are recorded (never forward / voicemail seconds). Retries back off exponentially
 * (attempt n waits 2^n x 10 min after the base delay); after RECONCILE_MAX_ATTEMPTS the job gives up with an audit row and an error log.
 */
import {
  bumpReconcileAttempt, claimCallMetering, getCall, listCallsNeedingReconcile, prisma, recordAudit, recordCallSeconds, releaseCallMetering, updateCall,
} from '@/lib/db';
import { fetchConversation, type ConversationFetch, type FetchDeps } from '@/lib/voice/conversations';
import { logger } from '@/lib/log';

const log = logger('voice/reconcile');

const intEnv = (raw: string | undefined, d: number, min: number, max: number): number => {
  const n = Number((raw ?? '').trim());
  return (raw ?? '').trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : d;
};
export const reconcileAfterMinutes = (env: Record<string, string | undefined> = process.env): number => intEnv(env.RECONCILE_AFTER_MINUTES, 20, 2, 24 * 60);
export const reconcileMaxAttempts = (env: Record<string, string | undefined> = process.env): number => intEnv(env.RECONCILE_MAX_ATTEMPTS, 5, 1, 20);
/** Minutes to wait (after the base delay) before try number `attempts + 1`. */
export const reconcileBackoffMinutes = (attempts: number): number => (attempts <= 0 ? 0 : Math.min(6 * 60, 10 * 2 ** (attempts - 1)));

export type ReconcileOutcome = 'metered' | 'already_metered' | 'not_ready' | 'backoff' | 'not_found' | 'fetch_failed' | 'gave_up' | 'failed';
export interface ReconcileItem { call_id: string; business_id: string; outcome: ReconcileOutcome; seconds?: number }
export interface ReconcileReport { considered: number; metered: number; gave_up: number; items: ReconcileItem[] }

export interface ReconcileDeps extends FetchDeps {
  now?: Date;
  fetchConversation?: (id: string) => Promise<ConversationFetch>;
  limit?: number;
  dryRun?: boolean;
}

export async function reconcileUnmeteredCalls(deps: ReconcileDeps = {}): Promise<ReconcileReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const maxAttempts = reconcileMaxAttempts(env);
  // Without a provider key there is nothing to fetch (dev / demo): do not burn the attempts.
  if (!deps.fetchConversation && !(env.ELEVENLABS_API_KEY ?? '').trim()) return { considered: 0, metered: 0, gave_up: 0, items: [] };
  const calls = await listCallsNeedingReconcile({ olderThan: new Date(now.getTime() - reconcileAfterMinutes(env) * 60_000), maxAttempts, limit: deps.limit ?? 50 });
  const report: ReconcileReport = { considered: calls.length, metered: 0, gave_up: 0, items: [] };
  const get = deps.fetchConversation ?? ((id: string) => fetchConversation(id, deps));
  for (const c of calls) {
    const item = (outcome: ReconcileOutcome, seconds?: number) => report.items.push({ call_id: c.id, business_id: c.business_id, outcome, ...(seconds !== undefined ? { seconds } : {}) });
    const waitMs = reconcileBackoffMinutes(c.reconcile_attempts) * 60_000;
    if (waitMs > 0 && now.getTime() - new Date(c.started_at).getTime() < reconcileAfterMinutes(env) * 60_000 + waitMs) { item('backoff'); continue; }
    if (deps.dryRun) { item('not_ready'); continue; }
    try {
      // The post-call webhook may have landed since the list was read.
      const fresh = await getCall(c.id);
      if (!fresh) continue;
      const meteredAlready = await alreadyMetered(c.id);
      if (meteredAlready) { item('already_metered'); continue; }

      const conv = await get(c.conversation_id as string);
      if (!conv.ok && conv.notFound && fresh.kind === 'owner') {
        // By design the provider-side conversation of an owner call is deleted right after the post-call webhook (nothing is kept). If its
        // duration never reached us there is nothing left to fetch: settle it (0 seconds) instead of retrying and "giving up" noisily.
        await claimCallMetering(c.id, now);
        item('already_metered');
        continue;
      }
      if (!conv.ok || conv.snapshot.status === 'in-progress' || conv.snapshot.status === 'initiated' || conv.snapshot.status === 'unknown') {
        const n = await bumpReconcileAttempt(c.id);
        const why = !conv.ok ? (conv.notFound ? 'not_found' : 'fetch_failed') : 'not_ready';
        item(why === 'not_found' ? 'not_found' : why === 'fetch_failed' ? 'fetch_failed' : 'not_ready');
        if (n !== null && n >= maxAttempts) await giveUp(c, why, n, report);
        continue;
      }
      const seconds = conv.snapshot.durationSecs ?? 0;
      if (!(await claimCallMetering(c.id, now))) { item('already_metered'); continue; }
      try {
        if (seconds > 0) await recordCallSeconds(c.business_id, seconds, now);
      } catch (err) {
        await releaseCallMetering(c.id); // the write failed: leave it for the next pass
        throw err;
      }
      await updateCall(c.id, { ...(seconds > 0 && !fresh.duration_sec ? { duration_sec: seconds } : {}), ...(fresh.ended_at ? {} : { ended_at: now.toISOString() }) });
      report.metered++;
      item('metered', seconds);
      log.info('reconciled', { business: c.business_id, call: c.id, seconds });
    } catch (err) {
      log.error('reconcile_failed', { business: c.business_id, call: c.id, err });
      const n = await bumpReconcileAttempt(c.id).catch(() => null);
      item('failed');
      if (n !== null && n >= maxAttempts) await giveUp(c, 'error', n, report);
    }
  }
  return report;
}

async function alreadyMetered(callId: string): Promise<boolean> {
  const row = await prisma.call.findUnique({ where: { id: callId }, select: { meteredAt: true } });
  return row?.meteredAt != null;
}

async function giveUp(c: { id: string; business_id: string }, why: string, attempts: number, report: ReconcileReport): Promise<void> {
  report.gave_up++;
  report.items.push({ call_id: c.id, business_id: c.business_id, outcome: 'gave_up' });
  log.error('reconcile_gave_up', { business: c.business_id, call: c.id, attempts, why, action: 'this call\'s minutes were never metered: check the conversation in ElevenLabs and docs/runbook.md section 6' });
  await recordAudit({ actor_kind: 'system', business_id: c.business_id, action: 'voice.reconcile_gave_up', target: `call:${c.id}`, meta: { attempts, why } });
}
