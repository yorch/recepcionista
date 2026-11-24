import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { getBusiness, listCallsPage } from '@/lib/db';
import type { Page } from '@/lib/db/paging';
import type { Call } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/calls?cursor=&limit=  Staff+, newest first, cursor-paginated and scoped to the caller's business. */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const q = new URL(req.url).searchParams;
    const businessId = scopeBusinessId(auth.principal, q.get('business_id'));
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    if (!(await getBusiness(businessId))) return fail('business not found', 404);
    return ok<Page<Call>>(await listCallsPage(businessId, { cursor: q.get('cursor'), limit: Number(q.get('limit') ?? '') || undefined }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
