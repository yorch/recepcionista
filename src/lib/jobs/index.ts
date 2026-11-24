/**
 * Background job runner. Started once per Node process from instrumentation.ts (never during `next build`).
 *
 * Jobs
 *  - daily_briefing  per business, at 18:00 in the BUSINESS time zone (catch-up until local midnight): generate the
 *                    end-of-day briefing once per local day and text the owner a link (verified owner phone, not in quiet
 *                    hours, within the SMS cap). Only live businesses whose billing allows service (isProvisioningAllowed).
 *  - gratitude_sweep hourly, per live business: the existing runGratitudeSweep (consent, opt-out, quiet-hours and cap rules
 *                    are enforced inside it, unchanged). A business in quiet hours is skipped, not swept.
 *  - cleanup         hourly: expired sessions, expired email tokens, old processed_events claims, stale rate-limit buckets.
 *  - retention       daily PII purge. OFF unless RETENTION_JOB=on (unchanged semantics; see retention-job.ts).
 *
 * Safe with several instances / several runners: every unit of work is a per-business lease (`withLease`) PLUS an
 * idempotency claim in `processed_events` (`claimEvent`), so two runners ticking at the same instant do the work once.
 * A runner that dies mid-way leaves a claim that expires on its own; the next tick retries.
 *
 * Time is injectable (`now`) everywhere so DST/time-zone behaviour is testable without waiting for 6 PM.
 *
 * Switches: JOBS=on|off (default on in production, off in development/test), JOBS_TICK_SECONDS (default 60).
 * RETENTION_JOB=on still works on its own (JOBS unset in development) and is off by default. JOBS=off turns everything off.
 */
import {
  claimEvent, cleanupProcessedEvents, completeEvent, deleteExpiredEmailTokens, deleteExpiredSessions, EMAIL_TOKEN_GRACE_MS,
  getBusiness, isProvisioningAllowed, listLiveBusinessesForJobs, prisma, PROCESSED_EVENTS_RETENTION_MS, recordAudit, releaseEvent,
  checkSmsAllowed, withLease,
} from '@/lib/db';
import { appBaseUrl } from '@/lib/email/templates';
import { generateBriefing } from '@/lib/briefing';
import { findGratitudeCandidates, runGratitudeSweep } from '@/lib/gratitude';
import { logger } from '@/lib/log';
import { ownerAlertStatus } from '@/lib/messaging/owner';
import { smsSegments } from '@/lib/messaging/policy';
import { CLEANUP_HORIZON_MS, cleanupRateLimitBuckets } from '@/lib/ratelimit';
import { retentionJobEnabled, logRetentionPreview, runRetentionNow } from '@/lib/retention-job';
import { alertOwner } from '@/lib/voice/owner-alert';
import type { Briefing, Business } from '@/lib/types';
import type { JobBusiness } from '@/lib/db';
import {
  briefingSlot, hourBucket, inQuietHours, JOB_NAMES, jobsSetting, nextBriefingAt, tickSeconds, type JobName,
} from './schedule';

export { JOB_NAMES, isJobName, jobsSetting, tickSeconds, briefingSlot, nextBriefingAt, hourBucket } from './schedule';
export type { JobName } from './schedule';

const log = logger('jobs');

/** Max businesses that get a briefing generated / a gratitude sweep per tick; the rest are picked up by the next tick. */
export const MAX_BRIEFINGS_PER_TICK = 10;
export const MAX_GRATITUDE_PER_TICK = 25;
const BRIEFING_LEASE_MS = 3 * 60_000;
const BRIEFING_CLAIM_LEASE_MS = 10 * 60_000;
const GRATITUDE_LEASE_MS = 5 * 60_000;
const CLEANUP_LEASE_MS = 2 * 60_000;
export const CLEANUP_EVERY_MS = 60 * 60_000;
export const RETENTION_EVERY_MS = 24 * 60 * 60_000;
const FIRST_TICK_DELAY_MS = 20_000;

const STATE_SOURCE = 'job-state';
export const BRIEFING_CLAIM_SOURCE = 'daily-briefing';
export const GRATITUDE_CLAIM_SOURCE = 'gratitude-sweep';

export const JOB_INFO: Record<JobName, { description: string; schedule: string }> = {
  daily_briefing: { description: 'End-of-day briefing, generated once per local day per live business; owner is texted a link.', schedule: '18:00 in each business time zone' },
  gratitude_sweep: { description: 'Day-after thank-you / review texts for completed jobs (consent, opt-out, quiet-hours and cap rules enforced).', schedule: 'hourly' },
  cleanup: { description: 'Delete expired sessions, expired email tokens, old processed events and stale rate-limit buckets.', schedule: 'hourly' },
  retention: { description: 'Delete customer data past each business retention window (OFF unless RETENTION_JOB=on).', schedule: 'daily' },
};

// ---- types ------------------------------------------------------------------------------------

export interface JobItem {
  business_id?: string;
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface JobReport {
  job: JobName;
  dry_run: boolean;
  at: string;
  /** Units of real work done (briefings generated, businesses swept, rows deleted groups run). 0 on a dry run. */
  processed: number;
  errors: number;
  items: JobItem[];
  counts?: Record<string, number>;
}

export interface JobDeps {
  generateBriefing(businessId: string, date: string): Promise<Briefing>;
  notifyOwner(business: Business, briefing: Briefing, now: Date): Promise<string>;
  /** `signal` aborts when the job lease is lost: stop before the next side effect. */
  sweepGratitude(businessId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  countGratitudeCandidates(businessId: string): Promise<number>;
}

export const defaultDeps: JobDeps = {
  generateBriefing: (id, date) => generateBriefing(id, date),
  notifyOwner: (b, br, now) => notifyOwnerOfBriefing(b, br, now),
  sweepGratitude: async (id, signal) => ({ ...(await runGratitudeSweep(id, { signal })) }),
  countGratitudeCandidates: async (id) => (await findGratitudeCandidates(id)).length,
};

export interface RunOptions {
  now?: Date;
  /** Restrict to one business (briefing / gratitude). */
  businessId?: string;
  dryRun?: boolean;
  /** Manual runs only: ignore the schedule gate (18:00 / hour-due) but keep every safety gate (billing, idempotency). */
  force?: boolean;
  deps?: Partial<JobDeps>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: how often the per-business job lease is renewed (default ttl/3). */
  leaseRenewMs?: number;
}

// ---- state ------------------------------------------------------------------------------------

/** When the job last did work (processed_events 'job-state' row; claimed_at). Null = never. */
export async function lastRunAt(job: JobName): Promise<Date | null> {
  const row = await prisma.processedEvent.findUnique({ where: { source_id: { source: STATE_SOURCE, id: job } }, select: { claimedAt: true } });
  return row?.claimedAt ?? null;
}

async function markRun(job: JobName, now: Date): Promise<void> {
  try {
    // created_at is refreshed too so the 30-day processed_events cleanup never deletes the state row.
    await prisma.processedEvent.upsert({
      where: { source_id: { source: STATE_SOURCE, id: job } },
      create: { source: STATE_SOURCE, id: job, status: 'done', claimedAt: now, createdAt: now },
      update: { status: 'done', claimedAt: now, createdAt: now },
    });
  } catch (err) {
    log.warn('state.write_failed', { job, err });
  }
}

async function auditRun(report: JobReport): Promise<void> {
  if (report.dry_run || (report.processed === 0 && report.errors === 0)) return;
  const outcomes: Record<string, number> = {};
  for (const i of report.items) outcomes[i.outcome] = (outcomes[i.outcome] ?? 0) + 1;
  await recordAudit({
    actor_kind: 'system', action: `jobs.${report.job}`, target: `job:${report.job}`,
    meta: { processed: report.processed, errors: report.errors, outcomes, counts: report.counts, at: report.at },
  });
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * The tenants a tick must look at: live ones only, NARROW columns (id, time zone, billing state), straight from an indexed query.
 * A job loads a tenant's full row (`getBusiness`) only when it is about to act on it, and never its sms/booking history.
 */
function liveBusinesses(businessId?: string): Promise<JobBusiness[]> {
  return listLiveBusinessesForJobs(businessId ? { businessId } : {});
}

/** Thrown inside a lease-held job when the lease was lost: nothing paid or user-visible may happen after it. */
export class JobLeaseLostError extends Error {
  constructor(job: string) { super(`${job}: lease lost; stopping before the next side effect`); this.name = 'JobLeaseLostError'; }
}
const assertLease = (signal: AbortSignal, job: string): void => { if (signal.aborted) throw new JobLeaseLostError(job); };

// ---- daily briefing ---------------------------------------------------------------------------

export type OwnerNoticeOutcome = 'sent' | 'skipped_no_owner_phone' | 'skipped_owner_unverified' | 'skipped_quiet_hours' | 'skipped_cap' | 'failed';

/**
 * Text the owner a link to the briefing. Respects what every other text respects: only a VERIFIED owner phone, never in
 * quiet hours (9pm-8am local), and only while the plan's SMS cap has room for it. Never throws.
 */
export async function notifyOwnerOfBriefing(business: Business, briefing: Briefing, now: Date): Promise<OwnerNoticeOutcome> {
  try {
    const status = ownerAlertStatus(business);
    if (status === 'no_owner_phone') return 'skipped_no_owner_phone';
    if (status === 'unverified') return 'skipped_owner_unverified';
    if (inQuietHours(now, business.timezone)) return 'skipped_quiet_hours';
    const body = `Your end-of-day briefing for ${briefing.date} is ready: ${appBaseUrl()}/dashboard/briefings`;
    const allowed = await checkSmsAllowed(business.id, now, smsSegments(body));
    if (!allowed.ok) return 'skipped_cap';
    const res = await alertOwner(business, body);
    return res.notified ? 'sent' : 'failed';
  } catch (err) {
    log.warn('briefing.notify_failed', { business: business.id, err });
    return 'failed';
  }
}

export async function runDailyBriefings(opts: RunOptions = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const deps = { ...defaultDeps, ...opts.deps };
  const dryRun = opts.dryRun === true;
  const report: JobReport = { job: 'daily_briefing', dry_run: dryRun, at: now.toISOString(), processed: 0, errors: 0, items: [] };

  const businesses = await liveBusinesses(opts.businessId);
  if (opts.businessId && businesses.length === 0) report.items.push({ business_id: opts.businessId, outcome: 'skipped_not_live' });

  // Cheap pass first (pure, no I/O): which tenants are due at all? After 18:00 local a finished tenant costs nothing per tick.
  const due: Array<{ b: JobBusiness; slot: ReturnType<typeof briefingSlot>; claimId: string }> = [];
  for (const b of businesses) {
    const slot = briefingSlot(now, b.timezone);
    if (!isProvisioningAllowed(b, now, opts.env)) { report.items.push({ business_id: b.id, outcome: 'skipped_billing' }); continue; }
    if (!slot.due && !opts.force) continue; // not yet 18:00 there: not worth a report row
    // A manual (forced) run has its own claim so it never uses up the scheduled 18:00 run of that day.
    due.push({ b, slot, claimId: `${b.id}:${slot.date}${opts.force ? ':manual' : ''}` });
  }
  // Two batched, indexed lookups for ALL due tenants (instead of two point queries per tenant per tick).
  const generated = new Map<string, Date>();
  const claimed = new Set<string>();
  if (due.length > 0) {
    const briefings = await prisma.briefing.findMany({
      where: { businessId: { in: due.map((d) => d.b.id) }, date: { in: [...new Set(due.map((d) => d.slot.date))] } },
      select: { businessId: true, date: true, createdAt: true },
    });
    for (const r of briefings) generated.set(`${r.businessId}:${r.date}`, r.createdAt);
    const done = await prisma.processedEvent.findMany({
      where: { source: BRIEFING_CLAIM_SOURCE, id: { in: due.map((d) => d.claimId) }, status: 'done' }, select: { id: true },
    });
    for (const r of done) claimed.add(r.id);
  }

  for (const { b, slot, claimId } of due) {
    if (report.processed >= MAX_BRIEFINGS_PER_TICK && !dryRun) { report.items.push({ business_id: b.id, outcome: 'deferred_to_next_tick' }); continue; }
    // Already generated at/after the scheduled time (by a runner, or by hand this evening): nothing to do.
    const existing = generated.get(`${b.id}:${slot.date}`);
    if (existing && existing.getTime() >= slot.scheduled_at.getTime()) { report.items.push({ business_id: b.id, outcome: 'already_generated', detail: { date: slot.date } }); continue; }
    if (claimed.has(claimId)) { report.items.push({ business_id: b.id, outcome: 'already_generated', detail: { date: slot.date } }); continue; }
    if (dryRun) { report.items.push({ business_id: b.id, outcome: 'would_generate', detail: { date: slot.date } }); continue; }

    try {
      const run = await withLease(`job:briefing:${b.id}`, BRIEFING_LEASE_MS, async (_lease, signal) => {
        if (!(await claimEvent(BRIEFING_CLAIM_SOURCE, claimId, BRIEFING_CLAIM_LEASE_MS))) return { outcome: 'already_claimed' } as const;
        try {
          assertLease(signal, 'daily_briefing'); // never start the (paid) generation without the lease
          const briefing = await deps.generateBriefing(b.id, slot.date);
          await completeEvent(BRIEFING_CLAIM_SOURCE, claimId);
          if (signal.aborted) return { outcome: 'generated', detail: { date: slot.date, owner_notice: 'skipped_lease_lost' } } as const; // no text from a stale holder
          const full = await getBusiness(b.id);
          const notice = full ? await deps.notifyOwner(full, briefing, now) : 'skipped_not_found';
          return { outcome: 'generated', detail: { date: slot.date, owner_notice: notice } } as const;
        } catch (err) {
          await releaseEvent(BRIEFING_CLAIM_SOURCE, claimId); // let the next tick retry
          throw err;
        }
      }, { renewEveryMs: opts.leaseRenewMs });
      if (!run.acquired) { report.items.push({ business_id: b.id, outcome: 'busy' }); continue; }
      report.items.push({ business_id: b.id, outcome: run.value.outcome, ...('detail' in run.value ? { detail: run.value.detail } : {}) });
      if (run.value.outcome === 'generated') report.processed++;
    } catch (err) {
      report.errors++;
      report.items.push({ business_id: b.id, outcome: err instanceof JobLeaseLostError ? 'lease_lost' : 'error', detail: { error: errMsg(err) } });
      log.error('briefing.failed', { business: b.id, date: slot.date, err });
    }
  }
  if (report.processed > 0) await markRun('daily_briefing', now);
  await auditRun(report);
  return report;
}

// ---- gratitude sweep --------------------------------------------------------------------------

export async function runGratitudeJob(opts: RunOptions = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const deps = { ...defaultDeps, ...opts.deps };
  const dryRun = opts.dryRun === true;
  const report: JobReport = { job: 'gratitude_sweep', dry_run: dryRun, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  const bucket = hourBucket(now);

  const businesses = await liveBusinesses(opts.businessId);
  if (opts.businessId && businesses.length === 0) report.items.push({ business_id: opts.businessId, outcome: 'skipped_not_live' });

  // One query: which businesses were already swept this hour (skipped for free, no per-business round trip).
  const sweptRows = opts.force ? [] : await prisma.processedEvent.findMany({
    where: { source: GRATITUDE_CLAIM_SOURCE, id: { startsWith: `${bucket}:` }, status: 'done' }, select: { id: true },
  });
  const swept = new Set(sweptRows.map((r) => r.id));

  for (const b of businesses) {
    if (!isProvisioningAllowed(b, now, opts.env)) { report.items.push({ business_id: b.id, outcome: 'skipped_billing' }); continue; }
    const claimId = `${bucket}:${b.id}`;
    if (swept.has(claimId)) continue;
    if (inQuietHours(now, b.timezone)) { report.items.push({ business_id: b.id, outcome: 'skipped_quiet_hours' }); continue; }
    if (report.processed >= MAX_GRATITUDE_PER_TICK && !dryRun) { report.items.push({ business_id: b.id, outcome: 'deferred_to_next_tick' }); continue; }
    if (dryRun) {
      report.items.push({ business_id: b.id, outcome: 'would_sweep', detail: { candidates: await deps.countGratitudeCandidates(b.id) } });
      continue;
    }
    try {
      const run = await withLease(`job:gratitude:${b.id}`, GRATITUDE_LEASE_MS, async (_lease, signal) => {
        // Manual runs do not take (or consume) the hourly claim: the sweep itself never double-texts.
        if (!opts.force && !(await claimEvent(GRATITUDE_CLAIM_SOURCE, claimId, GRATITUDE_LEASE_MS))) return { outcome: 'already_claimed' } as const;
        try {
          assertLease(signal, 'gratitude_sweep'); // never start texting without the lease
          const result = await deps.sweepGratitude(b.id, signal);
          // Lease lost mid-sweep: the sweep stopped itself; give the hour back so the next tick finishes the rest.
          if (signal.aborted) throw new JobLeaseLostError('gratitude_sweep');
          if (!opts.force) await completeEvent(GRATITUDE_CLAIM_SOURCE, claimId);
          return { outcome: 'swept', detail: result } as const;
        } catch (err) {
          if (!opts.force) await releaseEvent(GRATITUDE_CLAIM_SOURCE, claimId);
          throw err;
        }
      }, { renewEveryMs: opts.leaseRenewMs });
      if (!run.acquired) { report.items.push({ business_id: b.id, outcome: 'busy' }); continue; }
      report.items.push({ business_id: b.id, outcome: run.value.outcome, ...('detail' in run.value ? { detail: run.value.detail } : {}) });
      if (run.value.outcome === 'swept') report.processed++;
    } catch (err) {
      report.errors++;
      report.items.push({ business_id: b.id, outcome: err instanceof JobLeaseLostError ? 'lease_lost' : 'error', detail: { error: errMsg(err) } });
      log.error('gratitude.failed', { business: b.id, err });
    }
  }
  if (report.processed > 0) await markRun('gratitude_sweep', now);
  await auditRun(report);
  return report;
}

// ---- cleanup ----------------------------------------------------------------------------------

/** What the cleanup job would delete right now (read-only counts). */
export async function previewCleanup(now: Date = new Date()): Promise<Record<string, number>> {
  const [sessions, tokens, events, buckets] = await Promise.all([
    prisma.userSession.count({ where: { expiresAt: { lt: now } } }),
    prisma.emailToken.count({ where: { expiresAt: { lt: new Date(now.getTime() - EMAIL_TOKEN_GRACE_MS) } } }),
    prisma.processedEvent.count({ where: { createdAt: { lt: new Date(now.getTime() - PROCESSED_EVENTS_RETENTION_MS) } } }),
    prisma.rateLimitBucket.count({ where: { windowStart: { lt: new Date(now.getTime() - CLEANUP_HORIZON_MS) } } }),
  ]);
  return { sessions, email_tokens: tokens, processed_events: events, rate_limit_buckets: buckets };
}

export async function runCleanup(opts: RunOptions = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const report: JobReport = { job: 'cleanup', dry_run: dryRun, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  if (dryRun) {
    report.counts = await previewCleanup(now);
    report.items.push({ outcome: 'would_delete' });
    return report;
  }
  try {
    const run = await withLease('job:cleanup', CLEANUP_LEASE_MS, async () => ({
      sessions: await deleteExpiredSessions(now),
      email_tokens: await deleteExpiredEmailTokens(now),
      processed_events: await cleanupProcessedEvents(now, true),
      rate_limit_buckets: await cleanupRateLimitBuckets(now),
    }));
    if (!run.acquired) { report.items.push({ outcome: 'busy' }); return report; }
    report.counts = run.value;
    report.processed = 1;
    report.items.push({ outcome: 'cleaned', detail: run.value });
    await markRun('cleanup', now);
    if (Object.values(run.value).some((n) => n > 0)) await auditRun(report);
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: errMsg(err) } });
    log.error('cleanup.failed', { err });
  }
  return report;
}

// ---- retention (the existing job, now driven by the same runner) --------------------------------

export async function runRetentionJob(opts: RunOptions = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const report: JobReport = { job: 'retention', dry_run: dryRun, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  try {
    const res = await runRetentionNow(dryRun);
    if (!res.acquired) { report.items.push({ outcome: 'busy' }); return report; }
    report.counts = res.counts as unknown as Record<string, number>;
    report.items.push({ outcome: dryRun ? 'would_purge' : 'purged' });
    if (!dryRun) { report.processed = 1; await markRun('retention', now); await auditRun(report); }
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: errMsg(err) } });
    log.error('retention.failed', { err });
  }
  return report;
}

// ---- dispatch, tick, runner -------------------------------------------------------------------

/** Run one job by name now (admin endpoint and tests). */
export function runJob(job: JobName, opts: RunOptions = {}): Promise<JobReport> {
  switch (job) {
    case 'daily_briefing': return runDailyBriefings(opts);
    case 'gratitude_sweep': return runGratitudeJob(opts);
    case 'cleanup': return runCleanup(opts);
    case 'retention': return runRetentionJob(opts);
  }
}

/** Which jobs this instance's configuration turns on. */
export function enabledJobs(env: NodeJS.ProcessEnv = process.env): JobName[] {
  const s = jobsSetting(env);
  const retention = retentionJobEnabled(env.RETENTION_JOB);
  if (s.enabled) return JOB_NAMES.filter((j) => j !== 'retention' || retention);
  // JOBS unset outside production: the retention job keeps working on its own, as it always did. JOBS=off turns everything off.
  return !s.explicit && retention ? ['retention'] : [];
}

/** One scheduler pass: the due jobs, in order. Never throws. */
export async function runJobTick(opts: { now?: Date; env?: NodeJS.ProcessEnv; jobs?: JobName[]; deps?: Partial<JobDeps> } = {}): Promise<JobReport[]> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const jobs = opts.jobs ?? enabledJobs(env);
  const reports: JobReport[] = [];
  for (const job of jobs) {
    try {
      if (job === 'cleanup') {
        const last = await lastRunAt('cleanup');
        if (last && now.getTime() - last.getTime() < CLEANUP_EVERY_MS) continue;
      } else if (job === 'retention') {
        const last = await lastRunAt('retention');
        if (last && now.getTime() - last.getTime() < RETENTION_EVERY_MS) continue;
      }
      reports.push(await runJob(job, { now, deps: opts.deps, env }));
    } catch (err) {
      log.error('tick.job_failed', { job, err });
    }
  }
  return reports;
}

// ---- admin view -------------------------------------------------------------------------------

export interface JobStatus {
  name: JobName;
  description: string;
  schedule: string;
  /** Turned on by THIS instance's environment (JOBS / RETENTION_JOB). */
  enabled: boolean;
  last_run_at: string | null;
  /** The newest recorded outcome (counts, errors), from the audit trail. */
  last_result: Record<string, unknown> | null;
  /** Earliest moment the job is next due (null when disabled or nothing is eligible). */
  next_due_at: string | null;
  note?: string;
}

export async function jobsStatus(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{
  runner: { jobs_setting: 'on' | 'off'; explicit: boolean; tick_seconds: number; enabled_jobs: JobName[] };
  jobs: JobStatus[];
}> {
  const on = new Set(enabledJobs(env));
  const setting = jobsSetting(env);
  const businesses = (await liveBusinesses()).filter((b) => isProvisioningAllowed(b, now, env));
  const jobs: JobStatus[] = [];
  for (const name of JOB_NAMES) {
    const last = await lastRunAt(name);
    const audit = await prisma.auditEvent.findFirst({ where: { action: `jobs.${name}` }, orderBy: { at: 'desc' }, select: { at: true, meta: true } });
    let next: Date | null = null;
    let note: string | undefined;
    if (name === 'daily_briefing') {
      const ids = businesses.map((b) => `${b.id}:${briefingSlot(now, b.timezone).date}`);
      const done = new Set((await prisma.processedEvent.findMany({ where: { source: BRIEFING_CLAIM_SOURCE, id: { in: ids }, status: 'done' }, select: { id: true } })).map((r) => r.id));
      for (const b of businesses) {
        const slot = briefingSlot(now, b.timezone);
        const t = slot.due && !done.has(`${b.id}:${slot.date}`) ? now : nextBriefingAt(now, b.timezone);
        if (!next || t < next) next = t;
      }
      note = `${businesses.length} live business(es) eligible`;
    } else if (name === 'gratitude_sweep') {
      const bucket = hourBucket(now);
      const swept = new Set((await prisma.processedEvent.findMany({ where: { source: GRATITUDE_CLAIM_SOURCE, id: { startsWith: `${bucket}:` }, status: 'done' }, select: { id: true } })).map((r) => r.id));
      const pending = businesses.some((b) => !swept.has(`${bucket}:${b.id}`));
      next = pending ? now : new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
      note = `${businesses.length} live business(es) eligible`;
    } else if (name === 'cleanup') {
      next = last ? new Date(Math.max(now.getTime(), last.getTime() + CLEANUP_EVERY_MS)) : now;
    } else {
      next = retentionJobEnabled(env.RETENTION_JOB)
        ? (last ? new Date(Math.max(now.getTime(), last.getTime() + RETENTION_EVERY_MS)) : now)
        : null;
      if (!next) note = 'off: set RETENTION_JOB=on after reviewing every business retention window';
    }
    jobs.push({
      name, ...JOB_INFO[name], enabled: on.has(name),
      last_run_at: last?.toISOString() ?? null,
      last_result: audit ? { at: audit.at.toISOString(), ...((audit.meta ?? {}) as Record<string, unknown>) } : null,
      next_due_at: on.has(name) || name !== 'retention' ? next?.toISOString() ?? null : null,
      ...(note ? { note } : {}),
    });
  }
  return {
    runner: { jobs_setting: setting.enabled ? 'on' : 'off', explicit: setting.explicit, tick_seconds: tickSeconds(env), enabled_jobs: [...on] },
    jobs,
  };
}

// ---- the process-level runner -----------------------------------------------------------------

let started = false;
let ticking = false;

/** Start the interval runner once per process. Returns false when nothing is enabled here. */
export function startJobRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  if (started) return true;
  const jobs = enabledJobs(env);
  if (!retentionJobEnabled(env.RETENTION_JOB)) {
    // Unchanged: while the purge is off, boot logs what it WOULD delete.
    const t = setTimeout(() => { void logRetentionPreview(); }, 15_000);
    t.unref?.();
    log.warn('retention.off_by_default', { hint: 'set RETENTION_JOB=on to delete data past each business\'s retention window; counts that would be purged are logged shortly after boot' });
  }
  if (jobs.length === 0) {
    log.info('disabled', { JOBS: jobsSetting(env).explicit ? 'off' : 'unset (off outside production)', note: 'set JOBS=on to run the daily briefing, gratitude sweep and cleanup' });
    started = true;
    return false;
  }
  started = true;
  const every = tickSeconds(env) * 1000;
  const tick = async () => {
    if (ticking) return; // a slow pass never overlaps the next one in this process (other processes are fenced by leases)
    ticking = true;
    try { await runJobTick({ env }); } catch (err) { log.error('tick_failed', { err }); } finally { ticking = false; }
  };
  const first = setTimeout(() => { void tick(); }, FIRST_TICK_DELAY_MS);
  first.unref?.();
  const timer = setInterval(() => { void tick(); }, every);
  timer.unref?.();
  log.info('scheduled', { jobs, tick_seconds: every / 1000 });
  return true;
}
