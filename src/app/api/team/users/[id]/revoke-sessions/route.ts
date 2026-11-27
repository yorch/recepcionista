import { NextResponse } from 'next/server';
import { actorOf, authenticateTeam, businessIdsOfUser, getTeamUser, revokeTeamUserSessions, teamError } from '@/lib/team';
import { auditIp } from '@/lib/account-flows';
import { recordAudit } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Sign a team member out of THIS business (the sessions working in it; owner of that business). Only the break-glass credentials (Bearer ADMIN_TOKEN and its cookie session, audited and mailed) sign the account out
 * everywhere; an admin USER is scoped to the business the grant covers (authenticateTeam requires an open support write grant for exactly it), like an owner.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let requested = new URL(req.url).searchParams.get('business_id');
  if (!requested) {
    const ids = id.length <= 64 ? await businessIdsOfUser(id) : [];
    if (ids.length === 0) return teamError(404, 'user not found');
    if (ids.length === 1) requested = ids[0]; // admins naming no business; owners are pinned to the active one either way
  }
  const auth = await authenticateTeam(req, requested);
  if (!auth.ok) return auth.response;
  const target = id.length <= 64 ? await getTeamUser(auth.business.id, id) : null;
  if (!target) return teamError(404, 'user not found');
  // An owner or an admin USER (with a grant for this business) signs the person out of THIS business only; the break-glass token signs the account out everywhere.
  const everywhere = auth.principal.kind === 'admin' && auth.principal.via !== 'user';
  const revoked = await revokeTeamUserSessions(auth.business.id, target.id, { everywhere });
  await recordAudit({
    ...actorOf(auth.principal), business_id: auth.business.id, action: 'user.sessions_revoked', target: `user:${target.id}`, ip: auditIp(req), meta: { count: revoked },
  });
  return NextResponse.json({ ok: true, data: { revoked } });
}
