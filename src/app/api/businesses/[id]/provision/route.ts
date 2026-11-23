import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { extractFromUrl, templateResult, ExtractionError } from '@/lib/extraction';
import { generateKnowledgeBase, promptIsDeficient } from '@/lib/kb';
import { provisionNumber } from '@/lib/providers/twilio';
import { createOrUpdateAgent, bindPhoneNumber } from '@/lib/voice/elevenlabs';
import { ensurePostCallWebhook, registerPostCallWebhookOnAgent } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';
import { limitRequest } from '@/lib/ratelimit';
import { assertProvisioningAllowed, billingRequiredResponse } from '@/lib/billing/gate';
import type { Principal } from '@/lib/session';
import { withLease } from '@/lib/db';
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
  /** Shown ONCE, only when this call created the ElevenLabs post-call webhook. Store as ELEVENLABS_WEBHOOK_SECRET; it is not persisted or logged. */
  webhook_secret?: string;
  webhook_secret_notice?: string;
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
 * Cross-instance lock per business (Postgres lease row, auto-renewed while we run) so two
 * concurrent provision calls cannot both buy a number / create an agent. A crashed instance's
 * lease expires after PROVISION_LEASE_MS.
 */
const PROVISION_LEASE_MS = 90_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  // Buys a number / creates an agent: the OWNER of the business (verified email, billing gate below) or an admin.
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response as ReturnType<typeof fail>;
  const { id } = await params;
  try {
    requireBusinessAccess(auth.principal, id); // another tenant's business is a 404, never confirmed
  } catch (err) {
    return (authErrorResponse(err) ?? fail(err, 500)) as ReturnType<typeof fail>;
  }
  const limited = await limitRequest(req, 'businesses/provision', 5, 60_000, { globalLimit: 100 });
  if (limited) return limited as ReturnType<typeof fail>;
  try {
    const run = await withLease(`provision:${id}`, PROVISION_LEASE_MS, (_lease, signal) => provision(req, id, signal, auth.principal));
    if (!run.acquired) return fail('provisioning already in progress', 409);
    return run.value;
  } catch (err) {
    log.error('lock_failed', { business: id, err });
    return fail(err, 500);
  }
}

/** Throws (-> 500, nothing more is bought) once the provisioning lease is lost. */
function lostLeaseCheck(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('provisioning lease lost; aborting before the next paid step');
}

async function provision(
  req: Request,
  id: string,
  signal: AbortSignal,
  principal: Principal,
): Promise<ReturnType<typeof ok<ProvisionResult>> | ReturnType<typeof fail>> {
  const started = Date.now();
  try {
    const business = await getBusiness(id);
    if (!business) {
      log.warn('business_not_found', { business: id });
      return fail('business not found', 404);
    }

    // Paid resources (number, agent) only for a business with a plan; applies to `force` and re-provisioning too.
    // Admins bypass (comped accounts). A no-op unless BILLING_ENFORCED=true.
    try {
      assertProvisioningAllowed(principal, business);
    } catch (err) {
      const required = billingRequiredResponse(err);
      if (required) {
        log.warn('billing_required', { business: id, billing_status: business.billing_status ?? 'none' });
        return required as ReturnType<typeof fail>;
      }
      throw err;
    }

    let force = false;
    try {
      const body = await req.clone().json().catch(() => ({}));
      // `force` rebuilds the KB from scratch and re-registers the agent: admin-only (owners get the idempotent path).
      force = principal.kind === 'admin' && Boolean((body as { force?: unknown })?.force);
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
      lostLeaseCheck(signal); // never buy a number after the lease was lost: a successor may already hold it
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
    let webhookSecret: string | undefined;
    lostLeaseCheck(signal);
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
        webhookSecret = hook.webhook_secret;
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
      ...(webhookSecret ? {
        webhook_secret: webhookSecret,
        webhook_secret_notice: 'Store this as ELEVENLABS_WEBHOOK_SECRET in .env and redeploy. It is shown only once and is not saved by the app.',
      } : {}),
    });
  } catch (err) {
    // A failed scrape must not provision an agent against the wrong trade, so it
    // fails loudly — 422 with the reason when we know it, 500 otherwise.
    log.error('failed', { business: id, ms: Date.now() - started, err });
    if (err instanceof ExtractionError) return fail(err.message, 422);
    return fail(err, 500);
  }
}
