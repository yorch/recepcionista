import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, getKnowledgeBase, recordAudit, upsertKnowledgeBase } from '@/lib/db';
import { buildCallScript, buildSystemPrompt } from '@/lib/kb';
import { normalizeUrl } from '@/lib/extraction/url';
import type { FAQ, KnowledgeBase, Service } from '@/lib/types';

export const runtime = 'nodejs';

const MAX_SERVICES = 20;
const MAX_FAQS = 15;
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;

function cleanServices(v: unknown): Service[] | null {
  if (!Array.isArray(v) || v.length > MAX_SERVICES) return null;
  const out: Service[] = [];
  for (const raw of v) {
    const s = raw as Record<string, unknown>;
    const name = text(s?.name, 120);
    if (!name) return null;
    const svc: Service = { name };
    if (s.description !== undefined && s.description !== null && s.description !== '') {
      const d = text(s.description, 320);
      if (!d) return null;
      svc.description = d;
    }
    if (s.base_price !== undefined && s.base_price !== null) {
      if (typeof s.base_price !== 'number' || !Number.isFinite(s.base_price) || s.base_price < 0 || s.base_price > 100_000) return null;
      svc.base_price = Math.round(s.base_price * 100) / 100;
    } else {
      svc.base_price = null;
    }
    if (s.duration_minutes !== undefined && s.duration_minutes !== null) {
      if (typeof s.duration_minutes !== 'number' || !Number.isInteger(s.duration_minutes) || s.duration_minutes < 5 || s.duration_minutes > 1440) return null;
      svc.duration_minutes = s.duration_minutes;
    }
    out.push(svc);
  }
  return out;
}

function cleanFaqs(v: unknown): FAQ[] | null {
  if (!Array.isArray(v) || v.length > MAX_FAQS) return null;
  const out: FAQ[] = [];
  for (const raw of v) {
    const f = raw as Record<string, unknown>;
    const question = text(f?.question, 300);
    const answer = text(f?.answer, 1000);
    if (!question || !answer) return null;
    out.push({ question, answer });
  }
  return out;
}

/**
 * Create-or-update the knowledge base (services, prices, FAQs, pricing notes) and rebuild the system prompt
 * from the business's current facts. Unlike PUT /knowledge it also works BEFORE provisioning, which is what
 * lets onboarding save the owner's reviewed edits so provision keeps them instead of re-extracting.
 * Optional `extracted_from` (a URL) records "last extracted from <url>" in the audit trail.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<KnowledgeBase>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response as ReturnType<typeof fail>;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const existing = await getKnowledgeBase(id);

    const services = body.services === undefined ? (existing?.services ?? []) : cleanServices(body.services);
    if (!services) return fail('invalid "services": each needs a name, a dollar price of 0 to 100000 and minutes of 5 to 1440 (max 20)', 422);
    const faqs = body.faqs === undefined ? (existing?.faqs ?? []) : cleanFaqs(body.faqs);
    if (!faqs) return fail('invalid "faqs": each needs a question and an answer (max 15)', 422);
    let pricing_notes = existing?.pricing_notes ?? '';
    if (body.pricing_notes !== undefined) {
      if (typeof body.pricing_notes !== 'string' || body.pricing_notes.length > 1000) return fail('invalid "pricing_notes"', 422);
      pricing_notes = body.pricing_notes.trim();
    }
    let call_script = existing?.call_script ?? '';
    if (body.call_script !== undefined) {
      if (typeof body.call_script !== 'string' || body.call_script.length > 8000) return fail('invalid "call_script"', 422);
      call_script = body.call_script;
    } else if (!call_script) {
      call_script = buildCallScript({ services });
    }

    const system_prompt = buildSystemPrompt(business, { services, faqs, pricing_notes });
    const saved = await upsertKnowledgeBase(id, { services, faqs, pricing_notes, call_script, system_prompt });

    if (typeof body.extracted_from === 'string') {
      const url = normalizeUrl(body.extracted_from);
      if (url) {
        const p = auth.principal;
        await recordAudit({
          actor_kind: p.kind === 'admin' && !p.user ? 'admin_token' : 'user',
          actor_user_id: p.kind === 'user' ? p.user.id : p.user?.id ?? null,
          business_id: id,
          action: 'knowledge.extracted',
          target: `business:${id}`,
          meta: { url, services: services.length },
        });
      }
    }
    return ok<KnowledgeBase>(saved);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
