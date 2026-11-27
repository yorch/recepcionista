import { ok, fail } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { getTenantDetail } from '@/lib/admin/tenants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Tenant detail (support view, read-only): profile, provider ids, billing, suspension, users, usage, overridable knobs with bounds, support grants, the last audit rows. Permission: tenants.read. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.read', rate: { name: 'tenant-detail', max: 120 } });
  if (!g.ok) return g.response;
  try { const d = await getTenantDetail((await params).id); return d ? ok(d) : fail('business not found', 404); } catch (err) { return adminFail(err); }
}
