import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness, getKnowledgeBase, listBusinesses } from '@/lib/db';
import { buildSystemPrompt } from '@/lib/kb';
import { TOOL_NAMES } from '@/lib/voice/tools';
import { firstMessageFor, hasElevenLabs, agentIdFor } from '@/lib/voice/elevenlabs';

export const runtime = 'nodejs';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  check_availability: 'Look up open appointment slots before offering a time.',
  create_booking: 'Book the appointment once the caller agrees to a time.',
  send_sms: 'Text the caller or the owner.',
  create_payment_link: 'Create and text a secure deposit link (the amount is set by the business\'s deposit policy, not by you).',
  flag_emergency: 'Mark the call as an emergency and alert the owner now.',
  get_pricing: 'Look up a starting price — never quote from memory.',
  handoff_to_human: 'Transfer the caller to the owner.',
  reschedule_booking: "Move the caller's own booking (caller-id verified).",
  cancel_booking: "Cancel the caller's own booking after they confirm (caller-id verified).",
};

export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // full system prompt: owner+, own business only
  if (!auth.ok) return auth.response;
  try {
    const url = new URL(req.url);
    const requestedId = scopeBusinessId(auth.principal, url.searchParams.get('business_id')) ?? '';
    if (requestedId) requireBusinessAccess(auth.principal, requestedId);
    const business = requestedId
      ? await getBusiness(requestedId)
      : (await listBusinesses({ limit: 1 }))[0] ?? null;

    if (!business) {
      return fail(requestedId ? `business ${requestedId} not found` : 'no business configured', 404);
    }

    const kb = await getKnowledgeBase(business.id);
    const systemPrompt = kb?.system_prompt?.trim()
      || buildSystemPrompt(business, {
        services: kb?.services ?? [],
        faqs: kb?.faqs ?? [],
        pricing_notes: kb?.pricing_notes ?? '',
      });

    // The owner's number is only in the prompt text for human readers: handoff/alerts are done
    // server-side from the business record, so the voice agent never needs the digits. Mask it
    // unless the admin explicitly asks (?include_owner_phone=1).
    const includeOwnerPhone = url.searchParams.get('include_owner_phone') === '1';
    const mask = (text: string): string =>
      !includeOwnerPhone && business.owner_phone ? text.split(business.owner_phone).join('[owner phone omitted]') : text;

    return ok({
      business_id: business.id,
      business_name: business.name,
      system_prompt: mask(systemPrompt),
      first_message: firstMessageFor(business),
      language: 'en',
      language_mode: 'auto',
      voice_id: process.env.ELEVENLABS_VOICE_ID || null,
      agent_id: agentIdFor(business) || null,
      elevenlabs: hasElevenLabs(),
      tools: [...TOOL_NAMES],
      tool_definitions: TOOL_NAMES.map((name) => ({
        name,
        description: TOOL_DESCRIPTIONS[name],
        endpoint: `/api/voice/tools/${name}`,
      })),
      call_script: kb?.call_script ? mask(kb.call_script) : null,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
