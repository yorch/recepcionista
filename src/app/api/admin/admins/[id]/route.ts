import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { changeAdminRole, setAdminDisabled } from '@/lib/admin/admins';
import { SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH { disabled?: boolean, platform_role?: string }. disabled: true disables the admin and revokes their sessions (never the last enabled owner, never yourself); false
 * re-enables ("unlock"; also the break-glass token). platform_role changes the role (owners only; revokes their sessions; never your own, never the last owner).
 * Step-up, audited. Permission: admins.manage / admins.recover (enable) / admins.role (role change).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: ['admins.manage', 'admins.recover', 'admins.role'], write: true, rate: { name: 'admins-write', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const { id } = await params;
    const b = await readBody(req);
    if (b.disabled === undefined && b.platform_role === undefined) throw new SettingsError(422, 'invalid_body', 'nothing to change');
    if (b.disabled !== undefined) { if (typeof b.disabled !== 'boolean') throw new SettingsError(422, 'invalid_body', 'disabled must be true or false'); await setAdminDisabled({ id, disabled: b.disabled, actor: g.ctx.actor }); }
    let admin;
    if (b.platform_role !== undefined) admin = await changeAdminRole({ id, platform_role: b.platform_role, actor: g.ctx.actor });
    return ok({ updated: true, ...(admin ? { admin } : {}) });
  } catch (err) { return adminFail(err); }
}
