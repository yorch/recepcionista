import { ok, fail, readJson } from '@/lib/http';
import { authenticate, requireVerifiedEmail, scopeBusinessId } from '@/lib/session';
import { getBusiness, listBusinessUsers, recordAudit } from '@/lib/db';
import { claimTrial, emailFingerprint, trialUsedElsewhere } from '@/lib/billing/trial';
import { limitRequest } from '@/lib/ratelimit';
import { annualAvailable, billingMode, checkoutReturnPath, createCheckoutSession, parseInterval, returnBaseUrl } from '@/lib/providers/stripe-billing';
import { ensureCustomer } from '@/lib/billing/customer';
import { billingErrorResponse } from '@/lib/billing/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Owner (or admin): start a Stripe Checkout for the subscription with trial and a card on file.
 * Body: `{ business_id?, return_path?, interval?: 'month' | 'year' }` ('year' only when STRIPE_PRICE_ID_ANNUAL is set, else 422) (return_path: allowlisted same-origin page to come back to: /dashboard/billing (default) or /onboarding) (users are pinned to their own business; admins must name one).
 * Needs a verified email. Answers `{ url, mock }`; the browser then navigates to `url`.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  const limited = await limitRequest(req, 'billing/checkout', 10);
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: unknown; return_path?: unknown; interval?: unknown }>(req).catch(() => ({} as { business_id?: unknown; return_path?: unknown; interval?: unknown }));
    const interval = parseInterval(body.interval);
    if (interval === 'invalid') return fail('interval must be "month" or "year"', 422);
    if (interval === 'year' && !annualAvailable()) return fail('the annual plan is not available', 422);
    const requested = typeof body.business_id === 'string' && body.business_id ? body.business_id : null;
    const returnPath = checkoutReturnPath(body.return_path);
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
      const url = `${returnBaseUrl()}/api/billing/mock-activate?business_id=${encodeURIComponent(business.id)}`
        + (returnPath === '/dashboard/billing' ? '' : `&return_path=${encodeURIComponent(returnPath)}`);
      return ok({ url, mock: true });
    }

    const email = principal.kind === 'user' ? principal.user.email : null;
    const customerId = await ensureCustomer(business, email);
    // One free trial per business: a business that already had a subscription or trial starts paid.
    // ...and one per person: an owner address (normalised) that already started a trial for another business starts paid.
    let withTrial = !business.trial_ends_at && !business.stripe_subscription_id;
    let trialDenied: string | null = null;
    if (withTrial) {
      const owners = (await listBusinessUsers(business.id)).filter((u) => u.role === 'owner');
      const fps = owners.map((u) => emailFingerprint(u.email));
      for (const fp of fps) if (await trialUsedElsewhere('email', fp, business.id)) { withTrial = false; trialDenied = 'email_used_for_another_trial'; break; }
      if (withTrial) for (const fp of fps) await claimTrial('email', fp, business.id);
    }
    const session = await createCheckoutSession({ business, customerId, withTrial, returnPath, interval });
    await recordAudit({
      actor_kind: principal.kind === 'admin' && !principal.user ? 'admin_token' : 'user',
      actor_user_id: principal.kind === 'user' ? principal.user.id : principal.user?.id ?? null,
      business_id: business.id, action: 'billing.checkout_started', target: `business:${business.id}`, meta: { with_trial: withTrial, interval, ...(trialDenied ? { trial_denied: trialDenied } : {}) },
    });
    return ok({ url: session.url, mock: false });
  } catch (err) {
    return billingErrorResponse(err);
  }
}
