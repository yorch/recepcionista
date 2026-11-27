/**
 * Server-side gate of every /admin page (the console's `requireRolePage`). The proxy only checks that a credential is PRESENT; this validates it against the
 * database in Node: admin principals only (a tenant owner or staff gets a 404, never a hint that the console exists), the 2FA invariant (a DB admin who
 * still has to enrol is redirected to the security page by `getServerResolution`), and an optional permission. Memoised per request.
 */
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { adminRoleOf, can, PERMISSIONS, type AdminRole, type Permission } from '@/lib/admin/permissions';
import { freezeState, type FreezeState } from '@/lib/admin/settings-store';
import { getServerResolution } from '@/lib/session';

export interface AdminPageCtx {
  role: AdminRole;
  via: 'token' | 'cookie' | 'user' | 'dev';
  email: string | null;
  twoFactor: boolean;
  permissions: Permission[];
  /** When this session last proved who it is (ISO), or null (Bearer, dev, never). The step-up window is 5 minutes from here. */
  sudoAt: string | null;
  freeze: FreezeState;
}

export const getAdminPageCtx = cache(async (): Promise<AdminPageCtx> => {
  const res = await getServerResolution();
  if (!res) redirect('/login?next=/admin');
  const p = res.principal;
  if (p.kind !== 'admin') notFound();
  const role = adminRoleOf(p);
  if (!role) notFound();
  const freeze = await freezeState().catch((): FreezeState => ({ frozen: false, by_env: false, frozen_at: null, frozen_by: null, reason: null }));
  return {
    role, via: p.via, email: p.user?.email ?? null, twoFactor: Boolean(p.user?.totp_enabled),
    permissions: PERMISSIONS.filter((x) => can(p, x)), sudoAt: res.sudoAt ?? null, freeze,
  };
});

/** The page gate: admin only, plus `permission` when given (a role without it gets a 404, the nav never offers it). */
export async function requireAdminPage(permission?: Permission): Promise<AdminPageCtx> {
  const ctx = await getAdminPageCtx();
  if (permission && !ctx.permissions.includes(permission)) notFound();
  return ctx;
}
