import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { getBusiness, listBusinesses, createBusiness } from '@/lib/db';
import { VERTICALS, type Business } from '@/lib/types';
import { isVertical } from '@/lib/verticals';
import { isLocale } from '@/lib/i18n/core';

/** Dashboard-safe projection: no owner contact details or voice-agent ids. */
function publicBusiness(b: Business): Business {
  const { owner_phone: _p, agent_id: _a, ...rest } = b;
  void _p; void _a;
  return rest as Business;
}

/** Admin: every business. Owner/staff: the businesses they have an enabled membership in (the active one is `business_id` of /api/auth/me). */
export async function GET(req: Request): Promise<ReturnType<typeof ok<Business[]>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  try {
    if (principal.kind === 'user') {
      const own = await Promise.all(principal.memberships.map((m) => getBusiness(m.business_id)));
      return ok<Business[]>(own.filter((b): b is Business => b !== null).map(publicBusiness));
    }
    return ok<Business[]>((await listBusinesses()).map(publicBusiness));
  } catch (err) {
    return fail(err, 500);
  }
}

export async function POST(req: Request): Promise<ReturnType<typeof ok<Business>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'admin' }); // creating tenants is admin-only
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson<{ name?: string; url?: string; owner_phone?: string; owner_name?: string; vertical?: unknown; locale_default?: unknown }>(req);
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return fail('missing "name" in body');
    }
    if (body.vertical !== undefined && !isVertical(body.vertical)) return fail(`vertical must be one of: ${VERTICALS.join(', ')}`, 422);
    if (body.locale_default !== undefined && !isLocale(body.locale_default)) return fail('locale_default must be "en" or "es"', 422);
    const business = await createBusiness({
      ...(body.vertical !== undefined ? { vertical: body.vertical } : {}),
      ...(body.locale_default !== undefined ? { locale_default: body.locale_default as 'en' | 'es' } : {}),
      name: body.name.trim(),
      url: body.url?.trim() || null,
      owner_phone: body.owner_phone?.trim() || null,
      owner_name: body.owner_name?.trim() || null,
    });
    return ok<Business>(publicBusiness(business), 201);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
