import { NextResponse } from 'next/server';
import { checkSameOrigin, SESSION_COOKIE, USER_SESSION_COOKIE } from '@/lib/auth';
import { auditIp, limitIp, userAgentOf } from '@/lib/account-flows';
import { clearSessionCookie, setSessionCookie } from '@/lib/auth-cookies';
import {
  consumeEmailToken, createSession, createUser, EmailTakenError, getBusiness, getUserByEmail, peekEmailToken, recordAudit, SESSION_TTL_MS,
} from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { validateStrongPassword } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/accept-invite');
const fail = (status: number, error: string, code?: string) => NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
const BAD_LINK = 'this invitation is invalid or has expired';
const ACCOUNT_EXISTS = 'this email already has an account (an account belongs to one business). Sign in instead, or ask for an invitation to a different address.';

/**
 * `{ token, password }`: accept an invitation. The token is bound to one business and role (set by whoever
 * invited), single use, 7 days. Creates the user with the email already verified (the link proved the mailbox)
 * and signs them in. If the address already has an account the call fails with 409 `account_exists` WITHOUT
 * using up the invitation.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/accept-invite', 10, 15 * 60_000);
  if (limited) return limited;
  try {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const peek = await peekEmailToken('invite', token);
    if (!peek || !peek.business_id || !peek.role) return fail(400, BAD_LINK);
    const pwErr = validateStrongPassword(body.password, peek.email);
    if (pwErr) return fail(422, pwErr);
    if (await getUserByEmail(peek.email)) return fail(409, ACCOUNT_EXISTS, 'account_exists');
    if (!(await getBusiness(peek.business_id))) return fail(400, BAD_LINK);

    const rec = await consumeEmailToken('invite', token);
    if (!rec || !rec.business_id || !rec.role) return fail(400, BAD_LINK);
    let user;
    try {
      user = await createUser({
        email: rec.email, password_hash: await hashPassword(body.password as string), role: rec.role, business_id: rec.business_id, email_verified: true,
      });
    } catch (err) {
      if (err instanceof EmailTakenError) return fail(409, ACCOUNT_EXISTS, 'account_exists');
      throw err;
    }
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'user.invite_accepted', target: `user:${user.id}`,
      ip: auditIp(req), meta: { role: rec.role, invited_by: rec.invited_by },
    });
    const { token: sessionToken } = await createSession(user.id, { ip: auditIp(req), userAgent: userAgentOf(req) });
    const res = NextResponse.json({ ok: true, data: { accepted: true, role: user.role, business_id: user.business_id } });
    setSessionCookie(res, USER_SESSION_COOKIE, sessionToken, Math.floor(SESSION_TTL_MS / 1000));
    clearSessionCookie(res, SESSION_COOKIE);
    return res;
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
