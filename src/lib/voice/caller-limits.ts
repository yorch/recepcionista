/**
 * Who is spending a business's forward / voicemail budget (review 6, H1).
 *
 * The per-BUSINESS hourly budgets guard cost; they cannot also stop one caller from using them all. So every inbound call that would
 * dial the owner or record a voicemail is charged, in this order, against:
 *
 *   1. the CALLER's own budget (`voice/<kind>:caller:<business>:<hash of the E.164>`, default 3 forwards and 2 voicemails per hour).
 *      Callers that withhold their number (anonymous / restricted / unparseable) all share ONE stricter bucket per business
 *      (`...:withheld`, default 5 forwards and 3 voicemails per hour). A caller over their own budget never touches the business budget.
 *   2. for a caller who is NOT a known customer: the UNKNOWN share of the business budget (default 75%), so
 *   3. the business budget as a whole always has 25% left that only KNOWN customers (a booking, or an answered AI call, in the last
 *      90 days) can use: an anonymous flood degrades service for strangers, never for customers.
 *
 * Each CallSid is charged ONCE (`claimEvent`): a Twilio webhook retry, or the Dial-action callback of the same call, re-reads the
 * budgets without spending them again. The numbers are hashed in the bucket keys (no phone numbers in rate_limit_buckets).
 * When a business budget passes 80% a loud log line and one rate-limited owner notice say so.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { claimEvent, completeEvent, releaseEvent } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { peekRateLimit, rateLimit } from '@/lib/ratelimit';
import { alertOwner } from '@/lib/voice/owner-alert';
import { logger } from '@/lib/log';
import { attestationLevel, type Attestation } from '@/lib/stir';
import type { Business } from '@/lib/types';

const log = logger('voice/caller-limits');

export type BudgetKind = 'forward' | 'voicemail';
export type Env = Record<string, string | undefined>;

const HOUR = 60 * 60_000;
/** A customer is "known" for this long after their last booking / answered AI call. */
export const KNOWN_CUSTOMER_DAYS = 90;
/** The business budget share (percent) that strangers may use at most; the rest is reserved for known customers. */
export const DEFAULT_UNKNOWN_SHARE_PCT = 75;
/** Pressure notice threshold: percent of the business budget used in the current window. */
export const PRESSURE_PCT = 80;

const intEnv = (raw: string | undefined, fallback: number, min: number, max = 1_000_000): number => {
  const t = (raw ?? '').trim();
  const n = Number(t);
  return t !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export const perCallerPerHour = (kind: BudgetKind, env: Env = process.env): number =>
  kind === 'forward' ? intEnv(env.FORWARD_PER_CALLER_PER_HOUR, 3, 1) : intEnv(env.VOICEMAIL_PER_CALLER_PER_HOUR, 2, 1);
export const withheldPerHour = (kind: BudgetKind, env: Env = process.env): number =>
  kind === 'forward' ? intEnv(env.FORWARD_WITHHELD_PER_HOUR, 5, 1) : intEnv(env.VOICEMAIL_WITHHELD_PER_HOUR, 3, 1);
export const unknownSharePct = (env: Env = process.env): number => intEnv(env.CALLER_UNKNOWN_SHARE_PCT, DEFAULT_UNKNOWN_SHARE_PCT, 1, 100);

/** Numbers Twilio / carriers send instead of a caller id. */
const WITHHELD = new Set(['', 'anonymous', 'restricted', 'unavailable', 'unknown', 'private', 'blocked', '+266696687', '+86282452253', '+7378742883', '+2562533', '+8656696', '+464']);

/**
 * STIR/SHAKEN trust (Twilio `StirVerstat`). Caller-id can be spoofed, so a per-caller identity (own bucket, "known customer" reserved capacity)
 * is only granted to a caller whose number passed attestation A. Everyone else (B, C, no verstat, a native line that provides none) shares
 * the 'unverified' stranger bucket; a number that FAILED validation gets a stricter shared bucket (half the withheld budget). A spoofer who
 * dials as a known customer therefore can neither burn that customer's own budget nor use the capacity reserved for known customers.
 * `STIR_TRUST=off` (a deployment whose callers are mostly outside the US/Canada, where no verstat exists) restores caller-id identity.
 */
export type TrustClass = 'verified' | 'unverified' | 'failed';
export const stirTrustEnabled = (env: Env = process.env): boolean => (env.STIR_TRUST ?? '').trim().toLowerCase() !== 'off';
export function trustClassOf(stirStatus: string | null | undefined, env: Env = process.env): TrustClass {
  if (!stirTrustEnabled(env)) return 'verified';
  const a: Attestation = attestationLevel(stirStatus);
  return a === 'A' ? 'verified' : a === 'failed' ? 'failed' : 'unverified';
}
export const failedPerHour = (kind: BudgetKind, env: Env = process.env): number => Math.max(1, Math.floor(withheldPerHour(kind, env) / 2));

export interface CallerKey {
  /** Valid E.164, or null when the caller withheld the number. */
  e164: string | null;
  /** Bucket id: a hash of the E.164, or the literal `withheld` (shared). */
  bucket: string;
}

export function callerKey(from: string | null | undefined, businessId: string, trust: TrustClass = 'verified'): CallerKey {
  const raw = (from ?? '').trim().toLowerCase();
  const e164 = WITHHELD.has(raw) ? null : toE164(raw);
  if (!e164) return { e164: null, bucket: 'withheld' };
  if (trust !== 'verified') return { e164: null, bucket: trust === 'failed' ? 'failed' : 'unverified' };
  return { e164, bucket: crypto.createHash('sha256').update(`${businessId}:${e164}`).digest('hex').slice(0, 24) };
}

/**
 * Is this number a known customer of the business? A booking (not anonymised) created or scheduled in the last 90 days, or an AI
 * call it had in that window that really took place (a transcript, no recording, at least 15 s). Forwarded / voicemail / paused calls
 * never make a number "known", so an attacker cannot earn the reserved capacity by calling a lot.
 */
export async function isKnownCaller(businessId: string, e164: string | null, now: Date = new Date()): Promise<boolean> {
  if (!e164) return false;
  const since = new Date(now.getTime() - KNOWN_CUSTOMER_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<{ known: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM "bookings" WHERE "business_id" = ${businessId} AND "phone_e164" = ${e164} AND "anonymized_at" IS NULL
                AND ("created_at" >= ${since} OR "scheduled_at" >= ${since}))
      OR EXISTS (SELECT 1 FROM "calls" WHERE "business_id" = ${businessId} AND "kind" = 'customer' AND "caller_e164" = ${e164} AND "started_at" >= ${since}
                   AND "transcript" IS NOT NULL AND "recording_url" IS NULL AND COALESCE("duration_sec", 0) >= 15)
    ) AS known`;
  return rows[0]?.known === true;
}

/** Charge one unit (first sight of the call) or just look (a retry of the same call). `error` = the store failed. */
async function spend(key: string, limit: number, first: boolean): Promise<{ allowed: boolean; estimate: number; error: boolean }> {
  if (first) {
    const r = await rateLimit(key, limit, HOUR, { failClosed: true });
    return { allowed: r.allowed, estimate: r.estimate ?? 0, error: r.error === true };
  }
  const estimate = await peekRateLimit(key, HOUR);
  return { allowed: estimate <= limit, estimate, error: false };
}

export interface BudgetContext {
  business: Business;
  /** The Twilio CallSid: each call is charged once. Without it every call is charged (callers of the old signature). */
  callSid?: string | null;
  from?: string | null;
  now?: Date;
  /**
   * Twilio StirVerstat of the call (e.g. 'TN-Validation-Passed-A'). Pass the call's stored `stir_status` (null = none reported). Leaving the
   * key OUT (undefined) skips the trust check (legacy callers / tests): every real entry path passes it.
   */
  stirStatus?: string | null;
}

export type BudgetDenial = 'caller_limited' | 'unknown_reserved' | 'business_budget' | 'check_failed';
export type BudgetDecision = { ok: true; known: boolean } | { ok: false; why: BudgetDenial; known: boolean };

/** Per-business budget (calls per hour) of a kind, before the reservation split. */
export const businessBudget = (kind: BudgetKind, env: Env = process.env): number =>
  kind === 'forward' ? intEnv(env.FORWARD_CALLS_PER_HOUR, 60, 1) : intEnv(env.VOICEMAIL_PER_HOUR, 60, 1);

/**
 * Charge a call against the caller's budget, the stranger share and the business budget (see the module comment). Never throws: a failing
 * store fails CLOSED ('check_failed'; the caller is sent to the cheap path).
 */
export async function chargeCallBudget(kind: BudgetKind, ctx: BudgetContext, env: Env = process.env): Promise<BudgetDecision> {
  const businessId = ctx.business.id;
  let claimed = false;
  const source = kind === 'forward' ? 'voice-forward-budget' : 'voice-voicemail-budget';
  try {
    const trust: TrustClass = ctx.stirStatus === undefined ? 'verified' : trustClassOf(ctx.stirStatus, env);
    const caller = callerKey(ctx.from, businessId, trust);
    const first = ctx.callSid ? await claimEvent(source, ctx.callSid) : true;
    claimed = Boolean(ctx.callSid) && first;
    const known = await isKnownCaller(businessId, caller.e164, ctx.now);

    const own = await spend(
      `voice/${kind}:caller:${businessId}:${caller.bucket}`,
      caller.e164 ? perCallerPerHour(kind, env) : caller.bucket === 'failed' ? failedPerHour(kind, env) : withheldPerHour(kind, env), first,
    );
    if (own.error) { if (claimed && ctx.callSid) { await releaseEvent(source, ctx.callSid); claimed = false; } return { ok: false, why: 'check_failed', known }; }
    if (!own.allowed) {
      log.warn('caller_limited', { business: businessId, kind, caller: caller.bucket, withheld: caller.e164 === null, trust });
      if (claimed && ctx.callSid) await completeEvent(source, ctx.callSid);
      return { ok: false, why: 'caller_limited', known };
    }

    const total = businessBudget(kind, env);
    if (!known) {
      const share = Math.max(1, Math.floor((total * unknownSharePct(env)) / 100));
      const strangers = await spend(`voice/${kind}:unknown:${businessId}`, share, first);
      if (strangers.error) { if (claimed && ctx.callSid) { await releaseEvent(source, ctx.callSid); claimed = false; } return { ok: false, why: 'check_failed', known }; }
      if (!strangers.allowed) {
        log.warn('unknown_share_exhausted', { business: businessId, kind, share, estimate: Math.round(strangers.estimate) });
        void reportPressure(ctx.business, kind, strangers.estimate, share, true, env);
        if (claimed && ctx.callSid) await completeEvent(source, ctx.callSid);
        return { ok: false, why: 'unknown_reserved', known };
      }
    }
    const biz = await spend(`voice/${kind}:hour:${businessId}`, total, first);
    if (biz.error) { if (claimed && ctx.callSid) { await releaseEvent(source, ctx.callSid); claimed = false; } return { ok: false, why: 'check_failed', known }; }
    if (claimed && ctx.callSid) await completeEvent(source, ctx.callSid);
    if (biz.estimate > (total * PRESSURE_PCT) / 100) void reportPressure(ctx.business, kind, biz.estimate, total, false, env);
    return biz.allowed ? { ok: true, known } : { ok: false, why: 'business_budget', known };
  } catch (err) {
    log.error('charge_failed', { business: businessId, kind, err });
    if (claimed && ctx.callSid) await releaseEvent(source, ctx.callSid);
    return { ok: false, why: 'check_failed', known: false };
  }
}

/**
 * More than PRESSURE_PCT of a business budget is used (or the stranger share is exhausted): one loud log line, plus ONE owner text per
 * hour per kind (it never names a number). Never throws.
 */
export async function reportPressure(
  business: Business, kind: BudgetKind, estimate: number, limit: number, strangersOnly: boolean, env: Env = process.env,
): Promise<boolean> {
  try {
    const gate = await rateLimit(`voice/pressure:${kind}:${business.id}`, 1, HOUR, { failClosed: true });
    if (!gate.allowed) return false;
    const pct = Math.round((estimate / limit) * 100);
    log.error('call_budget_pressure', {
      business: business.id, kind, used_pct: pct, limit, strangers_only: strangersOnly, share_pct: unknownSharePct(env),
      action: 'unusually many calls this hour; known customers keep their reserved share (docs/runbook.md, call flood)',
    });
    const what = kind === 'forward' ? 'forwarded calls' : 'voicemails';
    const body = strangersOnly
      ? `HEADS UP — ${business.name}: unusually many ${what} from unknown numbers this hour. Their share is used up; known customers still get through. If this is not expected, switch calls back to the assistant.`
      : `HEADS UP — ${business.name}: ${pct}% of this hour's ${what} allowance is used. Known customers keep a reserved share. If this is not expected, check Calls.`;
    return (await alertOwner(business, body)).notified;
  } catch (err) {
    log.error('pressure_notice_failed', { business: business.id, err });
    return false;
  }
}
