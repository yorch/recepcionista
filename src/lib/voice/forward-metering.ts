/**
 * Metering and limits for the calls WE place: a forwarded call costs an inbound leg plus an outbound PSTN leg and, unlike an AI
 * call, no post-call webhook ever reports its minutes. So the app meters them itself, from the signed Twilio callbacks, into the
 * same `usage_counters.call_seconds` the AI minutes use (billing banner, plan caps and trial caps therefore apply):
 *
 *   - before dialling: `forwardAllowance` refuses when the plan lapsed or this month's minutes are used up, when the business
 *     already placed too many forwards this hour, or when the allowance check itself fails (a forward FAILS CLOSED; only AI calls
 *     fail open), and otherwise returns the `timeLimit` for <Dial>: the minutes still left (never more than FORWARD_MAX_CALL_SECONDS);
 *   - after the call: `meterForwardedCall` adds the bridged seconds exactly once per parent CallSid (claimEvent), whichever of the
 *     callbacks (the <Dial action> or the <Number statusCallback>) arrives first, and a voicemail's recorded seconds likewise.
 */
import { billingEnforced, checkCallAllowed, claimEvent, completeEvent, recordCallSeconds, releaseEvent } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';

const log = logger('voice/forward-metering');

const intEnv = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number((raw ?? '').trim());
  return (raw ?? '').trim() !== '' && Number.isInteger(n) && n >= min ? n : fallback;
};

/** Longest single forwarded call (seconds), whatever the plan: FORWARD_MAX_CALL_SECONDS (default 3600, at least 60). */
export const forwardMaxCallSeconds = (env: Record<string, string | undefined> = process.env): number => intEnv(env.FORWARD_MAX_CALL_SECONDS, 3600, 60);
/** Forwarded calls one business may start per hour: FORWARD_CALLS_PER_HOUR (default 30, at least 1). */
export const forwardCallsPerHour = (env: Record<string, string | undefined> = process.env): number => intEnv(env.FORWARD_CALLS_PER_HOUR, 30, 1);
/** Voicemails one business may take per hour: VOICEMAIL_PER_HOUR (default 30, at least 1). */
export const voicemailsPerHour = (env: Record<string, string | undefined> = process.env): number => intEnv(env.VOICEMAIL_PER_HOUR, 30, 1);
/** Below this many remaining seconds a forward is not started (a call cut after seconds helps nobody). */
export const FORWARD_MIN_REMAINING_SECONDS = 30;

export type ForwardAllowance =
  | { ok: true; timeLimit: number }
  | { ok: false; why: 'no_plan' | 'cap_reached' | 'rate_limited' | 'check_failed' };

export async function forwardAllowance(businessId: string, env: Record<string, string | undefined> = process.env): Promise<ForwardAllowance> {
  try {
    const gate = await checkCallAllowed(businessId);
    if (!gate.ok) return { ok: false, why: gate.reason === 'no_plan' ? 'no_plan' : 'cap_reached' };
    let limit = forwardMaxCallSeconds(env);
    if (billingEnforced(env as NodeJS.ProcessEnv)) {
      const remaining = gate.cap - gate.used;
      if (remaining < FORWARD_MIN_REMAINING_SECONDS) return { ok: false, why: 'cap_reached' };
      limit = Math.min(limit, remaining);
    }
    const hour = await rateLimit(`voice/forward:hour:${businessId}`, forwardCallsPerHour(env), 60 * 60_000, { failClosed: true });
    if (!hour.allowed) return { ok: false, why: 'rate_limited' };
    return { ok: true, timeLimit: Math.max(FORWARD_MIN_REMAINING_SECONDS, Math.floor(limit)) };
  } catch (err) {
    log.error('allowance_failed', { business: businessId, err });
    return { ok: false, why: 'check_failed' };
  }
}

/** May this business take another voicemail right now? (Fails closed.) */
export async function allowVoicemail(businessId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    return (await rateLimit(`voice/voicemail:hour:${businessId}`, voicemailsPerHour(env), 60 * 60_000, { failClosed: true })).allowed;
  } catch {
    return false;
  }
}

export type MeterOutcome = 'metered' | 'duplicate' | 'ignored' | 'failed';

/** Whole seconds from a Twilio duration field; null when it is not a sane non-negative number. */
export function parseSeconds(raw: unknown, max = 4 * 3600): number | null {
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw.trim())) return null;
  return Math.min(max, Number(raw.trim()));
}

async function meterOnce(source: string, key: string, businessId: string, seconds: number | null): Promise<MeterOutcome> {
  if (seconds === null || seconds <= 0) return 'ignored';
  let claimed = false;
  try {
    claimed = await claimEvent(source, key);
    if (!claimed) return 'duplicate';
    await recordCallSeconds(businessId, seconds);
    await completeEvent(source, key);
    return 'metered';
  } catch (err) {
    log.error('metering_failed', { source, business: businessId, err });
    if (claimed) await releaseEvent(source, key);
    return 'failed';
  }
}

/** Add the bridged seconds of a forwarded call, once per PARENT call sid (idempotent across both callbacks and Twilio retries). */
export const meterForwardedCall = (parentCallSid: string, businessId: string, seconds: number | null): Promise<MeterOutcome> =>
  meterOnce('forward-meter', parentCallSid, businessId, seconds);

/** Add the recorded seconds of a voicemail, once per call sid. */
export const meterVoicemail = (callSid: string, businessId: string, seconds: number | null): Promise<MeterOutcome> =>
  meterOnce('voicemail-meter', callSid, businessId, seconds);
