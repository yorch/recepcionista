import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  adminSessionTokenFrom, checkSameOrigin, SESSION_COOKIE, USER_SESSION_COOKIE, userSessionTokenFrom,
} from '@/lib/auth';
import { afterResponse, auditIp, userAgentOf } from '@/lib/account-flows';
import { clearSessionCookie, setSessionCookie } from '@/lib/auth-cookies';
import { createSession, deleteSession, getUserById, recordAudit, SESSION_TTL_MS } from '@/lib/db';
import { accountId, checkClientAttempts, checkPair, clearFailures, pairKey, recordFailure, verdictResponse } from '@/lib/login-throttle';
import { accountHasAccess, signedInData } from '@/lib/login-session';
import { configOr503, handleClonedPasskey, pkFail } from '@/lib/passkey-http';
import { finishAuthentication } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/login/verify');
const INVALID = 'passkey sign-in failed';

/** A new login replaces whatever session the browser still held (no fixation, no orphan rows). */
async function dropPreviousSessions(req: Request): Promise<void> {
  for (const t of [userSessionTokenFrom(req.headers), adminSessionTokenFrom(req.headers)]) {
    if (t) await deleteSession(t).catch(() => false);
  }
}

/**
 * POST (public) { response }: finish a passwordless sign-in. The assertion must carry user verification (PIN / biometric), so it counts as
 * BOTH factors: the session is created MFA-verified even for an account with an authenticator app. Everything else stays as at password
 * login: disabled accounts and accounts without an enabled membership are refused (identical, generic 401), an unverified email still signs
 * in (the dashboard shows the banner), a previous session is replaced (no fixation), per-client attempt caps and failure backoff apply.
 * A signature counter that did not advance means a cloned authenticator: the sign-in is refused, every session of that account is revoked,
 * the event is audited and the owner is emailed.
 */
export async function POST(req: Request) {
  const attempts = await checkClientAttempts(req);
  if (!attempts.ok) return verdictResponse(attempts);
  if (!checkSameOrigin(req.headers)) return pkFail(403, 'cross-site request refused');
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;

  const body = (await req.json().catch(() => ({}))) as { response?: unknown };
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || response.id.length > 1024) return pkFail(401, INVALID);

  const key = pairKey(accountId(`passkey:${response.id}`), req);
  const gate = await checkPair(key);
  if (!gate.ok) return verdictResponse(gate);
  const ip = auditIp(req);
  try {
    const r = await finishAuthentication(conf.cfg, 'login', response);
    if (!r.ok) {
      await recordFailure(key, accountId(`passkey:${response.id}`));
      if (r.reason === 'clone_suspected' && r.passkey) {
        const owner = await getUserById(r.passkey.user_id);
        if (owner) await handleClonedPasskey(req, owner, r.passkey);
      } else if (r.passkey) {
        await afterResponse('audit.passkey_login_failed', () => recordAudit({
          actor_kind: 'user', actor_user_id: r.passkey!.user_id, action: 'auth.login_failed', target: `user:${r.passkey!.user_id}`, ip, meta: { method: 'passkey', reason: r.reason },
        }));
      }
      return pkFail(401, INVALID);
    }
    const user = await getUserById(r.passkey.user_id);
    if (!user || user.disabled_at || !(await accountHasAccess(user))) {
      await recordFailure(key, accountId(`passkey:${response.id}`));
      if (user) {
        await afterResponse('audit.passkey_login_failed', () => recordAudit({
          actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.login_failed', target: `user:${user.id}`, ip,
          meta: { method: 'passkey', reason: user.disabled_at ? 'disabled' : 'no_membership' },
        }));
      }
      return pkFail(401, INVALID);
    }
    await clearFailures(key);

    await dropPreviousSessions(req);
    // User verification happened (requireUserVerification): the session is born MFA-verified.
    const { token } = await createSession(user.id, { ip, userAgent: userAgentOf(req), mfaVerified: true });
    const res = NextResponse.json({ ok: true, data: { ...(await signedInData(user)), method: 'passkey' } });
    setSessionCookie(res, USER_SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
    clearSessionCookie(res, SESSION_COOKIE);
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.login', target: `user:${user.id}`, ip,
      meta: { method: 'passkey', passkey_id: r.passkey.id },
    });
    log.info('ok', { user: user.id });
    return res;
  } catch (err) {
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
