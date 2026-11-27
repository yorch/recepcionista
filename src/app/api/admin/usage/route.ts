import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { usageOverview } from '@/lib/admin/usage-overview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Usage and revenue overview: tenants by status / billing state / plan, MRR ESTIMATE (the monthly equivalent of each plan's Stripe price x paying tenants; null while no price can be read),
 * this month's usage against the enforced caps, trials ending soon, the heaviest tenants. Permission: tenants.read. Read only.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'tenants.read', rate: { name: 'usage-overview', max: 30 } });
  if (!g.ok) return g.response;
  try { return ok(await usageOverview()); } catch (err) { return adminFail(err); }
}
