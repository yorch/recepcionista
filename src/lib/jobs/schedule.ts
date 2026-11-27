/**
 * Pure scheduling helpers for the job runner (no I/O, injectable clock: every function takes `now`).
 * All "what day is it / is it 6 PM" questions are answered in the BUSINESS time zone, never the process zone, so DST
 * transitions and zones far from the server behave.
 */
import { configEnv } from '@/lib/config';
import { isQuietHour } from '@/lib/messaging/policy';
import { addDaysToDateKey, localDateKey, tzOf, zonedTimeToUtc } from '@/lib/time';

/** Local wall-clock hour the end-of-day briefing is generated. */
export const BRIEFING_HOUR = 18;
export const BRIEFING_TIME = `${BRIEFING_HOUR}:00`;
const timeOf = (hour: number | undefined): string => (hour === undefined ? BRIEFING_TIME : `${Math.min(23, Math.max(0, Math.trunc(hour)))}:00`);

export const DEFAULT_TICK_SECONDS = 60;
export const MIN_TICK_SECONDS = 5;
export const MAX_TICK_SECONDS = 3600;

export const JOB_NAMES = ['daily_briefing', 'gratitude_sweep', 'cleanup', 'retention', 'recording_deletions', 'reconcile', 'usage_warnings', 'google_calendar', 'tenant_release', 'grandfather'] as const;
export type JobName = (typeof JOB_NAMES)[number];
export const isJobName = (v: unknown): v is JobName => typeof v === 'string' && (JOB_NAMES as readonly string[]).includes(v);

const truthy = new Set(['on', 'true', '1', 'yes']);
const falsy = new Set(['off', 'false', '0', 'no']);

/**
 * JOBS=on|off. Unset (or anything else) => ON in production, OFF in development and test. Returns whether the
 * runner is configured explicitly (`explicit`) so an unset dev run can still honour RETENTION_JOB=on on its own.
 */
export function jobsSetting(env: NodeJS.ProcessEnv = configEnv()): { enabled: boolean; explicit: boolean } {
  const v = (env.JOBS ?? '').trim().toLowerCase();
  if (truthy.has(v)) return { enabled: true, explicit: true };
  if (falsy.has(v)) return { enabled: false, explicit: true };
  return { enabled: env.NODE_ENV === 'production', explicit: false };
}

/** JOBS_TICK_SECONDS (default 60), clamped to [5, 3600]; garbage falls back to the default. */
export function tickSeconds(env: NodeJS.ProcessEnv = configEnv()): number {
  const raw = (env.JOBS_TICK_SECONDS ?? '').trim();
  if (!raw) return DEFAULT_TICK_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TICK_SECONDS;
  return Math.min(MAX_TICK_SECONDS, Math.max(MIN_TICK_SECONDS, Math.floor(n)));
}

export interface BriefingSlot {
  /** The business-local calendar day (YYYY-MM-DD) the briefing is FOR. */
  date: string;
  /** The instant that day's 18:00 happens in the business zone. */
  scheduled_at: Date;
  /** True from 18:00 local until local midnight (a missed run is caught up the same evening, never the next day). */
  due: boolean;
}

/** `hour`: the business's effective briefing hour (tenant override, `jobs.briefing_hour`); 18 when absent. */
export function briefingSlot(now: Date, timezone: string | null | undefined, hour?: number): BriefingSlot {
  const tz = tzOf(timezone);
  const date = localDateKey(now, tz);
  const scheduled = zonedTimeToUtc(date, timeOf(hour), tz);
  return { date, scheduled_at: scheduled, due: now.getTime() >= scheduled.getTime() };
}

/** The next 18:00 local instant strictly after `now` that has not passed (today's if still ahead, else tomorrow's). */
export function nextBriefingAt(now: Date, timezone: string | null | undefined, hour?: number): Date {
  const tz = tzOf(timezone);
  const today = briefingSlot(now, tz, hour);
  if (!today.due) return today.scheduled_at;
  return zonedTimeToUtc(addDaysToDateKey(today.date, 1), timeOf(hour), tz);
}

/** Texts to the owner (briefing-ready notice) respect the same 9pm-8am quiet window as every other text. */
export const inQuietHours = (now: Date, timezone: string | null | undefined, window?: { start: number; end: number }): boolean => isQuietHour(now, tzOf(timezone), window);

/** Hour bucket used to claim "this business was swept this hour" (UTC, so two instances always agree). */
export const hourBucket = (now: Date): string => now.toISOString().slice(0, 13); // 2027-03-14T18
