/**
 * Team management data layer (users of one business, pending invitations) with the last-owner guard.
 * Node runtime only. Authorization lives in the route handlers (src/app/api/team/**): everything here
 * takes the business id EXPLICITLY and never matches a user of another business.
 */
import { NextResponse } from 'next/server';
import { getBusiness, prisma } from '@/lib/db';
import { authenticate, type AuthenticateOptions, type Principal } from '@/lib/session';
import type { Business, User, UserRole } from '@/lib/types';

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

export type TeamUser = Pick<User, 'id' | 'email' | 'role' | 'created_at' | 'disabled_at' | 'email_verified_at' | 'totp_enabled'>;

const toTeamUser = (r: {
  id: string; email: string; role: string; createdAt: Date; disabledAt: Date | null; emailVerifiedAt: Date | null; totpEnabledAt: Date | null;
}): TeamUser => ({
  id: r.id, email: r.email, role: r.role as UserRole, created_at: r.createdAt.toISOString(),
  disabled_at: r.disabledAt ? r.disabledAt.toISOString() : null,
  email_verified_at: r.emailVerifiedAt ? r.emailVerifiedAt.toISOString() : null,
  totp_enabled: r.totpEnabledAt !== null,
});

/** Users of a business (owner/staff only), oldest first. No hashes, no secrets. */
export async function listTeamUsers(businessId: string): Promise<TeamUser[]> {
  const rows = await prisma.user.findMany({ where: { businessId, role: { in: ['owner', 'staff'] } }, orderBy: { createdAt: 'asc' } });
  return rows.map(toTeamUser);
}

export async function getTeamUser(businessId: string, userId: string): Promise<TeamUser | null> {
  const row = await prisma.user.findFirst({ where: { id: userId, businessId, role: { in: ['owner', 'staff'] } } });
  return row ? toTeamUser(row) : null;
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

/**
 * Serialise every change to a business's owners (row locks on its owner rows) and run `fn` inside the same
 * transaction, so two concurrent "demote/disable/remove" requests can never both pass the last-owner check.
 */
async function lockedOwnerChange<T>(
  businessId: string,
  userId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], target: { role: string; disabledAt: Date | null }, otherEnabledOwners: number, otherOwners: number) => Promise<T>,
): Promise<TeamChange<T>> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "business_id" = ${businessId} AND "role" = 'owner' ORDER BY "id" FOR UPDATE`;
    const target = await tx.user.findFirst({ where: { id: userId, businessId, role: { in: ['owner', 'staff'] } } });
    if (!target) return { ok: false as const, reason: 'not_found' as const };
    const [otherEnabledOwners, otherOwners] = await Promise.all([
      tx.user.count({ where: { businessId, role: 'owner', disabledAt: null, id: { not: userId } } }),
      tx.user.count({ where: { businessId, role: 'owner', id: { not: userId } } }),
    ]);
    const value = await fn(tx, target, otherEnabledOwners, otherOwners);
    return { ok: true as const, value };
  });
}

const LAST_OWNER = { ok: false, reason: 'last_owner' } as const;

/** Change owner<->staff. Refuses to demote the last enabled owner. */
export async function changeTeamRole(businessId: string, userId: string, role: 'owner' | 'staff'): Promise<TeamChange<TeamUser | null>> {
  const r = await lockedOwnerChange(businessId, userId, async (tx, target, others) => {
    if (target.role === 'owner' && role !== 'owner' && !target.disabledAt && others === 0) return 'last_owner' as const;
    const row = await tx.user.update({ where: { id: userId }, data: { role } });
    return toTeamUser(row);
  });
  if (r.ok && r.value === 'last_owner') return LAST_OWNER;
  return r as TeamChange<TeamUser | null>;
}

/** Disable or re-enable. Disabling revokes every session of that user and refuses for the last enabled owner. */
export async function setTeamUserDisabled(businessId: string, userId: string, disabled: boolean): Promise<TeamChange<TeamUser | null>> {
  const r = await lockedOwnerChange(businessId, userId, async (tx, target, others) => {
    if (disabled && target.role === 'owner' && !target.disabledAt && others === 0) return 'last_owner' as const;
    const row = await tx.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } });
    if (disabled) await tx.userSession.deleteMany({ where: { userId } });
    return toTeamUser(row);
  });
  if (r.ok && r.value === 'last_owner') return LAST_OWNER;
  return r as TeamChange<TeamUser | null>;
}

/** Delete a user (sessions, recovery codes and their tokens cascade). Refuses to remove the last owner. */
export async function removeTeamUser(businessId: string, userId: string): Promise<TeamChange<void>> {
  const r = await lockedOwnerChange(businessId, userId, async (tx, target, enabledOthers, others) => {
    if (target.role === 'owner' && ((!target.disabledAt && enabledOthers === 0) || others === 0)) return 'last_owner' as const;
    await tx.user.delete({ where: { id: userId } });
    return undefined;
  });
  if (r.ok && (r.value as unknown) === 'last_owner') return LAST_OWNER;
  return r as TeamChange<void>;
}

// ── request authorization shared by the /api/team routes ─────────────────────────

export type TeamAuth =
  | { ok: true; principal: Principal; business: Business; sessionId: string | null }
  | { ok: false; response: NextResponse };

const err = (status: number, error: string, code?: string) => NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
export { err as teamError };

/**
 * Owner-or-admin guard that also resolves the business. An owner is pinned to their own business (another id is a
 * 404, never a 403); an admin must name one (`requested`). Staff get 403.
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
