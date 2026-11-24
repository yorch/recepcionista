import { NextResponse } from 'next/server';
import { checkSameOrigin, USER_SESSION_COOKIE, userSessionTokenFrom } from '@/lib/auth';
import { auditIp, userAgentOf } from '@/lib/account-flows';
import { clearSessionCookie, setSessionCookie } from '@/lib/auth-cookies';
import { accountId, checkClientAttempts, checkPair, clearFailures, mfaPairKey, recordFailure, verdictResponse } from '@/lib/login-throttle';
import { countUnusedRecoveryCodes, createSession, deleteSession, recordAudit, SESSION_TTL_MS } from '@/lib/db';
import { verifySecondFactor } from '@/lib/mfa';
import { signedInData } from '@/lib/login-session';
import { rateLimit } from '@/lib/ratelimit';
import { resolvePendingMfa } from '@/lib/session';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/mfa');
/** Wrong codes allowed on one pending session before it is destroyed (the user signs in again with the password). */
const MAX_FAILURES_PER_SESSION = 5;

const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * Second login step. Accepts ONLY an MFA-pending session cookie (password already accepted) and
 * `{ code }` (TOTP, replay-guarded) or `{ recovery_code }` (single use). On success the pending session is
 * replaced by a fresh full-lifetime session (new token, so nothing issued before the second factor survives).
 */
export async function POST(req: Request) {
  const attempts = await checkClientAttempts(req);
  if (!attempts.ok) return verdictResponse(attempts);
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');

  try {
    const pending = await resolvePendingMfa(req.headers);
    if (!pending) return fail(401, 'unauthorized');
    const { user, session } = pending;
    const ip = auditIp(req);

    const key = mfaPairKey(user.id, req);
    const gate = await checkPair(key);
    if (!gate.ok) return verdictResponse(gate);

    const body = (await req.json().catch(() => ({}))) as { code?: unknown; recovery_code?: unknown };
    const result = await verifySecondFactor(user.id, body, { allowRecovery: true, account: { email: user.email, businessId: user.business_id, ip, locale: user.locale } });
    if (!result.ok && result.locked) return verdictResponse(result.locked);

    if (!result.ok) {
      await recordFailure(key, accountId(user.id));
      const perSession = await rateLimit(`auth/mfa:session:${session.id}`, MAX_FAILURES_PER_SESSION - 1, 15 * 60_000, { failClosed: true });
      await recordAudit({
        actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.mfa_failed', target: `user:${user.id}`, ip,
        meta: { method: typeof body.recovery_code === 'string' && body.recovery_code ? 'recovery' : 'totp' },
      });
      if (!perSession.allowed) {
        const token = userSessionTokenFrom(req.headers);
        if (token) await deleteSession(token);
        const res = fail(401, 'too many wrong codes: sign in again');
        clearSessionCookie(res, USER_SESSION_COOKIE);
        return res;
      }
      return fail(401, 'invalid code');
    }

    await clearFailures(key);
    const oldToken = userSessionTokenFrom(req.headers);
    if (oldToken) await deleteSession(oldToken);
    const { token } = await createSession(user.id, { ip, userAgent: userAgentOf(req), mfaVerified: true });
    const left = await countUnusedRecoveryCodes(user.id);
    const res = NextResponse.json({
      ok: true,
      data: {
        ...(await signedInData(user)),
        ...(result.method === 'recovery' ? { recovery_codes_left: left } : {}),
      },
    });
    setSessionCookie(res, USER_SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.login', target: `user:${user.id}`, ip,
      meta: { mfa: result.method },
    });
    if (result.method === 'recovery') {
      await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.recovery_code_used', target: `user:${user.id}`, ip, meta: { left } });
    }
    return res;
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
