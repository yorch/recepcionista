import { NextResponse } from 'next/server';
import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase, recordAudit, createNumberAttemptStore, numberHeldByBusiness } from '@/lib/db';
import { areaCodeForBusiness } from '@/lib/phone';
import crypto from 'node:crypto';
import { extractFromUrl, templateResult, ExtractionError } from '@/lib/extraction';
import { generateKnowledgeBase, promptIsDeficient } from '@/lib/kb';
import { readinessOf } from '@/lib/kb/readiness';
import { isMockPoolNumber, provisionNumber, releaseNumber } from '@/lib/providers/twilio';
import { syncAgent, bindPhoneNumber } from '@/lib/voice/elevenlabs';
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
  /** True when the agent exists but the post-call webhook could not be attached (operator action needed: docs/runbook.md). Never carries a secret. */
  post_call_webhook_pending?: boolean;
  /** Shown ONCE, ONLY to an admin principal, when this call created the ElevenLabs post-call webhook. Store as ELEVENLABS_WEBHOOK_SECRET; it is not persisted or logged. */
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
  return promptIsDeficient(kb.system_prompt, business.vertical) || kbIsStale(kb, business);
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


/**
 * A provisioning step failed. Never a 200: the business stays 'onboarding' (never 'live'), nothing fake is stored, and the
 * response says whether a number was already bought (`partial`) so the retry is known to reuse it (no second purchase).
 */
function provisionFailure(
  status: 502 | 503,
  error: string,
  extra: { code: string; stage: string; phone?: string | null; retry?: string },
): ReturnType<typeof fail> {
  return NextResponse.json({
    ok: false,
    error,
    code: extra.code,
    stage: extra.stage,
    retryable: true,
    ...(extra.phone ? { partial: { phone: extra.phone, number_kept: true } } : {}),
    retry: extra.retry ?? (extra.phone
      ? 'Your phone number is reserved for this business. Try again in a minute: the retry reuses it and will not buy another.'
      : 'Nothing was purchased or charged. Try again in a minute; if it keeps failing, contact support.'),
  }, { status }) as unknown as ReturnType<typeof fail>;
}

function auditProvision(principal: Principal, businessId: string, action: string, meta: Record<string, unknown>) {
  return recordAudit({
    actor_kind: principal.kind === 'admin' ? (principal.via === 'user' && principal.user ? 'user' : 'admin_token') : 'user',
    actor_user_id: principal.kind === 'user' ? principal.user.id : principal.user?.id ?? null,
    business_id: businessId,
    action,
    target: `business:${businessId}`,
    meta,
  });
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

    // Idempotent: already provisioned and live (number + agent + healthy KB) -> return it
    // instead of buying a number / creating an agent again.
    if (!force && business.status === 'live' && business.phone && business.agent_id && kb && !kbIsStale(kb, business) && !kbNeedsRegen(kb, business)) {
      log.info('already_provisioned', { business: id, phone: business.phone });
      return ok<ProvisionResult>({
        business,
        knowledge_base: kb,
        phone: business.phone,
        mock: isMockPoolNumber(business.phone),
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
          const extraction = await extractFromUrl(business.url, business.vertical);
          generated = generateKnowledgeBase(extraction, business);
        } else {
          generated = generateKnowledgeBase(templateResult(business.name, business.vertical, business.locale_default === 'es' ? 'es' : 'en'), business);
        }
      }
      kb = await upsertKnowledgeBase(id, generated);
      regenerated = true;
      log.info('knowledge_base.ready', { business: id, force, kept_services: Boolean(keepServices) });
    }

    // Minimum content checks (docs: kb readiness): a business whose KB is too thin to answer calls does not get a paid number or agent.
    // Admins may override (they can see the same list in the response). Checked before ANY paid step.
    if (principal.kind !== 'admin') {
      const readiness = readinessOf(kb, (await getBusiness(id)) ?? business);
      if (!readiness.ready) {
        log.info('kb_incomplete', { business: id, blockers: readiness.blockers.map((b) => b.key) });
        return NextResponse.json({
          ok: false, error: 'Add the missing details before turning your receptionist on.', code: 'kb_incomplete',
          blockers: readiness.blockers, warnings: readiness.warnings, score: readiness.score,
        }, { status: 422 }) as unknown as ReturnType<typeof fail>;
      }
    }

    // Preserve the business's existing line: CONTRACTS.md documents the demo
    // number (+13055550142) and WS3 routes inbound calls by phone, so a reset
    // must not hand the business a new one. Provision only if it has none.
    // A number recorded by an earlier, partly failed run is such a line: the retry reuses it and never buys again.
    let phone = business.phone;
    let mock = true;
    if (!phone) {
      lostLeaseCheck(signal); // never buy a number after the lease was lost: a successor may already hold it
      // Area code: the business's own (its owner phone's) when valid, else TWILIO_AREA_CODE (default 305).
      const areaCode = areaCodeForBusiness(business);
      const provisioned = await provisionNumber(areaCode, { attempts: createNumberAttemptStore(crypto.randomUUID()) });
      if (!provisioned.ok) {
        // Never a fake number once Twilio is configured or in production: fail the step, stay 'onboarding'.
        await auditProvision(principal, id, 'provision.number_failed', { stage: provisioned.stage, error: provisioned.error, area_code: areaCode, ...(provisioned.unsettled ? { unsettled_candidate: provisioned.unsettled } : {}) });
        log.error('number.failed', { business: id, stage: provisioned.stage, error: provisioned.error });
        return provisionFailure(
          provisioned.stage === 'not_configured' ? 503 : 502,
          provisioned.stage === 'not_configured'
            ? 'Phone provider is not configured on this server. Contact support.'
            : `We could not get a phone number from the carrier (${provisioned.error}).`,
          {
            code: provisioned.stage === 'not_configured' ? 'phone_provider_not_configured' : 'number_purchase_failed',
            stage: 'number',
            // The purchase answer was lost and the number could not be proven ours: it may exist at the carrier. Say so.
            ...(provisioned.unsettled ? { retry: 'The carrier did not confirm the purchase. If a number was bought it will be reconciled by support; try again in a few minutes.' } : {}),
          },
        );
      }
      phone = provisioned.phone;
      mock = provisioned.mock;
      const boughtThisCall = provisioned.mock || provisioned.bought === true;
      // Record the number IMMEDIATELY (status unchanged: it is not 'live' until the agent exists), so a failure below can
      // never lose a paid number and a retry reuses it.
      const saved = await updateBusiness(id, { phone }).catch(() => null);
      if (!saved) {
        // Another business may hold the number (unique constraint): it is THEIR live line, never release it.
        const heldElsewhere = await numberHeldByBusiness(phone, id).catch(() => true);
        if (heldElsewhere) {
          log.error('number.record_conflict', { business: id, phone, action: 'kept: another business holds this number' });
          await auditProvision(principal, id, 'provision.number_conflict', { phone, released: false });
          return provisionFailure(502, 'That number was claimed by another account at the same moment, so it was not assigned to you. Try again.', {
            code: 'number_taken', stage: 'number', retry: 'Nothing was released and no other account was affected. Try again in a minute; you will be offered a different number.',
          });
        }
        // Not held by anyone: only a number THIS call bought may be given back.
        log.error('number.record_failed', { business: id, phone, action: boughtThisCall ? 'releasing the number so it is not orphaned' : 'not released: not bought by this call' });
        const released = boughtThisCall ? await releaseNumber(phone, { callerBusinessId: id }) : null;
        await auditProvision(principal, id, 'provision.number_record_failed', { phone, released: Boolean(released?.ok) });
        return provisionFailure(502, released?.ok
          ? 'We bought a number but could not save it, so it was released. Try again.'
          : 'We bought a number but could not save it, and it could not be released automatically. Support has been alerted; try again in a minute.', {
          code: 'number_record_failed', stage: 'number',
          retry: released?.ok ? 'The number was released; you are not charged for it. Try again in a minute.' : 'Try again in a minute; if it keeps failing, contact support.',
        });
      }
      await auditProvision(principal, id, 'provision.number_purchased', { phone, mock });
    } else {
      mock = isMockPoolNumber(phone); // mock-pool numbers are issued as +1<area>555xxxx
    }
    let updated = (await getBusiness(id)) ?? business;
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
    //    phone line speaks the prompt we just wrote. A configured provider that FAILS leaves the business partly
    //    provisioned: the number stays recorded, status stays 'onboarding', the response is a 502 and a retry resumes here.
    let agentId: string | undefined;
    let agentMock: boolean | undefined;
    let webhookSecret: string | undefined;
    let postCallPending = false;
    let agentFailure: string | null = null;
    lostLeaseCheck(signal);
    try {
      const agent = await syncAgent({ business: updated, kb });
      agentId = agent.agent_id;
      agentMock = agent.mock;
      if (agent.error) agentFailure = `agent registration failed (${agent.error})`;
      if (!agent.mock && agent.agent_id && agent.agent_id !== updated.agent_id) {
        const withAgent = await updateBusiness(id, { agent_id: agent.agent_id });
        if (withAgent) updated = withAgent;
      }
      if (!agent.mock && agentId) {
        try { await bindPhoneNumber(agentId); } catch { /* best-effort */ }
        // Only an ADMIN call may create the platform-wide webhook (and so see its one-time signing secret).
        // A tenant call just attaches the existing one; if it is missing or cannot be looked up the step fails safely.
        const hook = await ensurePostCallWebhook({ allowCreate: principal.kind === 'admin' });
        if (principal.kind === 'admin') webhookSecret = hook.webhook_secret;
        if (hook.webhook_id) {
          await registerPostCallWebhookOnAgent(agentId, hook.webhook_id);
        } else {
          postCallPending = true;
          log.warn('post_call_webhook.unavailable', { business: id, error: hook.error ?? null });
        }
      }
    } catch (err) {
      log.error('agent.registration_failed', { business: id, err });
      agentFailure = 'agent or webhook registration failed';
    }

    if (agentFailure) {
      await auditProvision(principal, id, 'provision.partial', { phone, stage: 'agent', error: agentFailure });
      return provisionFailure(
        502,
        `Your phone number is ready but the voice agent could not be set up (${agentFailure}).`,
        { code: 'agent_registration_failed', stage: 'agent', phone },
      );
    }

    const live = await updateBusiness(id, { status: 'live' });
    if (!live) return fail('business not found', 404);
    updated = live;
    await auditProvision(principal, id, 'provision.completed', { phone, mock, agent_mock: agentMock ?? null });

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
      ...(postCallPending ? { post_call_webhook_pending: true } : {}),
      ...(webhookSecret && principal.kind === 'admin' ? {
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
