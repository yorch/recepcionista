/**
 * Support mode (T8). The read-only support view of a tenant needs no grant (permission tenants.read). WRITE mode is a SupportGrant: 30 minutes, with a written reason,
 * for one tenant, ended early on request, audited on enter / exit and on every write (the write routes add `support_grant_id` + the business id to their audit rows).
 * What a grant authorises is `SUPPORT_WRITE_SCOPE` in permissions.ts. Node runtime only.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { SUPPORT_WRITE_MS } from './permissions';
import { MAX_REASON, MIN_REASON, SettingsError } from './settings-store';

export interface SupportGrantView { id: string; user_id: string; business_id: string; reason: string; started_at: string; expires_at: string; ended_at: string | null; active: boolean }

const view = (g: { id: string; userId: string; businessId: string; reason: string; startedAt: Date; expiresAt: Date; endedAt: Date | null }, now: Date): SupportGrantView => ({
  id: g.id, user_id: g.userId, business_id: g.businessId, reason: g.reason, started_at: g.startedAt.toISOString(), expires_at: g.expiresAt.toISOString(), ended_at: g.endedAt?.toISOString() ?? null,
  active: g.endedAt === null && g.expiresAt.getTime() > now.getTime(),
});

/** The open grant of this admin for this tenant, or null (expired and ended grants never count). */
export async function activeSupportGrant(userId: string | null | undefined, businessId: string | null | undefined, now: Date = new Date()): Promise<SupportGrantView | null> {
  if (!userId || !businessId) return null;
  const g = await prisma.supportGrant.findFirst({ where: { userId, businessId, endedAt: null, expiresAt: { gt: now } }, orderBy: { startedAt: 'desc' } });
  return g ? view(g, now) : null;
}

export async function enterSupportWrite(opts: { user_id: string; business_id: string; reason: unknown; ip?: string | null; role: string; now?: Date }): Promise<SupportGrantView> {
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required`);
  const now = opts.now ?? new Date();
  const biz = await prisma.business.findUnique({ where: { id: opts.business_id }, select: { id: true } });
  if (!biz) throw new SettingsError(404, 'not_found', 'business not found');
  const row = await prisma.$transaction(async (tx) => {
    await tx.supportGrant.updateMany({ where: { userId: opts.user_id, businessId: opts.business_id, endedAt: null }, data: { endedAt: now } }); // one open grant per admin and tenant
    const g = await tx.supportGrant.create({ data: { id: crypto.randomUUID(), userId: opts.user_id, businessId: opts.business_id, reason, startedAt: now, expiresAt: new Date(now.getTime() + SUPPORT_WRITE_MS), ip: opts.ip ?? null } });
    await tx.auditEvent.create({ data: auditRowData({ actor_kind: 'user', actor_user_id: opts.user_id, business_id: opts.business_id, action: 'support.write_mode_entered', target: `business:${opts.business_id}`, ip: opts.ip, at: now, meta: { grant_id: g.id, reason, expires_at: g.expiresAt.toISOString(), role: opts.role }, meta_trusted: true }) });
    return g;
  });
  return view(row, now);
}

export async function exitSupportWrite(opts: { user_id: string; business_id: string; ip?: string | null; now?: Date }): Promise<{ ended: number }> {
  const now = opts.now ?? new Date();
  const res = await prisma.supportGrant.updateMany({ where: { userId: opts.user_id, businessId: opts.business_id, endedAt: null }, data: { endedAt: now } });
  if (res.count > 0) await prisma.auditEvent.create({ data: auditRowData({ actor_kind: 'user', actor_user_id: opts.user_id, business_id: opts.business_id, action: 'support.write_mode_exited', target: `business:${opts.business_id}`, ip: opts.ip, at: now, meta: { ended: res.count }, meta_trusted: true }) });
  return { ended: res.count };
}
