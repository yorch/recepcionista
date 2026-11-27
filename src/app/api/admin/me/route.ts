import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { PERMISSIONS, can } from '@/lib/admin/permissions';
import { freezeState } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Who am I in the console: role, how I authenticated, and the permissions the console UI should offer. Any admin. Permission: (any admin). */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'me', max: 120 } });
  if (!g.ok) return g.response;
  try {
    const { principal, role } = g.ctx;
    return ok({
      role, via: principal.via, user: principal.user ? { id: principal.user.id, email: principal.user.email, platform_role: principal.user.platform_role ?? null, two_factor: principal.user.totp_enabled } : null,
      permissions: PERMISSIONS.filter((p) => can(principal, p)), frozen: (await freezeState()).frozen, reveal_secret_meta: g.ctx.revealSecretMeta,
    });
  } catch (err) { return adminFail(err); }
}
