/**
 * Single-use emailed tokens (email verification, password reset, team invite). Node runtime only.
 * The raw token is returned ONCE by createEmailToken (put it in the emailed link); only its sha256 is
 * stored, so a database leak yields no usable links. Consumption is one atomic UPDATE ... RETURNING:
 * concurrent attempts with the same token let exactly one through.
 */
import crypto from 'node:crypto';
import { prisma, type DbClient } from './client';
import { normalizeEmail } from './users';
import type { EmailToken, EmailTokenPurpose } from '@/lib/types';

export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  invite: 7 * 24 * 60 * 60 * 1000,
};

const PURPOSES: readonly EmailTokenPurpose[] = ['verify', 'reset', 'invite'];

export const hashEmailToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

type Row = {
  id: string; user_id: string | null; email: string; purpose: string; business_id: string | null; role: string | null;
  invited_by: string | null; expires_at: Date; used_at: Date | null; created_at: Date;
};

const toToken = (r: Row): EmailToken => ({
  id: r.id,
  user_id: r.user_id,
  email: r.email,
  purpose: r.purpose as EmailTokenPurpose,
  business_id: r.business_id,
  role: (r.role as EmailToken['role']) ?? null,
  invited_by: r.invited_by,
  expires_at: r.expires_at.toISOString(),
  used_at: r.used_at ? r.used_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
});

export interface CreateEmailTokenInput {
  purpose: EmailTokenPurpose;
  /** Stored lowercased. */
  email: string;
  /** Required for 'verify' and 'reset'. */
  user_id?: string | null;
  /** Required for 'invite' (with role). */
  business_id?: string | null;
  role?: 'owner' | 'staff' | null;
  invited_by?: string | null;
  ttlMs?: number;
  now?: Date;
  /**
   * Invalidate earlier unused tokens of the same purpose for the same user (verify/reset) or the same
   * email + business (invite), so only the newest emailed link works. Default true.
   */
  supersede?: boolean;
}

/** Create a token. Returns the raw token (shown once: email it, never store or log it) and its record. */
export async function createEmailToken(input: CreateEmailTokenInput): Promise<{ token: string; record: EmailToken }> {
  if (!PURPOSES.includes(input.purpose)) throw new Error('createEmailToken: invalid purpose');
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('createEmailToken: invalid email');
  if (input.purpose === 'invite') {
    if (!input.business_id || (input.role !== 'owner' && input.role !== 'staff')) {
      throw new Error('createEmailToken: invites need business_id and role owner|staff');
    }
  } else if (!input.user_id) {
    throw new Error(`createEmailToken: ${input.purpose} tokens need user_id`);
  }
  const now = input.now ?? new Date();
  const token = crypto.randomBytes(32).toString('base64url');
  const supersede = input.supersede ?? true;
  const [, row] = await prisma.$transaction([
    prisma.emailToken.updateMany({
      where: supersede
        ? { purpose: input.purpose, usedAt: null, ...(input.purpose === 'invite' ? { email, businessId: input.business_id } : { userId: input.user_id }) }
        : { id: '__none__' },
      data: { usedAt: now },
    }),
    prisma.emailToken.create({
      data: {
        userId: input.purpose === 'invite' ? null : input.user_id,
        email,
        purpose: input.purpose,
        tokenHash: hashEmailToken(token),
        businessId: input.purpose === 'invite' ? input.business_id : null,
        role: input.purpose === 'invite' ? input.role : null,
        invitedBy: input.invited_by ?? null,
        expiresAt: new Date(now.getTime() + (input.ttlMs ?? EMAIL_TOKEN_TTL_MS[input.purpose])),
        createdAt: now,
      },
    }),
  ]);
  const record: EmailToken = {
    id: row.id, user_id: row.userId, email: row.email, purpose: row.purpose as EmailTokenPurpose, business_id: row.businessId,
    role: (row.role as EmailToken['role']) ?? null, invited_by: row.invitedBy, expires_at: row.expiresAt.toISOString(),
    used_at: null, created_at: row.createdAt.toISOString(),
  };
  return { token, record };
}

const plausible = (t: unknown): t is string => typeof t === 'string' && t.length >= 20 && t.length <= 200;

/**
 * Atomically consume a token: returns its record when it exists, has this purpose, is unused and
 * unexpired (marking it used in the same statement); null otherwise. Two concurrent calls with the
 * same token cannot both succeed. Pass a transaction client as `db` to make the consumption roll back with the caller's
 * other writes (invite acceptance: token + user are one unit).
 */
export async function consumeEmailToken(purpose: EmailTokenPurpose, token: string, now: Date = new Date(), db: DbClient = prisma): Promise<EmailToken | null> {
  if (!plausible(token)) return null;
  const rows = await db.$queryRaw<Row[]>`
    UPDATE "email_tokens" SET "used_at" = ${now}
     WHERE "token_hash" = ${hashEmailToken(token)} AND "purpose" = ${purpose}
       AND "used_at" IS NULL AND "expires_at" > ${now}
    RETURNING "id", "user_id", "email", "purpose", "business_id", "role", "invited_by", "expires_at", "used_at", "created_at"`;
  return rows.length === 1 ? toToken(rows[0]) : null;
}

/** Read-only validity check (e.g. to render an "accept invitation" page). Does not consume. */
export async function peekEmailToken(purpose: EmailTokenPurpose, token: string, now: Date = new Date()): Promise<EmailToken | null> {
  if (!plausible(token)) return null;
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashEmailToken(token) } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return toToken({
    id: row.id, user_id: row.userId, email: row.email, purpose: row.purpose, business_id: row.businessId, role: row.role,
    invited_by: row.invitedBy, expires_at: row.expiresAt, used_at: row.usedAt, created_at: row.createdAt,
  });
}

/** How many tokens of this purpose were issued to this address since `since` (throttle "resend" requests). */
export async function countRecentEmailTokens(purpose: EmailTokenPurpose, email: string, since: Date): Promise<number> {
  return prisma.emailToken.count({ where: { purpose, email: normalizeEmail(email), createdAt: { gte: since } } });
}

/** Invalidate every unused token of a purpose for a user (e.g. after a successful password reset). */
export async function invalidateUserEmailTokens(userId: string, purpose: EmailTokenPurpose, now: Date = new Date()): Promise<number> {
  const res = await prisma.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } });
  return res.count;
}

/** Delete tokens that expired more than a day ago. Never throws; returns the count. */
export async function deleteExpiredEmailTokens(now: Date = new Date()): Promise<number> {
  try {
    const res = await prisma.emailToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
    return res.count;
  } catch {
    return 0;
  }
}
