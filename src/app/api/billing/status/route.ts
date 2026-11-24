import { ok, fail } from '@/lib/http';
import { authenticate, scopeBusinessId } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { billingSummary } from '@/lib/billing/summary';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Any signed-in user: billing state and usage of their own business (admins pass `?business_id=`). */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'staff' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'billing/status', 60);
  if (limited) return limited;
  try {
    const requested = new URL(req.url).searchParams.get('business_id');
    const businessId = scopeBusinessId(auth.principal, requested);
    if (!businessId) return fail('business_id is required', 422);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    return ok(await billingSummary(business));
  } catch (err) {
    return billingErrorResponse(err);
  }
}
