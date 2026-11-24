/**
 * Passkeys (WebAuthn): credentials and single-use challenges. Node runtime only.
 * The ceremony itself (options, verification) belongs to @simplewebauthn/server in the route layer; this module only stores state.
 * Challenges are stored as their sha256 and consumed with one atomic UPDATE, so a challenge can be used exactly once.
 */
import crypto from 'node:crypto';
import { prisma } from './client';
import type { PasskeyForVerification, PasskeySummary, WebauthnPurpose } from '@/lib/types';
import type { PasskeyCredential as Row } from '@prisma/client';

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_PASSKEYS_PER_USER = 20;
const PURPOSES: readonly WebauthnPurpose[] = ['register', 'login', 'reauth'];

export const hashChallenge = (challenge: string): string => crypto.createHash('sha256').update(challenge).digest('hex');

const toSummary = (r: Row): PasskeySummary => ({
  id: r.id, user_id: r.userId, credential_id: r.credentialId, transports: r.transports, device_type: r.deviceType as PasskeySummary['device_type'],
  backed_up: r.backedUp, name: r.name, created_at: r.createdAt.toISOString(), last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

export class PasskeyLimitError extends Error {
  constructor() { super('too many passkeys'); this.name = 'PasskeyLimitError'; }
}
export class PasskeyExistsError extends Error {
  constructor() { super('passkey already registered'); this.name = 'PasskeyExistsError'; }
}

export interface AddPasskeyInput {
  user_id: string;
  /** base64url credential id. */
  credential_id: string;
  public_key: Uint8Array;
  counter?: number;
  transports?: string[];
  device_type?: 'singleDevice' | 'multiDevice';
  backed_up?: boolean;
  name?: string;
}

/** Store a verified credential. Throws PasskeyExistsError for a duplicate credential id and PasskeyLimitError beyond 20 per user. */
export async function addPasskey(input: AddPasskeyInput): Promise<PasskeySummary> {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(input.credential_id)) throw new Error('addPasskey: credential_id must be base64url');
  if (!input.public_key || input.public_key.length === 0 || input.public_key.length > 4096) throw new Error('addPasskey: invalid public key');
  const counter = input.counter ?? 0;
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('addPasskey: invalid counter');
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.user_id} FOR UPDATE`; // serialise concurrent registrations of one user
      if ((await tx.passkeyCredential.count({ where: { userId: input.user_id } })) >= MAX_PASSKEYS_PER_USER) throw new PasskeyLimitError();
      const row = await tx.passkeyCredential.create({
        data: {
          userId: input.user_id, credentialId: input.credential_id, publicKey: Buffer.from(input.public_key), counter: BigInt(counter),
          transports: (input.transports ?? []).slice(0, 8).map((t) => t.slice(0, 32)),
          deviceType: input.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice', backedUp: input.backed_up === true,
          name: (input.name ?? 'Passkey').trim().slice(0, 80) || 'Passkey',
        },
      });
      return toSummary(row);
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') throw new PasskeyExistsError();
    throw err;
  }
}

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const rows = await prisma.passkeyCredential.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  return rows.map(toSummary);
}

export const countPasskeys = (userId: string): Promise<number> => prisma.passkeyCredential.count({ where: { userId } });

/** What verification needs (public key and counter). Only the login/reauth routes should call this. */
export async function getPasskeyByCredentialId(credentialId: string): Promise<PasskeyForVerification | null> {
  if (!credentialId || credentialId.length > 1024) return null;
  const r = await prisma.passkeyCredential.findUnique({ where: { credentialId } });
  return r ? { ...toSummary(r), public_key: new Uint8Array(r.publicKey), counter: Number(r.counter) } : null;
}

/**
 * Record a successful assertion: sets the new signature counter and last-used time in one statement. Counter rule (WebAuthn): it must
 * increase, except authenticators that always report 0 (both stored and new are 0). False means a cloned authenticator is suspected
 * (new counter not greater than the stored one): the caller must reject the login.
 */
export async function recordPasskeyUse(credentialId: string, newCounter: number, now: Date = new Date()): Promise<boolean> {
  if (!Number.isSafeInteger(newCounter) || newCounter < 0) return false;
  const n = BigInt(newCounter);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "passkey_credentials" SET "counter" = ${n}, "last_used_at" = ${now}
     WHERE "credential_id" = ${credentialId} AND ("counter" < ${n} OR ("counter" = 0 AND ${n} = 0))
    RETURNING "id"`;
  return rows.length === 1;
}

export async function renamePasskey(userId: string, id: string, name: string): Promise<boolean> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return false;
  const res = await prisma.passkeyCredential.updateMany({ where: { id, userId }, data: { name: clean } });
  return res.count === 1;
}

/** Remove one of the user's own passkeys. */
export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const res = await prisma.passkeyCredential.deleteMany({ where: { id, userId } });
  return res.count === 1;
}

// ── challenges ───────────────────────────────────────────────────────────────

/**
 * Remember a challenge you are about to hand to the browser. 'register' and 'reauth' need `user_id`; a discoverable-credential 'login'
 * has none. Returns the row id. Expires after 5 minutes by default.
 */
export async function createWebauthnChallenge(input: {
  purpose: WebauthnPurpose; challenge: string; user_id?: string | null; ttlMs?: number; now?: Date;
}): Promise<{ id: string; expires_at: string }> {
  if (!PURPOSES.includes(input.purpose)) throw new Error('createWebauthnChallenge: invalid purpose');
  if (!input.challenge || input.challenge.length < 16 || input.challenge.length > 2048) throw new Error('createWebauthnChallenge: invalid challenge');
  if (input.purpose !== 'login' && !input.user_id) throw new Error(`createWebauthnChallenge: ${input.purpose} challenges need user_id`);
  const now = input.now ?? new Date();
  const row = await prisma.webauthnChallenge.create({
    data: {
      userId: input.user_id ?? null, purpose: input.purpose, challengeHash: hashChallenge(input.challenge),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? WEBAUTHN_CHALLENGE_TTL_MS)), createdAt: now,
    },
  });
  return { id: row.id, expires_at: row.expiresAt.toISOString() };
}

/**
 * Atomically consume a challenge: true only when it exists for this purpose, is unused and unexpired, and (when it was issued for a
 * user) belongs to `userId`. Two concurrent attempts with the same challenge cannot both succeed. The challenge is burned even if the
 * signature check that follows fails: the browser must start over.
 */
export async function consumeWebauthnChallenge(
  purpose: WebauthnPurpose, challenge: string, opts: { userId?: string | null; now?: Date } = {},
): Promise<boolean> {
  if (!PURPOSES.includes(purpose) || !challenge || challenge.length > 2048) return false;
  const now = opts.now ?? new Date();
  const userId = opts.userId ?? null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "webauthn_challenges" SET "used_at" = ${now}
     WHERE "challenge_hash" = ${hashChallenge(challenge)} AND "purpose" = ${purpose}
       AND "used_at" IS NULL AND "expires_at" > ${now}
       AND ("user_id" IS NULL OR "user_id" = ${userId})
    RETURNING "id"`;
  return rows.length === 1;
}

/** Expired challenges are kept this long (forensics) before the hourly cleanup job deletes them. */
export const WEBAUTHN_CHALLENGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Delete challenges that expired more than a day ago (called by the hourly cleanup job, src/lib/jobs). Never throws; returns the count. */
export async function deleteExpiredWebauthnChallenges(now: Date = new Date()): Promise<number> {
  try {
    const res = await prisma.webauthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - WEBAUTHN_CHALLENGE_GRACE_MS) } } });
    return res.count;
  } catch {
    return 0;
  }
}
