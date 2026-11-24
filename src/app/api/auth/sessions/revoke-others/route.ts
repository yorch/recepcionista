import { NextResponse } from 'next/server';
import { recordAudit, revokeOtherSessions } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { authenticate } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** "Sign out other devices": every session of the caller except the one making the request. */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user || !auth.sessionId) return NextResponse.json({ ok: false, error: 'no personal sessions on this credential' }, { status: 400 });
  const revoked = await revokeOtherSessions(user.id, auth.sessionId);
  await recordAudit({
    actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.sessions_revoked_others', target: `user:${user.id}`,
    ip: auditIp(req), meta: { count: revoked },
  });
  return NextResponse.json({ ok: true, data: { revoked } });
}
