import { NextResponse } from 'next/server';
import {
  confirmTotpEnrollment, getTotpState, markSessionMfaVerified, recordAudit, revokeOtherSessions,
} from '@/lib/db';
import { afterResponse, auditIp, sendTwoFactorNotice } from '@/lib/account-flows';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { decryptSecret, generateRecoveryCodes, hashRecoveryCode, verifyTotp } from '@/lib/totp';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/2fa/confirm');

/**
 * `{ code }`: finish enrolment with a code from the authenticator app. Turns 2FA on, returns the ten recovery
 * codes (shown ONCE; only their hashes are stored), keeps THIS session and signs every other session out.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user || !auth.sessionId) return NextResponse.json({ ok: false, error: 'two-factor needs a personal account' }, { status: 400 });
  if (!user.email_verified_at) return NextResponse.json({ ok: false, error: 'email_not_verified' }, { status: 403 });
  try {
    const limited = await rateLimit(`auth/2fa-confirm:${user.id}`, 10, 15 * 60_000, { failClosed: true });
    if (!limited.allowed) return NextResponse.json({ ok: false, error: 'too many attempts, try again later' }, { status: 429, headers: { 'retry-after': String(limited.retryAfterS) } });

    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const state = await getTotpState(user.id);
    if (!state?.secret_enc || state.enabled_at) return NextResponse.json({ ok: false, error: 'start enrolment first' }, { status: 409 });
    const v = typeof body.code === 'string' && body.code.length <= 32
      ? verifyTotp(decryptSecret(state.secret_enc, user.id), body.code)
      : { ok: false as const };
    if (!v.ok) return NextResponse.json({ ok: false, error: 'invalid code' }, { status: 400 });

    const codes = generateRecoveryCodes();
    if (!(await confirmTotpEnrollment(user.id, v.step, codes.map(hashRecoveryCode)))) {
      return NextResponse.json({ ok: false, error: 'start enrolment first' }, { status: 409 });
    }
    await markSessionMfaVerified(auth.sessionId);
    const revoked = await revokeOtherSessions(user.id, auth.sessionId);
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.2fa_enabled', target: `user:${user.id}`,
      ip: auditIp(req), meta: { other_sessions_revoked: revoked },
    });
    await afterResponse('2fa.notice', () => sendTwoFactorNotice(user.email, true));
    return NextResponse.json({ ok: true, data: { enabled: true, recovery_codes: codes } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    log.error('error', { err });
    return NextResponse.json({ ok: false, error: 'service temporarily unavailable' }, { status: 503 });
  }
}
