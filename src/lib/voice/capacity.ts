/**
 * Call capacity gate (plan caps via `checkCallAllowed`). Over the cap, or no active plan while BILLING_ENFORCED=true,
 * the agent says a polite out-of-service line and the call is handed off honestly: the owner is told (when their
 * phone is verified) and the reason is logged. Nothing is billed beyond the cap.
 */
import { checkCallAllowed, type AllowResult } from '@/lib/db';
import { disclosureFor } from '@/lib/kb/disclosure';
import { logger } from '@/lib/log';
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
