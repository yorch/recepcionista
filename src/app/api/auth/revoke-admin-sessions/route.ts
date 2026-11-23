import { NextResponse } from 'next/server';
import { recordAudit, revokeAdminSessions } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { authenticate } from '@/lib/session';
import { SESSION_COOKIE } from '@/lib/auth';
import { clearSessionCookie } from '@/lib/auth-cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin only (Bearer ADMIN_TOKEN or an admin user): revoke EVERY break-glass admin session, including the
 * caller's own when it came from one. Use after rotating ADMIN_TOKEN or when a browser may be compromised.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin', allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const revoked = await revokeAdminSessions();
  const p = auth.principal;
  await recordAudit({
    actor_kind: p.kind === 'admin' && p.user ? 'user' : 'admin_token', actor_user_id: p.kind === 'admin' ? p.user?.id ?? null : null,
    action: 'auth.admin_sessions_revoked', target: 'admin_token', ip: auditIp(req), meta: { count: revoked },
  });
  const res = NextResponse.json({ ok: true, data: { revoked } });
  clearSessionCookie(res, SESSION_COOKIE);
  return res;
}
