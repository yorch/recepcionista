/** Job wrapper: metering reconciliation (voice/reconcile.ts) and cap-warning safety net (billing/warnings.ts). Imported by jobs/index.ts. */
import { listBusinessesWithUsageChangedSince, listLiveBusinessesForJobs, prisma, recordAudit, withLease } from '@/lib/db';
import { checkUsageWarnings } from '@/lib/billing/warnings';
import { logger } from '@/lib/log';
import { reconcileUnmeteredCalls, settlePendingForwards } from '@/lib/voice/reconcile';
import { drainDirtyAgents } from '@/lib/voice/agent-resync';
import { reconcileStuckRefunds } from '@/lib/refund-service';
import { drainLinkDeactivations } from '@/lib/payments/link-store';
import { sweepStaleOwnerReplies } from '@/lib/messaging/owner-reply';

const log = logger('jobs/reconcile');

export interface SimpleJobReport { job: string; dry_run: boolean; at: string; processed: number; errors: number; items: { business_id?: string; outcome: string; detail?: Record<string, unknown> }[]; counts?: Record<string, number> }

export async function runReconcileJob(opts: { now?: Date; dryRun?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<SimpleJobReport> {
  const now = opts.now ?? new Date();
  const report: SimpleJobReport = { job: 'reconcile', dry_run: opts.dryRun === true, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  try {
    const r = await reconcileUnmeteredCalls({ now, dryRun: opts.dryRun, fetchImpl: opts.fetchImpl, env: opts.env });
    report.processed = r.metered;
    report.errors = r.items.filter((i) => i.outcome === 'failed' || i.outcome === 'gave_up').length;
    report.counts = { considered: r.considered, metered: r.metered, gave_up: r.gave_up };
    for (const i of r.items) if (i.outcome !== 'backoff') report.items.push({ business_id: i.business_id, outcome: i.outcome, detail: { call: i.call_id, seconds: i.seconds } });
    // Same safety-net tick: voice agents whose last sync failed (vertical change, ...) are re-synced with backoff.
    const agents = await drainDirtyAgents({ now, dryRun: opts.dryRun });
    report.counts = { ...report.counts, agents_considered: agents.considered, agents_synced: agents.synced, agents_failed: agents.failed, agents_gave_up: agents.gave_up };
    report.processed += agents.synced;
    report.errors += agents.gave_up;
    // Forward seconds of transferred calls whose write failed after the AI part was recorded.
    const fwd = await settlePendingForwards({ now, dryRun: opts.dryRun });
    report.counts = { ...report.counts, forwards_pending: fwd.considered, forwards_settled: fwd.settled, forwards_failed: fwd.failed };
    report.processed += fwd.settled;
    report.errors += fwd.failed;
    // Pending refunds that never reached Stripe, or whose answer never came back (see refund-service.ts checkPendingRefund).
    const refunds = await reconcileStuckRefunds({ now, dryRun: opts.dryRun });
    report.counts = { ...report.counts, refunds_stuck: refunds.considered, refunds_resolved: refunds.resolved };
    report.processed += refunds.resolved;
    // Deposit links of cancelled bookings whose background deactivation failed (Stripe down, ...): retried for up to 3 days.
    if (!opts.dryRun) {
      const links = await drainLinkDeactivations({ now, fetchImpl: opts.fetchImpl });
      report.counts = { ...report.counts, link_deactivations: links.considered, link_deactivations_done: links.done };
    }
    // Owner voice replies left in 'sending' by a crash: moved to 'uncertain' (never retried), so the dashboard stops saying "waiting".
    if (!opts.dryRun) {
      const stale = await sweepStaleOwnerReplies(now);
      report.counts = { ...report.counts, owner_replies_swept: stale };
    }
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: (err as Error).message.slice(0, 200) } });
    log.error('reconcile.failed', { err });
  }
  return report;
}

const PASS_SOURCE = 'usage-warn-pass';
const RETRY_SOURCE = 'usage-warn-retry';
/** Overlap when reading "changed since the last pass": a counter write that committed just after the last pass began is still seen. */
const CHANGED_SLACK_MS = 2 * 60_000;
/** A full sweep (every live business) at least this often: it covers what no counter write signals, e.g. a cap lowered by a plan change. */
const FULL_SWEEP_EVERY_MS = 24 * 3_600_000;

async function readMarker(id: string): Promise<Date | null> {
  const row = await prisma.processedEvent.findUnique({ where: { source_id: { source: PASS_SOURCE, id } }, select: { claimedAt: true } });
  return row?.claimedAt ?? null;
}
async function writeMarker(id: string, at: Date): Promise<void> {
  await prisma.processedEvent.upsert({
    where: { source_id: { source: PASS_SOURCE, id } }, create: { source: PASS_SOURCE, id, status: 'done', claimedAt: at, createdAt: at }, update: { claimedAt: at, createdAt: at },
  });
}

/**
 * Safety net for the inline trigger: sends any cap warning that is due and was not sent (a failed send, a quiet-hours deferral).
 * It visits only the businesses that can have something new due: those whose usage counter changed since the last pass, plus those whose
 * last visit left a warning deferred or failed (a durable retry marker). A full sweep of every live business runs on the first pass and then
 * at least daily (FULL_SWEEP_EVERY_MS). Warnings stay exactly-once: `markWarned` is still the claim; this only decides who is looked at.
 * The change window uses the wall clock (the database stamps counters with its own clock), not `opts.now`.
 */
export async function runUsageWarningsJob(opts: { now?: Date; dryRun?: boolean; businessId?: string; full?: boolean } = {}): Promise<SimpleJobReport> {
  const now = opts.now ?? new Date();
  const report: SimpleJobReport = { job: 'usage_warnings', dry_run: opts.dryRun === true, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  try {
    // One instance at a time: every runner ticks. A single-business (manual) run needs no lease and no marker.
    const pass = async (): Promise<void> => {
      const startedAt = new Date();
      let ids: string[];
      let full = true;
      let cursor: Date | null = null; // set when more businesses changed than one pass reads: the next pass continues from here
      if (opts.businessId) ids = (await listLiveBusinessesForJobs({ businessId: opts.businessId })).map((b) => b.id);
      else {
        const [since, lastFull] = await Promise.all([readMarker('since'), readMarker('full')]);
        full = opts.full === true || !since || !lastFull || startedAt.getTime() - lastFull.getTime() >= FULL_SWEEP_EVERY_MS;
        if (full) ids = (await listLiveBusinessesForJobs()).map((b) => b.id);
        else {
          const retry = (await prisma.processedEvent.findMany({ where: { source: RETRY_SOURCE }, select: { id: true }, take: 5000 })).map((r) => r.id);
          const changed = await listBusinessesWithUsageChangedSince(new Date(since!.getTime() - CHANGED_SLACK_MS));
          if (changed.truncated && changed.last) cursor = changed.last;
          ids = [...new Set([...changed.ids, ...retry])];
        }
      }
      report.counts = { visited: ids.length, full_sweep: full ? 1 : 0 };
      for (const id of ids) {
        if (opts.dryRun) { report.items.push({ business_id: id, outcome: 'would_check' }); continue; }
        const res = await checkUsageWarnings(id, { now: () => now });
        for (const w of res) {
          report.items.push({ business_id: id, outcome: w.outcome, detail: { kind: w.kind, level: w.level } });
          if (w.outcome === 'sent') report.processed++;
          if (w.outcome === 'failed' || w.outcome === 'error') report.errors++;
        }
        if (!opts.businessId) {
          // Something deferred (quiet hours) or failed stays on the list until a later visit finishes it; a clean visit removes the marker.
          const open = res.some((w) => w.outcome === 'deferred_quiet_hours' || w.outcome === 'failed' || w.outcome === 'error');
          if (open) await prisma.processedEvent.upsert({ where: { source_id: { source: RETRY_SOURCE, id } }, create: { source: RETRY_SOURCE, id, status: 'processing' }, update: { createdAt: new Date() } });
          else await prisma.processedEvent.deleteMany({ where: { source: RETRY_SOURCE, id } });
        }
      }
      if (!opts.businessId && !opts.dryRun) {
        // Normally everything up to now; after a truncated read only up to the last business read (the slack is added back when reading).
        await writeMarker('since', cursor ? new Date(cursor.getTime() + CHANGED_SLACK_MS) : startedAt);
        if (full) await writeMarker('full', startedAt);
      }
    };
    if (opts.businessId || opts.dryRun) await pass();
    else if (!(await withLease('usage-warnings-job', 5 * 60_000, pass)).acquired) report.items.push({ outcome: 'skipped_other_instance_running' });
    if (report.processed > 0) await recordAudit({ actor_kind: 'system', action: 'jobs.usage_warnings', target: 'job:usage_warnings', meta: { processed: report.processed } });
  } catch (err) {
    report.errors++;
    log.error('usage_warnings.failed', { err });
  }
  return report;
}
