import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { getBusiness, listBusinesses, createBusiness } from '@/lib/db';
import type { Business } from '@/lib/types';

/** Dashboard-safe projection: no owner contact details or voice-agent ids. */
function publicBusiness(b: Business): Business {
  const { owner_phone: _p, agent_id: _a, ...rest } = b;
  void _p; void _a;
  return rest as Business;
}

/** Admin: every business. Owner/staff: only their own (a list of one). */
export async function GET(req: Request): Promise<ReturnType<typeof ok<Business[]>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  try {
    if (principal.kind === 'user') {
      const own = await getBusiness(principal.business_id);
      return ok<Business[]>(own ? [publicBusiness(own)] : []);
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
    const body = await readJson<{ name?: string; url?: string; owner_phone?: string; owner_name?: string }>(req);
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return fail('missing "name" in body');
    }
    const business = await createBusiness({
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
