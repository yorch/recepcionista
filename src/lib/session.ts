/**
 * Node-side authentication and authorization. THE place where credentials are really validated;
 * src/proxy.ts only does a cheap presence/shape gate (it cannot reach the database).
 *
 * Credentials, in order of precedence:
 *   1. `Authorization: Bearer <ADMIN_TOKEN>`     -> admin (break-glass superadmin, CSRF-exempt)
 *      An invalid Bearer never falls back to cookies.
 *   2. `rc_session` cookie (random opaque token)  -> a server-side `admin_token` session (12 h, revocable)
 *   3. `rc_user_session` cookie (opaque token)    -> looked up in Postgres: owner/staff are tied to
 *      ONE business; a user with role 'admin' is a global admin.
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
import { resolveSessionByToken } from '@/lib/db/users';
import type { User, UserSession } from '@/lib/types';

export type Role = 'staff' | 'owner' | 'admin';

export type Principal =
  /**
   * `via`: token = Bearer ADMIN_TOKEN, cookie = break-glass admin session cookie (DB `admin_token` session),
   * user = a DB user with role admin, dev = ALLOW_INSECURE_DEV. `email_verified` is always true for the
   * break-glass paths (they are not tied to a mailbox).
   */
  | { kind: 'admin'; via: 'token' | 'cookie' | 'user' | 'dev'; user?: User; email_verified: boolean; needs_2fa_enrollment?: boolean }
  /** `email_verified`: the user proved their address. Provisioning/billing routes must require it (requireVerifiedEmail). */
  | { kind: 'user'; user: User; business_id: string; role: 'owner' | 'staff'; email_verified: boolean };

const RANK: Record<Role, number> = { staff: 1, owner: 2, admin: 3 };

export function principalRole(p: Principal): Role {
  return p.kind === 'admin' ? 'admin' : p.role;
}

/** Is this principal at least `min`? (admin > owner > staff) */
export function hasRole(p: Principal, min: Role): boolean {
  return RANK[principalRole(p)] >= RANK[min];
}

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 404 | 503, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Response for an AuthError (or null for any other error, so callers can fall through to their own handling). */
export function authErrorResponse(err: unknown): NextResponse<{ ok: false; error: string }> | null {
  if (!(err instanceof AuthError)) return null;
  return NextResponse.json({ ok: false as const, error: err.message }, { status: err.status });
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
 * access `businessId`. Admins may access every business.
 */
export function requireBusinessAccess(principal: Principal, businessId: string | null | undefined): void {
  if (principal.kind === 'admin') return;
  if (!businessId || businessId !== principal.business_id) throw new AuthError(404, 'business not found');
}

/**
 * The business id a request should operate on. A user is pinned to their own business: a different
 * requested id is a 404, an omitted one defaults to their own. An admin gets the requested id (null if none).
 */
export function scopeBusinessId(principal: Extract<Principal, { kind: 'user' }>, requested?: string | null): string;
export function scopeBusinessId(principal: Principal, requested?: string | null): string | null;
export function scopeBusinessId(principal: Principal, requested?: string | null): string | null {
  if (principal.kind === 'admin') return requested || null;
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

/** Should REQUIRE_2FA_FOR_ADMINS force DB admin users to enrol? Default off. */
export const require2faForAdmins = (): boolean => process.env.REQUIRE_2FA_FOR_ADMINS === 'true';

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
      if (user.business_id) {
        return {
          ok: true,
          principal: { kind: 'user', user, business_id: user.business_id, role: user.role === 'owner' ? 'owner' : 'staff', email_verified },
          ambient: true,
          sessionId: session.id,
          sudoAt: session.sudo_at,
        };
      }
      // owner/staff without a business must not exist (createUser forbids it): refuse rather than guess.
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
  return { ok: true, principal: res.principal, sessionId: res.sessionId, sudoAt: res.sudoAt ?? null };
}

/** How recent a proof of identity must be for a sensitive change (call forwarding / call mode): 5 minutes. */
export const RECENT_AUTH_MS = 5 * 60_000;

/**
 * Step-up ("sudo") guard for sensitive changes. A user (owner or staff) or a DB admin working through a browser session must have
 * proved who they are (login, or POST /api/auth/reauth with the password or a 2FA code) within RECENT_AUTH_MS; otherwise 403 with
 * `code: 'reauth_required'` (the dashboard then asks for the password and retries). Bearer ADMIN_TOKEN, the break-glass cookie
 * session and ALLOW_INSECURE_DEV carry no password to re-enter: the token itself is the proof, so they pass.
 * Returns the response to send, or null when allowed.
 */
export function requireRecentAuth(auth: Extract<AuthResult, { ok: true }>, now: Date = new Date()): NextResponse<{ ok: false; error: string; code: string }> | null {
  const p = auth.principal;
  const needs = p.kind === 'user' || (p.kind === 'admin' && p.via === 'user');
  if (!needs) return null;
  const at = auth.sudoAt ? new Date(auth.sudoAt).getTime() : NaN;
  if (Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < RECENT_AUTH_MS) return null;
  return NextResponse.json(
    { ok: false as const, error: 'Re-enter your password to continue.', code: 'reauth_required' },
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
