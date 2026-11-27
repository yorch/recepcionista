/**
 * Job run history (table job_runs): EVERY run of every job is recorded, scheduled or manual, real or dry-run, with work or without. Node runtime only.
 * Wired once, in `runJob` (src/lib/jobs/index.ts); recording never throws and never changes what the job returns.
 */
import crypto from 'node:crypto';
import { redactSecrets } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/log';

const log = logger('job-runs');

export type JobTrigger = 'schedule' | 'manual' | 'api';
export const JOB_RUN_KEEP_DAYS = 60;

/** The shape of a JobReport this module needs (kept structural: jobs/index.ts imports this file, not the other way round). */
export interface RunReport {
  dry_run: boolean;
  processed: number;
  errors: number;
  counts?: Record<string, number>;
  items?: { outcome: string; detail?: Record<string, unknown> }[];
}

const SKIPPED = new Set(['busy', 'refused_not_enabled', 'disabled', 'not_enabled', 'skipped']);

export function statusOfReport(r: RunReport): 'ok' | 'error' | 'skipped' {
  if (r.errors > 0) return 'error';
  const items = r.items ?? [];
  return items.length > 0 && r.processed === 0 && items.every((i) => SKIPPED.has(i.outcome)) ? 'skipped' : 'ok';
}

export function errorSampleOf(r: RunReport, thrown?: unknown): string | null {
  const raw = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : (r.items ?? []).find((i) => i.outcome === 'error')?.detail?.error;
  return typeof raw === 'string' && raw ? redactSecrets(raw).slice(0, 300) : null;
}

export async function recordJobRun(input: { job: string; startedAt: Date; finishedAt: Date; report?: RunReport; thrown?: unknown; actor?: string; trigger?: JobTrigger; dryRun?: boolean }): Promise<void> {
  try {
    const r = input.report;
    await prisma.jobRun.create({
      data: {
        id: crypto.randomUUID(), job: input.job, startedAt: input.startedAt, finishedAt: input.finishedAt, dryRun: r?.dry_run ?? input.dryRun ?? false,
        status: input.thrown ? 'error' : r ? statusOfReport(r) : 'ok', counts: ((r?.counts ?? {}) as object), processed: r?.processed ?? 0, errors: input.thrown ? Math.max(1, r?.errors ?? 0) : r?.errors ?? 0,
        errorSample: r || input.thrown ? errorSampleOf(r ?? { dry_run: false, processed: 0, errors: 0 }, input.thrown) : null, actor: (input.actor ?? 'system').slice(0, 80), trigger: input.trigger ?? 'schedule',
      },
    });
  } catch (err) {
    log.warn('record_failed', { job: input.job, error: (err as Error).message });
  }
}

/** Run `fn` and record it. The result (or the thrown error) passes through untouched. */
export async function withJobRun<T extends RunReport>(job: string, meta: { actor?: string; trigger?: JobTrigger; dryRun?: boolean }, fn: () => Promise<T>, now: () => Date = () => new Date()): Promise<T> {
  const startedAt = now();
  try {
    const report = await fn();
    await recordJobRun({ job, startedAt, finishedAt: now(), report, ...meta });
    return report;
  } catch (thrown) {
    await recordJobRun({ job, startedAt, finishedAt: now(), thrown, ...meta });
    throw thrown;
  }
}

export interface JobRunView {
  id: string; job: string; started_at: string; finished_at: string | null; duration_ms: number | null; dry_run: boolean; status: string; counts: unknown; processed: number; errors: number;
  error_sample: string | null; actor: string; trigger: string;
}

export async function listJobRuns(opts: { job?: string; dry_run?: boolean; status?: string; trigger?: string; before?: string; limit?: number } = {}): Promise<{ items: JobRunView[]; next_cursor: string | null }> {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before ? new Date(opts.before) : null;
  const rows = await prisma.jobRun.findMany({
    where: {
      ...(opts.job ? { job: opts.job } : {}), ...(opts.dry_run !== undefined ? { dryRun: opts.dry_run } : {}), ...(opts.status ? { status: opts.status } : {}), ...(opts.trigger ? { trigger: opts.trigger } : {}),
      ...(before && !Number.isNaN(before.getTime()) ? { startedAt: { lt: before } } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: take + 1,
  });
  const page = rows.slice(0, take);
  return {
    items: page.map((r) => ({
      id: r.id, job: r.job, started_at: r.startedAt.toISOString(), finished_at: r.finishedAt?.toISOString() ?? null, duration_ms: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      dry_run: r.dryRun, status: r.status, counts: r.counts, processed: r.processed, errors: r.errors, error_sample: r.errorSample, actor: r.actor, trigger: r.trigger,
    })),
    next_cursor: rows.length > take ? page[page.length - 1].startedAt.toISOString() : null,
  };
}

/** Cleanup-job step: drop history older than JOB_RUN_KEEP_DAYS. */
export async function pruneJobRuns(now: Date = new Date()): Promise<number> {
  return (await prisma.jobRun.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - JOB_RUN_KEEP_DAYS * 86_400_000) } } })).count;
}
