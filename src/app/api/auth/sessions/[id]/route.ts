import { NextResponse } from 'next/server';
import { recordAudit, revokeSession } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { authenticate } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Sign out one of the caller's own sessions ("this device"). Another user's session id is a 404. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user) return NextResponse.json({ ok: false, error: 'no personal sessions on this credential' }, { status: 400 });
  const { id } = await ctx.params;
  const removed = id.length <= 64 && (await revokeSession(id, user.id));
  if (!removed) return NextResponse.json({ ok: false, error: 'session not found' }, { status: 404 });
  await recordAudit({
    actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.session_revoked', target: `session:${id}`, ip: auditIp(req),
  });
  return NextResponse.json({ ok: true, data: { revoked: true, current: id === auth.sessionId } });
}
