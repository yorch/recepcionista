import { NextResponse } from 'next/server';
import { actorOf, authenticateTeam, getPendingInvite, supersedeInvites, teamError } from '@/lib/team';
import { auditIp, emailFailure, limitIp, sendInviteEmail } from '@/lib/account-flows';
import { createEmailToken, prisma, recordAudit } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('team/invite-resend');

/** Re-send a pending invitation: a fresh link (the old one stops working) and a fresh 7-day expiry. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateTeam(req, new URL(req.url).searchParams.get('business_id'), { verifiedEmail: true });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const limited = await limitIp(req, 'team/invite-resend', 30);
  if (limited) return limited;
  if (id.length > 64) return teamError(404, 'invitation not found');
  const invite = await getPendingInvite(auth.business.id, id);
  if (!invite) return teamError(404, 'invitation not found');
  if (!(await rateLimit(`team/invite-resend:${id}`, 3, 60 * 60_000, { failClosed: true })).allowed) return teamError(429, 'too many resends, try again later');
  try {
    const actor = actorOf(auth.principal);
    const { token, record } = await createEmailToken({
      purpose: 'invite', email: invite.email, business_id: auth.business.id, role: invite.role, invited_by: actor.actor_user_id, supersede: false,
    });
    try {
      await sendInviteEmail({
        email: invite.email, token, businessName: auth.business.name, role: invite.role,
        inviterEmail: 'user' in auth.principal ? auth.principal.user?.email : null,
        locale: auth.business.locale_default,
      });
    } catch (err) {
      await prisma.emailToken.updateMany({ where: { id: record.id }, data: { usedAt: new Date() } });
      const f = emailFailure(err);
      if (f) return teamError(f.status, f.error);
      throw err;
    }
    await supersedeInvites(auth.business.id, invite.email, record.id);
    await recordAudit({ ...actor, business_id: auth.business.id, action: 'user.invite_resent', target: `invite:${record.id}`, ip: auditIp(req), meta: { role: invite.role } });
    return NextResponse.json({ ok: true, data: { invite: await getPendingInvite(auth.business.id, record.id) } });
  } catch (err) {
    log.error('error', { err });
    return teamError(503, 'service temporarily unavailable');
  }
}
