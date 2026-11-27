/**
 * Background job runner. Started once per Node process from instrumentation.ts (never during `next build`).
 *
 * Jobs
 *  - daily_briefing  per business, at 18:00 in the BUSINESS time zone (catch-up until local midnight): generate the
 *                    end-of-day briefing once per local day and text the owner a link (verified owner phone, not in quiet
 *                    hours, within the SMS cap). Only live businesses whose billing allows service (isProvisioningAllowed).
 *  - gratitude_sweep hourly, per live business: the existing runGratitudeSweep (consent, opt-out, quiet-hours and cap rules
 *                    are enforced inside it, unchanged). A business in quiet hours is skipped, not swept.
 *  - cleanup         hourly: expired sessions, expired email tokens, old processed_events claims, stale rate-limit buckets, briefing audio older than
 *                    BRIEFING_AUDIO_KEEP_DAYS (default 30; the briefing text stays).
 *  - tenant_release  daily when TENANT_RELEASE_JOB=report|on: canceled/unpaid tenants' heads-up mail + release (jobs/tenants.ts). DRY RUN unless =on.
 *  - grandfather     manual only (admin): comp existing vetted tenants (jobs/tenants.ts). DRY RUN unless TENANT_RELEASE_JOB=on.
 *  - retention       daily PII purge. OFF unless RETENTION_JOB=on (unchanged semantics; see retention-job.ts).
 *  - recording_deletions  every tick: delete the provider-side voicemail recordings queued by a purge / erasure (retries with backoff,
 *                    a 404 counts as deleted, an alert fires when one keeps failing). Runs even while RETENTION_JOB is off (erasure
 *                    requests queue recordings too).
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
import { configEnv } from '@/lib/config';
import {
  claimEvent, cleanupProcessedEvents, completeEvent, deleteExpiredEmailTokens, deleteExpiredSessions, deleteExpiredWebauthnChallenges, WEBAUTHN_CHALLENGE_GRACE_MS, EMAIL_TOKEN_GRACE_MS,
  briefingAudioKeepDays, getBusiness, isProvisioningAllowed, pruneBriefingAudio, listLiveBusinessesForJobs, prisma, PROCESSED_EVENTS_RETENTION_MS, recordAudit, releaseEvent,
  checkSmsAllowed, recordingDeletionStatus, withLease,
} from '@/lib/db';
import { appBaseUrl } from '@/lib/email/templates';
import { withJobRun, type JobTrigger } from '@/lib/admin/job-runs';
import { cleanupConsoleTables } from '@/lib/admin/cleanup';
import { generateBriefing } from '@/lib/briefing';
import { findGratitudeCandidates, runGratitudeSweep } from '@/lib/gratitude';
import { logger } from '@/lib/log';
import { ownerAlertStatus } from '@/lib/messaging/owner';
import { smsSegments } from '@/lib/messaging/policy';
import { CLEANUP_HORIZON_MS, cleanupRateLimitBuckets } from '@/lib/ratelimit';
import { retentionJobEnabled, logRetentionPreview, runRetentionNow } from '@/lib/retention-job';
import { alertOwner } from '@/lib/voice/owner-alert';
import { makeT } from '@/lib/i18n';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import { runReconcileJob, runUsageWarningsJob } from './reconcile';
import { POLL_EVERY_MS as GOOGLE_POLL_EVERY_MS, runGoogleCalendarWork } from './calendar';
import { drainRecordingDeletions } from '@/lib/voice/recording-deletion';
import { runGrandfatherJob, runTenantReleaseJob, tenantReleaseSetting } from './tenants';
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
export const USAGE_WARNINGS_EVERY_MS = 10 * 60_000;
export const TENANT_RELEASE_EVERY_MS = 24 * 60 * 60_000;
const FIRST_TICK_DELAY_MS = 20_000;

const STATE_SOURCE = 'job-state';
export const BRIEFING_CLAIM_SOURCE = 'daily-briefing';
export const GRATITUDE_CLAIM_SOURCE = 'gratitude-sweep';

export const JOB_INFO: Record<JobName, { description: string; schedule: string }> = {
  daily_briefing: { description: 'End-of-day briefing, generated once per local day per live business; owner is texted a link.', schedule: '18:00 in each business time zone' },
  gratitude_sweep: { description: 'Day-after thank-you / review texts for completed jobs (consent, opt-out, quiet-hours and cap rules enforced).', schedule: 'hourly' },
  cleanup: { description: 'Delete expired sessions, expired email tokens, old processed events and stale rate-limit buckets.', schedule: 'hourly' },
  retention: { description: 'Delete customer data past each business retention window (OFF unless RETENTION_JOB=on).', schedule: 'daily' },
  recording_deletions: { description: 'Delete the provider-side voicemail recordings queued by retention / erasure (retries with backoff; alerts when one keeps failing).', schedule: 'every tick' },
  reconcile: { description: 'Add the AI minutes of calls whose post-call webhook never arrived (fetched from ElevenLabs; once, shared with the webhook; backs off, gives up with an audit row). Also re-syncs voice agents whose last sync failed (e.g. after a business-type change).', schedule: 'every tick' },
  usage_warnings: { description: 'Safety net for the 80% / 100% cap warnings (email + text, once per kind per period). One instance at a time (lease).', schedule: 'every 10 minutes' },
  google_calendar: { description: 'Google Calendar: fallback poll (15 min), push-channel renewal, retry/backoff, push reconcile, privacy sweep.', schedule: 'every tick (per connection every 15 min)' },
  tenant_release: { description: 'Canceled / unpaid tenants: heads-up e-mail, then release of the Twilio number, ElevenLabs agent and line after the grace period. DRY RUN unless TENANT_RELEASE_JOB=on; every run stores a report (audit jobs.tenant_release_report).', schedule: 'daily when TENANT_RELEASE_JOB is report or on; otherwise manual' },
  grandfather: { description: 'Comp existing vetted tenants created before a cutoff when plans start being enforced. Manual only; dry run unless TENANT_RELEASE_JOB=on.', schedule: 'manual only' },
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
  /** Admin jobs only (`grandfather`): ISO cutoff instant, the businesses created before it are considered. */
  before?: string;
  /** Restrict to one business (briefing / gratitude / tenant_release). */
  businessId?: string;
  dryRun?: boolean;
  /** Manual runs only: ignore the schedule gate (18:00 / hour-due) but keep every safety gate (billing, idempotency). */
  force?: boolean;
  deps?: Partial<JobDeps>;
  env?: NodeJS.ProcessEnv;
  /** Test seam: how often the per-business job lease is renewed (default ttl/3). */
  leaseRenewMs?: number;
  /** History (job_runs): who started the run ('system' for the scheduler, a user id, 'admin_token') and how. Default: system / schedule. */
  actor?: string;
  trigger?: JobTrigger;
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
    const body = makeT(await ownerLocaleFor(business))('alert.briefing', { date: briefing.date, url: `${appBaseUrl()}/dashboard/briefings` });
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
  const [sessions, tokens, events, buckets, challenges, audio] = await Promise.all([
    prisma.userSession.count({ where: { expiresAt: { lt: now } } }),
    prisma.emailToken.count({ where: { expiresAt: { lt: new Date(now.getTime() - EMAIL_TOKEN_GRACE_MS) } } }),
    prisma.processedEvent.count({ where: { createdAt: { lt: new Date(now.getTime() - PROCESSED_EVENTS_RETENTION_MS) } } }),
    prisma.rateLimitBucket.count({ where: { windowStart: { lt: new Date(now.getTime() - CLEANUP_HORIZON_MS) } } }),
    prisma.webauthnChallenge.count({ where: { expiresAt: { lt: new Date(now.getTime() - WEBAUTHN_CHALLENGE_GRACE_MS) } } }),
    prisma.briefingAudio.count({ where: { createdAt: { lt: new Date(now.getTime() - briefingAudioKeepDays() * 86_400_000) } } }),
  ]);
  return { sessions, email_tokens: tokens, processed_events: events, rate_limit_buckets: buckets, webauthn_challenges: challenges, briefing_audio: audio };
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
      ...(await cleanupConsoleTables(now)), // job_runs history, instance heartbeats, previous secret envelopes (7 days), expired support grants
      rate_limit_buckets: await cleanupRateLimitBuckets(now),
      webauthn_challenges: await deleteExpiredWebauthnChallenges(now), // expired passkey challenges (kept a day for forensics); no longer a random 2% side effect of issuing one
      briefing_audio: (await pruneBriefingAudio({ now })).removed, // stored briefing clips older than BRIEFING_AUDIO_KEEP_DAYS (default 30); the briefing text stays
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

// ---- provider-side recording deletion (the queue written by retention / erasure) -----------------

export async function runRecordingDeletions(opts: RunOptions & { fetchImpl?: typeof fetch } = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const report: JobReport = { job: 'recording_deletions', dry_run: dryRun, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  try {
    if (dryRun) {
      const due = await prisma.pendingRecordingDeletion.count({ where: { nextAttemptAt: { lte: now } } });
      report.counts = { due };
      report.items.push({ outcome: 'would_delete' });
      return report;
    }
    const res = await drainRecordingDeletions({ now, fetchImpl: opts.fetchImpl, limit: 100 });
    report.processed = res.deleted;
    report.errors = res.failed;
    report.counts = { attempted: res.attempted, deleted: res.deleted, failed: res.failed, alerted: res.alerted, pending: res.pending_total };
    if (res.attempted > 0) report.items.push({ outcome: res.failed > 0 ? 'partial' : 'deleted', detail: report.counts });
    if (res.attempted > 0) { await markRun('recording_deletions', now); await auditRun(report); }
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: errMsg(err) } });
    log.error('recording_deletions.failed', { err });
  }
  return report;
}

// ---- Google Calendar (logic in ./calendar) ------------------------------------------------------

export async function runGoogleCalendarJob(opts: RunOptions = {}): Promise<JobReport> {
  const now = opts.now ?? new Date();
  const report: JobReport = { job: 'google_calendar', dry_run: opts.dryRun === true, at: now.toISOString(), processed: 0, errors: 0, items: [] };
  if (opts.dryRun) return report;
  try {
    const r = await runGoogleCalendarWork({ now, force: opts.force });
    report.processed = r.processed; report.errors = r.errors; report.items = r.items; report.counts = r.counts;
    if (r.errors > 0) await auditRun(report);
  } catch (err) {
    report.errors++;
    report.items.push({ outcome: 'error', detail: { error: err instanceof Error ? err.message : String(err) } });
    log.error('google_calendar.failed', { err });
  }
  return report;
}

// ---- dispatch, tick, runner -------------------------------------------------------------------

/** Run one job by name now (admin endpoint, the scheduler and tests). EVERY run is recorded in job_runs (dry runs and runs without work too). */
export function runJob(job: JobName, opts: RunOptions = {}): Promise<JobReport> {
  return withJobRun(job, { actor: opts.actor, trigger: opts.trigger ?? (opts.force ? 'manual' : 'schedule'), dryRun: opts.dryRun === true }, () => runJobUnrecorded(job, opts));
}

function runJobUnrecorded(job: JobName, opts: RunOptions): Promise<JobReport> {
  switch (job) {
    case 'daily_briefing': return runDailyBriefings(opts);
    case 'gratitude_sweep': return runGratitudeJob(opts);
    case 'cleanup': return runCleanup(opts);
    case 'retention': return runRetentionJob(opts);
    case 'recording_deletions': return runRecordingDeletions(opts);
    case 'reconcile': return runReconcileJob({ now: opts.now, dryRun: opts.dryRun, env: opts.env }) as Promise<JobReport>;
    case 'usage_warnings': return runUsageWarningsJob({ now: opts.now, dryRun: opts.dryRun, businessId: opts.businessId }) as Promise<JobReport>;
    case 'google_calendar': return runGoogleCalendarJob(opts);
    case 'tenant_release': return runTenantReleaseJob(opts);
    case 'grandfather': return runGrandfatherJob(opts);
  }
}

/** Which jobs this instance's configuration turns on. */
export function enabledJobs(env: NodeJS.ProcessEnv = configEnv()): JobName[] {
  const s = jobsSetting(env);
  const retention = retentionJobEnabled(env.RETENTION_JOB);
  const release = tenantReleaseSetting(env) !== 'off'; // `report` (dry-run report) or `on` (acts): see jobs/tenants.ts
  if (s.enabled) return JOB_NAMES.filter((j) => (j !== 'retention' || retention) && (j !== 'tenant_release' || release) && j !== 'grandfather');
  // JOBS unset outside production: the retention job keeps working on its own, as it always did. JOBS=off turns everything off.
  return !s.explicit && retention ? ['retention', 'recording_deletions'] : [];
}

/** One scheduler pass: the due jobs, in order. Never throws. */
export async function runJobTick(opts: { now?: Date; env?: NodeJS.ProcessEnv; jobs?: JobName[]; deps?: Partial<JobDeps> } = {}): Promise<JobReport[]> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? configEnv();
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
      } else if (job === 'tenant_release') {
        const last = await lastRunAt('tenant_release');
        if (last && now.getTime() - last.getTime() < TENANT_RELEASE_EVERY_MS) continue;
      } else if (job === 'usage_warnings') {
        // A safety net (the inline trigger sends the warnings): 3 queries per live business, so not every 60 s tick.
        const last = await lastRunAt('usage_warnings');
        if (last && now.getTime() - last.getTime() < USAGE_WARNINGS_EVERY_MS) continue;
      }
      // tenant_release on the schedule: a REAL run only with TENANT_RELEASE_JOB=on, otherwise the dry-run report (runTenantReleaseJob enforces it).
      reports.push(await runJob(job, { now, deps: opts.deps, env, ...(job === 'tenant_release' ? { dryRun: tenantReleaseSetting(env) !== 'on' } : {}) }));
      if (job === 'usage_warnings') await markRun('usage_warnings', now);
      if (job === 'tenant_release') await markRun('tenant_release', now);
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

export async function jobsStatus(now: Date = new Date(), env: NodeJS.ProcessEnv = configEnv()): Promise<{
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
    } else if (name === 'recording_deletions') {
      const status = await recordingDeletionStatus();
      next = now;
      note = `${status.pending} recording(s) queued for provider-side deletion${status.stuck > 0 ? `, ${status.stuck} NOT draining (alerted): check the runbook` : ''}`;
    } else if (name === 'google_calendar') {
      next = now;
      note = `fallback poll every ${GOOGLE_POLL_EVERY_MS / 60_000} min per connection`;
    } else if (name === 'usage_warnings') {
      next = last ? new Date(Math.max(now.getTime(), last.getTime() + USAGE_WARNINGS_EVERY_MS)) : now;
    } else if (name === 'reconcile') {
      next = now;
    } else if (name === 'tenant_release') {
      const mode = tenantReleaseSetting(env);
      next = mode === 'off' ? null : last ? new Date(Math.max(now.getTime(), last.getTime() + TENANT_RELEASE_EVERY_MS)) : now;
      note = mode === 'on' ? 'ACTING: sends heads-up mails and releases tenants whose grace period is over' : mode === 'report' ? 'dry-run report only (TENANT_RELEASE_JOB=report)' : 'off: manual dry runs only; set TENANT_RELEASE_JOB=report or on';
    } else if (name === 'grandfather') {
      next = null;
      note = 'manual only (needs a cutoff); a real run also needs TENANT_RELEASE_JOB=on';
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

// ---- the process-level runner -----------------------------------------------------------------------------------------------
//
// The runner ALWAYS starts (once per process) and decides on EVERY tick, from the live configuration, which jobs are enabled and how often to
// tick: a console change to JOBS / RETENTION_JOB / TENANT_RELEASE_JOB / JOBS_TICK_SECONDS takes effect on the next pass without a restart.
// It never holds an env object: `env` is only passed through when a caller (a test) injects one; otherwise `configEnv()` is read per use.

let started = false;
let ticking = false;
let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let armedSeconds = 0;
let lastSignature = '';
/** Only a test injects an env; production passes nothing and every pass reads `configEnv()` afresh. */
let injectedEnv: NodeJS.ProcessEnv | undefined;

const runnerEnv = (): NodeJS.ProcessEnv => injectedEnv ?? configEnv();

function armInterval(seconds: number): void {
  if (timer) clearInterval(timer);
  armedSeconds = seconds;
  timer = setInterval(() => { void runnerTick(); }, seconds * 1000);
  timer.unref?.();
}

function announce(jobs: JobName[], cur: NodeJS.ProcessEnv): void {
  if (jobs.length === 0) log.info('disabled', { JOBS: jobsSetting(cur).explicit ? 'off' : 'unset (off outside production)', note: 'set JOBS=on to run the daily briefing, gratitude sweep and cleanup' });
  else log.info('scheduled', { jobs, tick_seconds: tickSeconds(cur) });
}

/**
 * One pass of the process-level runner: re-read the configuration, re-arm the interval when the tick period changed, announce a change of
 * the enabled set, run the enabled jobs. Exported for tests; the interval calls it.
 */
export async function runnerTick(): Promise<void> {
  if (ticking) return; // a slow pass never overlaps the next one in this process (other processes are fenced by leases)
  ticking = true;
  try {
    const cur = runnerEnv();
    const secs = tickSeconds(cur);
    if (secs !== armedSeconds && timer) { log.info('rearmed', { tick_seconds: secs, was: armedSeconds }); armInterval(secs); }
    const jobs = enabledJobs(cur);
    const signature = jobs.join(',');
    if (signature !== lastSignature) { announce(jobs, cur); lastSignature = signature; }
    if (jobs.length > 0) await runJobTick({ ...(injectedEnv ? { env: injectedEnv } : {}), jobs });
  } catch (err) {
    log.error('tick_failed', { err });
  } finally {
    ticking = false;
  }
}

/**
 * Start the interval runner once per process. Always schedules the interval (unref'd); a tick with nothing enabled is a no-op.
 * Returns whether any job is enabled right now (informational: it can change later).
 */
export function startJobRunner(env?: NodeJS.ProcessEnv): boolean {
  if (started) return enabledJobs(runnerEnv()).length > 0;
  started = true;
  injectedEnv = env;
  const first = runnerEnv();
  if (!retentionJobEnabled(first.RETENTION_JOB)) {
    // Unchanged: while the purge is off, boot logs what it WOULD delete.
    const t = setTimeout(() => { void logRetentionPreview(); }, 15_000);
    t.unref?.();
    log.warn('retention.off_by_default', { hint: 'set RETENTION_JOB=on to delete data past each business\'s retention window; counts that would be purged are logged shortly after boot' });
  }
  const initial = enabledJobs(first);
  lastSignature = initial.join(',');
  announce(initial, first);
  firstTimer = setTimeout(() => { void runnerTick(); }, FIRST_TICK_DELAY_MS);
  firstTimer.unref?.();
  armInterval(tickSeconds(first));
  return initial.length > 0;
}

/** Stop the runner (tests, graceful shutdown). A later `startJobRunner()` starts it again. */
export function stopJobRunner(): void {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null; firstTimer = null; started = false; ticking = false; armedSeconds = 0; lastSignature = ''; injectedEnv = undefined;
}

/** The tick period the runner is armed with (0 = not started). Exposed for tests and the admin diagnostics. */
export const armedTickSeconds = (): number => armedSeconds;
