import { NextResponse } from 'next/server';
import { auditIp } from '@/lib/account-flows';
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
 * it works only on a live cookie session of a user (Bearer / break-glass credentials do not need it). Audited, rate limited.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const p = auth.principal;
    if (p.kind === 'admin' && p.via !== 'user') return NextResponse.json({ ok: true, data: { reauthenticated: true, not_needed: true } });
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
    if (typeof body.code === 'string' && body.code && user.totp_enabled) {
      method = 'totp';
      const r = await verifySecondFactor(user.id, { code: body.code }, { allowRecovery: false, account: { email: user.email, businessId: user.business_id, ip } });
      if (!r.ok && r.locked) return fail(429, 'too many attempts; try again later');
      ok = r.ok;
    } else if (typeof body.password === 'string' && body.password && body.password.length <= 1024) {
      const row = await getUserByEmail(user.email);
      ok = await verifyPasswordOrDummy(body.password, row?.id === user.id ? row.password_hash : undefined);
    } else {
      return fail(422, user.totp_enabled ? 'enter your password or a 6-digit code' : 'enter your password');
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
