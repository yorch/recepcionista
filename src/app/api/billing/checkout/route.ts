import { ok, fail, readJson } from '@/lib/http';
import { authenticate, requireVerifiedEmail, scopeBusinessId } from '@/lib/session';
import { getBusiness, recordAudit } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { billingMode, createCheckoutSession, returnBaseUrl } from '@/lib/providers/stripe-billing';
import { ensureCustomer } from '@/lib/billing/customer';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Owner (or admin): start a Stripe Checkout for the subscription with trial and a card on file.
 * Body: `{ business_id? }` (users are pinned to their own business; admins must name one).
 * Needs a verified email. Answers `{ url, mock }`; the browser then navigates to `url`.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  const limited = await limitRequest(req, 'billing/checkout', 10);
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: unknown }>(req).catch(() => ({} as { business_id?: unknown }));
    const requested = typeof body.business_id === 'string' && body.business_id ? body.business_id : null;
    const businessId = scopeBusinessId(principal, requested);
    if (!businessId) return fail('business_id is required', 422);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);
    requireVerifiedEmail(principal);

    const status = business.billing_status ?? 'none';
    if (status === 'trialing' || status === 'active' || status === 'past_due') {
      return fail('already subscribed: use the billing portal to manage the plan', 409);
    }
    const mode = billingMode(); // throws BillingConfigError -> 503 (always in production without Stripe)

    if (mode === 'mock') {
      const url = `${returnBaseUrl()}/api/billing/mock-activate?business_id=${encodeURIComponent(business.id)}`;
      return ok({ url, mock: true });
    }

    const email = principal.kind === 'user' ? principal.user.email : null;
    const customerId = await ensureCustomer(business, email);
    // One free trial per business: a business that already had a subscription or trial starts paid.
    const withTrial = !business.trial_ends_at && !business.stripe_subscription_id;
    const session = await createCheckoutSession({ business, customerId, withTrial });
    await recordAudit({
      actor_kind: principal.kind === 'admin' && !principal.user ? 'admin_token' : 'user',
      actor_user_id: principal.kind === 'user' ? principal.user.id : principal.user?.id ?? null,
      business_id: business.id, action: 'billing.checkout_started', target: `business:${business.id}`, meta: { with_trial: withTrial },
    });
    return ok({ url: session.url, mock: false });
  } catch (err) {
    return billingErrorResponse(err);
  }
}
