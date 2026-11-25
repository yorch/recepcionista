/**
 * Twilio callback for the non-AI call modes (Twilio signature required, like /api/voice/incoming):
 *  - the result of a forwarded <Dial> (`DialCallStatus`): answered -> done; not answered / busy / failed -> the caller is
 *    offered the voicemail (recording notice first) and a verified owner is told, rate limited;
 *  - the finished voicemail <Record> (`RecordingUrl`): stored on the call row so the owner sees it in Calls > Voicemails (played back
 *    through the authenticated proxy /api/calls/:id/voicemail; the Twilio URL itself is never sent to a browser).
 * Forwarded and voicemail seconds are METERED here (once per call, claimEvent) into their OWN counters (`forward_seconds`,
 * `voicemail_seconds`; never the AI minutes: forward-metering.ts). A leg that "completed" in a few seconds or was answered by a machine
 * (the owner's carrier voicemail) counts as unanswered; a caller who hung up while it rang gets nothing and costs nothing.
 * No tenant data is taken from the request: the call is found by its CallSid and the business comes from that row.
 */
import { getBusiness, getCallBySid, recordDialSeconds, updateCall } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { classifyDial, meterForwardedCall, meterVoicemail, parseSeconds, voicemailAllowance } from '@/lib/voice/forward-metering';
import { callerKey, isKnownCaller } from '@/lib/voice/caller-limits';
import { FORWARD_UNANSWERED_FLAG, markUnavailable, notifyMissedCall } from '@/lib/voice/non-ai';
import { bridgedSeconds, screenOutcome } from '@/lib/voice/screening';
import { TWILIO_RECORDING_URL } from '@/lib/voice/voicemail';
import { emptyHangupTwiml, pausedTwiml, thanksTwiml, twimlResponse, unavailableTwiml } from '@/lib/voice/twiml';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('voice/voicemail');

export async function POST(req: Request): Promise<Response> {
  const form: Record<string, string> = {};
  try {
    (await req.formData()).forEach((v, k) => { if (typeof v === 'string') form[k] = v; });
  } catch { /* empty body: handled below */ }
  const verdict = verifyTwilioSignature(req, form);
  if (!verdict.ok) {
    log.warn('signature.rejected', { error: verdict.error });
    return new Response('forbidden', { status: 403 });
  }

  const callSid = (form.CallSid ?? '').trim();
  const call = callSid ? await getCallBySid(callSid) : null;
  const business = call ? await getBusiness(call.business_id) : null;
  if (!call || !business) {
    log.warn('unknown_call', { has_sid: Boolean(callSid) });
    return twimlResponse(emptyHangupTwiml());
  }

  try {
    if (form.DialCallStatus) {
      // Call screening: a leg whose owner never pressed 1 was not bridged (carrier voicemail, declined, no input): unanswered, 0 minutes.
      const screen = await screenOutcome((call.call_sid ?? callSid) || '');
      const notAccepted = screen.screened && !screen.accepted;
      const dial = notAccepted && (form.DialCallStatus ?? '').toLowerCase() !== 'canceled'
        ? { result: 'unanswered' as const, why: screen.declined ? 'owner declined the screening' : 'screening not accepted (no input / voicemail)' }
        : classifyDial(form);
      const secs = bridgedSeconds(parseSeconds(form.DialCallDuration), screen);
      await recordDialSeconds(call.call_sid ?? callSid, secs).catch(() => undefined); // the post-call split of a transferred call may use it
      if (dial.result === 'answered') {
        await updateCall(call.id, { status: 'completed', ...(secs !== null ? { duration_sec: secs } : {}) });
        await meterForwardedCall(call.call_sid ?? callSid, business.id, secs);
        return twimlResponse(emptyHangupTwiml());
      }
      // Whatever was bridged is real minutes (a carrier voicemail "answering" included): metered into the forward counter, never the AI minutes.
      await meterForwardedCall(call.call_sid ?? callSid, business.id, secs);
      if (dial.result === 'canceled') {
        // The caller hung up while it rang: there is nobody to offer a voicemail to and it costs nothing. Only a KNOWN customer's
        // missed call is texted (their own small budget), so hanging up on purpose cannot pump the owner's texts.
        await updateCall(call.id, { status: 'handed_off', flagged_reason: 'The caller hung up before the forwarded call was answered' });
        const known = await isKnownCaller(business.id, callerKey(call.caller_phone, business.id).e164);
        const notified = known ? await notifyMissedCall(business, call.caller_phone, 'the caller hung up while it rang', { known: true }) : false;
        log.info('forward_canceled', { business: business.id, call: call.id, known, owner_notified: notified });
        return twimlResponse(emptyHangupTwiml());
      }
      // Nobody picked up (or only a machine / an instant hang-up did): fall back to the voicemail (the notice below is spoken before the beep).
      const vm = await voicemailAllowance(business.id, process.env, { business, callSid: call.call_sid ?? callSid, from: call.caller_phone, stirStatus: call.stir_status ?? null });
      if (!vm.ok) {
        log.warn('voicemail_refused', { business: business.id, call: call.id, why: vm.why });
        const callerCaused = vm.why === 'caller_limited' || vm.why === 'unknown_reserved';
        await markUnavailable(business, call, call.caller_phone, vm.why === 'cap_reached' ? 'the voicemail minutes of this month are used up' : callerCaused ? 'too many calls from this number' : 'too many voicemails this hour', {
          notify: !callerCaused, known: vm.known,
        });
        return twimlResponse(unavailableTwiml());
      }
      await updateCall(call.id, { status: 'handed_off', flagged_reason: FORWARD_UNANSWERED_FLAG, recording_disclosed: true, consent_status: 'disclosed' });
      const notified = await notifyMissedCall(business, call.caller_phone, 'the forwarded call was not answered');
      log.info('forward_unanswered', { business: business.id, call: call.id, dial_status: form.DialCallStatus, why: dial.why, owner_notified: notified });
      return twimlResponse(pausedTwiml(business, '/api/voice/voicemail'));
    }

    if (form.RecordingUrl) {
      const url = TWILIO_RECORDING_URL.test(form.RecordingUrl) ? form.RecordingUrl : null;
      const parsed = parseSeconds(form.RecordingDuration);
      const secs = parsed ?? Number.NaN;
      const long = parsed !== null && parsed > 0 ? ` (${parsed}s)` : '';
      await updateCall(call.id, {
        status: 'handed_off',
        flagged_reason: `Voicemail left${long}: please call back`,
        ...(url ? { recording_url: url } : {}),
        ...(Number.isFinite(secs) && secs >= 0 ? { duration_sec: secs } : {}),
      });
      await meterVoicemail(call.call_sid ?? callSid, business.id, parsed);
      log.info('voicemail_saved', { business: business.id, call: call.id, seconds: Number.isFinite(secs) ? secs : null });
      return twimlResponse(thanksTwiml());
    }
  } catch (err) {
    log.error('failed', { business: business.id, call: call.id, err });
  }
  return twimlResponse(emptyHangupTwiml());
}
