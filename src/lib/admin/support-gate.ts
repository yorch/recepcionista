/**
 * The write gate of the tenant side (owner decision: no silent full-write impersonation). An ADMIN USER (a personal account with a platform role) that sends a state-changing request
 * to a tenant route (anything outside /api/admin, /api/auth, /api/health and /api/me/locale) must hold an OPEN support write grant (src/lib/admin/support.ts: 30 minutes, reason,
 * step-up, audited) for the tenant it touches. Without one the request is refused 403 `support_write_required`; a `read_only` admin may not write at all (403 `forbidden`). Reads are not
 * gated here (the dashboard logs them: `logSupportView`).
 *
 * WHICH tenant: the gate only knows the URL (`/api/businesses/<id>/...`, `?business_id=`). Routes also take the business from the JSON body or from the resource they load (a booking), so the
 * gate hands the admin's open grants to the principal (`writeGrants`) and `requireBusinessAccess` / `scopeBusinessId` / `authenticateTeam` (src/lib/session.ts, src/lib/team.ts) require a grant for
 * EXACTLY the business they resolve: a grant for tenant A never authorises tenant B. With no tenant in the URL at least one open grant is needed here and the exact check follows.
 *
 * The support ROLE is not owner write: in write mode it may write only SUPPORT_WRITE_SCOPE (permissions.ts), so no tenant route is open to it (403 `support_scope`).
 * Creating a tenant and provisioning one are operator actions on the providers: PLATFORM_WRITE_ROUTES (a platform permission instead of a tenant grant).
 * The Bearer ADMIN_TOKEN and its cookie session (break-glass: audited as `admin.bearer_use` and mailed) and the dev open mode are not personal accounts and pass.
 * Node runtime only; imported lazily by session.authenticate (it needs the database).
 */
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { adminRoleOf, roleCan, supportMayWriteRoute, type Permission } from './permissions';
import type { Principal } from '@/lib/session';

/** Routes an admin user may write without a tenant grant: the console itself (own permission matrix), sign-in / account flows and health. Matched on path-segment boundaries. */
const OPEN_PREFIXES = ['/api/admin', '/api/auth', '/api/health'];
/** Exact open paths (never a prefix: `/api/me` must not open `/api/media`, `/api/me/anything-new`). */
const OPEN_EXACT = ['/api/me/locale'];
const UUID = /^[0-9a-f-]{8,64}$/i;

export const isOpenPath = (path: string): boolean => OPEN_EXACT.includes(path) || OPEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Operator actions on the PROVIDERS that have no tenant grant of their own: creating a tenant and provisioning one (buys a Twilio number, creates an ElevenLabs agent). They need a
 * PLATFORM permission instead (a `read_only` or `support` admin has neither), and the provision route adds a step-up.
 */
export const PLATFORM_WRITE_ROUTES: ReadonlyArray<{ method: string; re: RegExp; permission: Permission }> = [
  { method: 'POST', re: /^\/api\/businesses$/, permission: 'tenants.users.create' },
  { method: 'POST', re: /^\/api\/businesses\/[^/]+\/provision$/, permission: 'providers.repair' },
  // the demo routes (DEMO_MODE only) wipe or simulate across every tenant: they name no business, so no tenant grant can authorise them; the owner role only
  { method: 'POST', re: /^\/api\/demo\//, permission: 'settings.write.critical' },
];

/**
 * The tenant a request EXPLICITLY names in its URL: `/api/businesses/<id>/...` or `?business_id=`. (The `rc_business` cookie is only the dashboard's selection hint and says nothing about
 * what a write touches, so it is no longer consulted. Body-supplied and resource-derived business ids are enforced where they are resolved: requireBusinessAccess / scopeBusinessId.)
 */
export function targetBusinessOf(req: Request): string | null {
  const url = new URL(req.url);
  const m = /^\/api\/businesses\/([^/]+)/.exec(url.pathname);
  if (m && m[1] !== 'mine' && UUID.test(m[1])) return m[1];
  return url.searchParams.get('business_id') || null;
}

export type GateResult =
  | { ok: false; status: 403; error: string; code: 'support_write_required' | 'forbidden' | 'support_scope' }
  | { ok: true; grants?: ReadonlySet<string> }
  | null;

const refuse = (error: string, code: 'support_write_required' | 'forbidden' | 'support_scope'): GateResult => ({ ok: false, status: 403, error, code });

/**
 * null: not gated. `{ ok: true, grants }`: the admin's open grants, which authenticate puts on the principal (`writeGrants`) so that the business the route RESOLVES (from the URL, the
 * body or the resource) must be one of them. When the URL names a tenant the grant for exactly that tenant is required here already. When it does not, at least one open grant is
 * required and the exact check happens at resolution; a grant for tenant A never authorises tenant B.
 */
export async function supportWriteGate(req: Request, principal: Principal, now: Date = new Date()): Promise<GateResult> {
  if (principal.kind !== 'admin' || principal.via !== 'user' || !principal.user) return null;
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/') || isOpenPath(path)) return null;
  const role = adminRoleOf(principal);
  const platform = PLATFORM_WRITE_ROUTES.find((r) => r.method === req.method && r.re.test(path));
  if (platform) return role && roleCan(role, platform.permission) ? { ok: true } : refuse('this admin role cannot do that', 'forbidden');
  if (!role || !roleCan(role, 'tenants.support_enter')) return refuse('this admin role cannot change a tenant', 'forbidden');
  const open = await prisma.supportGrant.findMany({ where: { userId: principal.user.id, endedAt: null, expiresAt: { gt: now } }, select: { businessId: true } });
  const grants = new Set(open.map((g) => g.businessId));
  const target = targetBusinessOf(req);
  if (target ? !grants.has(target) : grants.size === 0) {
    return refuse('enter support write mode for this business first (console: Tenants > Support, with a reason)', 'support_write_required');
  }
  // A support grant is NOT owner write: the role's write scope (SUPPORT_WRITE_SCOPE: the tenant knobs, through the console) is all it authorises, so no tenant route is open to it.
  if (role === 'support' && !supportMayWriteRoute(req.method, path)) return refuse('support write mode only covers the tenant settings overrides (console), not this action', 'support_scope');
  return { ok: true, grants };
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
