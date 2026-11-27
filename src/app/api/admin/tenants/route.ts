import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { listTenants } from '@/lib/admin/tenants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bool = (v: string | null): boolean | undefined => (v === null || v === '' ? undefined : v === '1' || v === 'true');

/**
 * Tenant directory. GET ?q=<name | id prefix | phone digits | agent id | stripe customer | owner e-mail>&status=onboarding|live|paused&billing_status=&plan=&suspended=1&comped=1
 * &past_due=1&trial_ending_days=7&limit=1..100&cursor=<opaque>. Server-side search and keyset pagination (newest first); usage = the latest month on record.
 * Permission: tenants.read.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'tenants.read', rate: { name: 'tenants', max: 120 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    const trial = q.get('trial_ending_days');
    return ok(await listTenants({
      q: q.get('q') ?? undefined, status: q.get('status') ?? undefined, billing_status: q.get('billing_status') ?? undefined, plan: q.get('plan') ?? undefined,
      suspended: bool(q.get('suspended')), comped: bool(q.get('comped')), past_due: bool(q.get('past_due')), trial_ending_days: trial === null ? undefined : int(trial, 7, 0, 365),
      limit: int(q.get('limit'), 25, 1, 100), cursor: q.get('cursor') ?? undefined,
    }));
  } catch (err) { return adminFail(err); }
}
