import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { exportCustomerData } from '@/lib/privacy';

export const dynamic = 'force-dynamic';

/** Access request: GET /api/privacy/export?business_id=...&phone=... Owner of that business, or admin. */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // customer PII export: owner+, own business only
  if (!auth.ok) return auth.response;
  try {
    const q = new URL(req.url).searchParams;
    const businessId = scopeBusinessId(auth.principal, q.get('business_id')) ?? '';
    const phone = q.get('phone') ?? '';
    if (businessId) requireBusinessAccess(auth.principal, businessId);
    if (!businessId || !phone) return fail('business_id and phone are required', 422);
    if (phone.replace(/\D/g, '').length < 7) return fail('phone must have at least 7 digits', 422);
    if (!(await getBusiness(businessId))) return fail('business not found', 404);
    return ok(await exportCustomerData(businessId, phone));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
