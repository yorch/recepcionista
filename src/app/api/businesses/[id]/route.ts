import { ok, fail, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, hasRole, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, updateBusiness, getKnowledgeBase, getDashboardStats, isOptedOut, recordAudit } from '@/lib/db';
import { isVertical } from '@/lib/verticals';
import { applyVerticalChange, type VerticalChangeOutcome } from '@/lib/verticals/change';
import { VERTICALS } from '@/lib/types';
import { tzOf } from '@/lib/time';
import { countryAllowed } from '@/lib/messaging/recipient';
import type { Business, Hours, KnowledgeBase } from '@/lib/types';

function publicBusiness(b: Business): Business {
  const { owner_phone: _p, agent_id: _a, ...rest } = b;
  void _p; void _a;
  return rest as Business;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const str = (max: number) => (v: unknown) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;

/** Only these fields may be changed through PATCH; everything else is rejected. */
const PATCHABLE: Record<string, (v: unknown) => unknown> = {
  name: str(200),
  url: (v) => (v === null ? null : typeof v === 'string' && v.length <= 2048 ? v.trim() : undefined),
  owner_name: (v) => (v === null ? null : str(200)(v)),
  owner_phone: (v) => (v === null ? null : typeof v === 'string' && E164.test(v.replace(/[\s().-]/g, '')) ? v.replace(/[\s().-]/g, '') : undefined),
  service_area: (v) =>
    Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && x.length <= 100) ? v : undefined,
  vertical: (v) => (isVertical(v) ? v : undefined),
  hours: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    for (const d of Object.values(v as Record<string, unknown>)) {
      if (d === null) continue;
      const o = d as { open?: unknown; close?: unknown };
      if (!o || typeof o.open !== 'string' || typeof o.close !== 'string') return undefined;
    }
    return v as Hours;
  },
};

export interface BusinessDetail {
  business: Business;
  knowledge_base: KnowledgeBase | null;
  /** revenue_month is integer CENTS. */
  stats: { calls_today: number; bookings_upcoming: number; revenue_month: number };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<BusinessDetail>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    // SQL aggregates in the BUSINESS's local day/month (the old code counted by UTC date and loaded every call and booking).
    const agg = await getDashboardStats(id, tzOf(business));
    const stats = { calls_today: agg.calls_today, bookings_upcoming: agg.bookings_upcoming, revenue_month: agg.revenue_month_cents };

    // The stored system prompt is the owner's configuration (it can name the owner and internal rules): staff get the knowledge, not the prompt.
    const kb = await getKnowledgeBase(id);
    const knowledge_base = kb && !hasRole(auth.principal, 'owner') ? { ...kb, system_prompt: '', call_script: '' } : kb;
    return ok<BusinessDetail>({ business: publicBusiness(business), knowledge_base, stats });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<Business>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'owner' }); // staff cannot change business settings
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      const validate = PATCHABLE[key];
      if (!validate) return fail(`field "${key}" cannot be updated`, 422);
      const clean = validate(value);
      if (clean === undefined) return fail(key === 'vertical' ? `vertical must be one of: ${VERTICALS.join(', ')}` : `invalid value for "${key}"`, 422);
      patch[key] = clean;
    }
    // owner_alert texts to the owner phone are exempt from customer opt-outs: that number must never be one
    // that opted out of this business's texts (otherwise re-pointing it would defeat a customer's STOP).
    if (typeof patch.owner_phone === 'string' && (await isOptedOut(id, patch.owner_phone))) {
      return fail('owner_phone is a number that opted out of texts from this business', 422);
    }
    // The alert destination must be in a country this deployment texts (SMS_ALLOWED_COUNTRY_CODES): no premium/international pumping.
    if (typeof patch.owner_phone === 'string' && !countryAllowed(patch.owner_phone)) {
      return fail('owner_phone is in a country that is not enabled for this account', 422);
    }
    // Changing the trade rewrites how the agent triages emergencies, so on a business that is already set up it needs a recent proof of
    // identity (the same step-up as call mode). A business still in onboarding (no number, no agent) has nothing live to protect.
    const before = typeof patch.vertical === 'string' ? await getBusiness(id) : null;
    if (typeof patch.vertical === 'string' && !before) return fail('business not found', 404);
    const verticalChanges = before !== null && patch.vertical !== (before.vertical ?? 'hvac');
    if (before && verticalChanges && (before.status !== 'onboarding' || before.phone || before.agent_id)) {
      const reauth = requireRecentAuth(auth);
      if (reauth) return reauth as unknown as ReturnType<typeof fail>;
    }
    const updated = await updateBusiness(id, patch as Partial<Business>);
    if (!updated) return fail('business not found', 404);
    if (before && verticalChanges) {
      const outcome: VerticalChangeOutcome = await applyVerticalChange(before, updated);
      const actor = auditActorOf(auth.principal);
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.vertical_changed',
        target: `business:${id}`, ip: clientKey(req),
        meta: { ...actor.meta, from: before.vertical ?? 'hvac', to: updated.vertical ?? 'hvac', ...outcome, kb_content_kept: true },
      });
    }
    return ok<Business>(publicBusiness(updated));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
