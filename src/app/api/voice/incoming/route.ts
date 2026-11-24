import { ok, fail } from '@/lib/http';
import { getBusinessByPhone, listBusinesses, createCall, getCallBySid, updateCall } from '@/lib/db';
import { createOrUpdateAgent, getSignedUrl, firstMessageFor, bindPhoneNumber, hasElevenLabs } from '@/lib/voice/elevenlabs';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { allowMissedCallAlert, callGate, outOfServiceFirstMessage, pausedFirstMessage } from '@/lib/voice/capacity';
import { resolveCallRoute } from '@/lib/voice/call-mode';
import { markForwarded, markPaused } from '@/lib/voice/non-ai';
import { allowVoicemail, forwardAllowance } from '@/lib/voice/forward-metering';
import { vetForwardNumber } from '@/lib/voice/forward-vet';
import { forwardTwiml, pausedTwiml, twimlResponse, unavailableTwiml } from '@/lib/voice/twiml';
import { alertOwner } from '@/lib/voice/owner-alert';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('voice/incoming');

export const runtime = 'nodejs';

interface IncomingPayload {
  To?: string;
  From?: string;
  CallSid?: string;
  callSid?: string;
  to?: string;
  from?: string;
}

/** Twilio posts form-encoded (signed); the demo UI posts JSON (unsigned, dev only). Accept both. */
async function readPayload(req: Request): Promise<{ payload: IncomingPayload; form: Record<string, string> }> {
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return { payload: (await req.json()) as IncomingPayload, form: {} };
    }
    const form = await req.formData();
    const out: Record<string, string> = {};
    form.forEach((value, key) => {
      if (typeof value === 'string') out[key] = value;
    });
    return { payload: out as IncomingPayload, form: out };
  } catch {
    return { payload: {}, form: {} };
  }
}

async function getCallSid(callSid: string, businessId: string) {
  const row = await getCallBySid(callSid);
  return row && row.business_id === businessId ? row : null;
}

export async function POST(req: Request) {
  try {
    const { payload, form } = await readPayload(req);
    const verdict = verifyTwilioSignature(req, form);
    if (!verdict.ok) {
      log.warn('signature.rejected', { error: verdict.error });
      return fail('forbidden', 403);
    }
    const to = payload.To || payload.to || '';
    const from = payload.From || payload.from || '';

    // A number that is not ours routes to the only business of a single-tenant/demo install, never to
    // "the first of several" (that would hand one tenant another tenant's caller).
    const matched = to ? await getBusinessByPhone(to) : null;
    const all = matched ? [] : await listBusinesses({ limit: 2 });
    const business: Business | null = matched ?? (all.length === 1 ? all[0] : null);
    if (!business) {
      log.error('no_business', { to: to || null, from: from || null });
      return fail('no business configured — run scripts/seed.ts', 404);
    }
    log.info('routed', {
      to: to || null,
      from: from || null,
      business: business.id,
      matched: matched ? 'phone' : 'fallback-first-business',
    });

    // The row is keyed by the Twilio CallSid, which the platform also hands the agent as system__call_sid and
    // the post-call webhook as metadata.phone_call.call_sid: tools and the transcript find THIS row, never a copy.
    // Twilio retries a webhook with the same CallSid: reuse the row.
    const callSid = (payload.CallSid || payload.callSid || '').trim();
    const existing = callSid ? await getCallSid(callSid, business.id) : null;
    const call = existing ?? await createCall({
      business_id: business.id,
      call_sid: callSid || null,
      caller_phone: from || null,
      status: 'in_progress',
      // NOT 'disclosed' yet: that is set below, only once the server knows the disclosure is what the agent will say.
      recording_disclosed: false,
      consent_status: 'unknown',
    });

    // Plan gate: over the call-minutes cap (or no active plan while billing is enforced) the caller hears an honest
    // out-of-service line, the call is handed off (the owner is told when their phone is verified) and no agent is used.
    const gate = await callGate(business.id);
    let allowedSeconds: number | undefined;

    // Call handling mode (paused / forward). A lapsed PLAN stops these too (we do not place or take calls for an inactive account).
    // This is the 'webhook' line (a signed Twilio form POST answered with TwiML), the only kind that can dial a human.
    let route = resolveCallRoute(business, new Date(), 'webhook');
    if (route.action === 'ai' && (business.call_mode ?? 'ai') === 'forward') {
      log.warn('forward_not_applied', { business: business.id, why: route.why });
    }
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    let refusal: string | null = null;
    if (route.action === 'ai' && route.why === 'forward_number_rejected') {
      log.error('forward_number_rejected', { business: business.id, call: call.id, reason: 'stored number no longer passes the forward rules' });
      refusal = 'Forwarding was refused: the forwarding number is not allowed';
    }
    if (route.action === 'forward') {
      // DIAL-TIME checks (never trust what was stored earlier): the target must still pass every forward-number rule and must not be
      // one of the platform's own lines, and the plan must still allow the minutes (the <Dial> is capped to what is left).
      const vet = await vetForwardNumber(business, route.to);
      if (!vet.ok) {
        log.error('forward_number_rejected', { business: business.id, call: call.id, reason: vet.error });
        refusal = 'Forwarding was refused: the forwarding number is not allowed';
        route = { action: 'ai', why: 'forward_number_rejected' };
      } else if (!(gate.ok || gate.reason !== 'no_plan')) {
        // plan lapsed: handled by the out-of-service branch below
      } else {
        const allowance = await forwardAllowance(business.id);
        if (!allowance.ok) {
          if (allowance.why !== 'no_plan') {
            log.warn('forward_refused', { business: business.id, call: call.id, why: allowance.why });
            refusal = allowance.why === 'cap_reached'
              ? 'Forwarding was not used: this month\'s call minutes are used up'
              : allowance.why === 'rate_limited' ? 'Forwarding was not used: too many forwarded calls this hour' : 'Forwarding was not used: the minutes check failed';
            route = { action: 'paused' };
          }
        } else {
          allowedSeconds = allowance.timeLimit;
        }
      }
    }
    // A forward that cannot be dialled never leaves a signed Twilio caller with JSON: they get the voicemail instead.
    if (refusal && route.action === 'ai' && !isJson) route = { action: 'paused' };
    if (route.action !== 'ai' && (gate.ok || gate.reason !== 'no_plan')) {
      if (route.action === 'forward') {
        await markForwarded(call, route.to);
        log.info('forwarded', { business: business.id, call: call.id, time_limit_s: allowedSeconds });
        if (isJson) return ok({ business_id: business.id, call_id: call.id, call_mode: 'forward', forwarded: true, ws_url: null, mock: true });
        return twimlResponse(forwardTwiml(route.to, {
          callerId: business.phone_e164 ?? null, action: '/api/voice/voicemail', timeLimit: allowedSeconds, statusCallback: '/api/voice/dial-status',
        }));
      }
      if (!isJson && !(await allowVoicemail(business.id))) {
        log.warn('voicemail_rate_limited', { business: business.id, call: call.id });
        return twimlResponse(unavailableTwiml());
      }
      await markPaused(business, call, from, refusal);
      if (isJson) {
        return ok({
          agent_id: '', business_id: business.id, call_id: call.id, business_name: business.name, caller_phone: from || null,
          ws_url: null, mock: true, call_mode: 'paused', paused: true, fallback_script: pausedFirstMessage(business),
        });
      }
      return twimlResponse(pausedTwiml(business, '/api/voice/voicemail'));
    }

    if (!gate.ok) {
      if (call.status !== 'handed_off') {
        await updateCall(call.id, { status: 'handed_off', flagged_reason: `out_of_service:${gate.reason ?? 'capacity'}` });
        const alert = (await allowMissedCallAlert(business.id))
          ? await alertOwner(business, `MISSED CALL — ${business.name}\nA call${from ? ` from ${from}` : ''} was not taken by the assistant (${gate.reason === 'no_plan' ? 'plan inactive' : 'monthly call minutes used up'}). Please call back.`)
          : null;
        log.warn('handed_off_out_of_service', { business: business.id, call: call.id, reason: gate.reason, owner_notified: alert?.notified ?? false, alert_suppressed: alert === null });
      }
      return ok({
        agent_id: '',
        business_id: business.id,
        call_id: call.id,
        business_name: business.name,
        caller_phone: from || null,
        ws_url: null,
        mock: true,
        out_of_service: true,
        fallback_script: outOfServiceFirstMessage(business),
      });
    }

    // Best-effort: a failed agent refresh must not drop the call.
    let agentId = '';
    let agentMock = true;
    try {
      const agent = await createOrUpdateAgent({ business, kb: null });
      agentId = agent.agent_id;
      agentMock = agent.mock;
      if (agentId && !agentMock) {
        try { await bindPhoneNumber(agentId); } catch { /* best-effort */ }
      }
    } catch (err) {
      log.error('agent_setup_failed', { business: business.id, err });
    }

    // Server-side evidence that the agent opens with the disclosure: its first message (firstMessageFor, which
    // always contains the notice) was just pushed to a real agent, or this is the scripted demo that speaks the
    // same text. If the agent refresh failed the old first message stands, so the state stays 'unknown'.
    if ((!hasElevenLabs() || !agentMock) && call.consent_status !== 'declined') {
      await updateCall(call.id, { recording_disclosed: true, consent_status: 'disclosed' });
    }

    let wsUrl: string | null = null;
    if (agentId) {
      const signed = await getSignedUrl(agentId);
      wsUrl = signed.signed_url;
      if (!wsUrl) log.warn('no_signed_url', { business: business.id, agent: agentId });
    }
    log.info('call_started', {
      business: business.id,
      call: call.id,
      agent: agentId || null,
      live: Boolean(agentId && wsUrl),
    });

    return ok({
      agent_id: agentId,
      business_id: business.id,
      call_id: call.id,
      business_name: business.name,
      caller_phone: from || null,
      ws_url: wsUrl,
      mock: agentMock || !wsUrl,
      fallback_script: firstMessageFor(business),
    });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Twilio health-check / browser probe. Reveals nothing about tenants. */
export async function GET() {
  return ok({ ready: true });
}
