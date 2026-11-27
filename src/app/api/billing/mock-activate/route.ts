import { configEnv } from '@/lib/config';
import { NextResponse } from 'next/server';
import { fail } from '@/lib/http';
import { demoModeEnabled } from '@/lib/auth';
import { authenticate, scopeBusinessId } from '@/lib/session';
import { getBusiness, recordAudit, setBillingState, updateBusiness } from '@/lib/db';
import { annualAvailable, checkoutReturnPath, returnBaseUrl, trialDays, planName } from '@/lib/providers/stripe-billing';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Demo-only stand-in for Stripe Checkout (the mock checkout URL points here). Requires DEMO_MODE=true, a non-production
 * build, no STRIPE_SECRET_KEY and the owner's own session; it starts a local trial and redirects to the billing page.
 * Anywhere else it answers 404 so the route does not exist as far as a prober can tell.
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === 'production' || configEnv().STRIPE_SECRET_KEY?.trim() || !demoModeEnabled()) return fail('not found', 404);
  // A state change on GET: refuse anything a third-party site could trigger.
  if (req.headers.get('sec-fetch-site') === 'cross-site') return fail('cross-site request refused', 403);
  const auth = await authenticate(req, { role: 'owner', stateChanging: true });
  if (!auth.ok) return auth.response;
  try {
    const requested = new URL(req.url).searchParams.get('business_id');
    const businessId = scopeBusinessId(auth.principal, requested);
    if (!businessId) return fail('business_id is required', 422);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    const status = business.billing_status ?? 'none';
    if (status === 'trialing' || status === 'active' || status === 'past_due') return fail('already subscribed', 409);
    const days = trialDays();
    const wantsYear = new URL(req.url).searchParams.get('interval') === 'year' && annualAvailable();
    if (wantsYear) await updateBusiness(business.id, { billing_interval: 'year' }); // the real flow learns this from the subscription's price
    await setBillingState(business.id, {
      billing_status: 'trialing', plan: planName(),
      trial_ends_at: new Date(Date.now() + days * 86_400_000), cancel_at_period_end: false,
    });
    await recordAudit({
      actor_kind: 'user', actor_user_id: auth.principal.kind === 'user' ? auth.principal.user.id : auth.principal.user?.id ?? null,
      business_id: business.id, action: 'billing.mock_activated', target: `business:${business.id}`, meta: { interval: wantsYear ? 'year' : 'month' },
    });
    return NextResponse.redirect(`${returnBaseUrl()}${checkoutReturnPath(new URL(req.url).searchParams.get('return_path'))}?checkout=success`, 303);
  } catch (err) {
    return billingErrorResponse(err);
  }
}
