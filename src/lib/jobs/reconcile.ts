/** Job wrapper: metering reconciliation (voice/reconcile.ts) and cap-warning safety net (billing/warnings.ts). Imported by jobs/index.ts. */
import { listLiveBusinessesForJobs, recordAudit } from '@/lib/db';
import { checkUsageWarnings } from '@/lib/billing/warnings';
import { logger } from '@/lib/log';
import { reconcileUnmeteredCalls } from '@/lib/voice/reconcile';

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
    if (report.processed > 0) await recordAudit({ actor_kind: 'system', action: 'jobs.usage_warnings', target: 'job:usage_warnings', meta: { processed: report.processed } });
  } catch (err) {
    report.errors++;
    log.error('usage_warnings.failed', { err });
  }
  return report;
}
