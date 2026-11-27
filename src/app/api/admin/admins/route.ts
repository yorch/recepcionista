import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { inviteAdmin, listAdmins } from '@/lib/admin/admins';
import { PLATFORM_ROLES } from '@/lib/admin/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The console administrators (role, 2FA, disabled, sessions) and the assignable roles. Permission: admins.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'admins.read', rate: { name: 'admins', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok({ admins: await listAdmins(), roles: PLATFORM_ROLES }); } catch (err) { return adminFail(err); }
}

/**
 * POST { email, platform_role, password? }: create an administrator. Without `password` an invite e-mail with a set-password link is sent (7 days); with `password` (the
 * break-glass token or an owner; RECOVERY use) the account is created directly. The new admin must enrol in 2FA before using anything. Step-up, audited as `admin.invited`.
 * Permission: admins.manage (owner) or admins.recover (break-glass token).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: ['admins.manage', 'admins.recover'], write: true, rate: { name: 'admins-write', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    return ok(await inviteAdmin({ email: b.email, platform_role: b.platform_role, password: b.password, actor: g.ctx.actor }), 201);
  } catch (err) { return adminFail(err); }
}
