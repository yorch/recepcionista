import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { suspendBusiness } from '@/lib/admin/tenants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { reason }: suspend a tenant. A suspended business answers "out of service" and cannot send texts, regardless of billing; its owners can still sign in.
 * Step-up + reason, audited as `tenant.suspended` (business id on the row). Permission: tenants.suspend.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.suspend', write: true, rate: { name: 'tenant-suspend', max: 20 } });
  if (!g.ok) return g.response;
  try { const b = await readBody(req); return ok(await suspendBusiness({ business_id: (await params).id, reason: b.reason, actor: g.ctx.actor })); } catch (err) { return adminFail(err); }
}
