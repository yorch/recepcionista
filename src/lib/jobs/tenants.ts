/**
 * Tenant lifecycle jobs (admin jobs of the job runner): `tenant_release` (heads-up mail, then release of the provider resources of canceled /
 * unpaid tenants; the logic is billing/release.ts, the same as scripts/release-canceled-tenants.ts) and `grandfather` (comp EXISTING vetted
 * tenants when plans start being enforced; billing/grandfather.ts, the same as scripts/grandfather-existing.ts).
 *
 * Both are DRY-RUN by default and destructive only on purpose:
 *   TENANT_RELEASE_JOB unset / off : manual runs only (POST /api/admin/jobs/run); a non-dry request is REFUSED (reported, nothing changes);
 *   TENANT_RELEASE_JOB=report      : the daily tick runs `tenant_release` as a dry run and stores the report (audit `jobs.tenant_release_report`);
 *   TENANT_RELEASE_JOB=on          : the daily tick (and a manual `dry_run:false`) really sends the heads-ups and releases what is due;
 *                                    `grandfather` stays manual (it needs a cutoff) but its `dry_run:false` also needs `on`.
 * State is audit-only (no table): `billing.release_notice`, `billing.tenant_released` (existing), `billing.grandfathered`, and a per-run
 * `jobs.tenant_release_report` / `jobs.grandfather_report` row with the counts (what the admin report shows).
 */
import { configEnv } from '@/lib/config';
import { recordAudit } from '@/lib/db';
import { logger } from '@/lib/log';
import { compBusiness, planGrandfather } from '@/lib/billing/grandfather';
import { DEFAULT_GRACE_DAYS, DEFAULT_NOTIFY_DAYS, flagStuckRelease, listReleaseCandidateStates, processBusiness, type BusinessReport, type CandidateState } from '@/lib/billing/release';
import type { JobItem, JobReport, RunOptions } from './index';

const log = logger('jobs.tenants');

export type TenantReleaseSetting = 'off' | 'report' | 'on';

/** TENANT_RELEASE_JOB: exactly "on" acts, exactly "report" reports on the schedule; anything else (including unset) is off. */
export function tenantReleaseSetting(env: NodeJS.ProcessEnv = configEnv()): TenantReleaseSetting {
  const v = (env.TENANT_RELEASE_JOB ?? '').trim().toLowerCase();
  return v === 'on' ? 'on' : v === 'report' ? 'report' : 'off';
}

/** Max businesses one run acts on (the rest wait for the next run): a runaway selection cannot release the whole customer base in one pass. */
export const MAX_RELEASES_PER_RUN = 10;
/** Circuit breaker: after this many businesses with a provider error in ONE run the rest wait for the next run (a provider outage must not be hammered business by business). */
export const MAX_RELEASE_ERRORS_PER_RUN = 3;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

function describe(r: BusinessReport): JobItem {
  const d = r.decision;
  return {
    business_id: r.id,
    outcome: r.error ? 'error' : r.outcome && r.outcome.errors.length > 0 ? 'partial_error' : r.applied ? (d.action === 'release' ? 'released' : 'notified') : d.action === 'release' ? 'would_release' : d.action === 'notify' ? 'would_notify' : d.action,
    detail: { ...(d.action === 'skip' || d.action === 'wait' ? { reason: d.reason } : {}), ...(r.error ? { error: r.error } : {}), ...(r.outcome?.errors.length ? { errors: r.outcome.errors } : {}) },
  };
}

async function storeReport(action: string, report: JobReport, extra: Record<string, unknown>): Promise<void> {
  try {
    await recordAudit({ actor_kind: 'system', action, target: `job:${report.job}`, meta: { at: report.at, dry_run: report.dry_run, processed: report.processed, errors: report.errors, counts: report.counts, items_total: report.items.length, items: report.items.slice(0, 40).map((i) => [i.business_id ?? null, i.outcome]), ...extra } }); // items: [business id, outcome] pairs (the audit meta cap is 4 KB); the admin console renders the report as a table
  } catch (err) {
    log.warn('report.audit_failed', { err });
  }
}

export async function runTenantReleaseJob(opts: RunOptions & { graceDays?: number; notifyDays?: number; includeRecent?: boolean } = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? configEnv();
  const setting = tenantReleaseSetting(env);
  const wantsApply = opts.dryRun === false;
  const apply = wantsApply && setting === 'on';
  const report: JobReport = { job: 'tenant_release', dry_run: !apply, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  if (wantsApply && !apply) report.items.push({ outcome: 'refused_not_enabled', detail: { note: 'TENANT_RELEASE_JOB is not "on": reported as a dry run, nothing was sent or released' } });
  const counts: Record<string, number> = { candidates: 0, would_notify: 0, would_release: 0, waiting: 0, skipped: 0, notified: 0, released: 0, deferred: 0 };
  try {
    // Least recently attempted first; a business that failed STUCK_AFTER_FAILED_ATTEMPTS times in a row needs an operator and sits out (flagged once) until its weekly retry,
    // so one that can never succeed cannot starve the others.
    const states: CandidateState[] = opts.businessId ? [{ id: opts.businessId, last_attempt_at: null, failed_attempts: 0, stuck: false }] : await listReleaseCandidateStates(now);
    const ids = states.filter((st) => !st.stuck).map((st) => st.id);
    counts.candidates = states.length;
    counts.stuck = 0;
    for (const st of states.filter((x) => x.stuck)) {
      counts.stuck++;
      if (apply) await flagStuckRelease(st, now);
      report.items.push({ business_id: st.id, outcome: 'needs_operator', detail: { failed_attempts: st.failed_attempts, last_attempt_at: st.last_attempt_at?.toISOString() ?? null } });
    }
    // The cap counts every business the run ACTED on (a provider call was attempted), whether or not it ended clean: a failing provider must not lift it.
    let acted = 0;
    let erroring = 0;
    for (const id of ids) {
      if (apply && acted >= MAX_RELEASES_PER_RUN) { counts.deferred++; report.items.push({ business_id: id, outcome: 'deferred_to_next_run' }); continue; }
      if (apply && erroring >= MAX_RELEASE_ERRORS_PER_RUN) { counts.deferred++; report.items.push({ business_id: id, outcome: 'deferred_to_next_run', detail: { reason: 'circuit_breaker: too many provider errors in this run' } }); continue; }
      const r = await processBusiness(id, {
        apply, now, graceDays: opts.graceDays ?? DEFAULT_GRACE_DAYS, notifyDays: opts.notifyDays ?? DEFAULT_NOTIFY_DAYS, includeRecent: opts.includeRecent === true,
        actor: { kind: 'system' }, script: 'jobs.tenant_release',
      });
      if (!r) continue;
      const item = describe(r);
      report.items.push(item);
      if (r.applied) acted++;
      if (r.error || (r.outcome && r.outcome.errors.length)) { report.errors++; if (r.applied) erroring++; }
      switch (item.outcome) {
        case 'released': counts.released++; report.processed++; break;
        case 'notified': counts.notified++; report.processed++; break;
        case 'partial_error': counts.partial_error = (counts.partial_error ?? 0) + 1; break; // retried by the next run
        case 'would_release': counts.would_release++; break;
        case 'would_notify': counts.would_notify++; break;
        case 'wait': counts.waiting++; break;
        case 'skip': counts.skipped++; break;
        default: break;
      }
    }
    report.counts = counts;
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: errMsg(err) } });
    log.error('tenant_release.failed', { err });
  }
  await storeReport('jobs.tenant_release_report', report, { setting });
  return report;
}

/**
 * Comp existing, vetted tenants created before `opts.before` (ISO instant; env GRANDFATHER_BEFORE is the default). Manual only. Dry run unless
 * `dry_run:false` AND TENANT_RELEASE_JOB=on. Owner phones are never marked verified.
 */
export async function runGrandfatherJob(opts: RunOptions & { before?: string; includeUnverifiedPhone?: boolean; includeSelfSignup?: boolean } = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? configEnv();
  const wantsApply = opts.dryRun === false;
  const apply = wantsApply && tenantReleaseSetting(env) === 'on';
  const report: JobReport = { job: 'grandfather', dry_run: !apply, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  if (wantsApply && !apply) report.items.push({ outcome: 'refused_not_enabled', detail: { note: 'TENANT_RELEASE_JOB is not "on": reported as a dry run, nothing was comped' } });
  const raw = opts.before ?? env.GRANDFATHER_BEFORE;
  const cutoff = raw ? new Date(raw) : null;
  if (!cutoff || Number.isNaN(cutoff.getTime())) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: 'a cutoff is required: pass "before" (ISO instant) or set GRANDFATHER_BEFORE; nothing is selected without one' } });
    return report;
  }
  try {
    const plan = await planGrandfather({ cutoff, includeUnverifiedPhone: opts.includeUnverifiedPhone === true, includeSelfSignup: opts.includeSelfSignup === true });
    report.counts = { eligible: plan.eligible.length, skipped: plan.skipped.length, comped: 0 };
    for (const b of plan.eligible) {
      if (!apply) { report.items.push({ business_id: b.id, outcome: 'would_comp' }); continue; }
      if (report.processed >= MAX_RELEASES_PER_RUN * 10) { report.items.push({ business_id: b.id, outcome: 'deferred_to_next_run' }); continue; }
      if (!(await compBusiness(b.id))) { report.items.push({ business_id: b.id, outcome: 'unchanged' }); continue; }
      await recordAudit({ actor_kind: 'system', business_id: b.id, action: 'billing.grandfathered', target: `business:${b.id}`, meta: { script: 'jobs.grandfather', cutoff: cutoff.toISOString(), owner_phone_verified: b.ownerPhoneVerified } });
      report.processed++;
      report.counts.comped++;
      report.items.push({ business_id: b.id, outcome: 'comped' });
    }
    for (const s of plan.skipped.slice(0, 200)) report.items.push({ business_id: s.id, outcome: 'skipped', detail: { reason: s.reason } });
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: errMsg(err) } });
    log.error('grandfather.failed', { err });
  }
  await storeReport('jobs.grandfather_report', report, { cutoff: cutoff.toISOString() });
  return report;
}
