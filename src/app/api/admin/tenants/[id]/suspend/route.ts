import { ok } from '@/lib/http';
import { prisma } from '@/lib/db/client';
import { requireConfirmPhrase, tenantPhraseOf, TENANT_VERBS } from '@/lib/admin/confirm';
import { isBreakGlass } from '@/lib/admin/permissions';
import { SettingsError } from '@/lib/admin/settings-store';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { suspendBusiness } from '@/lib/admin/tenants';
import { notifyAdmins } from '@/lib/admin/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST { reason, confirm }: suspend a tenant. A suspended business answers "out of service" and cannot send texts, regardless of billing; its owners can still sign in.
 * Step-up + reason + the typed phrase `suspend <business name>` (`confirm`, 422 `confirmation_required`), audited as `tenant.suspended` (business id on the row). Permission: tenants.suspend.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'tenants.suspend', write: true, rate: { name: 'tenant-suspend', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    const id = (await params).id;
    const biz = await prisma.business.findUnique({ where: { id }, select: { name: true } });
    if (!biz) throw new SettingsError(404, 'not_found', 'business not found');
    if (!isBreakGlass(g.ctx.principal)) requireConfirmPhrase(b.confirm, TENANT_VERBS.suspend.map((v) => tenantPhraseOf(v, biz.name))); // the typed phrase, enforced here as well as in the console
    const res = await suspendBusiness({ business_id: id, reason: b.reason, actor: g.ctx.actor });
    // Critical tier: every administrator is told (the reason is operator text, never a secret).
    await notifyAdmins({ kind: 'tenant.suspended', business_id: id, subject: 'A business was suspended', lines: [`Business: ${id}`, `By: ${g.ctx.actor.role}`, `Reason: ${String(b.reason).slice(0, 300)}`] }).catch(() => undefined);
    return ok(res);
  } catch (err) { return adminFail(err); }
}
