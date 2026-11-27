/**
 * Native-line live transfer (ElevenLabs "transfer to number" system tool). Gated by NATIVE_TRANSFER=on|off (DEFAULT off: provider
 * behaviour needs the live test in docs/runbook.md section 8).
 *
 * How it works (docs: ElevenLabs system tool `transfer_to_number`; its destination "can be typed directly or as a dynamic variable"):
 *  - the agent carries ONE transfer rule whose destination is `{{transfer_destination}}`;
 *  - the conversation-initiation webhook sets that variable PER CALL, only to the business's trusted forward number (verified, re-vetted
 *    NOW with validateForwardNumber + the platform-line loop check) and only when a transfer is allowed right now; otherwise it is '' and
 *    the platform cannot transfer anywhere;
 *  - (a) call_mode 'forward' (and an in-hours schedule): initiation charges the forward machinery (per-caller / business budgets, forward
 *    cap, concurrency lease) and tells the agent to transfer immediately (`transfer_mode` = 'forward');
 *  - (b) mid-call: the AI calls the `transfer_to_human` webhook tool, which re-checks everything and charges the allowance, then (only when
 *    it answers "approved") the agent calls the system tool. When it cannot transfer it takes a callback (handoff_to_human path).
 * Honest limits (docs/known-limitations.md): the transferred leg's talk time is not visible to this app; a prompt that skips the
 * webhook tool is not stopped by the server beyond the destination being empty / valid.
 */
import { configEnv } from '@/lib/config';
import { setTransferStatus } from '@/lib/db';
import { forwardAllowance } from '@/lib/voice/forward-metering';
import { forwardTarget, isOpenNow } from '@/lib/voice/call-mode';
import { vetForwardNumber } from '@/lib/voice/forward-vet';
import { disclosureFor } from '@/lib/kb/disclosure';
import { tzOf } from '@/lib/time';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('voice/transfer');

export type Env = Record<string, string | undefined>;
/** The platform CAPABILITY (NATIVE_TRANSFER=on). A business additionally has to opt in: see {@link transferEnabledFor}. */
export const nativeTransferEnabled = (env: Env = configEnv()): boolean => (env.NATIVE_TRANSFER ?? '').trim().toLowerCase() === 'on';

/** Live transfer is on for THIS business: the global capability AND the business's own opt-in (businesses.native_transfer_enabled, default off). */
export const transferEnabledFor = (business: Pick<Business, 'native_transfer_enabled'> | null | undefined, env: Env = configEnv()): boolean =>
  nativeTransferEnabled(env) && business?.native_transfer_enabled === true;

export type TransferWhy =
  | 'disabled' | 'no_number' | 'unverified' | 'rejected' | 'outside_hours' | 'no_plan' | 'cap_reached' | 'rate_limited' | 'caller_limited'
  | 'concurrent_limit' | 'check_failed';

export type TransferDecision = { ok: true; to: string; timeLimit: number } | { ok: false; why: TransferWhy; error?: string };

export interface TransferContext { callSid?: string | null; from?: string | null; stirStatus?: string | null; now?: Date; env?: Env }

/** Can this business's trusted number be dialled right now at all (no charging)? Used to decide the per-call destination variable. */
export async function transferTargetNow(business: Business, ctx: TransferContext = {}): Promise<{ ok: true; to: string } | { ok: false; why: TransferWhy; error?: string }> {
  const env = ctx.env ?? configEnv();
  if (!transferEnabledFor(business, env)) return { ok: false, why: 'disabled' };
  const t = forwardTarget(business);
  if (!t.ok) return { ok: false, why: t.why === 'none' ? 'no_number' : t.why === 'rejected' ? 'rejected' : 'unverified', error: t.error };
  if (business.forward_during_hours && !isOpenNow(business.hours, tzOf(business.timezone), ctx.now ?? new Date(), business.closed_dates)) return { ok: false, why: 'outside_hours' };
  const vet = await vetForwardNumber(business, t.to);
  if (!vet.ok) return { ok: false, why: 'rejected', error: vet.error };
  return { ok: true, to: vet.e164 };
}

/** Full decision incl. charging the forward allowance (budgets, cap, concurrency lease). Charged once per CallSid (claimEvent inside). */
export async function decideTransfer(business: Business, ctx: TransferContext = {}): Promise<TransferDecision> {
  const target = await transferTargetNow(business, ctx);
  if (!target.ok) return target;
  const a = await forwardAllowance(business.id, (ctx.env ?? configEnv()) as NodeJS.ProcessEnv, {
    business, callSid: ctx.callSid ?? null, from: ctx.from ?? null, stirStatus: ctx.stirStatus ?? null, now: ctx.now,
  });
  if (!a.ok) return { ok: false, why: a.why };
  return { ok: true, to: target.to, timeLimit: a.timeLimit };
}

/** Dynamic variables the initiation webhook always returns (the agent declares both as placeholders). */
export interface TransferVariables { transfer_mode: 'off' | 'available' | 'forward'; transfer_destination: string }
export const NO_TRANSFER: TransferVariables = { transfer_mode: 'off', transfer_destination: '' };

/** What the agent says first when the call is to be transferred straight away: the disclosure always comes first. */
export function forwardFirstMessage(business: Business): string {
  return `${disclosureFor(business)} — One moment, I am connecting you with the team at ${business.name}. If the call does not go through I will take a message. — `
    + `Un momento, le comunico con el equipo de ${business.name}. Si la llamada no se conecta, tomo su mensaje.`;
}

const say = (es: boolean, en: string, sp: string) => (es ? sp : en);

/** The spoken line for a refused / unavailable transfer: honest, and it moves to a callback. */
export function transferRefusalMessage(why: TransferWhy, es: boolean): string {
  const tail = say(es, 'I will pass a message to the owner so they call you back. ', 'Le paso un mensaje al dueño para que le devuelva la llamada. ');
  const reason = why === 'outside_hours'
    ? say(es, 'The team is not available to take calls right now. ', 'El equipo no está disponible para llamadas en este momento. ')
    : say(es, 'I cannot transfer the call right now. ', 'No puedo transferir la llamada en este momento. ');
  return reason + tail;
}

export const transferApprovedMessage = (es: boolean): string => say(es,
  'Transfer approved. Tell the caller you are connecting them now and that if it does not connect you will take a message, then use the transfer tool.',
  'Transferencia aprobada. Dígale a la persona que la está comunicando ahora y que, si no se conecta, tomará un mensaje; luego use la herramienta de transferencia.');

/** Record the attempt on the call (never downgrades a 'connected'). */
export async function noteTransferAttempt(callId: string): Promise<void> {
  try { await setTransferStatus(callId, 'attempted'); } catch (err) { log.warn('status_failed', { call: callId, err }); }
}

/**
 * Transfer outcome from the post-call transcript: ElevenLabs lists tool calls on agent turns. A call to `transfer_to_number` that has a
 * result without an error counts as connected, one with an error as failed, and an 'attempted' call that never called it as failed.
 * UNVERIFIED shape (tool_calls[].tool_name, tool_results[].is_error); anything unreadable leaves the status as 'attempted'.
 */
export function transferOutcomeFromTranscript(transcript: unknown): 'connected' | 'failed' | 'none' | 'unknown' {
  if (!Array.isArray(transcript)) return 'unknown';
  let called = false; let errored = false; let resolved = false;
  for (const turn of transcript as Record<string, unknown>[]) {
    const calls = Array.isArray(turn?.tool_calls) ? (turn.tool_calls as Record<string, unknown>[]) : [];
    for (const c of calls) if (String(c?.tool_name ?? c?.name ?? '') === 'transfer_to_number') called = true;
    const results = Array.isArray(turn?.tool_results) ? (turn.tool_results as Record<string, unknown>[]) : [];
    for (const r of results) {
      if (String(r?.tool_name ?? r?.name ?? '') !== 'transfer_to_number') continue;
      resolved = true;
      if (r?.is_error === true || /\berror\b|failed/i.test(String(r?.result_value ?? ''))) errored = true;
    }
  }
  if (!called) return 'none';
  if (errored) return 'failed';
  // Called but no readable result: we do not KNOW it connected (the provider shape is unverified, or the leg dropped silently). 'unknown'
  // leaves the status 'attempted' and the call is metered as an ordinary AI call.
  return resolved ? 'connected' : 'unknown';
}

/**
 * When (seconds into the call) the agent invoked `transfer_to_number`, from the turn's `time_in_call_secs`; null when unreadable. Everything
 * before it was the AI talking (AI minutes), only the time after it is forward time.
 */
export function transferStartSecs(transcript: unknown): number | null {
  if (!Array.isArray(transcript)) return null;
  for (const turn of transcript as Record<string, unknown>[]) {
    const calls = Array.isArray(turn?.tool_calls) ? (turn.tool_calls as Record<string, unknown>[]) : [];
    if (!calls.some((c) => String(c?.tool_name ?? c?.name ?? '') === 'transfer_to_number')) continue;
    return secsOf(turn.time_in_call_secs);
  }
  return null;
}

const secsOf = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === '') return null; // Number(null) is 0: absent must not read as "at second 0"
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
};

/** The latest `time_in_call_secs` of any turn BEFORE the transfer turn (the AI's last spoken moment); null when no earlier turn carries one. */
export function transferLeadInSecs(transcript: unknown): number | null {
  if (!Array.isArray(transcript)) return null;
  let last: number | null = null;
  for (const turn of transcript as Record<string, unknown>[]) {
    const calls = Array.isArray(turn?.tool_calls) ? (turn.tool_calls as Record<string, unknown>[]) : [];
    if (calls.some((c) => String(c?.tool_name ?? c?.name ?? '') === 'transfer_to_number')) break;
    const t = secsOf(turn?.time_in_call_secs);
    if (t !== null && t > 0 && (last === null || t > last)) last = t;
  }
  return last;
}

export interface TransferSplit {
  ai: number;
  forward: number;
  /** Where the boundary came from. 'whole_call': nothing readable, the whole call is forward time (the documented fallback). */
  basis: 'transfer_turn' | 'dial_duration' | 'last_turn' | 'whole_call';
}

/**
 * Split a connected transfer's duration into AI seconds and forward seconds. The two always add up to the call's duration, so neither
 * double-bills nor loses a second. Boundary, best evidence first:
 *  1. the transfer turn's own `time_in_call_secs` (everything before it was the AI);
 *  2. the bridged duration a Twilio dial-status callback reported (`DialCallDuration`): that is forward time, the rest was the AI;
 *  3. the last timed turn before the transfer turn (an estimate: the agent says "connecting you" and the transfer follows);
 *  4. nothing readable: the whole call is forward time.
 */
export function splitTransferSeconds(i: { durationSec: number; transcript: unknown; dialSeconds?: number | null }): TransferSplit {
  const total = Math.max(0, Math.round(i.durationSec));
  const at = transferStartSecs(i.transcript);
  if (at !== null) { const ai = Math.min(total, at); return { ai, forward: total - ai, basis: 'transfer_turn' }; }
  const dial = i.dialSeconds ?? null;
  if (dial !== null && dial > 0) { const forward = Math.min(total, Math.round(dial)); return { ai: total - forward, forward, basis: 'dial_duration' }; }
  const lead = transferLeadInSecs(i.transcript);
  if (lead !== null) { const ai = Math.min(total, lead); return { ai, forward: total - ai, basis: 'last_turn' }; }
  return { ai: 0, forward: total, basis: 'whole_call' };
}
