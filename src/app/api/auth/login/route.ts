import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  authConfig, checkSameOrigin, sessionValue, tokensMatch, SESSION_COOKIE, SESSION_MAX_AGE_S, USER_SESSION_COOKIE,
} from '@/lib/auth';
import { limitRequest, rateLimit } from '@/lib/ratelimit';
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
  const limited = await limitRequest(req, 'auth/login', 10, 5 * 60_000, { failClosed: true });
  if (limited) return limited;

  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') return fail(503, 'server auth not configured');
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');

  const body = (await req.json().catch(() => ({}))) as { token?: unknown; email?: unknown; password?: unknown };

  // --- break-glass admin token -------------------------------------------------------------
  if (typeof body.token === 'string' && typeof body.email !== 'string') {
    if (cfg.mode === 'enforce' && !(await tokensMatch(body.token, cfg.token))) return fail(401, INVALID);
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

  // Per-account cap on top of the per-client one (client keys are weak without a trusted proxy).
  const emailKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32);
  const perAccount = await rateLimit(`auth/login:acct:${emailKey}`, 10, 15 * 60_000, { failClosed: true });
  if (!perAccount.allowed) {
    return perAccount.error
      ? fail(503, 'service temporarily unavailable', { 'retry-after': String(perAccount.retryAfterS) })
      : fail(429, 'rate limit exceeded', { 'retry-after': String(perAccount.retryAfterS) });
  }

  try {
    const user = await getUserByEmail(email);
    const valid = await verifyPasswordOrDummy(body.password, user?.password_hash);
    if (!user || !valid || user.disabled_at) {
      log.warn('failed', { acct: emailKey.slice(0, 8) });
      return fail(401, INVALID);
    }
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
