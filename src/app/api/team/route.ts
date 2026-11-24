import { NextResponse } from 'next/server';
import { authenticateTeam, listPendingInvites, listTeamUsers } from '@/lib/team';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Owner (own business) or admin (`?business_id=`): members and pending invitations. Staff: 403. */
export async function GET(req: Request) {
  const businessId = new URL(req.url).searchParams.get('business_id');
  const auth = await authenticateTeam(req, businessId);
  if (!auth.ok) return auth.response;
  const [users, invites] = await Promise.all([listTeamUsers(auth.business.id), listPendingInvites(auth.business.id)]);
  return NextResponse.json({ ok: true, data: { business: { id: auth.business.id, name: auth.business.name }, users, invites } });
}
