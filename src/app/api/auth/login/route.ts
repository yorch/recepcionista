import { NextResponse } from 'next/server';
import {
  adminSessionTokenFrom, authConfig, checkSameOrigin, tokensMatch, SESSION_COOKIE, SESSION_MAX_AGE_S, USER_SESSION_COOKIE,
  userSessionTokenFrom,
} from '@/lib/auth';
import { afterResponse, auditIp, userAgentOf } from '@/lib/account-flows';
import { clearSessionCookie, setSessionCookie } from '@/lib/auth-cookies';
import {
  ADMIN_TOKEN_ACCOUNT, accountId, checkClientAttempts, checkPair, clearFailures, pairKey, recordFailure, verdictResponse,
} from '@/lib/login-throttle';
import {
  createAdminSession, createSession, deleteSession, getUserByEmail, normalizeEmail, recordAudit, SESSION_TTL_MS, upgradePasswordHash,
} from '@/lib/db';
import { MFA_PENDING_TTL_MS } from '@/lib/mfa';
import { accountHasAccess, signedInData } from '@/lib/login-session';
import { hashPassword, needsRehash, verifyPasswordOrDummy } from '@/lib/password';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/login');
const INVALID = 'invalid credentials';

const fail = (status: number, error: string, headers?: Record<string, string>) =>
  NextResponse.json({ ok: false, error }, { status, headers });

/** A new login replaces whatever session the browser still held (no fixation, no orphan rows). */
async function dropPreviousSessions(req: Request): Promise<void> {
  for (const t of [userSessionTokenFrom(req.headers), adminSessionTokenFrom(req.headers)]) {
    if (t) await deleteSession(t).catch(() => false);
  }
}

/**
 * Two ways in, one endpoint:
 *   { email, password }  -> per-user session (cookie `rc_user_session`, opaque token, hash stored in the DB).
 *                           With 2FA on, the session is MFA-pending (10 min, confined to /api/auth/mfa) and
 *                           the response says `mfa_required`.
 *   { token }            -> break-glass ADMIN_TOKEN: a server-side `admin_token` session (12 h, revocable),
 *                           cookie `rc_session` with a random opaque value.
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
  const ip = auditIp(req);

  // --- break-glass admin token -------------------------------------------------------------
  if (typeof body.token === 'string' && typeof body.email !== 'string') {
    const tokenKey = pairKey(ADMIN_TOKEN_ACCOUNT, req); // the break-glass token has its own backoff, per client
    const gate = await checkPair(tokenKey);
    if (!gate.ok) return verdictResponse(gate);
    if (cfg.mode === 'enforce' && !(await tokensMatch(body.token, cfg.token))) {
      await recordFailure(tokenKey, ADMIN_TOKEN_ACCOUNT);
      log.warn('admin_token_failed', {});
      return fail(401, INVALID);
    }
    await clearFailures(tokenKey);
    try {
      const res = NextResponse.json({ ok: true, data: { authenticated: true, kind: 'admin' } });
      if (cfg.mode === 'enforce') {
        await dropPreviousSessions(req);
        const { token } = await createAdminSession({ ip, userAgent: userAgentOf(req) });
        setSessionCookie(res, SESSION_COOKIE, token, SESSION_MAX_AGE_S);
        await recordAudit({ actor_kind: 'admin_token', action: 'auth.admin_login', target: 'admin_token', ip });
      }
      clearSessionCookie(res, USER_SESSION_COOKIE);
      return res;
    } catch (err) {
      log.error('error', { err });
      return fail(503, 'service temporarily unavailable');
    }
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
    if (!user || !valid || user.disabled_at || !(await accountHasAccess(user))) {
      log.warn('failed', { acct: account.slice(0, 8) });
      await recordFailure(key, account);
      // Only known accounts are audited (unknown addresses would let junk traffic fill the table); written after
      // the response so known and unknown addresses answer in the same time.
      if (user) {
        await afterResponse('audit.login_failed', () => recordAudit({
          actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.login_failed',
          target: `user:${user.id}`, ip, meta: { reason: user.disabled_at ? 'disabled' : valid ? 'no_membership' : 'bad_password' },
        }));
      }
      return fail(401, INVALID);
    }
    await clearFailures(key);

    // Transparent hash upgrade (stronger scrypt parameters). Does NOT touch sessions; never blocks the login.
    if (needsRehash(user.password_hash)) {
      try {
        await upgradePasswordHash(user.id, user.password_hash, await hashPassword(body.password));
      } catch (err) {
        log.warn('rehash_failed', { err });
      }
    }

    await dropPreviousSessions(req);
    const mfaPending = user.totp_enabled;
    const { token } = await createSession(user.id, {
      ip, userAgent: userAgentOf(req), ...(mfaPending ? { ttlMs: MFA_PENDING_TTL_MS } : {}),
    });
    const res = NextResponse.json({
      ok: true,
      data: mfaPending
        ? { authenticated: false, mfa_required: true }
        : await signedInData(user),
    });
    setSessionCookie(res, USER_SESSION_COOKIE, token, Math.floor((mfaPending ? MFA_PENDING_TTL_MS : SESSION_TTL_MS) / 1000));
    // The admin cookie outranks a user session: drop it so the account just signed in is the one acting.
    clearSessionCookie(res, SESSION_COOKIE);
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id,
      action: mfaPending ? 'auth.login_password_ok' : 'auth.login', target: `user:${user.id}`, ip,
    });
    log.info('ok', { user: user.id, role: user.role, mfa_pending: mfaPending });
    return res;
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
