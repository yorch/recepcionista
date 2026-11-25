/**
 * Multi-business memberships: which account belongs to which business, with which role. Node runtime only.
 *
 * `memberships` is the source of truth for access. `users.business_id` / `users.role` remain as the legacy "primary" business and are
 * kept in step: legacy writes are mirrored into memberships by a database trigger, and the helpers here write the legacy columns
 * back when they change the role in the user's primary business. Admins have no memberships.
 *
 * Last-owner protection counts MEMBERSHIPS: every change that could leave a business without an enabled owner (demote, disable) takes
 * a row lock on the business's owner memberships first, so two concurrent changes cannot both pass the check.
 */
import { prisma, type DbClient } from './client';
import { consumeEmailToken } from './email-tokens';
import { normalizeEmail } from './users';
import type { BusinessMember, EmailToken, Membership, MembershipRole, MembershipWithBusiness } from '@/lib/types';
import type { Membership as Row } from '@prisma/client';

const ROLES: readonly MembershipRole[] = ['owner', 'staff'];

const toMembership = (r: Row): Membership => ({
  id: r.id, user_id: r.userId, business_id: r.businessId, role: r.role as MembershipRole,
  created_at: r.createdAt.toISOString(), disabled_at: r.disabledAt ? r.disabledAt.toISOString() : null,
});

/** A user's memberships (oldest first) with the business name. Disabled ones only with `includeDisabled`. */
export async function listMembershipsForUser(userId: string, opts: { includeDisabled?: boolean } = {}, db: DbClient = prisma): Promise<MembershipWithBusiness[]> {
  const rows = await db.membership.findMany({
    where: { userId, ...(opts.includeDisabled ? {} : { disabledAt: null }) },
    include: { business: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ ...toMembership(r), business_name: r.business.name }));
}

/** The membership of one user in one business (disabled ones included: check `disabled_at`). */
export async function getMembership(userId: string, businessId: string, db: DbClient = prisma): Promise<Membership | null> {
  const row = await db.membership.findUnique({ where: { userId_businessId: { userId, businessId } } });
  return row ? toMembership(row) : null;
}

/** Enabled owners of a business: owner memberships that are not disabled, whose account is not disabled either. */
export async function countActiveOwners(businessId: string, db: DbClient = prisma): Promise<number> {
  return db.membership.count({ where: { businessId, role: 'owner', disabledAt: null, user: { disabledAt: null } } });
}

/** Row-lock the business's owner memberships (serialises every owner-affecting change of that business). */
async function lockOwners(tx: DbClient, businessId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "memberships" WHERE "business_id" = ${businessId} AND "role" = 'owner' ORDER BY "id" FOR UPDATE`;
}

export class MembershipError extends Error {
  constructor(message: string, public code: 'admin_account' | 'user_not_found' | 'business_not_found' | 'invalid_role') {
    super(message);
    this.name = 'MembershipError';
  }
}

/**
 * Add the user to a business (or update the existing membership: the role is set, a disabled membership is re-enabled).
 * `created` says whether a new row was made. Refuses admin accounts. This is how an EXISTING account accepts an invitation to
 * another business. Pass a transaction client to make it part of the caller's unit of work.
 */
export async function addMembership(
  input: { user_id: string; business_id: string; role: MembershipRole }, db: DbClient = prisma,
): Promise<{ membership: Membership; created: boolean }> {
  if (!ROLES.includes(input.role)) throw new MembershipError('invalid role', 'invalid_role');
  const user = await db.user.findUnique({ where: { id: input.user_id }, select: { role: true } });
  if (!user) throw new MembershipError('user not found', 'user_not_found');
  if (user.role === 'admin') throw new MembershipError('admin accounts have no memberships', 'admin_account');
  const exists = await db.membership.findUnique({ where: { userId_businessId: { userId: input.user_id, businessId: input.business_id } }, select: { id: true } });
  try {
    const row = await db.membership.upsert({
      where: { userId_businessId: { userId: input.user_id, businessId: input.business_id } },
      update: { role: input.role, disabledAt: null },
      create: { userId: input.user_id, businessId: input.business_id, role: input.role },
    });
    // A fresh grant (an invitation accepted with a token the owner issued) lifts an earlier sign-out of this business from the person's sessions.
    await db.$executeRaw`
      UPDATE "user_sessions" SET "revoked_business_ids" = array_remove("revoked_business_ids", ${input.business_id})
       WHERE "user_id" = ${input.user_id} AND ${input.business_id} = ANY("revoked_business_ids")`;
    return { membership: toMembership(row), created: !exists };
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2003') throw new MembershipError('business not found', 'business_not_found');
    throw err;
  }
}

export type MembershipChange =
  | { ok: true; membership: Membership; changed: boolean }
  | { ok: false; reason: 'not_found' | 'last_owner' };

async function guarded(
  businessId: string, userId: string,
  fn: (tx: DbClient, m: Row) => Promise<MembershipChange>,
): Promise<MembershipChange> {
  return prisma.$transaction(async (tx) => {
    await lockOwners(tx, businessId);
    const m = await tx.membership.findUnique({ where: { userId_businessId: { userId, businessId } } });
    if (!m) return { ok: false as const, reason: 'not_found' as const };
    return fn(tx, m);
  });
}

/** Would removing `m` from the enabled owners leave the business with none? */
async function wouldLeaveNoOwner(tx: DbClient, m: Row): Promise<boolean> {
  if (m.role !== 'owner' || m.disabledAt) return false;
  const u = await tx.user.findUnique({ where: { id: m.userId }, select: { disabledAt: true } });
  if (u?.disabledAt) return false; // already not counted
  const others = await tx.membership.count({ where: { businessId: m.businessId, role: 'owner', disabledAt: null, userId: { not: m.userId }, user: { disabledAt: null } } });
  return others === 0;
}

/**
 * Change the role in ONE business. Refuses to demote the last enabled owner. When the business is the user's legacy primary the
 * legacy `users.role` is updated too.
 */
export async function setMembershipRole(userId: string, businessId: string, role: MembershipRole): Promise<MembershipChange> {
  if (!ROLES.includes(role)) throw new MembershipError('invalid role', 'invalid_role');
  return guarded(businessId, userId, async (tx, m) => {
    if (m.role === role) return { ok: true, membership: toMembership(m), changed: false };
    if (role !== 'owner' && (await wouldLeaveNoOwner(tx, m))) return { ok: false, reason: 'last_owner' };
    const row = await tx.membership.update({ where: { id: m.id }, data: { role } });
    await tx.user.updateMany({ where: { id: userId, businessId }, data: { role } });
    return { ok: true, membership: toMembership(row), changed: true };
  });
}

/**
 * Disable (default) or re-enable the user's access to ONE business; the account and its other businesses are untouched. Disabling the
 * last enabled owner is refused. Sessions that were working in that business fall back to the primary one (active_business_id cleared).
 */
export async function disableMembership(userId: string, businessId: string, disabled = true, now: Date = new Date()): Promise<MembershipChange> {
  return guarded(businessId, userId, async (tx, m) => {
    if (disabled === (m.disabledAt !== null)) return { ok: true, membership: toMembership(m), changed: false };
    if (disabled && (await wouldLeaveNoOwner(tx, m))) return { ok: false, reason: 'last_owner' };
    const row = await tx.membership.update({ where: { id: m.id }, data: { disabledAt: disabled ? now : null } });
    if (disabled) {
      await tx.userSession.updateMany({ where: { userId, activeBusinessId: businessId }, data: { activeBusinessId: null } });
      await revokeBusinessForSessions(tx, { userId }, businessId); // re-enabling later must not revive a session that already lost this business
    }
    return { ok: true, membership: toMembership(row), changed: true };
  });
}

/**
 * Remove the user from ONE business (the team page's "remove"). The account and its other memberships survive; when this was their last
 * membership the account itself is deleted (a login with no business has nothing to open), exactly as removing a team member always did.
 * Refuses when the business would be left without an enabled owner (same lock as the other owner-affecting changes). Sessions that
 * were working in the business fall back to their primary one; the legacy `users.business_id/role` is moved to another membership.
 */
export async function removeMembership(
  userId: string, businessId: string,
): Promise<{ ok: true; account_deleted: boolean } | { ok: false; reason: 'not_found' | 'last_owner' }> {
  return prisma.$transaction(async (tx) => {
    await lockOwners(tx, businessId);
    const m = await tx.membership.findUnique({ where: { userId_businessId: { userId, businessId } } });
    if (!m) return { ok: false as const, reason: 'not_found' as const };
    if (m.role === 'owner') {
      const otherEnabled = await tx.membership.count({ where: { businessId, role: 'owner', disabledAt: null, userId: { not: userId }, user: { disabledAt: null } } });
      if (otherEnabled === 0) return { ok: false as const, reason: 'last_owner' as const };
    }
    const others = await tx.membership.findMany({ where: { userId, businessId: { not: businessId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (others.length === 0) {
      await tx.user.delete({ where: { id: userId } }); // sessions, tokens, passkeys and the membership cascade
      return { ok: true as const, account_deleted: true };
    }
    await tx.membership.delete({ where: { id: m.id } });
    await tx.userSession.updateMany({ where: { userId, activeBusinessId: businessId }, data: { activeBusinessId: null } });
    await revokeBusinessForSessions(tx, { userId }, businessId);
    const u = await tx.user.findUnique({ where: { id: userId }, select: { businessId: true } });
    if (u?.businessId === businessId) {
      const next = others.find((o) => o.disabledAt === null) ?? others[0];
      await tx.user.update({ where: { id: userId }, data: { businessId: next.businessId, role: next.role } });
    }
    return { ok: true as const, account_deleted: false };
  });
}

/**
 * Add `businessId` to the per-session revoked list of the user's sessions (idempotent; one UPDATE). A session on that list cannot resolve to
 * that business or switch to it, even if the membership is enabled again later: only a NEW login (a new session) clears it. `except` keeps one
 * session (the caller's own) out of it. Returns how many sessions were changed.
 */
export async function revokeBusinessForSessions(db: DbClient, who: { userId: string; exceptSessionId?: string }, businessId: string): Promise<number> {
  return db.$executeRaw`
    UPDATE "user_sessions" SET "revoked_business_ids" = array_append(COALESCE("revoked_business_ids", ARRAY[]::text[]), ${businessId})
     WHERE "user_id" = ${who.userId} AND "kind" = 'user' AND NOT (${businessId} = ANY(COALESCE("revoked_business_ids", ARRAY[]::text[])))
       AND (${who.exceptSessionId ?? null}::text IS NULL OR "id" <> ${who.exceptSessionId ?? null}::text)`;
}

export const enableMembership = (userId: string, businessId: string): Promise<MembershipChange> => disableMembership(userId, businessId, false);

/** The team of a business: account + role in THIS business. Disabled members (membership or account) only with `includeDisabled`. */
export async function listBusinessMembers(businessId: string, opts: { includeDisabled?: boolean } = {}, db: DbClient = prisma): Promise<BusinessMember[]> {
  const rows = await db.membership.findMany({
    where: { businessId, ...(opts.includeDisabled ? {} : { disabledAt: null, user: { disabledAt: null } }) },
    include: { user: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((m) => ({
    user_id: m.userId, email: m.user.email, role: m.role as MembershipRole,
    membership_disabled_at: m.disabledAt ? m.disabledAt.toISOString() : null,
    user_disabled_at: m.user.disabledAt ? m.user.disabledAt.toISOString() : null,
    email_verified_at: m.user.emailVerifiedAt ? m.user.emailVerifiedAt.toISOString() : null,
    totp_enabled: m.user.totpEnabledAt !== null, joined_at: m.createdAt.toISOString(),
  }));
}

/**
 * Point a user session at one of the account's businesses (or back to the primary with `null`). The membership check is part of the
 * UPDATE itself: the row changes only when the session is a user session and its account has an ENABLED membership in that business
 * (and the account is enabled). True when it changed; false means "not a member" or "no such session".
 */
export async function setSessionActiveBusiness(sessionId: string, businessId: string | null, db: DbClient = prisma): Promise<boolean> {
  if (businessId === null) {
    const res = await db.userSession.updateMany({ where: { id: sessionId, kind: 'user' }, data: { activeBusinessId: null } });
    return res.count === 1;
  }
  const n = await db.$executeRaw`
    UPDATE "user_sessions" s SET "active_business_id" = ${businessId}
     WHERE s."id" = ${sessionId} AND s."kind" = 'user'
       AND NOT (${businessId} = ANY(COALESCE(s."revoked_business_ids", ARRAY[]::text[])))
       AND EXISTS (SELECT 1 FROM "memberships" m JOIN "users" u ON u."id" = m."user_id"
                    WHERE m."user_id" = s."user_id" AND m."business_id" = ${businessId}
                      AND m."disabled_at" IS NULL AND u."disabled_at" IS NULL)`;
  return n === 1;
}

/**
 * The business a session should act in: its `active_business_id` while that membership is still enabled, else the user's primary
 * (legacy business_id) when still enabled, else their oldest enabled membership; null when they have none (admins).
 */
export async function resolveActiveMembership(
  userId: string, activeBusinessId: string | null | undefined, db: DbClient = prisma,
): Promise<MembershipWithBusiness | null> {
  const list = await listMembershipsForUser(userId, {}, db);
  if (list.length === 0) return null;
  const active = activeBusinessId ? list.find((m) => m.business_id === activeBusinessId) : undefined;
  if (active) return active;
  const u = await db.user.findUnique({ where: { id: userId }, select: { businessId: true } });
  return list.find((m) => m.business_id === u?.businessId) ?? list[0];
}

/**
 * Accept an invitation with an account that ALREADY EXISTS (the invited address has an account): atomically consumes the invite token
 * and adds the membership. Null when the token is invalid, expired, used, not an invite, or was issued for a different address.
 * Nothing is consumed on a mismatch (the whole thing is one transaction).
 */
export async function acceptInviteForExistingUser(
  token: string, userId: string, now: Date = new Date(),
): Promise<{ membership: Membership; created: boolean; invite: EmailToken } | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, disabledAt: true, role: true } });
      if (!user || user.disabledAt || user.role === 'admin') return null;
      const invite = await consumeEmailToken('invite', token, now, tx);
      if (!invite || !invite.business_id || (invite.role !== 'owner' && invite.role !== 'staff')) throw new Rollback();
      if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) throw new Rollback();
      const r = await addMembership({ user_id: userId, business_id: invite.business_id, role: invite.role }, tx);
      return { ...r, invite };
    });
  } catch (err) {
    if (err instanceof Rollback) return null;
    throw err;
  }
}

class Rollback extends Error {}
