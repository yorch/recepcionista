import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, hasRole, requireBusinessAccess } from '@/lib/session';
import { getBusiness, updateBusiness, getKnowledgeBase, getDashboardStats, isOptedOut } from '@/lib/db';
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
      if (clean === undefined) return fail(`invalid value for "${key}"`, 422);
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
    const updated = await updateBusiness(id, patch as Partial<Business>);
    if (!updated) return fail('business not found', 404);
    return ok<Business>(publicBusiness(updated));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
