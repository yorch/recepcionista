import { ok, fail, readJson } from '@/lib/http';
import { authenticate, scopeBusinessId } from '@/lib/session';
import { getBusiness } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { billingMode, createPortalSession } from '@/lib/providers/stripe-billing';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Owner (or admin): open the Stripe Customer Portal (card, invoices, cancel). Answers `{ url }`. */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  const limited = await limitRequest(req, 'billing/portal', 10);
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: unknown }>(req).catch(() => ({} as { business_id?: unknown }));
    const requested = typeof body.business_id === 'string' && body.business_id ? body.business_id : null;
    const businessId = scopeBusinessId(principal, requested);
    if (!businessId) return fail('business_id is required', 422);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    if (!business.stripe_customer_id) return fail('no billing account yet: start a trial first', 409);
    if (billingMode() === 'mock') return fail('billing portal is unavailable in mock mode', 409);
    const session = await createPortalSession(business.stripe_customer_id);
    return ok({ url: session.url });
  } catch (err) {
    return billingErrorResponse(err);
  }
}
