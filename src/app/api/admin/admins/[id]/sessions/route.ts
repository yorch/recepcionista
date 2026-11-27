import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { revokeAdminUserSessions } from '@/lib/admin/admins';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** DELETE: revoke every session of one administrator (recovery; also the break-glass token). Step-up, audited as `admin.sessions_revoked`. Permission: admins.recover. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'admins.recover', write: true, rate: { name: 'admins-write', max: 20 } });
  if (!g.ok) return g.response;
  try { return ok(await revokeAdminUserSessions({ id: (await params).id, actor: g.ctx.actor })); } catch (err) { return adminFail(err); }
}
