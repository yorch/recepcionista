import { NextResponse } from 'next/server';
import { auditIp } from '@/lib/account-flows';
import { authConfig, tokensMatch } from '@/lib/auth';
import { authenticate, authErrorResponse } from '@/lib/session';
import { getUserByEmail, markSessionSudo, recordAudit } from '@/lib/db';
import { verifySecondFactor } from '@/lib/mfa';
import { verifyPasswordOrDummy } from '@/lib/password';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/reauth');
const fail = (status: number, error: string, headers?: Record<string, string>) => NextResponse.json({ ok: false, error }, { status, headers });

/** Wrong re-entries per user per 15 minutes before the step is locked (independent of the client address). */
const MAX_ATTEMPTS = 8;

/**
 * POST /api/auth/reauth   { password } or, for an account with two-factor authentication, { code } (TOTP, replay-guarded).
 * Step-up for sensitive changes (call forwarding / call mode, docs/auth.md): on success the CALLER'S OWN session is stamped with
 * `sudo_at = now`, which the guard `requireRecentAuth` accepts for the next 5 minutes. It never creates or extends a session, and
 * it works only on a live cookie session (the Bearer ADMIN_TOKEN and ALLOW_INSECURE_DEV need no step-up). Audited, rate limited.
 *   - a user (or DB admin) WITHOUT 2FA: { password };
 *   - a user (or DB admin) WITH 2FA: { code } (the 6-digit authenticator code is REQUIRED: the password alone is refused, so a stolen
 *     cookie plus a reused password is not enough; recovery codes are refused here);
 *   - the break-glass admin COOKIE session: { admin_token } (the ADMIN_TOKEN itself).
 * Wrong authenticator codes count towards the account's 2FA lock (mfa.ts), like at login.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const p = auth.principal;
    if (p.kind === 'admin' && (p.via === 'token' || p.via === 'dev')) return NextResponse.json({ ok: true, data: { reauthenticated: true, not_needed: true } });
    if (p.kind === 'admin' && p.via === 'cookie') return reauthBreakGlass(req, auth.sessionId);
    if (!p.user || !auth.sessionId) return fail(401, 'unauthorized');
    const user = p.user;
    const ip = auditIp(req);

    const gate = await rateLimit(`auth/reauth:${user.id}`, MAX_ATTEMPTS, 15 * 60_000, { failClosed: true });
    if (!gate.allowed) {
      return gate.error
        ? fail(503, 'service temporarily unavailable', { 'retry-after': String(gate.retryAfterS) })
        : fail(429, 'too many attempts; try again later', { 'retry-after': String(gate.retryAfterS) });
    }

    const body = (await req.json().catch(() => ({}))) as { password?: unknown; code?: unknown };
    let ok = false;
    let method: 'password' | 'totp' = 'password';
    if (user.totp_enabled && !(typeof body.code === 'string' && body.code)) {
      // 2FA account: the password alone is not accepted for a step-up.
      return NextResponse.json({ ok: false, error: 'enter your 6-digit authenticator code', code: 'totp_required' }, { status: 422 });
    }
    if (typeof body.code === 'string' && body.code && user.totp_enabled) {
      method = 'totp';
      const r = await verifySecondFactor(user.id, { code: body.code }, { allowRecovery: false, account: { email: user.email, businessId: user.business_id, ip } });
      if (!r.ok && r.locked) return fail(429, 'too many attempts; try again later');
      ok = r.ok;
    } else if (typeof body.password === 'string' && body.password && body.password.length <= 1024) {
      const row = await getUserByEmail(user.email);
      ok = await verifyPasswordOrDummy(body.password, row?.id === user.id ? row.password_hash : undefined);
    } else {
      return fail(422, 'enter your password');
    }

    if (!ok) {
      log.warn('failed', { method });
      await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.reauth_failed', target: `user:${user.id}`, ip, meta: { method } });
      return fail(401, method === 'totp' ? 'invalid code' : 'wrong password');
    }
    await markSessionSudo(auth.sessionId);
    await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.reauth', target: `user:${user.id}`, ip, meta: { method } });
    return NextResponse.json({ ok: true, data: { reauthenticated: true, valid_for_s: 300 } });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}

/** Step-up of the break-glass admin cookie session: the ADMIN_TOKEN is the proof (compared in constant time). */
async function reauthBreakGlass(req: Request, sessionId: string | null): Promise<NextResponse> {
  if (!sessionId) return fail(401, 'unauthorized');
  const cfg = authConfig();
  const ip = auditIp(req);
  const gate = await rateLimit(`auth/reauth:admin-session:${sessionId}`, MAX_ATTEMPTS, 15 * 60_000, { failClosed: true });
  if (!gate.allowed) {
    return gate.error
      ? fail(503, 'service temporarily unavailable', { 'retry-after': String(gate.retryAfterS) })
      : fail(429, 'too many attempts; try again later', { 'retry-after': String(gate.retryAfterS) });
  }
  const body = (await req.json().catch(() => ({}))) as { admin_token?: unknown };
  if (typeof body.admin_token !== 'string' || !body.admin_token || body.admin_token.length > 1024) return fail(422, 'enter the admin token');
  const ok = cfg.mode === 'enforce' && (await tokensMatch(body.admin_token.trim(), cfg.token));
  if (!ok) {
    log.warn('failed', { method: 'admin_token' });
    await recordAudit({ actor_kind: 'admin_token', action: 'auth.reauth_failed', target: `session:${sessionId}`, ip, meta: { method: 'admin_token', via: 'cookie' } });
    return fail(401, 'wrong admin token');
  }
  await markSessionSudo(sessionId);
  await recordAudit({ actor_kind: 'admin_token', action: 'auth.reauth', target: `session:${sessionId}`, ip, meta: { method: 'admin_token', via: 'cookie' } });
  return NextResponse.json({ ok: true, data: { reauthenticated: true, valid_for_s: 300 } });
}
