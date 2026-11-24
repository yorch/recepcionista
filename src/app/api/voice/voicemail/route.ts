/**
 * Twilio callback for the non-AI call modes (Twilio signature required, like /api/voice/incoming):
 *  - the result of a forwarded <Dial> (`DialCallStatus`): answered -> done; not answered / busy / failed -> the caller is
 *    offered the voicemail (recording notice first) and a verified owner is told, rate limited;
 *  - the finished voicemail <Record> (`RecordingUrl`): stored on the call row so the owner sees it in Calls > Voicemails (played back
 *    through the authenticated proxy /api/calls/:id/voicemail; the Twilio URL itself is never sent to a browser).
 * Forwarded and voicemail seconds are METERED here (once per call, claimEvent) into the plan's call minutes (forward-metering.ts).
 * No tenant data is taken from the request: the call is found by its CallSid and the business comes from that row.
 */
import { getBusiness, getCallBySid, updateCall } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { allowVoicemail, meterForwardedCall, meterVoicemail, parseSeconds } from '@/lib/voice/forward-metering';
import { FORWARD_UNANSWERED_FLAG, notifyMissedCall } from '@/lib/voice/non-ai';
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
      const status = form.DialCallStatus;
      if (status === 'completed' || status === 'answered') {
        const secs = parseSeconds(form.DialCallDuration);
        await updateCall(call.id, { status: 'completed', ...(secs !== null ? { duration_sec: secs } : {}) });
        await meterForwardedCall(call.call_sid ?? callSid, business.id, secs);
        return twimlResponse(emptyHangupTwiml());
      }
      // Nobody picked up: fall back to the voicemail (the notice below is spoken before the beep).
      // Ringing time that was bridged before the far end dropped (rare) is still real minutes.
      await meterForwardedCall(call.call_sid ?? callSid, business.id, parseSeconds(form.DialCallDuration));
      if (!(await allowVoicemail(business.id))) {
        log.warn('voicemail_rate_limited', { business: business.id, call: call.id });
        return twimlResponse(unavailableTwiml());
      }
      await updateCall(call.id, { status: 'handed_off', flagged_reason: FORWARD_UNANSWERED_FLAG, recording_disclosed: true, consent_status: 'disclosed' });
      const notified = await notifyMissedCall(business, call.caller_phone, 'the forwarded call was not answered');
      log.info('forward_unanswered', { business: business.id, call: call.id, dial_status: status, owner_notified: notified });
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
