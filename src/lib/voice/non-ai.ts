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
import { makeT } from '@/lib/i18n';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import type { Business, Call } from '@/lib/types';

const log = logger('voice/non-ai');

export const PAUSED_FLAG = 'Paused: the assistant did not answer; the caller was asked to leave a message';
export const FORWARD_UNANSWERED_FLAG = 'Forwarded call was not answered; the caller was asked to leave a message';

/** The owner-language text of a missed-call alert (`why` is shown as given: callers pass a short reason). */
export async function missedCallText(business: Business, from: string | null | undefined, why: string): Promise<string> {
  const t = makeT(await ownerLocaleFor(business));
  return t('alert.missed', { business: business.name, who: from ? t('alert.missed.from', { from }) : '', why });
}

/** Tell a verified owner about a call nobody took (rate limited: 1 / 10 min, 6 / hour; never throws). */
export async function notifyMissedCall(business: Business, from: string | null | undefined, why: string, opts: { known?: boolean } = {}): Promise<boolean> {
  try {
    if (!(await allowMissedCallAlert(business.id, opts))) return false;
    return (await alertOwner(business, await missedCallText(business, from, why))).notified;
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
export async function markPaused(
  business: Business, call: Call, from: string | null | undefined, refusal?: string | null, opts: { notify?: boolean; known?: boolean } = {},
): Promise<void> {
  if (call.status === 'handed_off') return; // a Twilio retry of the same CallSid: already handled
  // `refusal`: a forward that could NOT be dialled (cap, rate limit, disallowed number) is flagged as such, not as a pause the owner chose.
  await updateCall(call.id, { status: 'handed_off', flagged_reason: refusal ?? PAUSED_FLAG, recording_disclosed: true, consent_status: 'disclosed' });
  // `notify: false`: a caller over their own limit never costs the owner a text (it would be a way to pump the owner's SMS).
  const notified = opts.notify === false ? false : await notifyMissedCall(business, from, refusal ? 'forwarding could not be used' : 'calls are paused', { known: opts.known });
  log.info('paused_call', { business: business.id, call: call.id, owner_notified: notified });
}

/** A paused / forwarded call on the NATIVE ElevenLabs path: the agent says the paused message and takes a callback message. */
export async function markPausedNative(business: Business, call: Call, from: string | null | undefined, mode: 'paused' | 'forward', refusedWhy: string | null = null): Promise<void> {
  if (call.status === 'handed_off') return;
  await updateCall(call.id, {
    status: 'handed_off',
    flagged_reason: mode === 'forward'
      ? (refusedWhy ? `Forwarding was not used (${refusedWhy.replace(/_/g, ' ')}); the assistant took a message` : 'Forwarding is not available on this line; the assistant took a message')
      : PAUSED_FLAG,
  });
  const notified = await notifyMissedCall(business, from, mode === 'forward' ? (refusedWhy ? 'forwarding could not be used' : 'forwarding is not available on this line') : 'calls are paused');
  log.info('paused_call_native', { business: business.id, call: call.id, mode, owner_notified: notified });
}

/**
 * A call that gets neither the owner nor a voicemail (its caller is over their own limit, or the voicemail budget / minutes are spent):
 * the call row says so (instead of staying "in progress" with no trace) and, unless the CALLER is the cause, a known customer or the
 * budget being spent tells the owner (rate limited, own budget for known customers).
 */
export async function markUnavailable(
  business: Business, call: Call, from: string | null | undefined, why: string, opts: { notify: boolean; known?: boolean },
): Promise<void> {
  if (call.status !== 'handed_off') await updateCall(call.id, { status: 'handed_off', flagged_reason: `Not taken: ${why}` });
  const notified = opts.notify ? await notifyMissedCall(business, from, why, { known: opts.known }) : false;
  log.warn('call_unavailable', { business: business.id, call: call.id, why, owner_notified: notified });
}
