/**
 * Node-side authentication and authorization. THE place where credentials are really validated;
 * src/proxy.ts only does a cheap presence/shape gate (it cannot reach the database).
 *
 * Credentials, in order of precedence:
 *   1. `Authorization: Bearer <ADMIN_TOKEN>`     -> admin (break-glass superadmin, CSRF-exempt)
 *      An invalid Bearer never falls back to cookies.
 *   2. `rc_session` cookie (random opaque token)  -> a server-side `admin_token` session (12 h, revocable)
 *   3. `rc_user_session` cookie (opaque token)    -> looked up in Postgres: owner/staff work in ONE business at a
 *      time (the session's active business, validated against the account's enabled MEMBERSHIPS on every request; the
 *      role is the membership's role); a user with role 'admin' is a global admin.
 *      A user with 2FA whose session has not passed the second factor (mfa_verified_at NULL) is
 *      "MFA pending": it resolves to NOTHING here (401 `mfa_required`); only /api/auth/mfa and logout see it.
 *   4. ALLOW_INSECURE_DEV=true without ADMIN_TOKEN -> admin (never in production)
 *
 * Fail closed: ADMIN_TOKEN unset without the dev opt-in -> 503 for everything (users included).
 */
import { cache } from 'react';
import { headers as nextHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import {
  adminSessionTokenFrom, authConfig, checkSameOrigin, hasBearer, SAFE_METHODS, tokensMatch, userSessionTokenFrom,
} from '@/lib/auth';
import { require2faForAdmins } from '@/lib/admin-2fa';
import { listMembershipsForUser } from '@/lib/db/memberships';
import { resolveSessionByToken } from '@/lib/db/users';
import type { MembershipWithBusiness, User, UserSession } from '@/lib/types';

export type Role = 'staff' | 'owner' | 'admin';

const SUPPORT_WRITE_MESSAGE = 'enter support write mode for this business first (console: Tenants > Support, with a reason)';

export type Principal =
  /**
   * `via`: token = Bearer ADMIN_TOKEN, cookie = break-glass admin session cookie (DB `admin_token` session),
   * user = a DB user with role admin, dev = ALLOW_INSECURE_DEV. `email_verified` is always true for the
   * break-glass paths (they are not tied to a mailbox).
   */
  | {
    kind: 'admin'; via: 'token' | 'cookie' | 'user' | 'dev'; user?: User; email_verified: boolean; needs_2fa_enrollment?: boolean;
    /**
     * Set by `authenticate` for an admin USER on a state-changing request to a tenant route: the business ids the admin holds an OPEN support write grant for.
     * requireBusinessAccess / scopeBusinessId then refuse (403 `support_write_required`) any business that is not in it, wherever the business id came from
     * (path, query, body or the resource itself). Absent on reads, on the Bearer / cookie / dev credentials and on console (/api/admin) routes.
     */
    writeGrants?: ReadonlySet<string>;
  }
  /**
   * `business_id` / `role`: the ACTIVE business of this session and the account's role IN THAT business (from its membership; the
   * legacy `user.role` is only the role in the primary business and must not be used for authorization). `memberships` are all the
   * account's ENABLED memberships. `email_verified`: the user proved their address. Provisioning/billing routes must require it.
   */
  | { kind: 'user'; user: User; business_id: string; role: 'owner' | 'staff'; email_verified: boolean; memberships: MembershipWithBusiness[] };

const RANK: Record<Role, number> = { staff: 1, owner: 2, admin: 3 };

export function principalRole(p: Principal): Role {
  return p.kind === 'admin' ? 'admin' : p.role;
}

/**
 * Who to write in the audit trail for this principal. A DB user, admin role included, is ALWAYS `user` (with its id; the role and how it
 * authenticated go in meta); only the Bearer / break-glass cookie / dev credentials, which are not a person's account, are `admin_token`.
 */
export function auditActorOf(p: Principal): { actor_kind: 'user' | 'admin_token'; actor_user_id: string | null; meta: { actor_role: Role; actor_via?: string } } {
  const user = p.kind === 'user' ? p.user : p.user ?? null;
  return {
    actor_kind: user ? 'user' : 'admin_token',
    actor_user_id: user?.id ?? null,
    meta: { actor_role: principalRole(p), ...(p.kind === 'admin' ? { actor_via: p.via } : {}) },
  };
}

/** Is this principal at least `min`? (admin > owner > staff) */
export function hasRole(p: Principal, min: Role): boolean {
  return RANK[principalRole(p)] >= RANK[min];
}

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 404 | 503, message: string, public code?: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Response for an AuthError (or null for any other error, so callers can fall through to their own handling). */
export function authErrorResponse(err: unknown): NextResponse<{ ok: false; error: string; code?: string }> | null {
  if (!(err instanceof AuthError)) return null;
  return NextResponse.json({ ok: false as const, error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
}

/**
 * Throws 403 `email_not_verified` for a tenant user whose email address is not verified yet. Call it first in every
 * route that provisions paid resources or touches billing (the billing agent's routes). Admins always pass.
 */
export function requireVerifiedEmail(principal: Principal): void {
  if (!principal.email_verified) throw new AuthError(403, 'email_not_verified');
}

/** Throws 403 unless the principal has at least `min` role. */
export function requireRole(principal: Principal, min: Role): void {
  if (!hasRole(principal, min)) throw new AuthError(403, 'forbidden');
}

/**
 * Throws 404 (not 403: never confirm that another tenant's business exists) unless the principal may
 * access `businessId`. Admins may access every business. A user may access only the business their session is ACTIVE in (which
 * is always one with an enabled membership): the role the route checked belongs to that business, so a business the account also
 * belongs to but has not switched to is a 404 until POST /api/auth/switch-business.
 */
export function requireBusinessAccess(principal: Principal, businessId: string | null | undefined, opts: { platformAction?: boolean } = {}): void {
  if (principal.kind === 'admin') {
    // An admin USER writing a tenant needs an open support write grant for EXACTLY this business (principal.writeGrants, loaded by authenticate).
    // `platformAction`: the route is an operator action on the providers that checks its own platform permission (business provisioning).
    if (principal.writeGrants && !opts.platformAction && !(businessId && principal.writeGrants.has(businessId))) throw new AuthError(403, SUPPORT_WRITE_MESSAGE, 'support_write_required');
    return;
  }
  if (!businessId || businessId !== principal.business_id) throw new AuthError(404, 'business not found');
}

/**
 * The business id a request should operate on. A user is pinned to the session's active business: a different
 * requested id is a 404, an omitted one defaults to it. An admin gets the requested id (null if none).
 */
export function scopeBusinessId(principal: Extract<Principal, { kind: 'user' }>, requested?: string | null): string;
export function scopeBusinessId(principal: Principal, requested?: string | null): string | null;
export function scopeBusinessId(principal: Principal, requested?: string | null): string | null {
  if (principal.kind === 'admin') {
    if (requested) requireBusinessAccess(principal, requested);
    else if (principal.writeGrants) throw new AuthError(403, SUPPORT_WRITE_MESSAGE, 'support_write_required'); // a write that names no business is not a tenant write an admin user may make
    return requested || null;
  }
  if (requested) requireBusinessAccess(principal, requested);
  return principal.business_id;
}

export type Resolution =
  | {
    ok: true; principal: Principal; ambient: boolean;
    /** The DB session behind a cookie credential (null for Bearer/dev). */ sessionId: string | null;
    /** When that session last proved who it is (login or re-authentication); null for Bearer/dev/break-glass or a pre-existing session. */ sudoAt?: string | null;
  }
  | { ok: false; status: 401 | 403 | 503; error: string; code?: 'mfa_required' | '2fa_enrollment_required' };

/**
 * The membership a session works in: its active business while that membership is still enabled, else the account's primary
 * (legacy) business, else the oldest enabled membership. Same rule as resolveActiveMembership in src/lib/db/memberships.ts,
 * applied to an already loaded list (one query per request).
 */
export function pickActiveMembership(
  list: MembershipWithBusiness[], activeBusinessId: string | null, primaryBusinessId: string | null,
): MembershipWithBusiness | null {
  if (list.length === 0) return null;
  return (activeBusinessId ? list.find((m) => m.business_id === activeBusinessId) : undefined)
    ?? list.find((m) => m.business_id === primaryBusinessId)
    ?? list[0];
}

export { require2faForAdmins };

/** A user whose password was accepted but whose second factor is outstanding (the only session state /api/auth/mfa accepts). */
export interface PendingMfa { user: User; session: UserSession }

/** The MFA-pending session of a request, if any (cookie shape ok, row exists, user has 2FA, session not yet verified). */
export async function resolvePendingMfa(h: Headers): Promise<PendingMfa | null> {
  const token = userSessionTokenFrom(h);
  if (!token) return null;
  const found = await resolveSessionByToken(token);
  if (!found || found.kind !== 'user') return null;
  return found.user.totp_enabled && !found.session.mfa_verified_at ? { user: found.user, session: found.session } : null;
}

/**
 * Resolve the caller from request headers. `ambient` is true when the credential is a browser cookie
 * (the CSRF-relevant case). Throws only on database errors.
 *
 * `allowEnrollment`: let a DB admin who must enrol in 2FA (REQUIRE_2FA_FOR_ADMINS) through; only the 2FA/session
 * management endpoints and the security page set it.
 */
export async function resolvePrincipal(h: Headers, opts: { allowEnrollment?: boolean } = {}): Promise<Resolution> {
  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') return { ok: false, status: 503, error: 'server auth not configured' };
  const unauthorized = { ok: false, status: 401, error: 'unauthorized' } as const;

  if (hasBearer(h)) {
    if (cfg.mode === 'enforce' && (await tokensMatch((h.get('authorization') ?? '').slice(7).trim(), cfg.token))) {
      return { ok: true, principal: { kind: 'admin', via: 'token', email_verified: true }, ambient: false, sessionId: null };
    }
    if (cfg.mode === 'enforce') return unauthorized; // never fall back to cookies behind a bad Bearer
  }

  if (cfg.mode === 'enforce') {
    const adminToken = adminSessionTokenFrom(h);
    if (adminToken) {
      const found = await resolveSessionByToken(adminToken);
      if (found && found.kind === 'admin_token') {
        return { ok: true, principal: { kind: 'admin', via: 'cookie', email_verified: true }, ambient: true, sessionId: found.session.id, sudoAt: found.session.sudo_at };
      }
    }
  }

  const token = userSessionTokenFrom(h);
  if (token) {
    const found = await resolveSessionByToken(token);
    if (found && found.kind === 'user') {
      const { user, session } = found;
      // Password accepted but second factor outstanding: this session proves nothing yet.
      if (user.totp_enabled && !session.mfa_verified_at) {
        return { ok: false, status: 401, error: 'two-factor code required', code: 'mfa_required' };
      }
      const email_verified = user.email_verified_at !== null;
      if (user.role === 'admin') {
        const needs = require2faForAdmins() && !user.totp_enabled;
        if (needs && !opts.allowEnrollment) {
          return { ok: false, status: 403, error: 'two-factor enrollment required', code: '2fa_enrollment_required' };
        }
        return {
          ok: true,
          principal: { kind: 'admin', via: 'user', user, email_verified, ...(needs ? { needs_2fa_enrollment: true } : {}) },
          ambient: true,
          sessionId: session.id,
          sudoAt: session.sudo_at,
        };
      }
      // A business this session was signed out of (or whose membership was disabled / removed) never resolves again for THIS session.
      const revoked = new Set(session.revoked_business_ids ?? []);
      const memberships = (await listMembershipsForUser(user.id)).filter((m) => !revoked.has(m.business_id));
      const active = pickActiveMembership(memberships, session.active_business_id ?? null, user.business_id);
      if (active) {
        return {
          ok: true,
          principal: { kind: 'user', user, business_id: active.business_id, role: active.role, email_verified, memberships },
          ambient: true,
          sessionId: session.id,
          sudoAt: session.sudo_at,
        };
      }
      // No enabled membership (every business disabled them): the account has nothing to act on, refuse rather than guess.
    }
  }

  if (cfg.mode === 'open') return { ok: true, principal: { kind: 'admin', via: 'dev', email_verified: true }, ambient: false, sessionId: null };
  return unauthorized;
}

export type AuthResult =
  | {
    ok: true; principal: Principal; /** The caller's own DB session id (cookie credentials only). */ sessionId: string | null;
    /** Last proof of identity of that session (ISO), when known. */ sudoAt: string | null;
  }
  | { ok: false; response: NextResponse<{ ok: false; error: string; code?: string }> };

const deny = (status: number, error: string, code?: string): AuthResult => ({
  ok: false,
  response: NextResponse.json({ ok: false as const, error, ...(code ? { code } : {}) }, { status }),
});

export interface AuthenticateOptions {
  role?: Role;
  /** Also require a verified email address (403 `email_not_verified`): provisioning and billing routes. */
  verifiedEmail?: boolean;
  /** Let an admin who still has to enrol in 2FA through (2FA / session management endpoints only). */
  allowEnrollment?: boolean;
}

/**
 * Standard guard for route handlers:
 *
 *   const auth = await authenticate(req, { role: 'owner' });
 *   if (!auth.ok) return auth.response;
 *   const { principal } = auth;
 *
 * Validates the credential against the database, enforces the minimum role (default 'staff'; 403 below
 * it) and, for cookie-authenticated state-changing requests, a same-origin check. Never trusts the proxy.
 * `verifiedEmail: true` additionally requires a verified email address.
 */
export async function authenticate(req: Request, opts: AuthenticateOptions = {}): Promise<AuthResult> {
  let res: Resolution;
  try {
    res = await resolvePrincipal(req.headers, { allowEnrollment: opts.allowEnrollment });
  } catch (err) {
    console.error('[session] lookup failed', err);
    return deny(503, 'service temporarily unavailable');
  }
  if (!res.ok) return deny(res.status, res.error, res.code);
  if (res.ambient && !SAFE_METHODS.has(req.method) && !checkSameOrigin(req.headers, { requirePresent: true })) {
    return deny(403, 'cross-site request refused');
  }
  if (!hasRole(res.principal, opts.role ?? 'staff')) return deny(403, 'forbidden');
  if (opts.verifiedEmail && !res.principal.email_verified) return deny(403, 'email_not_verified', 'email_not_verified');
  // An admin USER changing a tenant needs an open support write grant (no silent full-write impersonation): see src/lib/admin/support-gate.ts.
  if (res.principal.kind === 'admin' && res.principal.via === 'user' && !SAFE_METHODS.has(req.method)) {
    const { supportWriteGate } = await import('@/lib/admin/support-gate');
    const gate = await supportWriteGate(req, res.principal);
    if (gate && gate.ok === false) return deny(gate.status, gate.error, gate.code);
    if (gate && gate.ok === true) return { ok: true, principal: { ...res.principal, writeGrants: gate.grants }, sessionId: res.sessionId, sudoAt: res.sudoAt ?? null };
  }
  return { ok: true, principal: res.principal, sessionId: res.sessionId, sudoAt: res.sudoAt ?? null };
}

/** How recent a proof of identity must be for a sensitive change (call forwarding / call mode): 5 minutes. */
export const RECENT_AUTH_MS = 5 * 60_000;

/**
 * Step-up ("sudo") guard for sensitive changes. Every AMBIENT browser credential must have proved who it is within RECENT_AUTH_MS:
 * a user (owner or staff), a DB admin user, and the break-glass admin COOKIE session (the 12 h `admin_token` session). They prove it by login,
 * or POST /api/auth/reauth (the password, or for an account with 2FA the 6-digit code; for the break-glass cookie session the ADMIN_TOKEN
 * itself); otherwise 403 with `code: 'reauth_required'` (the dashboard then asks and retries). Only credentials that are NOT ambient pass
 * without it: the Bearer ADMIN_TOKEN header (sent on purpose with every request, and audited with actor kind `admin_token`) and
 * ALLOW_INSECURE_DEV (never in production). Returns the response to send, or null when allowed.
 */
export function requireRecentAuth(auth: Extract<AuthResult, { ok: true }>, now: Date = new Date()): NextResponse<{ ok: false; error: string; code: string }> | null {
  const p = auth.principal;
  const needs = p.kind === 'user' || (p.kind === 'admin' && (p.via === 'user' || p.via === 'cookie'));
  if (!needs) return null;
  const at = auth.sudoAt ? new Date(auth.sudoAt).getTime() : NaN;
  if (Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < RECENT_AUTH_MS) return null;
  return NextResponse.json(
    { ok: false as const, error: p.kind === 'admin' && p.via === 'cookie' ? 'Re-enter the admin token to continue.' : 'Re-enter your password to continue.', code: 'reauth_required' },
    { status: 403 },
  );
}

/**
 * Resolution of the current server-component render, memoised per request. A DB admin that must enrol in 2FA
 * is redirected to the security page from everywhere else (the proxy forwards the path as `x-rc-pathname`).
 */
export const getServerResolution = cache(async (): Promise<Extract<Resolution, { ok: true }> | null> => {
  const h = new Headers(await nextHeaders());
  const path = h.get('x-rc-pathname') ?? '';
  const onSecurityPage = path === '/dashboard/security' || path.startsWith('/dashboard/security/');
  let res: Resolution;
  try {
    res = await resolvePrincipal(h, { allowEnrollment: onSecurityPage });
  } catch (err) {
    console.error('[session] lookup failed', err);
    return null;
  }
  if (!res.ok && res.code === '2fa_enrollment_required') redirect('/dashboard/security?enroll=required');
  return res.ok ? res : null;
});

/** Principal of the current server-component render (null when unauthenticated/misconfigured). Memoised per request. */
export const getServerPrincipal = cache(async (): Promise<Principal | null> => (await getServerResolution())?.principal ?? null);
