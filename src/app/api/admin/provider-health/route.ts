import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { providerHealthOverview } from '@/lib/admin/provider-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Provider health HISTORY: every connection test the console ran (live selftest, per-provider Test) is recorded as `provider.health`; this reads them back per provider
 * (current outcome, share of passing checks, last good / bad moment, the recent points). To run a check now use `GET /api/admin/selftest?live=1&force=1` (it records its results).
 * GET ?days=1..90 (default 14)&provider=. Permission: selftest.read. Read only.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'selftest.read', rate: { name: 'provider-health', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    const provider = q.get('provider') || undefined;
    if (provider && !/^[a-z]{3,20}$/.test(provider)) return ok({ window: null, providers: [] });
    return ok(await providerHealthOverview({ days: int(q.get('days'), 14, 1, 90), provider }));
  } catch (err) { return adminFail(err); }
}
