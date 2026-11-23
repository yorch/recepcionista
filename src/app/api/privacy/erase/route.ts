import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { eraseCustomerData, getBusiness } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Right-to-erasure for one customer of one business. Admin only. */
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
    if (!(await getBusiness(businessId))) return fail('business not found', 404);
    return ok(await eraseCustomerData(businessId, body.phone));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
