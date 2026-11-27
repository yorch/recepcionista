/**
 * Route guard of every /api/admin/* handler (replaces the plain "is admin" check). Node runtime only.
 *
 *   const g = await guardAdminRoute(req, { permission: 'settings.write', write: true, rate: { name: 'settings-apply', max: 20 } });
 *   if (!g.ok) return g.response;
 *   const { ctx } = g;            // ctx.actor feeds the store functions; ctx.principal / ctx.role / ctx.grant for the route
 *
 * Order (the first failure answers): authenticate (credential, same-origin CSRF for cookie writes, 2FA enrolment, role admin) -> permission matrix (`can`, including the
 * support write grant) -> rate limit -> step-up (writes, cookie credentials) -> freeze (writes that change console state) -> Bearer notice.
 * Bearer ADMIN_TOKEN: recovery only (permissions.ts); EVERY use is audited (`admin.bearer_use`) and mailed to every admin (at most once a minute per route).
 */
import { NextResponse } from 'next/server';
import { auditIp } from '@/lib/account-flows';
import { recordAudit } from '@/lib/db/audit';
import { authenticate, authErrorResponse, AuthError, requireRecentAuth, type AuthResult, type Principal } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { readJson } from '@/lib/http';
import { notifyAdmins } from './notify';
import { adminRoleOf, can, isBreakGlass, type AdminRole, type Permission } from './permissions';
import { actorFromPrincipal, assertSettingsWritable, SettingsError, type StoreActor } from './settings-store';
import { activeSupportGrant, type SupportGrantView } from './support';
import { SsrfError } from './ssrf';

export interface AdminCtx {
  principal: Extract<Principal, { kind: 'admin' }>;
  role: AdminRole;
  actor: StoreActor;
  ip: string | null;
  sessionId: string | null;
  auth: Extract<AuthResult, { ok: true }>;
  /** The open support write grant that authorised this request (support role only). */
  grant: SupportGrantView | null;
  /** Secret metadata (fingerprint, who, when) is hidden from read_only and support. */
  revealSecretMeta: boolean;
}

export interface GuardOptions {
  /** Any ONE of these permits the request. */
  permission: Permission | Permission[];
  /** A state-changing request: step-up for cookie credentials. */
  write?: boolean;
  rate?: { name: string; max: number; windowMs?: number };
  /** The tenant the request targets (needed for the support write grant). */
  business_id?: string;
  /** 403 settings_frozen while the console is frozen (every write of console state). */
  frozenBlocks?: boolean;
}

const json = (status: number, error: string, code: string, extra: Record<string, unknown> = {}): NextResponse => NextResponse.json({ ok: false as const, error, code, ...extra }, { status });

/** Throttle of the Bearer e-mail: one per route per minute per process (the audit row is written for EVERY use). */
const BEARER_NOTICE_KEY = Symbol.for('rc.admin.bearer-notices');
function bearerNoticeDue(route: string): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const m = (g[BEARER_NOTICE_KEY] ??= new Map());
  const now = Date.now();
  if (now - (m.get(route) ?? 0) < 60_000) return false;
  m.set(route, now);
  return true;
}

export async function guardAdminRoute(req: Request, opts: GuardOptions): Promise<{ ok: true; ctx: AdminCtx } | { ok: false; response: NextResponse }> {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return { ok: false, response: auth.response as NextResponse };
  const principal = auth.principal as Extract<Principal, { kind: 'admin' }>;
  const role = adminRoleOf(principal);
  if (!role) return { ok: false, response: json(403, 'forbidden', 'forbidden') };
  const perms = Array.isArray(opts.permission) ? opts.permission : [opts.permission];
  let grant: SupportGrantView | null = null;
  let allowed = perms.some((p) => can(principal, p));
  if (!allowed && role === 'support' && opts.business_id && principal.user) {
    grant = await activeSupportGrant(principal.user.id, opts.business_id);
    allowed = perms.some((p) => can(principal, p, { grant: grant !== null }));
    if (!allowed) return { ok: false, response: json(403, 'support write mode is required for this action (enter it with a reason first)', 'support_write_required') };
  }
  if (!allowed) {
    const hint = isBreakGlass(principal) ? { hint: 'the break-glass token is recovery only (ADMIN_TOKEN_ALLOW_SETTINGS=true allows settings writes)' } : {};
    return { ok: false, response: json(403, 'forbidden', 'forbidden', hint) };
  }
  if (opts.rate) {
    const limited = await limitRequest(req, `admin/${opts.rate.name}`, opts.rate.max, opts.rate.windowMs);
    if (limited) return { ok: false, response: limited as NextResponse };
  }
  if (opts.write) {
    const stale = requireRecentAuth(auth);
    if (stale) return { ok: false, response: stale };
  }
  if (opts.write && opts.frozenBlocks) {
    try { await assertSettingsWritable(); } catch (err) { if (err instanceof SettingsError) return { ok: false, response: json(err.status, err.message, err.code) }; throw err; }
  }
  const ip = auditIp(req);
  if (isBreakGlass(principal) && principal.via === 'token') {
    const path = new URL(req.url).pathname;
    await recordAudit({ actor_kind: 'admin_token', action: 'admin.bearer_use', target: `${req.method} ${path}`.slice(0, 200), ip, meta: { permission: perms[0], write: Boolean(opts.write) } });
    if (bearerNoticeDue(`${req.method} ${path}`)) {
      void notifyAdmins({ subject: '[Recepcionista] The break-glass ADMIN_TOKEN was used', kind: 'bearer_use', lines: ['The Bearer ADMIN_TOKEN was used.', `request: ${req.method} ${path}`, `permission: ${perms[0]}`, `client: ${ip ?? 'unknown'}`, 'Routine work should use an individual admin account.'] }).catch(() => undefined);
    }
  }
  return { ok: true, ctx: { principal, role, actor: actorFromPrincipal(principal, ip), ip, sessionId: auth.sessionId, auth, grant, revealSecretMeta: role !== 'read_only' && role !== 'support' } };
}

/** JSON body of an object shape, size-capped (1 MB); anything else is a 400. */
export async function readBody(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > maxBytes) throw new SettingsError(400, 'payload_too_large', 'request body too large');
  let raw: unknown;
  try { raw = await readJson<unknown>(req); } catch { throw new SettingsError(400, 'invalid_json', 'invalid JSON body'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError(400, 'invalid_body', 'body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** Error to response for every admin route. A 5xx never echoes internals. */
export function adminFail(err: unknown): NextResponse {
  if (err instanceof SettingsError) return json(err.status, err.message, err.code, err.problems.length ? { problems: err.problems } : {});
  if (err instanceof SsrfError) return json(422, err.message, 'smtp_target_refused');
  const auth = authErrorResponse(err);
  if (auth) return auth;
  if (err instanceof AuthError) return json(err.status, err.message, 'forbidden');
  console.error('[admin] unexpected error', err);
  return json(500, 'internal error', 'internal');
}

export const int = (v: string | null, dflt: number, min: number, max: number): number => {
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
