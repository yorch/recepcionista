import { NextResponse } from 'next/server';
import { actorOf, authenticateTeam, revokeInvite, teamError } from '@/lib/team';
import { auditIp } from '@/lib/account-flows';
import { recordAudit } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Revoke a pending invitation of the caller's business (admins: `?business_id=`). Another business's invite id is a 404. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateTeam(req, new URL(req.url).searchParams.get('business_id'));
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (id.length > 64 || !(await revokeInvite(auth.business.id, id))) return teamError(404, 'invitation not found');
  await recordAudit({ ...actorOf(auth.principal), business_id: auth.business.id, action: 'user.invite_revoked', target: `invite:${id}`, ip: auditIp(req) });
  return NextResponse.json({ ok: true, data: { revoked: true } });
}
