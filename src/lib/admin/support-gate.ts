/**
 * The write gate of the tenant side (owner decision: no silent full-write impersonation). An ADMIN USER (a personal account with a platform role) that sends a
 * state-changing request to a tenant route (anything outside /api/admin, /api/auth and the few business-less routes) must hold an OPEN support write grant
 * (src/lib/admin/support.ts: 30 minutes, reason, step-up, audited) for the tenant it touches. Without one the request is refused 403 `support_write_required`;
 * a `read_only` admin may not write at all (403 `forbidden`). Reads are not gated here (the dashboard logs them: `logSupportView`).
 * The Bearer ADMIN_TOKEN and its cookie session (break-glass: audited as `admin.bearer_use` and mailed) and the dev open mode are not personal accounts and pass.
 * Node runtime only; imported lazily by session.authenticate (it needs the database).
 */
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { adminRoleOf, roleCan } from './permissions';
import type { Principal } from '@/lib/session';

/** Routes an admin user may write to without a tenant grant: the console itself, sign-in / account flows, health, tenant creation and provisioning. */
const OPEN_PREFIXES = ['/api/admin/', '/api/auth/', '/api/health', '/api/me'];
const UUID = /^[0-9a-f-]{8,64}$/i;

/** The tenant a request touches: `/api/businesses/<id>/...`, `?business_id=`, or the console's selected business cookie. */
export function targetBusinessOf(req: Request): string | null {
  const url = new URL(req.url);
  const m = /^\/api\/businesses\/([^/]+)/.exec(url.pathname);
  if (m && m[1] !== 'mine' && UUID.test(m[1])) return m[1];
  const q = url.searchParams.get('business_id');
  if (q) return q;
  const cookie = /(?:^|;\s*)rc_business=([^;]+)/.exec(req.headers.get('cookie') ?? '');
  if (cookie) { try { return decodeURIComponent(cookie[1]); } catch { return null; } }
  return null;
}

export type GateResult = { status: 403; error: string; code: 'support_write_required' | 'forbidden' } | null;

export async function supportWriteGate(req: Request, principal: Principal, now: Date = new Date()): Promise<GateResult> {
  if (principal.kind !== 'admin' || principal.via !== 'user' || !principal.user) return null;
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/') || OPEN_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return null;
  if (req.method === 'POST' && path === '/api/businesses') return null; // creating a tenant has no tenant yet
  if (/^\/api\/businesses\/[^/]+\/provision$/.test(path)) return null; // provisioning is an operator action on the PROVIDERS (own admin-only checks, audited), not a change of tenant data
  const role = adminRoleOf(principal);
  if (!role || !roleCan(role, 'tenants.support_enter')) return { status: 403, error: 'this admin role cannot change a tenant', code: 'forbidden' };
  const target = targetBusinessOf(req);
  const grant = await prisma.supportGrant.findFirst({
    where: { userId: principal.user.id, endedAt: null, expiresAt: { gt: now }, ...(target ? { businessId: target } : {}) }, select: { id: true },
  });
  return grant ? null : { status: 403, error: 'enter support write mode for this business first (console: Tenants > Support, with a reason)', code: 'support_write_required' };
}

/** A read of a tenant's dashboard by an admin: one audit row per admin and tenant per 15 minutes (in memory per process; the audit trail is the record). */
const seen = new Map<string, number>();
export async function logSupportView(userId: string, businessId: string, role: string, now: Date = new Date()): Promise<void> {
  const key = `${userId}:${businessId}`;
  const last = seen.get(key);
  if (last !== undefined && now.getTime() - last < 15 * 60_000) return;
  seen.set(key, now.getTime());
  if (seen.size > 2000) seen.clear();
  await prisma.auditEvent.create({
    data: auditRowData({ actor_kind: 'user', actor_user_id: userId, business_id: businessId, action: 'support.view', target: `business:${businessId}`, at: now, meta: { role, surface: 'dashboard' }, meta_trusted: true }),
  }).catch(() => undefined);
}
