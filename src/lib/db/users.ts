/**
 * Per-tenant users and server-side sessions. Node runtime only (never import from proxy.ts).
 * Password hashing lives in src/lib/password.ts; this module only stores the encoded hash.
 * Session tokens are random 256-bit values; only their sha256 is stored, so a database leak
 * does not yield usable sessions.
 */
import crypto from 'node:crypto';
import { prisma } from './client';
import type { User, UserRole, UserSession } from '@/lib/types';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = 5 * 60 * 1000;
const ROLES: readonly UserRole[] = ['owner', 'staff', 'admin'];

export type UserWithHash = User & { password_hash: string };

export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const hashSessionToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

type UserRow = { id: string; email: string; passwordHash: string; businessId: string | null; role: string; createdAt: Date; disabledAt: Date | null };
type SessionRow = { id: string; userId: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date };

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    business_id: row.businessId,
    role: row.role as UserRole,
    created_at: row.createdAt.toISOString(),
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
  };
}
const toSession = (r: SessionRow): UserSession => ({
  id: r.id,
  user_id: r.userId,
  expires_at: r.expiresAt.toISOString(),
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt.toISOString(),
});

/**
 * Create a user. `password_hash` must come from hashPassword(). Owners/staff need a business_id;
 * admins must not have one. Throws EmailTakenError on a duplicate email (case-insensitive).
 */
export async function createUser(input: {
  email: string;
  password_hash: string;
  role: UserRole;
  business_id?: string | null;
}): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('createUser: invalid email');
  if (!ROLES.includes(input.role)) throw new Error('createUser: invalid role');
  const businessId = input.business_id ?? null;
  if (input.role === 'admin' ? businessId !== null : businessId === null) {
    throw new Error('createUser: owner/staff need a business_id; admin must not have one');
  }
  try {
    const row = await prisma.user.create({
      data: { email, passwordHash: input.password_hash, role: input.role, businessId },
    });
    return toUser(row);
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') throw new EmailTakenError();
    throw err;
  }
}

/** Case-insensitive lookup. Includes password_hash for login verification; never send it to a client. */
export async function getUserByEmail(email: string): Promise<UserWithHash | null> {
  const row = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  return row ? { ...toUser(row), password_hash: row.passwordHash } : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const row = await prisma.user.findUnique({ where: { id } });
  return row ? toUser(row) : null;
}

/** Replace the password hash and revoke every session of that user. */
export async function setUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.userSession.deleteMany({ where: { userId } }),
  ]);
}

/** Disable (or re-enable) a user. Disabling also revokes every session. */
export async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } }),
    ...(disabled ? [prisma.userSession.deleteMany({ where: { userId } })] : []),
  ]);
}

/**
 * Create a session. The raw token is returned ONCE (put it in an HttpOnly cookie); only its
 * sha256 is stored. Also opportunistically deletes expired sessions.
 */
export async function createSession(
  userId: string,
  opts: { ttlMs?: number; now?: Date } = {},
): Promise<{ token: string; session: UserSession }> {
  const now = opts.now ?? new Date();
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await prisma.userSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? SESSION_TTL_MS)),
      createdAt: now,
      lastUsedAt: now,
    },
  });
  if (Math.random() < 0.02) void deleteExpiredSessions(now);
  return { token, session: toSession(row) };
}

/**
 * Resolve a raw token to its session + user. Null when unknown, expired (an expired row is
 * deleted), or the user is disabled. Refreshes last_used_at at most every 5 minutes.
 */
export async function getSessionByToken(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<{ session: UserSession; user: User } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await prisma.userSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await prisma.userSession.deleteMany({ where: { id: row.id } });
    return null;
  }
  if (row.user.disabledAt) return null;
  let lastUsedAt = row.lastUsedAt;
  if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
    await prisma.userSession.updateMany({ where: { id: row.id }, data: { lastUsedAt: now } });
    lastUsedAt = now;
  }
  return { session: toSession({ ...row, lastUsedAt }), user: toUser(row.user) };
}

/** Log out one session by its raw token. Returns whether a session was removed. */
export async function deleteSession(token: string): Promise<boolean> {
  if (!token) return false;
  const res = await prisma.userSession.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  return res.count > 0;
}

/** Revoke all sessions of a user ("log out everywhere"). Returns how many were removed. */
export async function deleteUserSessions(userId: string): Promise<number> {
  const res = await prisma.userSession.deleteMany({ where: { userId } });
  return res.count;
}

export async function deleteExpiredSessions(now: Date = new Date()): Promise<number> {
  try {
    const res = await prisma.userSession.deleteMany({ where: { expiresAt: { lt: now } } });
    return res.count;
  } catch {
    return 0;
  }
}
