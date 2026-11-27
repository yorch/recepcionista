import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { selftest } from '@/lib/admin/selftest';
import { can } from '@/lib/admin/permissions';
import { liveSelftest } from '@/lib/admin/provider-tests';
import { recordLiveSelftest } from '@/lib/admin/provider-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Provider readiness (configured? from where?) without any secret and without a network call (`tested:false`). With `?live=1` each CONFIGURED provider also gets a real,
 * coarse connection test (`test: { outcome: ok | auth_failed | unreachable | misconfigured, ... }`, `tested: true`), cached for 5 minutes per provider and credential set;
 * `&force=1` skips the cache. Only a role that may repair providers (ops, owner) makes the calls; any other role gets what is already cached. Permission: selftest.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'selftest.read', rate: { name: 'selftest', max: 30 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    if (q.get('live') === '1') {
      const refresh = can(g.ctx.principal, 'providers.repair');
      const res = await liveSelftest({ refresh, force: refresh && q.get('force') === '1' });
      if (refresh) await recordLiveSelftest(res, g.ctx.actor); // provider health history (audit `provider.health`, de-duplicated)
      return ok(res);
    }
    return ok(selftest());
  } catch (err) { return adminFail(err); }
}
