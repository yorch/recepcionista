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
import { planAllowsLocation } from '@/lib/admin/plan-catalog';
import { settingDef } from '@/lib/config/registry';
import { effectiveFor } from '@/lib/admin/tenant-effective';

export const DEFAULT_MAX_BUSINESSES_PER_USER = 10;

/** MAX_BUSINESSES_PER_USER (1..100, default 10). */
export function maxBusinessesPerUser(): number {
  const n = Number.parseInt(configEnv().MAX_BUSINESSES_PER_USER ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : DEFAULT_MAX_BUSINESSES_PER_USER;
}

const MAX_KEY = 'limits.max_businesses_per_user';

/**
 * The account's limit: the platform value (MAX_BUSINESSES_PER_USER) unless a TENANT override of `limits.max_businesses_per_user` applies to a business the account OWNS. The limit is
 * per account while the override is per business, so the STRICTEST effective value among the owned businesses wins (an owner cannot dodge a lowered limit by acting from another
 * of their businesses; to raise the limit set the override on each owned business).
 */
export async function maxBusinessesFor(userId: string, db: Pick<typeof prisma, 'membership' | 'tenantSettingOverride'> = prisma): Promise<number> {
  const platform = maxBusinessesPerUser();
  const def = settingDef(MAX_KEY);
  if (!def) return platform;
  const owned = await db.membership.findMany({ where: { userId, role: 'owner' }, select: { businessId: true } });
  if (owned.length === 0) return platform;
  const rows = await db.tenantSettingOverride.findMany({ where: { key: MAX_KEY, businessId: { in: owned.map((m) => m.businessId) } } });
  const values = rows.map((r) => effectiveFor(def, { [MAX_KEY]: r.value }))
    .filter((e) => e.source === 'tenant' && typeof e.value === 'number').map((e) => e.value as number);
  return values.length ? Math.min(...values) : platform;
}

export type AddLocationResult =
  | { ok: true; business: Business }
  | { ok: false; reason: 'limit_reached' | 'not_owner' | 'user_disabled' };

/**
 * Requires that `userId` is an enabled OWNER of at least one business. The cap counts every owner membership of the account
 * (disabled ones included, so disabling cannot be used to dodge it).
 */
export async function createBusinessForOwner(userId: string, input: { name: string }, maxOverride?: number): Promise<AddLocationResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ disabled_at: Date | null }[]>`SELECT "disabled_at" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    if (locked.length !== 1 || locked[0].disabled_at) return { ok: false as const, reason: 'user_disabled' as const };
    const owned = await tx.membership.findMany({ where: { userId, role: 'owner' }, select: { disabledAt: true } });
    if (!owned.some((m) => m.disabledAt === null)) return { ok: false as const, reason: 'not_owner' as const };
    const max = maxOverride ?? await maxBusinessesFor(userId, tx);
    if (owned.length >= max) return { ok: false as const, reason: 'limit_reached' as const };
    // Plan entitlement: the plans of the businesses this account owns decide whether another location is allowed (the roomiest plan wins; no limit when unknown).
    const plans = await tx.business.findMany({ where: { memberships: { some: { userId, role: 'owner' } } }, select: { plan: true } });
    if (plans.length && !plans.some((b) => planAllowsLocation(b.plan, owned.length))) return { ok: false as const, reason: 'limit_reached' as const };
    const business = await createBusiness({ name: input.name }, tx);
    await addMembership({ user_id: userId, business_id: business.id, role: 'owner' }, tx);
    return { ok: true as const, business };
  });
}
