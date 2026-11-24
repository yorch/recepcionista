/**
 * Selection logic of scripts/grandfather-existing.ts (comping EXISTING tenants when plans are enforced).
 *
 * Comping is a gift of free paid service, so it must never reach someone who signed up recently or anonymously:
 *  - only businesses created BEFORE `cutoff` (the rollout time) are considered;
 *  - the business must have at least one owner whose email is verified, and must not have been self-signed-up
 *    (an `auth.signup` audit row) unless `includeSelfSignup` is passed;
 *  - a business whose owner phone is set but not verified is skipped unless `includeUnverifiedPhone` is passed;
 *  - an owner phone is NEVER marked verified here (that proof belongs to the owner: Settings > alert phone, or an
 *    explicit per-business admin action).
 * Node runtime only.
 */
import { prisma } from '@/lib/db/client';

export interface GrandfatherOptions {
  cutoff: Date;
  includeUnverifiedPhone?: boolean;
  includeSelfSignup?: boolean;
}

export interface GrandfatherCandidate {
  id: string;
  name: string;
  createdAt: Date;
  ownerPhone: string | null;
  ownerPhoneVerified: boolean;
  ownerEmails: string[];
}

export interface GrandfatherSkip { id: string; name: string; reason: string }

export interface GrandfatherPlan {
  eligible: GrandfatherCandidate[];
  skipped: GrandfatherSkip[];
}

export async function planGrandfather(opts: GrandfatherOptions): Promise<GrandfatherPlan> {
  const rows = await prisma.business.findMany({
    select: {
      id: true, name: true, createdAt: true, billingStatus: true, stripeSubscriptionId: true, ownerPhone: true, ownerPhoneVerifiedAt: true,
      users: { where: { role: 'owner', disabledAt: null }, select: { email: true, emailVerifiedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const signedUp = new Set(
    (await prisma.auditEvent.findMany({ where: { action: 'auth.signup', businessId: { not: null } }, select: { businessId: true } }))
      .map((r) => r.businessId as string),
  );
  const plan: GrandfatherPlan = { eligible: [], skipped: [] };
  for (const b of rows) {
    const skip = (reason: string) => plan.skipped.push({ id: b.id, name: b.name, reason });
    if (b.billingStatus !== 'none' || b.stripeSubscriptionId) { skip('already has billing state'); continue; }
    if (b.createdAt >= opts.cutoff) { skip('created at/after the cutoff'); continue; }
    if (!b.users.some((u) => u.emailVerifiedAt)) { skip('no owner with a verified email'); continue; }
    if (!opts.includeSelfSignup && signedUp.has(b.id)) { skip('self-signup business (auth.signup audit row)'); continue; }
    const phoneVerified = Boolean(b.ownerPhoneVerifiedAt);
    if (b.ownerPhone && !phoneVerified && !opts.includeUnverifiedPhone) { skip('owner phone is not verified'); continue; }
    plan.eligible.push({
      id: b.id, name: b.name, createdAt: b.createdAt, ownerPhone: b.ownerPhone, ownerPhoneVerified: phoneVerified,
      ownerEmails: b.users.filter((u) => u.emailVerifiedAt).map((u) => u.email),
    });
  }
  return plan;
}

/** Comp one business (idempotent: only while it still has no billing state). True when it changed. */
export async function compBusiness(id: string): Promise<boolean> {
  const r = await prisma.business.updateMany({
    where: { id, billingStatus: 'none', stripeSubscriptionId: null },
    data: { billingStatus: 'active', plan: 'legacy' },
  });
  return r.count === 1;
}
