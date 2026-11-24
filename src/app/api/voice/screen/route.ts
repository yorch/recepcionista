/**
 * Call screening whisper (Twilio `<Dial><Number url="/api/voice/screen">`), run on the OWNER's leg after they answer, before bridging.
 * First request: "<business> call from <number>. Press 1 to accept." (Gather). With Digits=1: accept (empty TwiML -> bridged). Anything
 * else / no input: hang up the owner's leg (the Dial ends unanswered -> voicemail; nothing is metered). Twilio-signed; the tenant and the
 * caller number come from the PARENT call row, never from the request body.
 */
import { getBusiness, getCallBySid } from '@/lib/db';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { markScreenAccepted, markScreenDeclined, markScreenStarted } from '@/lib/voice/screening';
import { screenAcceptTwiml, screenDeclineTwiml, screenPromptTwiml, twimlResponse } from '@/lib/voice/twiml';
import { logger } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const log = logger('voice/screen');

export async function POST(req: Request): Promise<Response> {
  const form: Record<string, string> = {};
  try { (await req.formData()).forEach((v, k) => { if (typeof v === 'string') form[k] = v; }); } catch { /* empty */ }
  const verdict = verifyTwilioSignature(req, form);
  if (!verdict.ok) { log.warn('signature.rejected', { error: verdict.error }); return new Response('forbidden', { status: 403 }); }

  const parentSid = (form.ParentCallSid ?? '').trim();
  const call = parentSid ? await getCallBySid(parentSid) : null;
  const business = call ? await getBusiness(call.business_id) : null;
  if (!call || !business) { log.warn('unknown_call', { has_parent: Boolean(parentSid) }); return twimlResponse(screenDeclineTwiml()); }

  const digits = (form.Digits ?? '').trim();
  if (!('Digits' in form)) {
    await markScreenStarted(parentSid);
    return twimlResponse(screenPromptTwiml(business, call.caller_phone, '/api/voice/screen'));
  }
  if (digits === '1') {
    await markScreenAccepted(parentSid);
    log.info('screen_accepted', { business: business.id, call: call.id });
    return twimlResponse(screenAcceptTwiml());
  }
  await markScreenDeclined(parentSid);
  log.info('screen_declined', { business: business.id, call: call.id, pressed: digits || null });
  return twimlResponse(screenDeclineTwiml());
}
