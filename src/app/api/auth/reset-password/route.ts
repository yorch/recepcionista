import { NextResponse } from 'next/server';
import { checkSameOrigin } from '@/lib/auth';
import { afterResponse, auditIp, limitIp, sendPasswordChangedNotice, sendTwoFactorNotice } from '@/lib/account-flows';
import {
  changePassword, consumeEmailToken, disableTotp, getTotpState, getUserById, invalidateUserEmailTokens, markEmailVerified, peekEmailToken, recordAudit,
} from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { validateStrongPassword } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/reset-password');
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });
const BAD_LINK = 'this link is invalid or has expired';

/**
 * `{ token, password }`: set a new password with a single-use, one-hour link. Every session of the user is
 * revoked (changePassword), other outstanding reset links die, and the owner of the mailbox is notified.
 * The password is validated BEFORE the token is consumed, so a typo does not burn the link.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/reset-password', 10, 15 * 60_000);
  if (limited) return limited;
  try {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const peek = await peekEmailToken('reset', token);
    if (!peek || !peek.user_id) return fail(400, BAD_LINK);
    const pwErr = validateStrongPassword(body.password, peek.email);
    if (pwErr) return fail(422, pwErr);

    const rec = await consumeEmailToken('reset', token);
    if (!rec || !rec.user_id) return fail(400, BAD_LINK);
    const user = await getUserById(rec.user_id);
    if (!user || user.email !== rec.email || user.disabled_at) return fail(400, BAD_LINK);

    // M4: 2FA planted before the mailbox was ever proven (pre-account squatting) must not outlive the real owner's reset.
    // 2FA enrolled while the address was unverified, or enrolled BEFORE it was verified, is not trusted: the reset (which
    // proves the mailbox) clears it. 2FA enrolled after verification is kept: the reset link alone must not remove it.
    const totp = await getTotpState(user.id);
    const untrustedTotp = Boolean(totp?.enabled_at) && (!user.email_verified_at || Date.parse(user.email_verified_at) > Date.parse(totp!.enabled_at as string));

    await changePassword(user.id, await hashPassword(body.password as string));
    await invalidateUserEmailTokens(user.id, 'reset');
    await markEmailVerified(user.id); // proving the mailbox is what verification means
    if (untrustedTotp) {
      await disableTotp(user.id);
      await recordAudit({
        actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.2fa_cleared_on_reset', target: `user:${user.id}`, ip: auditIp(req),
        meta: { reason: 'enrolled_before_email_verified' },
      });
      await afterResponse('reset.2fa_notice', () => sendTwoFactorNotice(user.email, false, user.locale));
    }
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.password_reset', target: `user:${user.id}`, ip: auditIp(req),
    });
    await afterResponse('reset.notice', () => sendPasswordChangedNotice(user.email, user.locale));
    return NextResponse.json({ ok: true, data: { reset: true } });
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
