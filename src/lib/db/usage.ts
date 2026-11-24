/**
 * Plan usage metering and caps. Node runtime only.
 *
 * - Usage is counted per business per calendar month IN THE BUSINESS'S TIMEZONE (`usage_counters.period_start`
 *   = first day of that month). All period math happens in SQL (one source of truth) and every increment is a
 *   single atomic upsert, so concurrent sends cannot lose counts.
 * - Caps: per-business override columns (these always win), else, while billing_status='trialing', the lower trial caps
 *   TRIAL_SMS_CAP (default 50) / TRIAL_CALL_MINUTES_CAP (default 30) (never above the plan cap), else env
 *   PLAN_SMS_CAP (default 500) / PLAN_CALL_MINUTES_CAP (default 300).
 * - Call time is split in THREE counters so one kind of traffic can never starve another: `call_seconds` = AI conversation seconds (the
 *   only thing the plan's call-minutes cap gates on), `voicemail_seconds` (cap VOICEMAIL_MINUTES_CAP, default 60/month) and
 *   `forward_seconds` (cap FORWARD_MINUTES_CAP, default 600/month; trial: TRIAL_FORWARD_MINUTES_CAP, default 30). Anonymous voicemails
 *   or silent forwarded calls can use up their own counter, never the AI line.
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
export const DEFAULT_VOICEMAIL_MINUTES_CAP = 60;
export const DEFAULT_FORWARD_MINUTES_CAP = 600;
export const DEFAULT_TRIAL_FORWARD_MINUTES_CAP = 30;

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

/** Monthly cap (minutes) of voicemail recordings: VOICEMAIL_MINUTES_CAP (default 60). Separate from the AI minutes. */
export const voicemailMinutesCap = (env: NodeJS.ProcessEnv = process.env): number => nonNegInt(env.VOICEMAIL_MINUTES_CAP, DEFAULT_VOICEMAIL_MINUTES_CAP);

/** Monthly cap (minutes) of forwarded calls: FORWARD_MINUTES_CAP (default 600); while trialing min(that, TRIAL_FORWARD_MINUTES_CAP, default 30). Separate from the AI minutes. */
export const forwardMinutesCapFor = (b: CapSubject, env: NodeJS.ProcessEnv = process.env): number => {
  const plan = nonNegInt(env.FORWARD_MINUTES_CAP, DEFAULT_FORWARD_MINUTES_CAP);
  return b.billing_status === 'trialing' ? Math.min(plan, nonNegInt(env.TRIAL_FORWARD_MINUTES_CAP, DEFAULT_TRIAL_FORWARD_MINUTES_CAP)) : plan;
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
  /** AI conversation seconds ONLY. */
  call_seconds: number;
  /** Voicemail recording seconds (own cap). */
  voicemail_seconds: number;
  /** Bridged seconds of forwarded calls (own cap). */
  forward_seconds: number;
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

type CounterRow = { sms_count: number; call_seconds: number; voicemail_seconds: number; forward_seconds: number };

async function bump(businessId: string, sms: number, seconds: number, now: Date, voicemail = 0, forward = 0): Promise<UsageSummary | null> {
  const rows = await prisma.$queryRaw<(CounterRow & { period_start: string })[]>`
    INSERT INTO "usage_counters" ("id", "business_id", "period_start", "sms_count", "call_seconds", "voicemail_seconds", "forward_seconds", "updated_at")
    SELECT ${crypto.randomUUID()}, b."id", date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date,
           ${sms}::int, ${seconds}::int, ${voicemail}::int, ${forward}::int, clock_timestamp()
      FROM "businesses" b WHERE b."id" = ${businessId}
    ON CONFLICT ("business_id", "period_start") DO UPDATE
      SET "sms_count" = "usage_counters"."sms_count" + EXCLUDED."sms_count",
          "call_seconds" = "usage_counters"."call_seconds" + EXCLUDED."call_seconds",
          "voicemail_seconds" = "usage_counters"."voicemail_seconds" + EXCLUDED."voicemail_seconds",
          "forward_seconds" = "usage_counters"."forward_seconds" + EXCLUDED."forward_seconds",
          "updated_at" = EXCLUDED."updated_at"
    RETURNING to_char("period_start", 'YYYY-MM-DD') AS period_start, "sms_count", "call_seconds", "voicemail_seconds", "forward_seconds"`;
  return rows[0] ?? null;
}

/** Atomically add `n` (default 1) SMS segments to the current period. Null when the business does not exist. */
export async function recordSms(businessId: string, n = 1, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, positiveInt(n, 'recordSms n'), 0, now);
}

/** Atomically add AI call time (whole seconds) to the current period. Null when the business does not exist. */
export async function recordCallSeconds(businessId: string, seconds: number, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, 0, positiveInt(seconds, 'recordCallSeconds seconds'), now);
}

/** Atomically add voicemail recording time (whole seconds). Never touches the AI minutes. */
export async function recordVoicemailSeconds(businessId: string, seconds: number, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, 0, 0, now, positiveInt(seconds, 'recordVoicemailSeconds seconds'), 0);
}

/** Atomically add forwarded (bridged) call time (whole seconds). Never touches the AI minutes. */
export async function recordForwardSeconds(businessId: string, seconds: number, now: Date = new Date()): Promise<UsageSummary | null> {
  return bump(businessId, 0, 0, now, 0, positiveInt(seconds, 'recordForwardSeconds seconds'));
}

/** Usage in the current period (zeros before the first event). Null when the business does not exist. */
export async function getUsage(businessId: string, now: Date = new Date()): Promise<UsageSummary | null> {
  const rows = await prisma.$queryRaw<(CounterRow & { period_start: string })[]>`
    SELECT to_char(date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date, 'YYYY-MM-DD') AS period_start,
           COALESCE(u."sms_count", 0) AS sms_count, COALESCE(u."call_seconds", 0) AS call_seconds,
           COALESCE(u."voicemail_seconds", 0) AS voicemail_seconds, COALESCE(u."forward_seconds", 0) AS forward_seconds
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

type DecideKind = 'sms' | 'call' | 'forward' | 'voicemail';

async function decide(businessId: string, kind: DecideKind, now: Date, units = 1): Promise<AllowResult> {
  const [b, usage] = await Promise.all([billingRow(businessId), getUsage(businessId, now)]);
  if (!b || !usage) return { ok: false, reason: 'no_plan', used: 0, cap: 0 };
  const used = kind === 'sms' ? usage.sms_count : kind === 'forward' ? usage.forward_seconds : kind === 'voicemail' ? usage.voicemail_seconds : usage.call_seconds;
  const cap = kind === 'sms'
    ? smsCapFor({ sms_cap_override: b.smsCapOverride, billing_status: b.billingStatus })
    : kind === 'forward' ? forwardMinutesCapFor({ billing_status: b.billingStatus }) * 60
      : kind === 'voicemail' ? voicemailMinutesCap() * 60
        : callMinutesCapFor({ call_minutes_cap_override: b.callMinutesCapOverride, billing_status: b.billingStatus }) * 60;
  if (!billingEnforced()) return { ok: true, used, cap };
  const plan = billingStateAllows({ billing_status: b.billingStatus as Business['billing_status'], past_due_since: b.pastDueSince ? b.pastDueSince.toISOString() : null }, now);
  if (!plan) return { ok: false, reason: 'no_plan', used, cap };
  // Calls: blocked once the allowance is used. Texts: blocked when THIS message (`units` segments) would not fit.
  if (kind !== 'sms' ? used >= cap : used + Math.max(1, units) > cap) return { ok: false, reason: 'cap_reached', used, cap };
  return { ok: true, used, cap };
}

export interface SmsReservation extends AllowResult {
  /** The period the segments were reserved in ('YYYY-MM-DD'); pass it to releaseSmsReservation so a refund hits the same row. */
  period_start?: string;
}

/** Highest value the cap check can take: used when billing is not enforced (counting only). */
const NO_CAP = 2_147_483_647;

/**
 * ATOMICALLY reserve `segments` SMS segments: one `INSERT .. ON CONFLICT DO UPDATE .. WHERE used + n <= cap RETURNING`, so
 * concurrent sends (parallel dashboard texts, voice tools, several app instances) can never exceed the cap: exactly as many
 * reservations succeed as fit. The reservation IS the metering: after a successful send nothing more is recorded; when the send
 * fails, give it back with `releaseSmsReservation`. Plan gate (no plan / past-due beyond grace) is checked first. When billing
 * is not enforced the segments are counted without a cap.
 */
export async function reserveSms(businessId: string, segments = 1, now: Date = new Date()): Promise<SmsReservation> {
  const n = Math.max(1, positiveInt(segments, 'reserveSms segments'));
  const b = await billingRow(businessId);
  if (!b) return { ok: false, reason: 'no_plan', used: 0, cap: 0 };
  const cap = smsCapFor({ sms_cap_override: b.smsCapOverride, billing_status: b.billingStatus });
  const enforced = billingEnforced();
  if (enforced) {
    const plan = billingStateAllows({ billing_status: b.billingStatus as Business['billing_status'], past_due_since: b.pastDueSince ? b.pastDueSince.toISOString() : null }, now);
    if (!plan) return { ok: false, reason: 'no_plan', used: (await getUsage(businessId, now))?.sms_count ?? 0, cap };
  }
  const limit = enforced ? cap : NO_CAP;
  const rows = await prisma.$queryRaw<{ period_start: string; sms_count: number }[]>`
    INSERT INTO "usage_counters" ("id", "business_id", "period_start", "sms_count", "call_seconds", "updated_at")
    SELECT ${crypto.randomUUID()}, b."id", date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date,
           ${n}::int, 0, clock_timestamp()
      FROM "businesses" b WHERE b."id" = ${businessId} AND ${n}::bigint <= ${limit}::bigint
    ON CONFLICT ("business_id", "period_start") DO UPDATE
      SET "sms_count" = "usage_counters"."sms_count" + EXCLUDED."sms_count", "updated_at" = EXCLUDED."updated_at"
      WHERE "usage_counters"."sms_count"::bigint + EXCLUDED."sms_count"::bigint <= ${limit}::bigint
    RETURNING to_char("period_start", 'YYYY-MM-DD') AS period_start, "sms_count"`;
  if (rows.length === 1) return { ok: true, used: rows[0].sms_count, cap, period_start: rows[0].period_start };
  const usage = await getUsage(businessId, now);
  return { ok: false, reason: usage ? 'cap_reached' : 'no_plan', used: usage?.sms_count ?? 0, cap };
}

/** Give back segments reserved with reserveSms (the provider send failed). Never goes below zero; never throws. */
export async function releaseSmsReservation(businessId: string, segments: number, periodStart: string): Promise<void> {
  try {
    const n = Math.max(1, positiveInt(segments, 'releaseSmsReservation segments'));
    await prisma.$executeRaw`
      UPDATE "usage_counters" SET "sms_count" = GREATEST(0, "sms_count" - ${n}::int), "updated_at" = clock_timestamp()
       WHERE "business_id" = ${businessId} AND "period_start" = ${periodStart}::date`;
  } catch {
    /* the counter stays slightly high (conservative); never turn a failed send into an error */
  }
}

/**
 * May this business send a text of `segments` SMS segments (default 1) this period? Blocks when used + segments would
 * exceed the cap. ADVISORY (a read): senders must use reserveSms, which is atomic; this is for pre-checks that do not send.
 */
export const checkSmsAllowed = (businessId: string, now: Date = new Date(), segments = 1): Promise<AllowResult> => decide(businessId, 'sms', now, segments);

/** May this business take another AI call this period? Gates on AI seconds ONLY. `used` and `cap` are in SECONDS. */
export const checkCallAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'call', now);

/** May this business forward another call this period (its own forwarded-minutes cap, not the AI minutes)? SECONDS. */
export const checkForwardAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'forward', now);

/** May this business take another voicemail this period (its own voicemail-minutes cap, not the AI minutes)? SECONDS. */
export const checkVoicemailAllowed = (businessId: string, now: Date = new Date()): Promise<AllowResult> => decide(businessId, 'voicemail', now);

// ── "80% / 100% of your plan used" warnings ─────────────────────────────────────

/** Which allowance a warning is about: SMS segments, AI call seconds, forwarded-call seconds. */
export type WarnKind = 'sms' | 'ai' | 'forward';
export type WarnLevel = 80 | 100;

const WARN_COLUMN: Record<WarnKind, Record<WarnLevel, string>> = {
  sms: { 80: 'sms_warned_80_at', 100: 'sms_warned_100_at' },
  ai: { 80: 'ai_warned_80_at', 100: 'ai_warned_100_at' },
  forward: { 80: 'forward_warned_80_at', 100: 'forward_warned_100_at' },
};

/**
 * Atomically claim the right to send ONE warning of this kind and level for the current period (business time zone month).
 * True only for the first caller (a single `UPDATE .. WHERE col IS NULL RETURNING`), so concurrent workers / instances send exactly
 * one text per period. False when it was already claimed, when there is no usage row for the period yet, or the business is unknown.
 * A new month is a new counter row, so the warning re-arms by itself. If the send then fails, give the claim back with `unmarkWarned`.
 */
export async function markWarned(businessId: string, kind: WarnKind, level: WarnLevel, now: Date = new Date()): Promise<boolean> {
  const col = WARN_COLUMN[kind]?.[level];
  if (!col) throw new Error('markWarned: invalid kind or level');
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "usage_counters" u SET "${col}" = clock_timestamp()
       FROM "businesses" b
      WHERE u."business_id" = b."id" AND b."id" = $1
        AND u."period_start" = date_trunc('month', timezone(b."timezone", $2::timestamptz))::date
        AND u."${col}" IS NULL
      RETURNING u."id"`, businessId, now);
  return rows.length === 1;
}

/** Release a claim made by markWarned (the warning could not be delivered), so the next pass tries again. */
export async function unmarkWarned(businessId: string, kind: WarnKind, level: WarnLevel, now: Date = new Date()): Promise<void> {
  const col = WARN_COLUMN[kind]?.[level];
  if (!col) throw new Error('unmarkWarned: invalid kind or level');
  await prisma.$executeRawUnsafe(
    `UPDATE "usage_counters" u SET "${col}" = NULL FROM "businesses" b
      WHERE u."business_id" = b."id" AND b."id" = $1
        AND u."period_start" = date_trunc('month', timezone(b."timezone", $2::timestamptz))::date`, businessId, now);
}

export type UsageWarnings = Record<`${WarnKind}_${WarnLevel}`, string | null>;

/** Which warnings were already sent this period (ISO time or null). Null when the business does not exist. */
export async function getUsageWarnings(businessId: string, now: Date = new Date()): Promise<UsageWarnings | null> {
  const rows = await prisma.$queryRaw<{ s80: Date | null; s100: Date | null; a80: Date | null; a100: Date | null; f80: Date | null; f100: Date | null }[]>`
    SELECT u."sms_warned_80_at" AS s80, u."sms_warned_100_at" AS s100, u."ai_warned_80_at" AS a80, u."ai_warned_100_at" AS a100,
           u."forward_warned_80_at" AS f80, u."forward_warned_100_at" AS f100
      FROM "businesses" b
      LEFT JOIN "usage_counters" u ON u."business_id" = b."id"
       AND u."period_start" = date_trunc('month', timezone(b."timezone", ${now}::timestamptz))::date
     WHERE b."id" = ${businessId}`;
  const r = rows[0];
  if (!r) return null;
  const t = (d: Date | null) => (d ? d.toISOString() : null);
  return { sms_80: t(r.s80), sms_100: t(r.s100), ai_80: t(r.a80), ai_100: t(r.a100), forward_80: t(r.f80), forward_100: t(r.f100) };
}

/** The integer percent of `cap` that `used` represents (0 when there is no cap); the jobs runner compares it with 80 / 100. */
export const usagePercent = (used: number, cap: number): number => (cap > 0 ? Math.floor((used * 100) / cap) : used > 0 ? 100 : 0);
