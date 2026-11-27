import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { suspendBusiness } from '@/lib/admin/tenants';
import { notifyAdmins } from '@/lib/admin/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { reason }: suspend a tenant. A suspended business answers "out of service" and cannot send texts, regardless of billing; its owners can still sign in.
 * Step-up + reason, audited as `tenant.suspended` (business id on the row). Permission: tenants.suspend.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.suspend', write: true, rate: { name: 'tenant-suspend', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    const id = (await params).id;
    const res = await suspendBusiness({ business_id: id, reason: b.reason, actor: g.ctx.actor });
    // Critical tier: every administrator is told (the reason is operator text, never a secret).
    await notifyAdmins({ kind: 'tenant.suspended', business_id: id, subject: 'A business was suspended', lines: [`Business: ${id}`, `By: ${g.ctx.actor.role}`, `Reason: ${String(b.reason).slice(0, 300)}`] }).catch(() => undefined);
    return ok(res);
  } catch (err) { return adminFail(err); }
}
