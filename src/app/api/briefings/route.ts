import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness, listBriefings } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const businessId = scopeBusinessId(auth.principal, new URL(req.url).searchParams.get('business_id'));
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    if (!(await getBusiness(businessId))) return fail('business not found', 404);
    return ok(await listBriefings(businessId));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
