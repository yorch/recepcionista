import { NextResponse } from 'next/server';
import {
  authConfig, checkSameOrigin, sessionValue, tokensMatch, SESSION_COOKIE, SESSION_MAX_AGE_S, USER_SESSION_COOKIE,
} from '@/lib/auth';
import {
  ADMIN_TOKEN_ACCOUNT, accountId, checkClientAttempts, checkPair, clearFailures, pairKey, recordFailure, verdictResponse,
} from '@/lib/login-throttle';
import { createSession, getUserByEmail, normalizeEmail, SESSION_TTL_MS } from '@/lib/db/users';
import { verifyPasswordOrDummy } from '@/lib/password';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/login');
const INVALID = 'invalid credentials';

const cookieBase = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
});

const fail = (status: number, error: string, headers?: Record<string, string>) =>
  NextResponse.json({ ok: false, error }, { status, headers });

/**
 * Two ways in, one endpoint:
 *   { email, password }  -> per-user session (cookie `rc_user_session`, opaque token, hash stored in the DB)
 *   { token }            -> break-glass ADMIN_TOKEN (cookie `rc_session`)
 * Failure responses are identical for unknown email, wrong password and disabled account.
 */
export async function POST(req: Request) {
  // Layer 1: per-client attempt cap, before any credential work. Never shared across clients, so junk
  // traffic from one address cannot starve anyone else (see src/lib/login-throttle.ts).
  const attempts = await checkClientAttempts(req);
  if (!attempts.ok) return verdictResponse(attempts);

  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') return fail(503, 'server auth not configured');
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');

  const body = (await req.json().catch(() => ({}))) as { token?: unknown; email?: unknown; password?: unknown };

  // --- break-glass admin token -------------------------------------------------------------
  if (typeof body.token === 'string' && typeof body.email !== 'string') {
    const tokenKey = pairKey(ADMIN_TOKEN_ACCOUNT, req); // the break-glass token has its own backoff, per client
    const gate = await checkPair(tokenKey);
    if (!gate.ok) return verdictResponse(gate);
    if (cfg.mode === 'enforce' && !(await tokensMatch(body.token, cfg.token))) {
      await recordFailure(tokenKey, ADMIN_TOKEN_ACCOUNT);
      return fail(401, INVALID);
    }
    await clearFailures(tokenKey);
    const res = NextResponse.json({ ok: true, data: { authenticated: true, kind: 'admin' } });
    if (cfg.mode === 'enforce') {
      res.cookies.set(SESSION_COOKIE, await sessionValue(cfg.token), { ...cookieBase(), maxAge: SESSION_MAX_AGE_S });
    }
    res.cookies.set(USER_SESSION_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    return res;
  }

  // --- email + password ----------------------------------------------------------------------
  if (typeof body.email !== 'string' || typeof body.password !== 'string'
    || !body.email || !body.password || body.email.length > 254 || body.password.length > 1024) {
    return fail(401, INVALID);
  }
  const email = normalizeEmail(body.email);

  // Layer 2: per (account, client IP) failure backoff. The same for known and unknown emails (no enumeration),
  // and a different client's pair is untouched, so nobody can lock the real user out of their own address.
  const account = accountId(email);
  const key = pairKey(account, req);
  const gate = await checkPair(key);
  if (!gate.ok) return verdictResponse(gate);

  try {
    const user = await getUserByEmail(email);
    const valid = await verifyPasswordOrDummy(body.password, user?.password_hash);
    if (!user || !valid || user.disabled_at) {
      log.warn('failed', { acct: account.slice(0, 8) });
      await recordFailure(key, account);
      return fail(401, INVALID);
    }
    await clearFailures(key);
    const { token } = await createSession(user.id);
    const res = NextResponse.json({
      ok: true,
      data: { authenticated: true, kind: 'user', email: user.email, role: user.role, business_id: user.business_id },
    });
    res.cookies.set(USER_SESSION_COOKIE, token, { ...cookieBase(), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    // The admin cookie outranks a user session: drop it so the account just signed in is the one acting.
    res.cookies.set(SESSION_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    log.info('ok', { user: user.id, role: user.role });
    return res;
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
