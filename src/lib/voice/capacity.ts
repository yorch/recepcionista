/**
 * Call capacity gate (plan caps via `checkCallAllowed`). Over the cap, or no active plan while BILLING_ENFORCED=true,
 * the agent says a polite out-of-service line and the call is handed off honestly: the owner is told (when their
 * phone is verified) and the reason is logged. The gate reads the live billing state and usage on EVERY call (one indexed
 * query, no cache), so cancelling/exhausting takes effect on the very next call. An out-of-service call is also cut short
 * (OUT_OF_SERVICE_MAX_SECONDS) instead of running up to the agent's 15 minute limit, and the owner is texted at most
 * once per 10 minutes and MISSED_CALL_ALERTS_PER_HOUR per hour per business.
 */
import { checkCallAllowed, type AllowResult } from '@/lib/db';
import { disclosureFor } from '@/lib/kb/disclosure';
import { logger } from '@/lib/log';
import { rateLimit } from '@/lib/ratelimit';
import type { Business } from '@/lib/types';

const log = logger('voice/capacity');

export interface CallGate extends AllowResult {
  /** Why service is unavailable: the plan lapsed, or this month's minutes are used up. */
  reason?: 'no_plan' | 'cap_reached';
}

/** Never throws: a failing meter must not take the phone line down (fail open, loudly). */
export async function callGate(businessId: string): Promise<CallGate> {
  try {
    const r = await checkCallAllowed(businessId);
    if (!r.ok) log.warn('call.refused', { business: businessId, reason: r.reason, used_seconds: r.used, cap_seconds: r.cap });
    return r;
  } catch (err) {
    log.error('call_gate.failed', { business: businessId, err });
    return { ok: true, used: 0, cap: 0 };
  }
}

/** An out-of-service call is ended after this long (message taking only). Needs the initiation override to be enabled on the agent. */
export const OUT_OF_SERVICE_MAX_SECONDS = 60;
/** Owner "MISSED CALL" texts per business per hour (bursts: one per 10 minutes). */
export const MISSED_CALL_ALERTS_PER_HOUR = 6;

/** `conversation_config_override` for a call we cannot serve: the first message plus a short maximum duration. */
export function outOfServiceOverride(business: Business): { agent: { first_message: string }; conversation: { max_duration_seconds: number } } {
  return { agent: { first_message: outOfServiceFirstMessage(business) }, conversation: { max_duration_seconds: OUT_OF_SERVICE_MAX_SECONDS } };
}

/**
 * May this business's owner be texted about a missed (out-of-service) call right now? At most one per 10 minutes and
 * MISSED_CALL_ALERTS_PER_HOUR per hour, so a lapsed tenant (or a caller redialling) cannot pump owner SMS.
 * Fails closed (no text) when the limiter store is down.
 */
export async function allowMissedCallAlert(businessId: string): Promise<boolean> {
  const burst = await rateLimit(`voice/missed-call:burst:${businessId}`, 1, 10 * 60_000, { failClosed: true });
  if (!burst.allowed) return false;
  const hour = await rateLimit(`voice/missed-call:hour:${businessId}`, MISSED_CALL_ALERTS_PER_HOUR, 60 * 60_000, { failClosed: true });
  return hour.allowed;
}

/** What the agent says when we cannot serve the call (the recording/AI notice always comes first). */
export function outOfServiceFirstMessage(business: Business): string {
  return `${disclosureFor(business)} — `
    + `Thanks for calling ${business.name}. Our assistant cannot take bookings right now. Please tell me your name and number and I will pass your message to the owner, who will call you back. — `
    + `Gracias por llamar a ${business.name}. Nuestra asistente no puede agendar citas en este momento. Dígame su nombre y número y le paso su mensaje al dueño, quien le devolverá la llamada.`;
}

/** Spoken by a tool that is refused for capacity reasons (the caller is already on the line). */
export function outOfServiceToolMessage(lang: 'en' | 'es'): string {
  return lang === 'es'
    ? 'Lo siento, no puedo hacer eso en este momento. Dígame su nombre y número y le paso su mensaje al dueño para que le devuelva la llamada.'
    : 'I am sorry, I cannot do that right now. Please tell me your name and number and I will pass your message to the owner, who will call you back.';
}

/** Tools that stay available when capacity is exhausted: they only alert the owner (exempt from the plan cap). */
export const CAPACITY_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['flag_emergency', 'handoff_to_human']);
