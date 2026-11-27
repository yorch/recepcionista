import { configEnv } from '@/lib/config';
import { ok, fail, readiness } from '@/lib/http';
import { insecureDevAllowed } from '@/lib/auth';
import { getBusinessByPhone, listBusinesses, createCall, getCallBySid, updateCall } from '@/lib/db';
import { syncAgent, getSignedUrl, firstMessageFor, hasElevenLabs } from '@/lib/voice/elevenlabs';
import { registerTwilioCall } from '@/lib/voice/elevenlabs-phone';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { allowMissedCallAlert, callGate, outOfServiceFirstMessage, pausedFirstMessage } from '@/lib/voice/capacity';
import { resolveCallRoute } from '@/lib/voice/call-mode';
import { markAiUnavailable, markForwarded, markPaused, markUnavailable } from '@/lib/voice/non-ai';
import { forwardAllowance, voicemailAllowance } from '@/lib/voice/forward-metering';
import { vetForwardNumber } from '@/lib/voice/forward-vet';
import { forwardRingSeconds, forwardTwiml, lineNoticeTwiml, pausedTwiml, twimlResponse, unavailableTwiml } from '@/lib/voice/twiml';
import { alertOwner } from '@/lib/voice/owner-alert';
import { missedCallText } from '@/lib/voice/non-ai';
import { makeT } from '@/lib/i18n';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import { setCallTrust } from '@/lib/db';
import { enterOwnerMode } from '@/lib/voice/owner/session';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';
import { knobOr } from '@/lib/admin/tenant-knobs';

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
  // A signed Twilio call (form post) is ALWAYS answered with TwiML; only the unsigned demo UI (JSON) gets JSON.
  const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
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
      if (!isJson) return twimlResponse(unavailableTwiml());
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

    // STIR/SHAKEN: Twilio reports the caller-id verification as `StirVerstat` (form post; unsigned JSON demo posts have none). Stored on the
    // call; per-caller budgets and known-customer capacity apply only to attestation A (voice/caller-limits.ts).
    const stirStatus = (form.StirVerstat ?? form.StirStatus ?? '').trim() || null;
    if (!existing || stirStatus) { try { await setCallTrust(call.id, stirStatus); } catch (err) { log.warn('trust_store_failed', { call: call.id, err }); } }

    // Plan gate: over the call-minutes cap (or no active plan while billing is enforced) the caller hears an honest
    // out-of-service line, the call is handed off (the owner is told when their phone is verified) and no agent is used.
    const gate = await callGate(business.id);
    let allowedSeconds: number | undefined;

    // OWNER CALL-IN (voice/owner): the caller id equals the VERIFIED owner number -> kind 'owner' (server side), private prompt, 5 minute
    // limit, never blocked by the minute caps, no customer artifacts. A spoofed id only gets a conversation: changes need the owner's SMS.
    try {
      const ownerEntry = await enterOwnerMode(business, call, from, { planLapsed: !gate.ok && gate.reason === 'no_plan', stirStatus });
      if (ownerEntry) {
        let agentId = '';
        let agentMock = true;
        let wsUrl: string | null = null;
        try {
          const agent = await syncAgent({ business, kb: null }) // syncAgent loads the stored KB itself;
          agentId = agent.agent_id;
          agentMock = agent.mock;
          if (agentId) wsUrl = (await getSignedUrl(agentId)).signed_url ?? null;
        } catch (err) { log.error('owner_agent_setup_failed', { business: business.id, err }); }
        if (!isJson) {
          // Webhook line: connect the owner to the private assistant through ElevenLabs' register-call TwiML (UNVERIFIED shape, voice/elevenlabs-phone.ts),
          // else say plainly that the owner line is not available here. Never JSON to Twilio.
          if (agentId && !agentMock && registerCallEnabled()) {
            const rc = await registerTwilioCall({ agentId, from, to, dynamicVariables: { ...ownerEntry.variables, call_sid: callSid, caller_phone: from }, configOverride: ownerEntry.override as unknown as Record<string, unknown> });
            if (rc.ok) return twimlResponse(rc.twiml);
            log.warn('owner_register_call_failed', { business: business.id, error: rc.error });
          }
          return twimlResponse(lineNoticeTwiml('owner'));
        }
        return ok({
          agent_id: agentId, business_id: business.id, call_id: call.id, business_name: business.name, caller_phone: from || null,
          ws_url: wsUrl, mock: agentMock || !wsUrl, owner_mode: true, dynamic_variables: ownerEntry.variables,
          conversation_config_override: ownerEntry.override, fallback_script: ownerEntry.override.agent.first_message,
        });
      }
    } catch (err) { log.error('owner_mode_failed', { business: business.id, err }); }

    // Call handling mode (paused / forward). A lapsed PLAN stops these too (we do not place or take calls for an inactive account).
    // This is the 'webhook' line (a signed Twilio form POST answered with TwiML), the only kind that can dial a human.
    let route = resolveCallRoute(business, new Date(), 'webhook');
    if (route.action === 'ai' && (business.call_mode ?? 'ai') === 'forward') {
      log.warn('forward_not_applied', { business: business.id, why: route.why });
    }
    let refusal: string | null = null;
    // The CALLER is the reason a forward was refused (their own hourly budget): the owner is not texted about it.
    let callerLimited = false;
    let knownCaller = false;
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
        const allowance = await forwardAllowance(business.id, configEnv(), { business, callSid: callSid || null, from, stirStatus });
        knownCaller = allowance.known ?? false;
        if (!allowance.ok) {
          if (allowance.why !== 'no_plan') {
            log.warn('forward_refused', { business: business.id, call: call.id, why: allowance.why });
            callerLimited = allowance.why === 'caller_limited';
            refusal = allowance.why === 'cap_reached'
              ? 'Forwarding was not used: this month\'s forwarded-call minutes are used up'
              : allowance.why === 'rate_limited' ? 'Forwarding was not used: too many forwarded calls this hour'
                : allowance.why === 'caller_limited' ? 'Forwarding was not used: too many calls from this number this hour'
                  : allowance.why === 'concurrent_limit' ? 'Forwarding was not used: too many forwarded calls at the same time' : 'Forwarding was not used: the minutes check failed';
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
          ringSeconds: await knobOr(business.id, 'forward.ring_seconds', forwardRingSeconds()), screenUrl: '/api/voice/screen',
        }));
      }
      if (!isJson) {
        const vm = await voicemailAllowance(business.id, configEnv(), { business, callSid: callSid || null, from, stirStatus });
        if (!vm.ok) {
          // Over their own limit (or the stranger share): the cheap path, nothing is recorded, and the owner is not texted for it.
          log.warn('voicemail_refused', { business: business.id, call: call.id, why: vm.why });
          const callerCaused = vm.why === 'caller_limited' || vm.why === 'unknown_reserved';
          await markUnavailable(business, call, from, vm.why === 'cap_reached' ? 'the voicemail minutes of this month are used up' : callerCaused ? 'too many calls from this number' : 'too many voicemails this hour', {
            notify: !callerCaused, known: vm.known,
          });
          return twimlResponse(unavailableTwiml());
        }
      }
      await markPaused(business, call, from, refusal, { notify: !callerLimited, known: knownCaller });
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
          ? await alertOwner(business, await missedCallText(business, from, makeT(await ownerLocaleFor(business))(gate.reason === 'no_plan' ? 'alert.missed.noPlan' : 'alert.missed.noMinutes')))
          : null;
        log.warn('handed_off_out_of_service', { business: business.id, call: call.id, reason: gate.reason, owner_notified: alert?.notified ?? false, alert_suppressed: alert === null });
      }
      if (!isJson) return twimlResponse(unavailableTwiml()); // the honest out-of-service line, never JSON to Twilio
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
      const agent = await syncAgent({ business, kb: null }) // syncAgent loads the stored KB itself;
      agentId = agent.agent_id;
      agentMock = agent.mock;
    } catch (err) {
      log.error('agent_setup_failed', { business: business.id, err });
    }

    // Server-side evidence that the agent opens with the disclosure: its first message (firstMessageFor, which
    // always contains the notice) was just pushed to a real agent, or this is the scripted demo (outside production) that
    // speaks the same text. If the agent refresh failed, or production has no ElevenLabs key (nothing speaks any notice),
    // the state stays 'unknown'.
    if ((!agentMock || (!hasElevenLabs() && process.env.NODE_ENV !== 'production')) && call.consent_status !== 'declined') {
      await updateCall(call.id, { recording_disclosed: true, consent_status: 'disclosed' });
    }

    if (!isJson) {
      // Signed Twilio form post: the AI is connected through ElevenLabs' register-call TwiML when it works (UNVERIFIED shape, isolated in
      // voice/elevenlabs-phone.ts); otherwise the caller gets the honest voicemail (never JSON, never silence).
      if (agentId && !agentMock && registerCallEnabled()) {
        const rc = await registerTwilioCall({ agentId, from, to, dynamicVariables: { business_id: business.id, call_sid: callSid, caller_phone: from } });
        if (rc.ok) {
          log.info('call_started', { business: business.id, call: call.id, agent: agentId, live: true, via: 'register_call' });
          return twimlResponse(rc.twiml);
        }
        log.warn('register_call_failed', { business: business.id, call: call.id, error: rc.error });
      }
      return voicemailFallback(business, call, from, callSid, stirStatus);
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
    log.error('incoming_failed', { err });
    if (!isJson) return twimlResponse(lineNoticeTwiml('ai'));
    return fail(err, 500);
  }
}

/** ELEVENLABS_REGISTER_CALL=off skips the register-call connection (the AI branch of a webhook line then always takes a voicemail). Default on. */
const registerCallEnabled = (): boolean => (configEnv().ELEVENLABS_REGISTER_CALL ?? '').trim().toLowerCase() !== 'off';

/** The AI cannot be reached on this webhook line: the caller is told so plainly and may leave a recorded message (same budget checks as a paused line). */
async function voicemailFallback(business: Business, call: Awaited<ReturnType<typeof createCall>>, from: string, callSid: string, stirStatus: string | null): Promise<Response> {
  const vm = await voicemailAllowance(business.id, configEnv(), { business, callSid: callSid || null, from, stirStatus });
  if (!vm.ok) {
    const callerCaused = vm.why === 'caller_limited' || vm.why === 'unknown_reserved';
    await markUnavailable(business, call, from, vm.why === 'cap_reached' ? 'the voicemail minutes of this month are used up' : callerCaused ? 'too many calls from this number' : 'too many voicemails this hour', { notify: !callerCaused, known: vm.known });
    return twimlResponse(unavailableTwiml());
  }
  await markAiUnavailable(business, call, from);
  return twimlResponse(pausedTwiml(business, '/api/voice/voicemail'));
}

/** Readiness probe (reveals nothing about tenants): 200 only when Twilio signatures can be verified (TWILIO_AUTH_TOKEN set, or the local-dev opt-in is on). */
export async function GET() {
  return readiness(Boolean(configEnv().TWILIO_AUTH_TOKEN) || insecureDevAllowed());
}
