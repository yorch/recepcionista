import { NextResponse } from 'next/server';
import { actorOf, authenticateTeam, getTeamUser, teamError } from '@/lib/team';
import { auditIp } from '@/lib/account-flows';
import { deleteUserSessions, prisma, recordAudit } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Sign a team member out everywhere (owner of that business, or admin). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = id.length <= 64 ? await prisma.user.findUnique({ where: { id }, select: { businessId: true } }) : null;
  const auth = await authenticateTeam(req, new URL(req.url).searchParams.get('business_id') ?? row?.businessId ?? null);
  if (!auth.ok) return auth.response;
  const target = id.length <= 64 ? await getTeamUser(auth.business.id, id) : null;
  if (!target) return teamError(404, 'user not found');
  const revoked = await deleteUserSessions(target.id);
  await recordAudit({
    ...actorOf(auth.principal), business_id: auth.business.id, action: 'user.sessions_revoked', target: `user:${target.id}`, ip: auditIp(req), meta: { count: revoked },
  });
  return NextResponse.json({ ok: true, data: { revoked } });
}
