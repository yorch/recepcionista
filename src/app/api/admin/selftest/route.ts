import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { selftest } from '@/lib/admin/selftest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Provider readiness (configured? from where?) without any secret and without a network call (`tested:false`; Phase 4 adds real tests). Permission: selftest.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'selftest.read', rate: { name: 'selftest', max: 30 } });
  if (!g.ok) return g.response;
  try { return ok(selftest()); } catch (err) { return adminFail(err); }
}
