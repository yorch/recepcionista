/**
 * ElevenLabs "conversation initiation client data" webhook (native Twilio integration).
 *
 * ElevenLabs POSTs { caller_id, agent_id, called_number, call_sid, conversation_id } BEFORE the call is answered and
 * expects { type: 'conversation_initiation_client_data', dynamic_variables, conversation_config_override }.
 * (Source: ElevenLabs docs "Twilio personalization". The docs do not say what the platform does when the webhook
 * fails or times out, so every path here answers 200 with a well-formed body once the caller is authenticated.)
 *
 * This is where the recording/AI disclosure evidence is created on the native path: the endpoint injects the
 * disclosure into `conversation_config_override.agent.first_message`, and ONLY THEN records
 * `recording_disclosed = true` / `consent_status = 'disclosed'` on the call row. It also enforces the call cap.
 *
 * Auth: the shared tool secret header (x-recepcionista-tool-secret), the same value and check as the tool webhooks;
 * fails closed in production when ELEVENLABS_TOOL_SECRET is unset.
 */
import { getBusinessByAgentId, getBusinessByPhone, updateCall, upsertCallForConversation } from '@/lib/db';
import { firstMessageFor, verifyToolSecret } from '@/lib/voice/elevenlabs';
import { callGate, outOfServiceFirstMessage } from '@/lib/voice/capacity';
import { alertOwner } from '@/lib/voice/owner-alert';
import { nowVariables } from '@/lib/time';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('voice/initiation');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Every dynamic variable the agent declares (provisioning placeholders), so the platform never lacks one. */
function variables(business: Business | null, extra: { caller: string; callSid: string }) {
  return {
    business_id: business?.id ?? '',
    ...nowVariables(business),
    call_sid: extra.callSid,
    caller_phone: extra.caller,
  };
}

export async function POST(req: Request): Promise<Response> {
  const auth = verifyToolSecret(req);
  if (!auth.ok) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw) {
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }
  } catch { /* empty body: handled as an unknown tenant */ }

  const agentId = text(body.agent_id);
  const calledNumber = text(body.called_number);
  const callerId = text(body.caller_id);
  const callSid = text(body.call_sid);
  const conversationId = text(body.conversation_id);
  const empty = (): Response => json({
    type: 'conversation_initiation_client_data',
    dynamic_variables: variables(null, { caller: callerId, callSid }),
  });

  try {
    // Tenant: the platform agent id (ambiguity fails closed), else the dialled number. A disagreement is refused.
    const byAgent = agentId ? await getBusinessByAgentId(agentId) : null;
    const byNumber = calledNumber ? await getBusinessByPhone(calledNumber) : null;
    if (byAgent && byNumber && byAgent.id !== byNumber.id) {
      log.error('tenant.mismatch', { agent_business: byAgent.id, number_business: byNumber.id });
      return empty();
    }
    const business = byAgent ?? byNumber;
    if (!business) {
      log.error('no_business', { agent: agentId || null, called: calledNumber || null });
      return empty();
    }

    // ONE call row per call, keyed by call SID and conversation id (shared with /api/voice/incoming and the tools).
    const call = await upsertCallForConversation(business.id, {
      callSid: callSid || undefined, conversationId: conversationId || undefined, callerPhone: callerId || null,
    });

    const gate = await callGate(business.id);
    const outOfService = !gate.ok;
    const firstMessage = outOfService ? outOfServiceFirstMessage(business) : firstMessageFor(business);

    if (call) {
      // Both messages open with disclosureFor(business): the override below is the server-side evidence.
      // A previously recorded objection is never overwritten (the write layer keeps 'declined' sticky).
      await updateCall(call.id, { recording_disclosed: true, consent_status: 'disclosed' });
      if (outOfService && call.status !== 'handed_off') {
        await updateCall(call.id, { status: 'handed_off', flagged_reason: `out_of_service:${gate.reason ?? 'capacity'}` });
        const who = callerId ? ` from ${callerId}` : '';
        const alert = await alertOwner(business, `MISSED CALL — ${business.name}\nA call${who} was not taken by the assistant (${gate.reason === 'no_plan' ? 'plan inactive' : 'monthly call minutes used up'}). Please call back.`);
        log.warn('call.handed_off_out_of_service', { business: business.id, call: call.id, reason: gate.reason, owner_notified: alert.notified });
      }
    } else {
      log.warn('no_call_key', { business: business.id });
    }

    return json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: variables(business, { caller: callerId, callSid }),
      conversation_config_override: { agent: { first_message: firstMessage } },
    });
  } catch (err) {
    log.error('failed', { err });
    return empty();
  }
}

/** Probe for provisioning checks; reveals nothing about tenants. */
export async function GET() {
  return json({ ready: true });
}
