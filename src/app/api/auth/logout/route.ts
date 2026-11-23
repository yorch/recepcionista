import { NextResponse } from 'next/server';
import { adminSessionTokenFrom, checkSameOrigin, userSessionTokenFrom } from '@/lib/auth';
import { auditIp } from '@/lib/account-flows';
import { clearAllSessionCookies } from '@/lib/auth-cookies';
import { deleteSession, recordAudit, resolveSessionByToken } from '@/lib/db';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/logout');

/**
 * Deletes the server-side session(s) (so a copied cookie is dead too) and clears both cookies.
 * Also the one API an MFA-pending session may call (it is how a half-logged-in user backs out).
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) {
    return NextResponse.json({ ok: false, error: 'cross-site request refused' }, { status: 403 });
  }
  for (const token of [userSessionTokenFrom(req.headers), adminSessionTokenFrom(req.headers)]) {
    if (!token) continue;
    try {
      const found = await resolveSessionByToken(token);
      await deleteSession(token);
      if (found && !(found.kind === 'user' && found.user.totp_enabled && !found.session.mfa_verified_at)) {
        await recordAudit({
          actor_kind: found.kind === 'user' ? 'user' : 'admin_token',
          actor_user_id: found.user?.id ?? null,
          business_id: found.user?.business_id ?? null,
          action: 'auth.logout',
          target: `session:${found.session.id}`,
          ip: auditIp(req),
        });
      }
    } catch (err) {
      log.error('delete_failed', { err });
    }
  }
  const res = NextResponse.json({ ok: true, data: { authenticated: false } });
  clearAllSessionCookies(res);
  return res;
}
