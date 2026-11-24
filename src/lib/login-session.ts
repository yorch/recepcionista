/**
 * Shared bits of "an account just authenticated" (password login, MFA, passkey login, invite acceptance). Node runtime only.
 */
import { listMembershipsForUser } from '@/lib/db/memberships';
import type { User } from '@/lib/types';

/**
 * Can this account act anywhere? An admin always can; an owner/staff account needs at least one ENABLED membership (a person disabled in
 * every business has nothing to sign in to, so sign-in answers like any other refusal).
 */
export async function accountHasAccess(user: User): Promise<boolean> {
  if (user.disabled_at) return false;
  if (user.role === 'admin') return true;
  return (await listMembershipsForUser(user.id)).length > 0;
}

/** The sign-in response body: the role and business the new session will start in (primary first, else the oldest enabled membership). */
export async function signedInData(user: User): Promise<{
  authenticated: true; kind: 'user'; email: string; role: User['role']; business_id: string | null; email_verified: boolean; business_count: number;
}> {
  const list = user.role === 'admin' ? [] : await listMembershipsForUser(user.id);
  const active = list.find((m) => m.business_id === user.business_id) ?? list[0] ?? null;
  return {
    authenticated: true, kind: 'user', email: user.email, role: active ? active.role : user.role,
    business_id: active ? active.business_id : user.business_id, email_verified: user.email_verified_at !== null, business_count: list.length,
  };
}
