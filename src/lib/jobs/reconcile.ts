/** Job wrapper: metering reconciliation (voice/reconcile.ts) and cap-warning safety net (billing/warnings.ts). Imported by jobs/index.ts. */
import { listLiveBusinessesForJobs, recordAudit, withLease } from '@/lib/db';
import { checkUsageWarnings } from '@/lib/billing/warnings';
import { logger } from '@/lib/log';
import { reconcileUnmeteredCalls } from '@/lib/voice/reconcile';
import { drainDirtyAgents } from '@/lib/voice/agent-resync';

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
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: (err as Error).message.slice(0, 200) } });
    log.error('reconcile.failed', { err });
  }
  return report;
}

/** Safety net for the inline trigger: sends any cap warning that is due and was not sent (a failed send, a quiet-hours deferral). */
export async function runUsageWarningsJob(opts: { now?: Date; dryRun?: boolean; businessId?: string } = {}): Promise<SimpleJobReport> {
  const now = opts.now ?? new Date();
  const report: SimpleJobReport = { job: 'usage_warnings', dry_run: opts.dryRun === true, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  try {
    // One instance at a time: every runner ticks, and the pass is 3 queries per live business. A single-business (manual) run needs no lease.
    const pass = async (): Promise<void> => {
      const list = await listLiveBusinessesForJobs(opts.businessId ? { businessId: opts.businessId } : {});
      for (const b of list) {
        if (opts.dryRun) { report.items.push({ business_id: b.id, outcome: 'would_check' }); continue; }
        const res = await checkUsageWarnings(b.id, { now: () => now });
        for (const w of res) {
          report.items.push({ business_id: b.id, outcome: w.outcome, detail: { kind: w.kind, level: w.level } });
          if (w.outcome === 'sent') report.processed++;
          if (w.outcome === 'failed') report.errors++;
        }
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
