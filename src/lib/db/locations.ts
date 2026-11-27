/**
 * "Add another location": an owner creates an additional business under their existing account. Node runtime only.
 * Business + owner membership are ONE transaction; the per-account cap is checked under a row lock on the user, so concurrent requests
 * cannot overshoot it. The new business starts like a signup's: billing 'none', nothing provisioned (every business pays and provisions on its own).
 */
import { configEnv } from '@/lib/config';
import { createBusiness } from './index';
import { prisma } from './client';
import { addMembership } from './memberships';
import type { Business } from '@/lib/types';

export const DEFAULT_MAX_BUSINESSES_PER_USER = 10;

/** MAX_BUSINESSES_PER_USER (1..100, default 10). */
export function maxBusinessesPerUser(): number {
  const n = Number.parseInt(configEnv().MAX_BUSINESSES_PER_USER ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : DEFAULT_MAX_BUSINESSES_PER_USER;
}

export type AddLocationResult =
  | { ok: true; business: Business }
  | { ok: false; reason: 'limit_reached' | 'not_owner' | 'user_disabled' };

/**
 * Requires that `userId` is an enabled OWNER of at least one business. The cap counts every owner membership of the account
 * (disabled ones included, so disabling cannot be used to dodge it).
 */
export async function createBusinessForOwner(userId: string, input: { name: string }, max: number = maxBusinessesPerUser()): Promise<AddLocationResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ disabled_at: Date | null }[]>`SELECT "disabled_at" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    if (locked.length !== 1 || locked[0].disabled_at) return { ok: false as const, reason: 'user_disabled' as const };
    const owned = await tx.membership.findMany({ where: { userId, role: 'owner' }, select: { disabledAt: true } });
    if (!owned.some((m) => m.disabledAt === null)) return { ok: false as const, reason: 'not_owner' as const };
    if (owned.length >= max) return { ok: false as const, reason: 'limit_reached' as const };
    const business = await createBusiness({ name: input.name }, tx);
    await addMembership({ user_id: userId, business_id: business.id, role: 'owner' }, tx);
    return { ok: true as const, business };
  });
}
