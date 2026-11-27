/**
 * Metering and limits for the calls WE place and the voicemails WE take (non-AI call handling). A forwarded call costs an inbound leg
 * plus an outbound PSTN leg and, unlike an AI call, no post-call webhook ever reports its minutes. So the app meters them itself, from
 * the signed Twilio callbacks, into their OWN counters (review 6, M1): forwarded seconds into `usage_counters.forward_seconds` (cap
 * FORWARD_MINUTES_CAP, default 600/month) and voicemail seconds into `voicemail_seconds` (cap VOICEMAIL_MINUTES_CAP, default 60/month).
 * Neither ever touches `call_seconds`, the AI minutes, so anonymous voicemails or a silent forwarded call cannot take the AI line out of
 * service.
 *
 *   - before dialling: `forwardAllowance` refuses when the plan lapsed or this month's forwarded minutes are used up, when the CALLER
 *     (or the business budget, with a share reserved for known customers: caller-limits.ts) is over its hourly budget, when too many
 *     forwards are already live (FORWARD_MAX_CONCURRENT) or when the allowance check itself fails (a forward FAILS CLOSED; only AI calls
 *     fail open), and otherwise returns the `timeLimit` for <Dial>: the minutes still left minus what live forwards reserved (never
 *     more than FORWARD_MAX_CALL_SECONDS);
 *   - after the call: `meterForwardedCall` adds the bridged seconds exactly once per parent CallSid (claimEvent), whichever of the
 *     callbacks (the <Dial action> or the <Number statusCallback>) arrives first, frees the live-forward lease, and a voicemail's
 *     recorded seconds likewise.
 */
import { configEnv } from '@/lib/config';
import {
  acquireForwardLease, billingEnforced, checkForwardAllowed, checkVoicemailAllowed, claimEvent, completeEvent, recordForwardSeconds,
  recordVoicemailSeconds, releaseEvent, releaseForwardLease,
} from '@/lib/db';
import { chargeCallBudget, businessBudget, type BudgetContext, type BudgetDenial } from '@/lib/voice/caller-limits';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import { knobOr } from '@/lib/admin/tenant-knobs';

const log = logger('voice/forward-metering');

const intEnv = (raw: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Number((raw ?? '').trim());
  return (raw ?? '').trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Longest single forwarded call (seconds), whatever the plan: FORWARD_MAX_CALL_SECONDS (default 3600, at least 60). */
export const forwardMaxCallSeconds = (env: Record<string, string | undefined> = configEnv()): number => intEnv(env.FORWARD_MAX_CALL_SECONDS, 3600, 60);
/** Forwarded calls one business may start per hour, ALL callers together: FORWARD_CALLS_PER_HOUR (default 60, at least 1). Each caller has a much lower budget of their own (caller-limits.ts). */
export const forwardCallsPerHour = (env: Record<string, string | undefined> = configEnv()): number => businessBudget('forward', env);
/** Voicemails one business may take per hour, ALL callers together: VOICEMAIL_PER_HOUR (default 60, at least 1). */
export const voicemailsPerHour = (env: Record<string, string | undefined> = configEnv()): number => businessBudget('voicemail', env);
/** Forwarded calls one business may have in progress at the same time: FORWARD_MAX_CONCURRENT (default 3, at least 1). */
export const forwardMaxConcurrent = (env: Record<string, string | undefined> = configEnv()): number => intEnv(env.FORWARD_MAX_CONCURRENT, 3, 1, 100);
/**
 * A forwarded leg that was "answered" but lasted fewer seconds than this is treated as NOT answered by a person (the owner's carrier
 * voicemail or a hang-up the moment it connected): the caller is offered our voicemail. FORWARD_MIN_ANSWERED_SECONDS, default 6, 0 = off.
 */
export const forwardMinAnsweredSeconds = (env: Record<string, string | undefined> = configEnv()): number => intEnv(env.FORWARD_MIN_ANSWERED_SECONDS, 6, 0, 120);
/** Below this many remaining seconds a forward is not started (a call cut after seconds helps nobody). */
export const FORWARD_MIN_REMAINING_SECONDS = 30;

export type ForwardAllowance =
  | { ok: true; timeLimit: number; known?: boolean }
  | { ok: false; why: 'no_plan' | 'cap_reached' | 'rate_limited' | 'caller_limited' | 'concurrent_limit' | 'check_failed'; known?: boolean };

/**
 * May this business dial the owner for this call? `ctx` (the call's business, CallSid and caller id) switches on the per-caller budgets
 * and the known-customer reservation; without it only the business budget applies (the Phase-1 behaviour).
 */
export async function forwardAllowance(businessId: string, env: Record<string, string | undefined> = configEnv(), ctx?: BudgetContext): Promise<ForwardAllowance> {
  try {
    const gate = await checkForwardAllowed(businessId);
    if (!gate.ok) return { ok: false, why: gate.reason === 'no_plan' ? 'no_plan' : 'cap_reached' };
    const enforced = billingEnforced(env as NodeJS.ProcessEnv);
    if (enforced && gate.cap - gate.used < FORWARD_MIN_REMAINING_SECONDS) return { ok: false, why: 'cap_reached' };

    let known: boolean | undefined;
    if (ctx) {
      const d = await chargeCallBudget('forward', ctx, env);
      known = d.known;
      if (!d.ok) return { ok: false, why: d.why === 'caller_limited' ? 'caller_limited' : d.why === 'check_failed' ? 'check_failed' : 'rate_limited', known };
    } else {
      const hour = await rateLimit(`voice/forward:hour:${businessId}`, await knobOr(businessId, 'forward.calls_per_hour', forwardCallsPerHour(env)), 60 * 60_000, { failClosed: true });
      if (!hour.allowed) return { ok: false, why: 'rate_limited' };
    }

    const lease = await acquireForwardLease({
      businessId, callSid: ctx?.callSid || `nosid-${businessId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      maxConcurrent: forwardMaxConcurrent(env), known, maxCallSeconds: forwardMaxCallSeconds(env), minSeconds: FORWARD_MIN_REMAINING_SECONDS,
      capSeconds: enforced ? gate.cap : null,
    });
    if (!lease.ok) return { ok: false, why: lease.why === 'concurrent_limit' ? 'concurrent_limit' : 'cap_reached', known };
    return { ok: true, timeLimit: lease.timeLimit, known };
  } catch (err) {
    log.error('allowance_failed', { business: businessId, err });
    return { ok: false, why: 'check_failed' };
  }
}

export type VoicemailAllowance = { ok: true } | { ok: false; why: BudgetDenial | 'cap_reached' | 'no_plan'; known?: boolean };

/** May this business take another voicemail from this call right now? (Fails closed.) */
export async function voicemailAllowance(businessId: string, env: Record<string, string | undefined> = configEnv(), ctx?: BudgetContext): Promise<VoicemailAllowance> {
  try {
    if (billingEnforced(env as NodeJS.ProcessEnv)) {
      const gate = await checkVoicemailAllowed(businessId);
      if (!gate.ok) return { ok: false, why: gate.reason === 'no_plan' ? 'no_plan' : 'cap_reached' };
    }
    if (ctx) {
      const d = await chargeCallBudget('voicemail', ctx, env);
      return d.ok ? { ok: true } : { ok: false, why: d.why, known: d.known };
    }
    return (await rateLimit(`voice/voicemail:hour:${businessId}`, await knobOr(businessId, 'voicemail.calls_per_hour', voicemailsPerHour(env)), 60 * 60_000, { failClosed: true })).allowed
      ? { ok: true } : { ok: false, why: 'business_budget' };
  } catch {
    return { ok: false, why: 'check_failed' };
  }
}

/** Boolean form of `voicemailAllowance` (Phase-1 signature; `ctx` adds the per-caller budgets). */
export async function allowVoicemail(businessId: string, env: Record<string, string | undefined> = configEnv(), ctx?: BudgetContext): Promise<boolean> {
  return (await voicemailAllowance(businessId, env, ctx)).ok;
}

export type DialResult = 'answered' | 'unanswered' | 'canceled';

/**
 * What a `<Dial action>` callback says happened. `canceled` = the caller hung up while it rang (nothing to offer them). A leg that was
 * "completed" but is flagged as answered by a machine (`AnsweredBy=machine_*` when Twilio provides it) or lasted fewer than
 * FORWARD_MIN_ANSWERED_SECONDS counts as unanswered: it is the owner's carrier voicemail (or an instant hang-up), not the owner.
 */
export function classifyDial(form: Record<string, string | undefined>, env: Record<string, string | undefined> = configEnv()): { result: DialResult; why: string } {
  const status = (form.DialCallStatus ?? '').trim().toLowerCase();
  if (status === 'canceled') return { result: 'canceled', why: 'caller hung up while ringing' };
  if (status === 'completed' || status === 'answered') {
    if (/^machine/i.test((form.AnsweredBy ?? '').trim())) return { result: 'unanswered', why: 'answered by a machine' };
    const secs = parseSeconds(form.DialCallDuration);
    const min = forwardMinAnsweredSeconds(env);
    if (min > 0 && secs !== null && secs < min) return { result: 'unanswered', why: `ended after ${secs}s (under ${min}s)` };
    return { result: 'answered', why: 'answered' };
  }
  return { result: 'unanswered', why: status || 'no status' };
}

export type MeterOutcome = 'metered' | 'duplicate' | 'ignored' | 'failed';

/** Whole seconds from a Twilio duration field; null when it is not a sane non-negative number. */
export function parseSeconds(raw: unknown, max = 4 * 3600): number | null {
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw.trim())) return null;
  return Math.min(max, Number(raw.trim()));
}

async function meterOnce(
  source: string, key: string, businessId: string, seconds: number | null, record: (businessId: string, seconds: number) => Promise<unknown>,
): Promise<MeterOutcome> {
  if (seconds === null || seconds <= 0) return 'ignored';
  let claimed = false;
  try {
    claimed = await claimEvent(source, key);
    if (!claimed) return 'duplicate';
    await record(businessId, seconds);
    await completeEvent(source, key);
    return 'metered';
  } catch (err) {
    log.error('metering_failed', { source, business: businessId, err });
    if (claimed) await releaseEvent(source, key);
    return 'failed';
  }
}

/**
 * Add the bridged seconds of a forwarded call to `forward_seconds`, once per PARENT call sid (idempotent across both callbacks and Twilio
 * retries), then free the live-forward lease (AFTER the seconds are recorded: see db/forward-leases.ts). Never touches the AI minutes.
 */
export async function meterForwardedCall(parentCallSid: string, businessId: string, seconds: number | null): Promise<MeterOutcome> {
  const outcome = await meterOnce('forward-meter', parentCallSid, businessId, seconds, recordForwardSeconds);
  if (outcome !== 'failed') await releaseForwardLease(businessId, parentCallSid);
  return outcome;
}

/** Add the recorded seconds of a voicemail to `voicemail_seconds`, once per call sid. Never touches the AI minutes. */
export const meterVoicemail = (callSid: string, businessId: string, seconds: number | null): Promise<MeterOutcome> =>
  meterOnce('voicemail-meter', callSid, businessId, seconds, recordVoicemailSeconds);
