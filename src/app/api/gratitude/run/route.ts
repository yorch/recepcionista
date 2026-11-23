import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { runGratitudeSweep } from '@/lib/gratitude';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // sends SMS to customers: owner+
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'gratitude/run', 3);
  if (limited) return limited;
  try {
    // Body is optional: the sweep defaults to every business.
    const body = (await req.json().catch(() => ({}))) as { business_id?: string };
    // Owners are pinned to their own business; only an admin may omit it (= every business).
    const businessId = scopeBusinessId(auth.principal, body.business_id) ?? undefined;
    if (businessId) requireBusinessAccess(auth.principal, businessId);
    const result = await runGratitudeSweep(businessId);
    return ok(result);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
