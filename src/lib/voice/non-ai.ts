/**
 * Database side effects of a call that the AI does NOT answer (call mode 'paused', or 'forward'): the call row, and the
 * rate-limited "missed call" text to a verified owner phone. The TwiML itself lives in twiml.ts; the routing decision in
 * call-mode.ts. Both voice entry paths use these so they behave the same.
 *
 * Compliance: nothing is recorded or transcribed here. A forwarded call is never recorded by us and keeps
 * `recording_disclosed = false` / `consent_status = 'unknown'`; only the voicemail <Record>, which is always preceded by the
 * spoken recording notice, marks a call 'disclosed' (and a previously recorded objection stays sticky in updateCall).
 */
import { updateCall } from '@/lib/db';
import { allowMissedCallAlert } from '@/lib/voice/capacity';
import { maskNumber } from '@/lib/voice/call-mode';
import { alertOwner } from '@/lib/voice/owner-alert';
import { logger } from '@/lib/log';
import type { Business, Call } from '@/lib/types';

const log = logger('voice/non-ai');

export const PAUSED_FLAG = 'Paused: the assistant did not answer; the caller was asked to leave a message';
export const FORWARD_UNANSWERED_FLAG = 'Forwarded call was not answered; the caller was asked to leave a message';

/** Tell a verified owner about a call nobody took (rate limited: 1 / 10 min, 6 / hour; never throws). */
export async function notifyMissedCall(business: Business, from: string | null | undefined, why: string): Promise<boolean> {
  try {
    if (!(await allowMissedCallAlert(business.id))) return false;
    const who = from ? ` from ${from}` : '';
    return (await alertOwner(business, `MISSED CALL — ${business.name}\nA call${who} was not taken by the assistant (${why}). Please call back.`)).notified;
  } catch (err) {
    log.error('missed_call_alert.failed', { business: business.id, err });
    return false;
  }
}

/** A forwarded call: record that it was forwarded (not recorded, not transcribed, not disclosed). */
export async function markForwarded(call: Call, to: string): Promise<void> {
  if (call.status === 'handed_off' || call.status === 'completed') return;
  await updateCall(call.id, { status: 'completed', summary: `Forwarded to ${maskNumber(to)} (call handling: forward). Not recorded.` });
}

/**
 * A paused call, Twilio path: the call is handed off, the voicemail notice is spoken before the beep (so the recording
 * evidence is true), and the owner is told once (rate limited).
 */
export async function markPaused(business: Business, call: Call, from: string | null | undefined): Promise<void> {
  if (call.status === 'handed_off') return; // a Twilio retry of the same CallSid: already handled
  await updateCall(call.id, { status: 'handed_off', flagged_reason: PAUSED_FLAG, recording_disclosed: true, consent_status: 'disclosed' });
  const notified = await notifyMissedCall(business, from, 'calls are paused');
  log.info('paused_call', { business: business.id, call: call.id, owner_notified: notified });
}

/** A paused / forwarded call on the NATIVE ElevenLabs path: the agent says the paused message and takes a callback message. */
export async function markPausedNative(business: Business, call: Call, from: string | null | undefined, mode: 'paused' | 'forward'): Promise<void> {
  if (call.status === 'handed_off') return;
  await updateCall(call.id, {
    status: 'handed_off',
    flagged_reason: mode === 'forward' ? 'Forwarding is not available on this line; the assistant took a message' : PAUSED_FLAG,
  });
  const notified = await notifyMissedCall(business, from, mode === 'forward' ? 'forwarding is not available on this line' : 'calls are paused');
  log.info('paused_call_native', { business: business.id, call: call.id, mode, owner_notified: notified });
}
