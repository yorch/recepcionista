/**
 * Team management data layer (members of one business, pending invitations) with the last-owner guard.
 * Node runtime only. Authorization lives in the route handlers (src/app/api/team/**): everything here
 * takes the business id EXPLICITLY and never matches a member of another business. Membership (src/lib/db/memberships.ts) is the
 * source of truth: a person's role and disabled state here are per business.
 */
import { NextResponse } from 'next/server';
import { getBusiness, prisma } from '@/lib/db';
import { disableMembership, listBusinessMembers, listMembershipsForUser, removeMembership, setMembershipRole } from '@/lib/db/memberships';
import { authenticate, type AuthenticateOptions, type Principal } from '@/lib/session';
import type { Business, BusinessMember, User, UserRole } from '@/lib/types';

export interface PendingInvite {
  id: string;
  email: string;
  role: 'owner' | 'staff';
  business_id: string;
  invited_by: string | null;
  invited_by_email: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * A person on one business's team. `role` is their role IN THIS business (their membership), `disabled_at` is set when that
 * membership OR the whole account is disabled. The shape is what the team UI and /api/team have always returned.
 */
export type TeamUser = Pick<User, 'id' | 'email' | 'created_at' | 'disabled_at' | 'email_verified_at' | 'totp_enabled'> & { role: UserRole };

const toTeamUser = (m: BusinessMember): TeamUser => ({
  id: m.user_id, email: m.email, role: m.role, created_at: m.joined_at,
  disabled_at: m.membership_disabled_at ?? m.user_disabled_at, email_verified_at: m.email_verified_at, totp_enabled: m.totp_enabled,
});

/** Team of a business (owner/staff memberships, disabled ones included), oldest first. No hashes, no secrets. */
export async function listTeamUsers(businessId: string): Promise<TeamUser[]> {
  return (await listBusinessMembers(businessId, { includeDisabled: true })).map(toTeamUser);
}

export async function getTeamUser(businessId: string, userId: string): Promise<TeamUser | null> {
  return (await listTeamUsers(businessId)).find((u) => u.id === userId) ?? null;
}

/** The businesses a user (any account) has a membership in, for admins acting on a user without naming a business. */
export async function businessIdsOfUser(userId: string): Promise<string[]> {
  return (await listMembershipsForUser(userId, { includeDisabled: true })).map((m) => m.business_id);
}

/** Unused, unexpired invitations of one business, newest first. */
export async function listPendingInvites(businessId: string, now: Date = new Date()): Promise<PendingInvite[]> {
  const rows = await prisma.emailToken.findMany({
    where: { purpose: 'invite', businessId, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    include: { inviter: { select: { email: true } } },
  });
  return rows.map((r) => ({
    id: r.id, email: r.email, role: r.role as 'owner' | 'staff', business_id: r.businessId as string, invited_by: r.invitedBy,
    invited_by_email: r.inviter?.email ?? null, expires_at: r.expiresAt.toISOString(), created_at: r.createdAt.toISOString(),
  }));
}

export async function getPendingInvite(businessId: string, inviteId: string, now: Date = new Date()): Promise<PendingInvite | null> {
  return (await listPendingInvites(businessId, now)).find((i) => i.id === inviteId) ?? null;
}

/** Void a pending invitation (its link stops working). True when one was pending in THIS business. */
export async function revokeInvite(businessId: string, inviteId: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.emailToken.updateMany({ where: { id: inviteId, purpose: 'invite', businessId, usedAt: null }, data: { usedAt: now } });
  return res.count === 1;
}

/** After a new invitation mail went out: void every OTHER pending invitation of that address in this business. */
export async function supersedeInvites(businessId: string, email: string, exceptId: string, now: Date = new Date()): Promise<void> {
  await prisma.emailToken.updateMany({
    where: { purpose: 'invite', businessId, email: email.trim().toLowerCase(), usedAt: null, id: { not: exceptId } }, data: { usedAt: now },
  });
}

export type TeamChange<T = void> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'last_owner' };

const LAST_OWNER = { ok: false, reason: 'last_owner' } as const;

/**
 * Change owner<->staff IN THIS BUSINESS ONLY. Refuses to demote the last enabled owner (row lock on the business's owner memberships,
 * so two concurrent changes cannot both pass). A role change re-authorises the person: their sessions in this business end, except the caller's own when
 * they changed their own role.
 */
export async function changeTeamRole(
  businessId: string, userId: string, role: 'owner' | 'staff', opts: { keepSessionId?: string } = {},
): Promise<TeamChange<TeamUser | null>> {
  const r = await setMembershipRole(userId, businessId, role);
  if (!r.ok) return r.reason === 'last_owner' ? LAST_OWNER : { ok: false, reason: 'not_found' };
  if (r.changed) {
    // Only the sessions working in THIS business: the person's sessions in their other businesses are unaffected by this role.
    const primary = await prisma.user.findUnique({ where: { id: userId }, select: { businessId: true } });
    await prisma.userSession.deleteMany({
      where: {
        userId, ...(opts.keepSessionId ? { id: { not: opts.keepSessionId } } : {}),
        OR: [{ activeBusinessId: businessId }, ...(primary?.businessId === businessId ? [{ activeBusinessId: null }] : [])],
      },
    });
  }
  return { ok: true, value: await getTeamUser(businessId, userId) };
}

/**
 * Disable or re-enable the person's access to THIS business (their account and other businesses are untouched). Refuses for the last
 * enabled owner. Sessions that were working here fall back to another of their businesses (done by disableMembership); when this was
 * their only business every session of theirs ends.
 */
export async function setTeamUserDisabled(businessId: string, userId: string, disabled: boolean): Promise<TeamChange<TeamUser | null>> {
  const r = await disableMembership(userId, businessId, disabled);
  if (!r.ok) return r.reason === 'last_owner' ? LAST_OWNER : { ok: false, reason: 'not_found' };
  if (disabled && r.changed && (await listMembershipsForUser(userId)).length === 0) await prisma.userSession.deleteMany({ where: { userId } });
  return { ok: true, value: await getTeamUser(businessId, userId) };
}

/** Remove a person from this business. Their account survives when it has other businesses. Refuses to remove the last owner. */
export async function removeTeamUser(businessId: string, userId: string): Promise<TeamChange<{ account_deleted: boolean }>> {
  const r = await removeMembership(userId, businessId);
  return r.ok ? { ok: true, value: { account_deleted: r.account_deleted } } : r.reason === 'last_owner' ? LAST_OWNER : { ok: false, reason: 'not_found' };
}

// ── request authorization shared by the /api/team routes ─────────────────────────

export type TeamAuth =
  | { ok: true; principal: Principal; business: Business; sessionId: string | null }
  | { ok: false; response: NextResponse };

const err = (status: number, error: string, code?: string) => NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
export { err as teamError };

/**
 * Owner-or-admin guard that also resolves the business. An owner is pinned to the session's ACTIVE business, where the account is
 * an owner (another id is a 404, never a 403, even one the account belongs to: switch first); an admin must name one (`requested`).
 * Staff (in the active business) get 403.
 */
export async function authenticateTeam(req: Request, requested: string | null | undefined, opts: AuthenticateOptions = {}): Promise<TeamAuth> {
  const auth = await authenticate(req, { role: 'owner', ...opts });
  if (!auth.ok) return auth;
  const { principal } = auth;
  let businessId: string | null;
  if (principal.kind === 'user') {
    if (requested && requested !== principal.business_id) return { ok: false, response: err(404, 'business not found') };
    businessId = principal.business_id;
  } else {
    businessId = requested || null;
    if (!businessId) return { ok: false, response: err(422, 'business_id is required') };
  }
  const business = await getBusiness(businessId);
  if (!business) return { ok: false, response: err(404, 'business not found') };
  return { ok: true, principal, business, sessionId: auth.sessionId };
}

/** Who is acting, for audit rows. */
export function actorOf(principal: Principal): { actor_kind: 'user' | 'admin_token'; actor_user_id: string | null } {
  const user = 'user' in principal ? principal.user : undefined;
  return user ? { actor_kind: 'user', actor_user_id: user.id } : { actor_kind: 'admin_token', actor_user_id: null };
}
