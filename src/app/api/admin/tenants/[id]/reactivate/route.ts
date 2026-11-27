import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { reactivateBusiness } from '@/lib/admin/tenants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST { reason }: lift a suspension. Step-up + reason, audited as `tenant.reactivated`. Permission: tenants.suspend. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.suspend', write: true, rate: { name: 'tenant-suspend', max: 20 } });
  if (!g.ok) return g.response;
  try { const b = await readBody(req); await reactivateBusiness({ business_id: (await params).id, reason: b.reason, actor: g.ctx.actor }); return ok({ reactivated: true }); } catch (err) { return adminFail(err); }
}
