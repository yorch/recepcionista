import { ok, fail } from '@/lib/http';
import { getBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { extractFromUrl, templateResult, ExtractionError } from '@/lib/extraction';
import { generateKnowledgeBase, promptIsDeficient } from '@/lib/kb';
import { provisionNumber } from '@/lib/providers/twilio';
import { createOrUpdateAgent, bindPhoneNumber } from '@/lib/voice/elevenlabs';
import { ensurePostCallWebhook, registerPostCallWebhookOnAgent } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';
import { limitRequest } from '@/lib/ratelimit';
import type { Business, KnowledgeBase } from '@/lib/types';

export const runtime = 'nodejs';

const log = logger('provision');

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

/**
 * In-process lock per business id so two concurrent provision calls cannot both
 * buy a number / create an agent. NOTE: this only protects a single instance;
 * a multi-instance deployment needs a DB-level lock (advisory lock or a
 * conditional update on a `provisioning` status column).
 */
const inFlight = new Set<string>();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  const limited = limitRequest(req, 'businesses/provision', 5);
  if (limited) return limited as ReturnType<typeof fail>;
  const { id } = await params;
  if (inFlight.has(id)) return fail('provisioning already in progress', 409);
  inFlight.add(id);
  try {
    return await provision(req, id);
  } finally {
    inFlight.delete(id);
  }
}

async function provision(
  req: Request,
  id: string,
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  const started = Date.now();
  try {
    const business = await getBusiness(id);
    if (!business) {
      log.warn('business_not_found', { business: id });
      return fail('business not found', 404);
    }

    let force = false;
    try {
      const body = await req.clone().json().catch(() => ({}));
      force = Boolean((body as { force?: unknown })?.force);
    } catch {
      force = false;
    }

    let kb = await getKnowledgeBase(id);
    let regenerated = false;

    // Idempotent: already provisioned (number + agent + healthy KB) -> return it
    // instead of buying a number / creating an agent again.
    if (!force && business.phone && business.agent_id && kb && !kbIsStale(kb, business) && !kbNeedsRegen(kb, business)) {
      log.info('already_provisioned', { business: id, phone: business.phone });
      return ok<ProvisionResult>({
        business,
        knowledge_base: kb,
        phone: business.phone,
        mock: business.phone.includes('555'),
        agent_id: business.agent_id,
        regenerated: false,
      });
    }

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
        if (business.url) {
          // A real URL that cannot be scraped must fail loudly — the user
          // needs to know their agent would be talking about the wrong trade.
          const extraction = await extractFromUrl(business.url);
          generated = generateKnowledgeBase(extraction, business);
        } else {
          generated = generateKnowledgeBase(templateResult(business.name), business);
        }
      }
      kb = await upsertKnowledgeBase(id, generated);
      regenerated = true;
      log.info('knowledge_base.ready', { business: id, force, kept_services: Boolean(keepServices) });
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
    log.info('number.assigned', { business: id, phone, mock });

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
      if (!agent.mock && agentId) {
        try { await bindPhoneNumber(agentId); } catch { /* best-effort */ }
        const hook = await ensurePostCallWebhook();
        if (hook.webhook_id) {
          await registerPostCallWebhookOnAgent(agentId, hook.webhook_id);
        }
      }
    } catch (err) {
      log.error('agent.registration_failed', { business: id, err });
    }

    log.info('done', {
      business: id,
      name: updated.name,
      phone,
      phone_mock: mock,
      agent: agentId ?? null,
      agent_mock: agentMock ?? null,
      regenerated,
      ms: Date.now() - started,
    });

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
    // A failed scrape must not provision an agent against the wrong trade, so it
    // fails loudly — 422 with the reason when we know it, 500 otherwise.
    log.error('failed', { business: id, ms: Date.now() - started, err });
    if (err instanceof ExtractionError) return fail(err.message, 422);
    return fail(err, 500);
  }
}
