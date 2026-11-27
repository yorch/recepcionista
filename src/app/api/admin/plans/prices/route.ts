import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { listPlans } from '@/lib/admin/plans';
import { fetchPlanPrice, type PlanPriceInfo } from '@/lib/billing/price';
import { annualPriceId } from '@/lib/providers/stripe-billing';
import { configEnv } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET: the LIVE Stripe price behind each plan's price ids (read from Stripe, cached 10 minutes, fail soft: `null` when Stripe is not configured or does not
 * answer), plus the platform price (STRIPE_PRICE_ID / _ANNUAL) a plan without ids falls back to. Permission: plans.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'plans.read', rate: { name: 'plan-prices', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const env = configEnv();
    const plans = await listPlans({ includeArchived: true });
    const platform = { monthly: await fetchPlanPrice(env.STRIPE_PRICE_ID?.trim()), annual: await fetchPlanPrice(annualPriceId(env)) };
    const items: Record<string, { monthly: PlanPriceInfo | null; annual: PlanPriceInfo | null }> = {};
    for (const p of plans) items[p.key] = { monthly: await fetchPlanPrice(p.stripe_price_id), annual: await fetchPlanPrice(p.stripe_price_id_annual) };
    return ok({ platform, plans: items, stripe_configured: Boolean(env.STRIPE_SECRET_KEY?.trim()) });
  } catch (err) { return adminFail(err); }
}
