import { NextResponse } from 'next/server';
import { disableTotp, recordAudit, revokeOtherSessions } from '@/lib/db';
import { afterResponse, auditIp, sendTwoFactorNotice } from '@/lib/account-flows';
import { reauthWithPassword, verifySecondFactor } from '@/lib/mfa';
import { accountId, checkPair, clearFailures, mfaPairKey, recordFailure, verdictResponse } from '@/lib/login-throttle';
import { authenticate, require2faForAdmins } from '@/lib/session';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/2fa/disable');

/** `{ password, code | recovery_code }`: turn 2FA off. Needs BOTH the password and a valid second factor. */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user || !auth.sessionId) return NextResponse.json({ ok: false, error: 'two-factor needs a personal account' }, { status: 400 });
  if (user.role === 'admin' && require2faForAdmins()) {
    return NextResponse.json({ ok: false, error: 'two-factor is required for administrators on this server' }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { password?: unknown; code?: unknown; recovery_code?: unknown };
    const denied = await reauthWithPassword(req, user.email, body.password);
    if (denied) return denied;
    const key = mfaPairKey(user.id, req);
    const gate = await checkPair(key);
    if (!gate.ok) return verdictResponse(gate);
    const result = await verifySecondFactor(user.id, body, { allowRecovery: true });
    if (!result.ok) {
      await recordFailure(key, accountId(user.id));
      return NextResponse.json({ ok: false, error: 'invalid code' }, { status: 400 });
    }
    await clearFailures(key);
    await disableTotp(user.id);
    const revoked = await revokeOtherSessions(user.id, auth.sessionId);
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.2fa_disabled', target: `user:${user.id}`,
      ip: auditIp(req), meta: { other_sessions_revoked: revoked, method: result.method },
    });
    await afterResponse('2fa.notice', () => sendTwoFactorNotice(user.email, false));
    return NextResponse.json({ ok: true, data: { enabled: false } });
  } catch (err) {
    log.error('error', { err });
    return NextResponse.json({ ok: false, error: 'service temporarily unavailable' }, { status: 503 });
  }
}
