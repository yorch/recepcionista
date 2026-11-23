/**
 * Plan usage metering and caps. Node runtime only.
 *
 * - Usage is counted per business per calendar month IN THE BUSINESS'S TIMEZONE (`usage_counters.period_start`
 *   = first day of that month). All period math happens in SQL (one source of truth) and every increment is a
 *   single atomic upsert, so concurrent sends cannot lose counts.
 * - Caps: per-business override columns, else env PLAN_SMS_CAP (default 500) / PLAN_CALL_MINUTES_CAP (default 300).
 * - Plan gate: BILLING_ENFORCED must be exactly 'true' for anything to be refused (demo/legacy tenants and
 *   local development stay unrestricted). When enforced, billing_status 'trialing'/'active' is allowed,
 *   'past_due' is allowed for BILLING_PAST_DUE_GRACE_DAYS (default 5) after it became past due, everything else is not.
 */
import crypto from 'node:crypto';
import { prisma } from './client';
import type { Business } from '@/lib/types';

export const DEFAULT_SMS_CAP = 500;
export const DEFAULT_CALL_MINUTES_CAP = 300;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 5;

const nonNegInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const billingEnforced = (env: NodeJS.ProcessEnv = process.env): boolean => env.BILLING_ENFORCED === 'true';
export const pastDueGraceDays = (env: NodeJS.ProcessEnv = process.env): number =>
  nonNegInt(env.BILLING_PAST_DUE_GRACE_DAYS, DEFAULT_PAST_DUE_GRACE_DAYS);

/** Effective monthly SMS cap: override (when not null) else PLAN_SMS_CAP else 500. */
export const smsCapFor = (b: { sms_cap_override?: number | null }, env: NodeJS.ProcessEnv = process.env): number =>
  b.sms_cap_override ?? nonNegInt(env.PLAN_SMS_CAP, DEFAULT_SMS_CAP);

/** Effective monthly call-minutes cap: override (when not null) else PLAN_CALL_MINUTES_CAP else 300. */
export const callMinutesCapFor = (b: { call_minutes_cap_override?: number | null }, env: NodeJS.ProcessEnv = process.env): number =>
  b.call_minutes_cap_override ?? nonNegInt(env.PLAN_CALL_MINUTES_CAP, DEFAULT_CALL_MINUTES_CAP);

/**
 * Does this business's billing state currently allow service? Pure. NOT subject to BILLING_ENFORCED:
 * use isProvisioningAllowed / checkSmsAllowed / checkCallAllowed for the enforced decision.
 */
export function billingStateAllows(
  b: Pick<Business, 'billing_status' | 'past_due_since'>,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const status = b.billing_status ?? 'none';
  if (status === 'trialing' || status === 'active') return true;
  if (status === 'past_due') {
    if (!b.past_due_since) return false; // fail closed: we cannot tell when the grace period started
    return now.getTime() < new Date(b.past_due_since).getTime() + pastDueGraceDays(env) * 86_400_000;
  }
  return false;
}

/** May this business buy a number / create an agent (provisioning)? Always true unless BILLING_ENFORCED=true. */
export function isProvisioningAllowed(
  b: Pick<Business, 'billing_status' | 'past_due_since'>,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !billingEnforced(env) || billingStateAllows(b, now, env);
}

export interface UsageSummary {
  /** 'YYYY-MM-01' in the business timezone. */
  period_start: string;
  sms_count: number;
  call_seconds: number;
}

export interface AllowResult {
  ok: boolean;
  reason?: 'no_plan' | 'cap_reached';
  /** SMS: messages this period. Calls: SECONDS this period. */
  used: number;
  /** SMS: messages. Calls: SECONDS (the minutes cap x 60). */
  cap: number;
}

function positiveInt(n: number, what: string): number {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a non-negative number`);
  return Math.round(n);
}

type CounterRow = { sms_count: number; call_seconds: number };

async function bump(businessId: string, sms: number, seconds: number, now: Date): Promise<UsageSummary | null> {
  const rows = await prisma.$queryRaw<(CounterRow & { period_start: string })[]>`
    INSERT INTO "usage_counters" ("id", "business_id", "period_start", "sms_count", "call_seconds", "updated_at")
    SELECT ${crypto.randomUUID()}, b."id", date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date,
           ${sms}::int, ${seconds}::int, clock_timestamp()
      FROM "businesses" b WHERE b."id" = ${businessId}
    ON CONFLICT ("business_id", "period_start") DO UPDATE
      SET "sms_count" = "usage_counters"."sms_count" + EXCLUDED."sms_count",
          "call_seconds" = "usage_counters"."call_seconds" + EXCLUDED."call_seconds",
          "updated_at" = EXCLUDED."updated_at"
    RETURNING to_char("period_start", 'YYYY-MM-DD') AS period_start, "sms_count", "call_seconds"`;
  return rows[0] ?? null;
}

/** Atomically add `n` (default 1) sent texts to the current period. Null when the business does not exist. */
export async function recordSms(businessId: string, n = 1, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, positiveInt(n, 'recordSms n'), 0, now);
}

/** Atomically add call time (whole seconds) to the current period. Null when the business does not exist. */
export async function recordCallSeconds(businessId: string, seconds: number, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, 0, positiveInt(seconds, 'recordCallSeconds seconds'), now);
}

/** Usage in the current period (zeros before the first event). Null when the business does not exist. */
export async function getUsage(businessId: string, now: Date = new Date()): Promise<UsageSummary | null> {
  const rows = await prisma.$queryRaw<(CounterRow & { period_start: string })[]>`
    SELECT to_char(date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date, 'YYYY-MM-DD') AS period_start,
           COALESCE(u."sms_count", 0) AS sms_count, COALESCE(u."call_seconds", 0) AS call_seconds
      FROM "businesses" b
      LEFT JOIN "usage_counters" u ON u."business_id" = b."id"
       AND u."period_start" = date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date
     WHERE b."id" = ${businessId}`;
  return rows[0] ?? null;
}

async function billingRow(businessId: string) {
  return prisma.business.findUnique({
    where: { id: businessId },
    select: { billingStatus: true, pastDueSince: true, smsCapOverride: true, callMinutesCapOverride: true },
  });
}

async function decide(businessId: string, kind: 'sms' | 'call', now: Date): Promise<AllowResult> {
  const [b, usage] = await Promise.all([billingRow(businessId), getUsage(businessId, now)]);
  if (!b || !usage) return { ok: false, reason: 'no_plan', used: 0, cap: 0 };
  const used = kind === 'sms' ? usage.sms_count : usage.call_seconds;
  const cap = kind === 'sms' ? smsCapFor({ sms_cap_override: b.smsCapOverride }) : callMinutesCapFor({ call_minutes_cap_override: b.callMinutesCapOverride }) * 60;
  if (!billingEnforced()) return { ok: true, used, cap };
  const plan = billingStateAllows({ billing_status: b.billingStatus as Business['billing_status'], past_due_since: b.pastDueSince ? b.pastDueSince.toISOString() : null }, now);
  if (!plan) return { ok: false, reason: 'no_plan', used, cap };
  if (used >= cap) return { ok: false, reason: 'cap_reached', used, cap };
  return { ok: true, used, cap };
}

/** May this business send another text this period? (Advisory: pair with recordSms after sending.) */
export const checkSmsAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'sms', now);

/** May this business take/make another call this period? `used` and `cap` are in SECONDS. */
export const checkCallAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'call', now);
