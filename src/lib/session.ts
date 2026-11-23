/**
 * Node-side authentication and authorization. THE place where credentials are really validated;
 * src/proxy.ts only does a cheap presence/shape gate (it cannot reach the database).
 *
 * Credentials, in order of precedence:
 *   1. `Authorization: Bearer <ADMIN_TOKEN>`     -> admin (break-glass superadmin, CSRF-exempt)
 *      An invalid Bearer never falls back to cookies.
 *   2. `rc_session` cookie (HMAC of ADMIN_TOKEN)  -> admin
 *   3. `rc_user_session` cookie (opaque token)    -> looked up in Postgres: owner/staff are tied to
 *      ONE business; a user with role 'admin' is a global admin.
 *   4. ALLOW_INSECURE_DEV=true without ADMIN_TOKEN -> admin (never in production)
 *
 * Fail closed: ADMIN_TOKEN unset without the dev opt-in -> 503 for everything (users included).
 */
import { cache } from 'react';
import { headers as nextHeaders } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  authConfig, checkSameOrigin, hasBearer, readCookie, SAFE_METHODS, SESSION_COOKIE, sessionValue,
  timingSafeEqual, tokensMatch, userSessionTokenFrom,
} from '@/lib/auth';
import { getSessionByToken } from '@/lib/db/users';
import type { User } from '@/lib/types';

export type Role = 'staff' | 'owner' | 'admin';

export type Principal =
  /** `via`: token = Bearer ADMIN_TOKEN, cookie = admin cookie, user = a DB user with role admin, dev = ALLOW_INSECURE_DEV. */
  | { kind: 'admin'; via: 'token' | 'cookie' | 'user' | 'dev'; user?: User }
  | { kind: 'user'; user: User; business_id: string; role: 'owner' | 'staff' };

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
  | { ok: true; principal: Principal; ambient: boolean }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Resolve the caller from request headers. `ambient` is true when the credential is a browser cookie
 * (the CSRF-relevant case). Throws only on database errors.
 */
export async function resolvePrincipal(h: Headers): Promise<Resolution> {
  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') return { ok: false, status: 503, error: 'server auth not configured' };
  const unauthorized = { ok: false, status: 401, error: 'unauthorized' } as const;

  if (hasBearer(h)) {
    if (cfg.mode === 'enforce' && (await tokensMatch((h.get('authorization') ?? '').slice(7).trim(), cfg.token))) {
      return { ok: true, principal: { kind: 'admin', via: 'token' }, ambient: false };
    }
    if (cfg.mode === 'enforce') return unauthorized; // never fall back to cookies behind a bad Bearer
  }

  if (cfg.mode === 'enforce') {
    const cookie = readCookie(h.get('cookie'), SESSION_COOKIE);
    if (cookie && timingSafeEqual(cookie, await sessionValue(cfg.token))) {
      return { ok: true, principal: { kind: 'admin', via: 'cookie' }, ambient: true };
    }
  }

  const token = userSessionTokenFrom(h);
  if (token) {
    const found = await getSessionByToken(token);
    if (found) {
      const { user } = found;
      if (user.role === 'admin') return { ok: true, principal: { kind: 'admin', via: 'user', user }, ambient: true };
      if (user.business_id) {
        return {
          ok: true,
          principal: { kind: 'user', user, business_id: user.business_id, role: user.role === 'owner' ? 'owner' : 'staff' },
          ambient: true,
        };
      }
      // owner/staff without a business must not exist (createUser forbids it): refuse rather than guess.
    }
  }

  if (cfg.mode === 'open') return { ok: true, principal: { kind: 'admin', via: 'dev' }, ambient: false };
  return unauthorized;
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse<{ ok: false; error: string }> };

const deny = (status: number, error: string): AuthResult => ({
  ok: false,
  response: NextResponse.json({ ok: false as const, error }, { status }),
});

/**
 * Standard guard for route handlers:
 *
 *   const auth = await authenticate(req, { role: 'owner' });
 *   if (!auth.ok) return auth.response;
 *   const { principal } = auth;
 *
 * Validates the credential against the database, enforces the minimum role (default 'staff'; 403 below
 * it) and, for cookie-authenticated state-changing requests, a same-origin check. Never trusts the proxy.
 */
export async function authenticate(req: Request, opts: { role?: Role } = {}): Promise<AuthResult> {
  let res: Resolution;
  try {
    res = await resolvePrincipal(req.headers);
  } catch (err) {
    console.error('[session] lookup failed', err);
    return deny(503, 'service temporarily unavailable');
  }
  if (!res.ok) return deny(res.status, res.error);
  if (res.ambient && !SAFE_METHODS.has(req.method) && !checkSameOrigin(req.headers, { requirePresent: true })) {
    return deny(403, 'cross-site request refused');
  }
  if (!hasRole(res.principal, opts.role ?? 'staff')) return deny(403, 'forbidden');
  return { ok: true, principal: res.principal };
}

/** Principal of the current server-component render (null when unauthenticated/misconfigured). Memoised per request. */
export const getServerPrincipal = cache(async (): Promise<Principal | null> => {
  const h = await nextHeaders();
  try {
    const res = await resolvePrincipal(new Headers(h));
    return res.ok ? res.principal : null;
  } catch (err) {
    console.error('[session] lookup failed', err);
    return null;
  }
});
