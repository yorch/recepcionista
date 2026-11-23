import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { countryForBusiness, eraseCustomerData, getBusiness } from '@/lib/db';

import { toE164 } from '@/lib/phone';

export const dynamic = 'force-dynamic';

/** Right-to-erasure for one customer of one business. Owner of that business, or admin. */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // owners erase their own customers' data; admins any business
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson<{ business_id?: unknown; phone?: unknown }>(req);
    if ((body.business_id !== undefined && typeof body.business_id !== 'string') || typeof body.phone !== 'string' || !body.phone) {
      return fail('business_id and phone are required', 422);
    }
    const businessId = scopeBusinessId(auth.principal, body.business_id as string | undefined);
    if (!businessId) return fail('business_id and phone are required', 422);
    requireBusinessAccess(auth.principal, businessId);
    if (body.phone.replace(/\D/g, '').length < 7) return fail('phone must have at least 7 digits', 422);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    if (!toE164(body.phone, countryForBusiness(business))) return fail('phone must be a valid number (use +country code for non-US numbers)', 422);
    return ok(await eraseCustomerData(businessId, body.phone, countryForBusiness(business)));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
