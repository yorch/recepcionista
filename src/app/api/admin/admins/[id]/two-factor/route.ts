import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { resetAdminTwoFactor } from '@/lib/admin/admins';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE: reset an administrator's 2FA (secret, recovery codes, passkeys) and revoke their sessions; they must enrol again. Step-up, audited. Permission: admins.manage (owner). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'admins.manage', write: true, rate: { name: 'admins-write', max: 20 } });
  if (!g.ok) return g.response;
  try { return ok(await resetAdminTwoFactor({ id: (await params).id, actor: g.ctx.actor })); } catch (err) { return adminFail(err); }
}
