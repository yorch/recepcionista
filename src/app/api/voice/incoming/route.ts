import { ok, fail } from '@/lib/http';
import { getBusinessByPhone, listBusinesses, createCall, getCallBySid, updateCall } from '@/lib/db';
import { createOrUpdateAgent, getSignedUrl, firstMessageFor, bindPhoneNumber, hasElevenLabs } from '@/lib/voice/elevenlabs';
import { verifyTwilioSignature } from '@/lib/providers/twilio';
import { allowMissedCallAlert, callGate, outOfServiceFirstMessage } from '@/lib/voice/capacity';
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
    const all = matched ? [] : await listBusinesses();
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
