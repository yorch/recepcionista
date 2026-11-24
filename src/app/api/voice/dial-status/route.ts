/**
 * Twilio per-leg status callback of a forwarded call (`<Number statusCallback ... statusCallbackEvent="completed">`).
 * It reports the bridged duration even when the CALLER hangs up first (when the <Dial action> may not be delivered), so the forwarded
 * minutes are always metered. Signed like every Twilio webhook; the business comes from the parent CallSid row, never from the
 * request; the seconds are added once per parent call (claimEvent), whichever callback arrives first.
 */
import { getCallBySid } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { meterForwardedCall, parseSeconds } from '@/lib/voice/forward-metering';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('voice/dial-status');
const empty = (status = 200) => new Response(null, { status });

export async function POST(req: Request): Promise<Response> {
  const form: Record<string, string> = {};
  try {
    (await req.formData()).forEach((v, k) => { if (typeof v === 'string') form[k] = v; });
  } catch { /* empty body */ }
  const verdict = verifyTwilioSignature(req, form);
  if (!verdict.ok) {
    log.warn('signature.rejected', { error: verdict.error });
    return empty(403);
  }
  // The child leg's own CallSid is `CallSid`; the call we know is its parent.
  const parentSid = (form.ParentCallSid ?? '').trim();
  const call = parentSid ? await getCallBySid(parentSid) : null;
  if (!call) {
    log.warn('unknown_call', { has_parent: Boolean(parentSid) });
    return empty();
  }
  const seconds = parseSeconds(form.CallDuration ?? form.DialCallDuration);
  const outcome = await meterForwardedCall(parentSid, call.business_id, seconds);
  log.info('forward_metered', { business: call.business_id, call: call.id, seconds, outcome });
  // A failed write is retried by Twilio (non-2xx); everything else is final.
  return empty(outcome === 'failed' ? 503 : 200);
}
