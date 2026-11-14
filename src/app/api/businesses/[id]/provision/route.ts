import { ok, fail } from '@/lib/http';
import { getBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { extractFromUrl, templateResult } from '@/lib/extraction';
import { generateKnowledgeBase, promptIsDeficient } from '@/lib/kb';
import { provisionNumber } from '@/lib/providers/twilio';
import { createOrUpdateAgent } from '@/lib/voice/elevenlabs';
import type { Business, KnowledgeBase } from '@/lib/types';

export const runtime = 'nodejs';

export interface ProvisionResult {
  business: Business;
  knowledge_base: KnowledgeBase;
  phone: string;
  mock: boolean;
  agent_id?: string;
  agent_mock?: boolean;
  regenerated?: boolean;
}

/** True when the stored prompt no longer reflects the business's own facts. */
function kbIsStale(kb: KnowledgeBase, business: Business): boolean {
  if (!kb.system_prompt?.trim()) return true;
  if (business.name && !kb.system_prompt.includes(business.name)) return true;
  // A curated prompt written before this business had a phone line still needs
  // the number injected, otherwise the agent cannot identify its own line.
  if (business.phone && !kb.system_prompt.includes(business.phone)) return true;
  return false;
}

/**
 * Regen gate for an existing KB: rebuild only when the prompt is missing rules
 * the voice agent needs, or has drifted from the business's identity/phone.
 * A correct curated prompt is left untouched so owner edits survive re-runs.
 */
function kbNeedsRegen(kb: KnowledgeBase, business: Business): boolean {
  return promptIsDeficient(kb.system_prompt) || kbIsStale(kb, business);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  try {
    const { id } = await params;
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    let force = false;
    try {
      const body = await req.clone().json().catch(() => ({}));
      force = Boolean((body as { force?: unknown })?.force);
    } catch {
      force = false;
    }

    let kb = await getKnowledgeBase(id);
    let regenerated = false;

    if (!kb || force || kbIsStale(kb, business)) {
      // Preserve curated services/faqs; only rebuild what is missing or out of date.
      const keepServices = !force && kb && kb.services.length > 0 ? kb : null;
      let generated;
      if (keepServices) {
        generated = generateKnowledgeBase(
          {
            name: business.name,
            services: keepServices.services,
            hours: business.hours ?? {},
            service_area: business.service_area ?? [],
            faqs: keepServices.faqs,
            pricing_notes: keepServices.pricing_notes,
            confidence: 'high',
            source: 'scrape',
          },
          business,
        );
      } else {
        let extraction;
        try {
          extraction = business.url ? await extractFromUrl(business.url) : templateResult(business.name);
        } catch {
          extraction = templateResult(business.name);
        }
        generated = generateKnowledgeBase(extraction, business);
      }
      kb = await upsertKnowledgeBase(id, generated);
      regenerated = true;
    }

    // Preserve the business's existing line: CONTRACTS.md documents the demo
    // number (+13055550142) and WS3 routes inbound calls by phone, so a reset
    // must not hand the business a new one. Provision only if it has none.
    let phone = business.phone;
    let mock = true;
    if (!phone) {
      const provisioned = await provisionNumber('305');
      phone = provisioned.phone;
      mock = provisioned.mock;
    } else {
      mock = phone.includes('555'); // mock-pool numbers are issued as +1<area>555xxxx
    }
    let updated = await updateBusiness(id, { phone, status: 'live' });
    if (!updated) return fail('business not found', 404);

    // Only rebuild the prompt when it genuinely fails our rules — a curated or
    // already-correct KB is left byte-identical so owners keep their edits.
    if (kbNeedsRegen(kb, updated)) {
      kb = await upsertKnowledgeBase(id, generateKnowledgeBase(
        {
          name: updated.name,
          services: kb.services,
          hours: updated.hours ?? {},
          service_area: updated.service_area ?? [],
          faqs: kb.faqs,
          pricing_notes: kb.pricing_notes,
          confidence: 'high',
          source: 'scrape',
        },
        updated,
      ));
      regenerated = true;
    }

    // 3. Register the ElevenLabs agent against THIS knowledge base so the live
    //    phone line speaks the prompt we just wrote. Best-effort by design:
    //    a failed registration must never leave the business unprovisioned.
    let agentId: string | undefined;
    let agentMock: boolean | undefined;
    try {
      const agent = await createOrUpdateAgent({ business: updated, kb });
      agentId = agent.agent_id;
      agentMock = agent.mock;
      if (!agent.mock && agent.agent_id && agent.agent_id !== updated.agent_id) {
        const withAgent = await updateBusiness(id, { agent_id: agent.agent_id });
        if (withAgent) updated = withAgent;
      }
    } catch (err) {
      console.warn('[provision] agent registration failed:', (err as Error).message);
    }

    return ok<ProvisionResult>({
      business: updated,
      knowledge_base: kb,
      phone,
      mock,
      agent_id: agentId,
      agent_mock: agentMock,
      regenerated,
    });
  } catch (err) {
    return fail(err, 500);
  }
}
