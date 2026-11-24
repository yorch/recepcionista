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
import { getBusinessByAgentId, getBusinessByPhone, setCallTrust, setTransferStatus, updateCall, upsertCallForConversation } from '@/lib/db';
import { firstMessageFor, verifyToolSecret } from '@/lib/voice/elevenlabs';
import { allowMissedCallAlert, callGate, outOfServiceOverride, pausedOverride } from '@/lib/voice/capacity';
import { resolveCallRoute } from '@/lib/voice/call-mode';
import { markPausedNative } from '@/lib/voice/non-ai';
import { alertOwner } from '@/lib/voice/owner-alert';
import { missedCallText } from '@/lib/voice/non-ai';
import { makeT } from '@/lib/i18n';
import { ownerLocaleFor } from '@/lib/i18n/owner-locale';
import { decideTransfer, forwardFirstMessage, NO_TRANSFER, transferTargetNow, type TransferVariables } from '@/lib/voice/transfer';
import { enterOwnerMode } from '@/lib/voice/owner/session';
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
function variables(business: Business | null, extra: { caller: string; callSid: string }, transfer: TransferVariables = NO_TRANSFER) {
  return {
    ...transfer,
    business_id: business?.id ?? '',
    ...nowVariables(business),
    call_sid: extra.callSid,
    caller_phone: extra.caller,
    owner_mode: 'false', // server-set per call; 'true' only on the verified owner line (voice/owner/session.ts)
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

    // OWNER CALL-IN: the caller id equals the business's VERIFIED owner number -> the row becomes kind 'owner' (server side, here only) and the
    // call gets the private owner prompt. Spoofable caller id grants a conversation, never a change: every change needs the owner's SMS reply.
    // Owner calls skip the minute-cap / call-handling branches below (they are limited by their own 5 minute maximum), and store no transcript.
    try {
      const ownerEntry = await enterOwnerMode(business, call, callerId, { planLapsed: outOfService && gate.reason === 'no_plan' });
      if (ownerEntry) {
        return json({
          type: 'conversation_initiation_client_data',
          dynamic_variables: { ...variables(business, { caller: callerId, callSid }), ...ownerEntry.variables },
          conversation_config_override: ownerEntry.override,
        });
      }
    } catch (err) { log.error('owner_mode_failed', { business: business.id, err }); }

    // Call handling mode. On this path the platform answers the call itself, so nothing here can dial a human: both
    // 'paused' and a due 'forward' become the paused script (message + callback capture) with a short maximum duration.
    // A lapsed plan keeps winning (out-of-service text); a used-up minutes cap does not block these (no AI minutes needed
    // beyond the short message). See docs/known-limitations.md "Call forwarding on the native ElevenLabs path".
    // The same decision the tools use (voice/tools.ts refuses booking, texting and payments whenever it is not 'ai'), on the 'native' line,
    // where a due forward can only ever be the paused script (forwarding is not available on this line: docs/known-limitations.md).
    const route = resolveCallRoute(business, new Date(), 'native');
    const planLapsed = outOfService && gate.reason === 'no_plan';

    // Live transfer (NATIVE_TRANSFER=on, voice/transfer.ts). A due forward charges the forward machinery NOW (budgets, caps, concurrency) and, when
    // approved, the agent transfers straight away to the re-vetted verified number; refused, it is the paused script (callback capture).
    // Otherwise the per-call destination is set only when a mid-call transfer_to_human would be allowed (the tool re-checks and charges then).
    // STIR: the native path may carry no verstat (docs/known-limitations.md); absent => stranger treatment.
    const stirStatus = text(body.stir_verstat) || text(body.StirVerstat) || text(body.stir_status) || null;
    let transferVars: TransferVariables = NO_TRANSFER;
    let transferStarted = false;
    let refusedWhy: string | null = null;
    if (route.action === 'forward' && !planLapsed) {
      const d = await decideTransfer(business, { callSid, from: callerId, stirStatus });
      if (d.ok) { transferVars = { transfer_mode: 'forward', transfer_destination: d.to }; transferStarted = true; }
      else { refusedWhy = d.why; log.warn('transfer_refused', { business: business.id, why: d.why }); }
    } else if (route.action === 'ai' && !outOfService) {
      const t = await transferTargetNow(business, { callSid, from: callerId });
      if (t.ok) transferVars = { transfer_mode: 'available', transfer_destination: t.to };
    }
    const nonAi: 'paused' | 'forward' | null = route.action === 'paused' ? (route.why === 'forward_unavailable_on_line' ? 'forward' : 'paused')
      : route.action === 'forward' && !transferStarted ? 'forward' : null;
    const usePausedScript = nonAi !== null && !planLapsed;
    const override = transferStarted
      ? { agent: { first_message: forwardFirstMessage(business) } }
      : usePausedScript
        ? pausedOverride(business)
        : outOfService ? outOfServiceOverride(business) : { agent: { first_message: firstMessageFor(business) } };

    if (call) {
      // Both messages open with disclosureFor(business): the override below is the server-side evidence.
      // A previously recorded objection is never overwritten (the write layer keeps 'declined' sticky).
      await updateCall(call.id, { recording_disclosed: true, consent_status: 'disclosed' });
      if (stirStatus) { try { await setCallTrust(call.id, stirStatus); } catch { /* best-effort */ } }
      if (transferStarted) {
        await setTransferStatus(call.id, 'attempted');
        await updateCall(call.id, { summary: 'Transferring to the business (call handling: forward).' });
      } else if (usePausedScript && nonAi) await markPausedNative(business, call, callerId || null, nonAi, refusedWhy);
      else if (outOfService && call.status !== 'handed_off') {
        await updateCall(call.id, { status: 'handed_off', flagged_reason: `out_of_service:${gate.reason ?? 'capacity'}` });
        const who = callerId ? ` from ${callerId}` : '';
        // Rate limited per business (1 / 10 min, 6 / hour): a lapsed tenant must not be a free SMS pump.
        const alert = (await allowMissedCallAlert(business.id))
          ? await alertOwner(business, await missedCallText(business, who.replace(/^ from /, '') || null, makeT(await ownerLocaleFor(business))(gate.reason === 'no_plan' ? 'alert.missed.noPlan' : 'alert.missed.noMinutes')))
          : null;
        log.warn('call.handed_off_out_of_service', { business: business.id, call: call.id, reason: gate.reason, owner_notified: alert?.notified ?? false, alert_suppressed: alert === null });
      }
    } else {
      log.warn('no_call_key', { business: business.id });
    }

    return json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: variables(business, { caller: callerId, callSid }, transferVars),
      conversation_config_override: override,
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
