/**
 * Plan usage metering and caps. Node runtime only.
 *
 * - Usage is counted per business per calendar month IN THE BUSINESS'S TIMEZONE (`usage_counters.period_start`
 *   = first day of that month). All period math happens in SQL (one source of truth) and every increment is a
 *   single atomic upsert, so concurrent sends cannot lose counts.
 * - Caps: per-business override columns (these always win), else, while billing_status='trialing', the lower trial caps
 *   TRIAL_SMS_CAP (default 50) / TRIAL_CALL_MINUTES_CAP (default 30) (never above the plan cap), else env
 *   PLAN_SMS_CAP (default 500) / PLAN_CALL_MINUTES_CAP (default 300).
 * - SMS usage is counted in real SMS SEGMENTS (GSM-7 160/153, UCS-2 70/67), not in sends: a 3-segment text is 3 units, and a text
 *   that would push usage past the cap is blocked (see checkSmsAllowed `units`).
 * - Plan gate: in production billing is enforced unless BILLING_ENFORCED=false is set explicitly (fail closed); in
 *   development/test it is enforced only with BILLING_ENFORCED=true. When enforced, billing_status 'trialing'/'active' is allowed,
 *   'past_due' is allowed for BILLING_PAST_DUE_GRACE_DAYS (default 5) after it became past due, everything else is not.
 */
import crypto from 'node:crypto';
import { prisma } from './client';
import type { Business } from '@/lib/types';

export const DEFAULT_SMS_CAP = 500;
export const DEFAULT_CALL_MINUTES_CAP = 300;
export const DEFAULT_TRIAL_SMS_CAP = 50;
export const DEFAULT_TRIAL_CALL_MINUTES_CAP = 30;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 5;

const nonNegInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const isProduction = (env: NodeJS.ProcessEnv): boolean => env.NODE_ENV === 'production';

/**
 * FAIL CLOSED in production: billing is enforced unless BILLING_ENFORCED is exactly 'false' (an explicit, loud opt-out;
 * any other value, including a typo, enforces). Outside production (dev/test) it is enforced only when exactly 'true'.
 */
export const billingEnforced = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = (env.BILLING_ENFORCED ?? '').trim();
  if (isProduction(env)) return v !== 'false';
  return v === 'true';
};
export const pastDueGraceDays = (env: NodeJS.ProcessEnv = process.env): number =>
  nonNegInt(env.BILLING_PAST_DUE_GRACE_DAYS, DEFAULT_PAST_DUE_GRACE_DAYS);

type CapSubject = { billing_status?: Business['billing_status'] | string | null };

/**
 * Effective monthly SMS cap, in SEGMENTS: override (when not null) wins; else while trialing min(TRIAL_SMS_CAP, plan cap);
 * else PLAN_SMS_CAP; else 500.
 */
export const smsCapFor = (b: CapSubject & { sms_cap_override?: number | null }, env: NodeJS.ProcessEnv = process.env): number => {
  if (b.sms_cap_override != null) return b.sms_cap_override;
  const plan = nonNegInt(env.PLAN_SMS_CAP, DEFAULT_SMS_CAP);
  return b.billing_status === 'trialing' ? Math.min(plan, nonNegInt(env.TRIAL_SMS_CAP, DEFAULT_TRIAL_SMS_CAP)) : plan;
};

/** Effective monthly call-minutes cap: override wins; else while trialing min(TRIAL_CALL_MINUTES_CAP, plan cap); else PLAN_CALL_MINUTES_CAP; else 300. */
export const callMinutesCapFor = (b: CapSubject & { call_minutes_cap_override?: number | null }, env: NodeJS.ProcessEnv = process.env): number => {
  if (b.call_minutes_cap_override != null) return b.call_minutes_cap_override;
  const plan = nonNegInt(env.PLAN_CALL_MINUTES_CAP, DEFAULT_CALL_MINUTES_CAP);
  return b.billing_status === 'trialing' ? Math.min(plan, nonNegInt(env.TRIAL_CALL_MINUTES_CAP, DEFAULT_TRIAL_CALL_MINUTES_CAP)) : plan;
};

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

/**
 * May this business buy a number / create an agent (provisioning)? In production a business ALWAYS needs a plan,
 * whatever BILLING_ENFORCED says (BILLING_ENFORCED=false only relaxes texts/calls for comped tenants; strangers who
 * signed up never get free paid resources). Outside production: only when enforcement is on.
 */
export function isProvisioningAllowed(
  b: Pick<Business, 'billing_status' | 'past_due_since'>,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !(isProduction(env) || billingEnforced(env)) || billingStateAllows(b, now, env);
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
  /** SMS: SEGMENTS this period. Calls: SECONDS this period. */
  used: number;
  /** SMS: segments. Calls: SECONDS (the minutes cap x 60). */
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

/** Atomically add `n` (default 1) SMS segments to the current period. Null when the business does not exist. */
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

async function decide(businessId: string, kind: 'sms' | 'call', now: Date, units = 1): Promise<AllowResult> {
  const [b, usage] = await Promise.all([billingRow(businessId), getUsage(businessId, now)]);
  if (!b || !usage) return { ok: false, reason: 'no_plan', used: 0, cap: 0 };
  const used = kind === 'sms' ? usage.sms_count : usage.call_seconds;
  const cap = kind === 'sms'
    ? smsCapFor({ sms_cap_override: b.smsCapOverride, billing_status: b.billingStatus })
    : callMinutesCapFor({ call_minutes_cap_override: b.callMinutesCapOverride, billing_status: b.billingStatus }) * 60;
  if (!billingEnforced()) return { ok: true, used, cap };
  const plan = billingStateAllows({ billing_status: b.billingStatus as Business['billing_status'], past_due_since: b.pastDueSince ? b.pastDueSince.toISOString() : null }, now);
  if (!plan) return { ok: false, reason: 'no_plan', used, cap };
  // Calls: blocked once the allowance is used. Texts: blocked when THIS message (`units` segments) would not fit.
  if (kind === 'call' ? used >= cap : used + Math.max(1, units) > cap) return { ok: false, reason: 'cap_reached', used, cap };
  return { ok: true, used, cap };
}

/**
 * May this business send a text of `segments` SMS segments (default 1) this period? Blocks when used + segments would
 * exceed the cap. (Advisory: pair with recordSms(segments) after sending.)
 */
export const checkSmsAllowed = (businessId: string, now: Date = new Date(), segments = 1): Promise<AllowResult> => decide(businessId, 'sms', now, segments);

/** May this business take/make another call this period? `used` and `cap` are in SECONDS. */
export const checkCallAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'call', now);
