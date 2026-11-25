/**
 * Per-tenant users and server-side sessions. Node runtime only (never import from proxy.ts).
 * Password hashing lives in src/lib/password.ts; this module only stores the encoded hash.
 * Session tokens are random 256-bit values; only their sha256 is stored, so a database leak
 * does not yield usable sessions.
 */
import crypto from 'node:crypto';
import { prisma, type DbClient } from './client';
import type { Locale, SessionKind, User, UserRole, UserSession } from '@/lib/types';
import { LOCALES } from '@/lib/types';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Break-glass (ADMIN_TOKEN) server-side sessions are short lived. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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

type UserRow = {
  id: string; email: string; passwordHash: string; businessId: string | null; role: string; createdAt: Date; disabledAt: Date | null;
  emailVerifiedAt: Date | null; phone: string | null; totpEnabledAt: Date | null; locale?: string;
};
type SessionRow = {
  id: string; userId: string | null; kind: string; expiresAt: Date; createdAt: Date; lastUsedAt: Date;
  mfaVerifiedAt: Date | null; sudoAt: Date | null; ip: string | null; userAgent: string | null; activeBusinessId?: string | null;
  revokedBusinessIds?: string[] | null;
};

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    business_id: row.businessId,
    role: row.role as UserRole,
    created_at: row.createdAt.toISOString(),
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
    email_verified_at: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
    phone: row.phone ?? null,
    totp_enabled: row.totpEnabledAt !== null && row.totpEnabledAt !== undefined,
    locale: row.locale === 'es' ? 'es' : 'en',
  };
}
const toSession = (r: SessionRow): UserSession => ({
  id: r.id,
  user_id: r.userId,
  kind: r.kind as SessionKind,
  expires_at: r.expiresAt.toISOString(),
  created_at: r.createdAt.toISOString(),
  last_used_at: r.lastUsedAt.toISOString(),
  mfa_verified_at: r.mfaVerifiedAt ? r.mfaVerifiedAt.toISOString() : null,
  sudo_at: r.sudoAt ? r.sudoAt.toISOString() : null,
  ip: r.ip ?? null,
  user_agent: r.userAgent ?? null,
  active_business_id: r.activeBusinessId ?? null,
  revoked_business_ids: r.revokedBusinessIds ?? [],
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
  /** Set when the address is already proven (invite acceptance, admin-created users). Default: unverified. */
  email_verified?: boolean;
  /** E.164 (see toE164) or null. */
  phone?: string | null;
  /** UI / text language of the user (default 'en'). */
  locale?: Locale;
}, db: DbClient = prisma): Promise<User> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('createUser: invalid email');
  if (!ROLES.includes(input.role)) throw new Error('createUser: invalid role');
  const businessId = input.business_id ?? null;
  if (input.role === 'admin' ? businessId !== null : businessId === null) {
    throw new Error('createUser: owner/staff need a business_id; admin must not have one');
  }
  try {
    const row = await db.user.create({
      data: {
        email, passwordHash: input.password_hash, role: input.role, businessId,
        emailVerifiedAt: input.email_verified ? new Date() : null,
        phone: input.phone ?? null,
        ...(input.locale && LOCALES.includes(input.locale) ? { locale: input.locale } : {}),
      },
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

/**
 * The user changed (or reset) their password: store the new hash and revoke EVERY session of that user.
 * Optionally keep one session (the caller's own, after a self-service change): pass its id in `keepSessionId`.
 */
export async function changePassword(userId: string, passwordHash: string, opts: { keepSessionId?: string } = {}): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.userSession.deleteMany({ where: { userId, ...(opts.keepSessionId ? { id: { not: opts.keepSessionId } } : {}) } }),
  ]);
}

/**
 * Transparent hash upgrade after a successful login (see needsRehash): replaces the stored hash WITHOUT
 * touching sessions. Only writes when the stored hash is still `expectedOldHash`, so a concurrent
 * password change is never overwritten by a stale rehash. Returns whether it wrote.
 */
export async function upgradePasswordHash(userId: string, expectedOldHash: string, newHash: string): Promise<boolean> {
  const res = await prisma.user.updateMany({ where: { id: userId, passwordHash: expectedOldHash }, data: { passwordHash: newHash } });
  return res.count === 1;
}

/** @deprecated Use changePassword (revokes sessions) or upgradePasswordHash (does not). Kept as an alias of changePassword. */
export const setUserPasswordHash = changePassword;

/** Mark the user's email address as proven (idempotent; the first timestamp wins). */
export async function markEmailVerified(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
}

/** The user's UI/text language. Anything but 'en' | 'es' is rejected. */
export async function setUserLocale(userId: string, locale: Locale): Promise<void> {
  if (!LOCALES.includes(locale)) throw new Error('setUserLocale: locale must be en or es');
  await prisma.user.update({ where: { id: userId }, data: { locale } });
}

/** Set or clear (null) the user's phone. Pass E.164 from toE164(); anything else is rejected. */
export async function setUserPhone(userId: string, phoneE164: string | null): Promise<void> {
  if (phoneE164 !== null && !/^\+[1-9][0-9]{6,14}$/.test(phoneE164)) throw new Error('setUserPhone: not an E.164 number');
  await prisma.user.update({ where: { id: userId }, data: { phone: phoneE164 } });
}

/** Disable (or re-enable) a user. Disabling also revokes every session. */
export async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } }),
    ...(disabled ? [prisma.userSession.deleteMany({ where: { userId } })] : []),
  ]);
}

export interface SessionOptions {
  ttlMs?: number;
  now?: Date;
  ip?: string | null;
  userAgent?: string | null;
  /** Mark the session as having passed the second factor at creation time. */
  mfaVerified?: boolean;
}

const clip = (v: string | null | undefined, max: number): string | null => (v ? v.slice(0, max) : null);

async function insertSession(userId: string | null, kind: SessionKind, defaultTtl: number, opts: SessionOptions) {
  const now = opts.now ?? new Date();
  const token = crypto.randomBytes(32).toString('base64url');
  const row = await prisma.userSession.create({
    data: {
      userId,
      kind,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? defaultTtl)),
      createdAt: now,
      lastUsedAt: now,
      mfaVerifiedAt: opts.mfaVerified ? now : null,
      sudoAt: now, // a session is born from a fresh proof of identity (password / invite / reset / second factor)
      ip: clip(opts.ip, 64),
      userAgent: clip(opts.userAgent, 300),
    },
  });
  if (Math.random() < 0.02) void deleteExpiredSessions(now);
  return { token, session: toSession(row) };
}

/**
 * Create a user session. The raw token is returned ONCE (put it in an HttpOnly cookie); only its
 * sha256 is stored. Also opportunistically deletes expired sessions.
 */
export function createSession(userId: string, opts: SessionOptions = {}): Promise<{ token: string; session: UserSession }> {
  return insertSession(userId, 'user', SESSION_TTL_MS, opts);
}

/**
 * Server-side session for the break-glass ADMIN_TOKEN login (kind 'admin_token', no user): lets it be
 * listed, revoked and audited like any other. Default lifetime 12 h (ADMIN_SESSION_TTL_MS).
 */
export function createAdminSession(opts: SessionOptions = {}): Promise<{ token: string; session: UserSession }> {
  return insertSession(null, 'admin_token', ADMIN_SESSION_TTL_MS, opts);
}

export type ResolvedSession =
  | { session: UserSession; kind: 'user'; user: User }
  | { session: UserSession; kind: 'admin_token'; user: null };

/**
 * Resolve a raw token to its session for either kind. Null when unknown, expired (an expired row is
 * deleted) or, for a user session, the user is disabled. Refreshes last_used_at at most every 5 minutes.
 */
export async function resolveSessionByToken(token: string | null | undefined, now: Date = new Date()): Promise<ResolvedSession | null> {
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
  if (row.kind === 'user' && (!row.user || row.user.disabledAt)) return null;
  let lastUsedAt = row.lastUsedAt;
  if (now.getTime() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
    await prisma.userSession.updateMany({ where: { id: row.id }, data: { lastUsedAt: now } });
    lastUsedAt = now;
  }
  const session = toSession({ ...row, lastUsedAt });
  return row.kind === 'user' && row.user
    ? { session, kind: 'user', user: toUser(row.user) }
    : { session, kind: 'admin_token', user: null };
}

/**
 * Resolve a raw token to a USER session + user (back-compat shape). Break-glass admin_token sessions
 * return null here: use resolveSessionByToken to see them.
 */
export async function getSessionByToken(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<{ session: UserSession; user: User } | null> {
  const r = await resolveSessionByToken(token, now);
  return r && r.kind === 'user' ? { session: r.session, user: r.user } : null;
}

/** Record that the second factor was satisfied for this session. Returns whether a row changed. */
export async function markSessionMfaVerified(sessionId: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.userSession.updateMany({ where: { id: sessionId }, data: { mfaVerifiedAt: now } });
  return res.count === 1;
}

/** Record a fresh proof of identity (password or second factor re-entered) on this session. Returns whether a row changed. */
export async function markSessionSudo(sessionId: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.userSession.updateMany({ where: { id: sessionId }, data: { sudoAt: now } });
  return res.count === 1;
}

/** A user's live (unexpired) sessions, newest first. Never includes token hashes. */
export async function listUserSessions(userId: string, now: Date = new Date()): Promise<UserSession[]> {
  const rows = await prisma.userSession.findMany({
    where: { userId, expiresAt: { gt: now } },
    orderBy: { lastUsedAt: 'desc' },
  });
  return rows.map(toSession);
}

/** Live break-glass sessions (admin UI). */
export async function listAdminSessions(now: Date = new Date()): Promise<UserSession[]> {
  const rows = await prisma.userSession.findMany({
    where: { kind: 'admin_token', expiresAt: { gt: now } },
    orderBy: { lastUsedAt: 'desc' },
  });
  return rows.map(toSession);
}

/**
 * Revoke one session by id. With `userId` it only matches that user's sessions (self-service
 * "sign out this device" can never touch someone else's). Returns whether a session was removed.
 */
export async function revokeSession(sessionId: string, userId?: string): Promise<boolean> {
  const res = await prisma.userSession.deleteMany({ where: { id: sessionId, ...(userId ? { userId } : {}) } });
  return res.count > 0;
}

/** Revoke every session of a user except `exceptSessionId` ("sign out other devices"). Returns how many. */
export async function revokeOtherSessions(userId: string, exceptSessionId: string): Promise<number> {
  const res = await prisma.userSession.deleteMany({ where: { userId, id: { not: exceptSessionId } } });
  return res.count;
}

/** Revoke all break-glass sessions (e.g. after rotating ADMIN_TOKEN). Returns how many. */
export async function revokeAdminSessions(): Promise<number> {
  const res = await prisma.userSession.deleteMany({ where: { kind: 'admin_token' } });
  return res.count;
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

// ── Two-factor (TOTP) state ─────────────────────────────────────────────────
// Crypto lives in src/lib/totp.ts. This module only stores the encrypted envelope and the replay step.

export interface TotpState {
  secret_enc: string | null;
  enabled_at: string | null;
  last_used_step: number | null;
}

export async function getTotpState(userId: string): Promise<TotpState | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastUsedStep: true },
  });
  return row
    ? { secret_enc: row.totpSecretEnc, enabled_at: row.totpEnabledAt ? row.totpEnabledAt.toISOString() : null, last_used_step: row.totpLastUsedStep }
    : null;
}

/** Start enrolment: store the (already encrypted) secret, inactive until confirmTotpEnrollment. Refused when 2FA is already on. */
export async function beginTotpEnrollment(userId: string, secretEnc: string): Promise<boolean> {
  const res = await prisma.user.updateMany({
    where: { id: userId, totpEnabledAt: null },
    data: { totpSecretEnc: secretEnc, totpLastUsedStep: null },
  });
  return res.count === 1;
}

/**
 * Finish enrolment after the user typed a valid code (`step` = verifyTotp().step): activates 2FA, records the
 * step and replaces ALL recovery codes with `recoveryCodeHashes` (hashRecoveryCode()), atomically.
 * Returns false when there is no pending secret or 2FA is already active.
 */
export async function confirmTotpEnrollment(userId: string, step: number, recoveryCodeHashes: string[]): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.user.updateMany({
      where: { id: userId, totpEnabledAt: null, totpSecretEnc: { not: null } },
      data: { totpEnabledAt: new Date(), totpLastUsedStep: step },
    });
    if (res.count !== 1) return false;
    await tx.recoveryCode.deleteMany({ where: { userId } });
    if (recoveryCodeHashes.length) {
      await tx.recoveryCode.createMany({ data: recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })), skipDuplicates: true });
    }
    return true;
  });
}

/**
 * Turn 2FA off: clears the secret, step and recovery codes AND, in the same transaction, revokes every session of the user
 * except `keepSessionId` (the caller's own, already second-factor-verified). This matters most for MFA-PENDING sessions
 * (password accepted, second factor not yet): they are only "pending" while 2FA is on, so without the revocation they would
 * silently become full sessions the moment 2FA is disabled.
 */
export async function disableTotp(userId: string, opts: { keepSessionId?: string } = {}): Promise<number> {
  const [, , sessions] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.userSession.deleteMany({ where: { userId, ...(opts.keepSessionId ? { id: { not: opts.keepSessionId } } : {}) } }),
  ]);
  return sessions.count;
}

/**
 * Replay protection: atomically record `step` as used. True only when it is strictly newer than the last
 * accepted step, so two concurrent submissions of the same code let exactly one through.
 */
export async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "users" SET "totp_last_used_step" = ${step}
     WHERE "id" = ${userId} AND "totp_enabled_at" IS NOT NULL
       AND ("totp_last_used_step" IS NULL OR "totp_last_used_step" < ${step})
    RETURNING "id"`;
  return rows.length === 1;
}

/** Replace every recovery code (regenerate). Hashes come from hashRecoveryCode(). */
export async function replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userId, codeHash })), skipDuplicates: true }),
  ]);
}

/** Atomically burn a recovery code (pass hashRecoveryCode(input)). True only for the first use of an unused code. */
export async function consumeRecoveryCode(userId: string, codeHash: string, now: Date = new Date()): Promise<boolean> {
  const res = await prisma.recoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: now } });
  return res.count === 1;
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Members of one business (owner/staff), oldest membership first, as `User` objects whose `role` is the role IN THIS business and whose
 * `business_id` is this business (an account of several businesses appears in each). `disabled_at` is the account's, else the membership's.
 * Never includes password hashes. For richer rows use listBusinessMembers.
 */
export async function listBusinessUsers(businessId: string): Promise<User[]> {
  const rows = await prisma.membership.findMany({ where: { businessId }, include: { user: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((m) => ({
    ...toUser(m.user), business_id: businessId, role: m.role as UserRole,
    disabled_at: m.user.disabledAt ? m.user.disabledAt.toISOString() : m.disabledAt ? m.disabledAt.toISOString() : null,
  }));
}
