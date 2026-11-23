import { ok, fail } from '@/lib/http';
import { guardAdmin } from '@/lib/admin-guard';
import { getBusiness, getKnowledgeBase, listBusinesses } from '@/lib/db';
import { buildSystemPrompt } from '@/lib/kb';
import { TOOL_NAMES } from '@/lib/voice/tools';
import { firstMessageFor, hasElevenLabs, agentIdFor } from '@/lib/voice/elevenlabs';

export const runtime = 'nodejs';

const TOOL_DESCRIPTIONS: Record<string, string> = {
  check_availability: 'Look up open appointment slots before offering a time.',
  create_booking: 'Book the appointment once the caller agrees to a time.',
  send_sms: 'Text the caller or the owner.',
  create_payment_link: 'Create and text a secure deposit link (max $500).',
  flag_emergency: 'Mark the call as an emergency and alert the owner now.',
  get_pricing: 'Look up a starting price — never quote from memory.',
  handoff_to_human: 'Transfer the caller to the owner.',
};

export async function GET(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const requestedId = url.searchParams.get('business_id') ?? '';
    const business = requestedId
      ? await getBusiness(requestedId)
      : (await listBusinesses())[0] ?? null;

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

    return ok({
      business_id: business.id,
      business_name: business.name,
      system_prompt: systemPrompt,
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
      call_script: kb?.call_script ?? null,
    });
  } catch (err) {
    return fail(err, 500);
  }
}
