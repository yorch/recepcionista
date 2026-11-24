import { NextResponse } from 'next/server';
import { actorOf, authenticateTeam, getPendingInvite, listPendingInvites, supersedeInvites, teamError } from '@/lib/team';
import { auditIp, emailFailure, limitIp, sendInviteEmail, allowPerEmail } from '@/lib/account-flows';
import { createEmailToken, getMembership, getUserByEmail, normalizeEmail, prisma, recordAudit } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { validatePublicEmail } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('team/invite');

/**
 * `{ email, role: "owner"|"staff", business_id? }`: invite someone (a new address or one that already has an account) to the caller's active business (admins: any, via
 * business_id). Needs a verified email on the inviter. The link is bound to this business and role and works once for 7 days.
 * Email provider problems are reported (503 email_not_configured) and leave no live invitation behind.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; role?: unknown; business_id?: unknown };
  const auth = await authenticateTeam(req, typeof body.business_id === 'string' ? body.business_id : null, { verifiedEmail: true });
  if (!auth.ok) return auth.response;
  const limited = await limitIp(req, 'team/invite', 30);
  if (limited) return limited;
  if ((await rateLimit(`team/invite:biz:${auth.business.id}`, 20, 60 * 60_000, { failClosed: true })).allowed === false) {
    return teamError(429, 'too many invitations, try again later');
  }

  const bad = validatePublicEmail(body.email);
  if (bad) return teamError(422, bad);
  if (body.role !== 'owner' && body.role !== 'staff') return teamError(422, 'role must be "owner" or "staff"');
  const email = normalizeEmail(body.email as string);
  if (!(await allowPerEmail('team/invite', email, 5))) return teamError(429, 'too many invitations to this address, try again later');

  try {
    // An address that already has an account may be invited into THIS business too (accepting adds a membership); only a current,
    // enabled member is refused. The token stays bound to this business + role + address.
    const existing = await getUserByEmail(email);
    const current = existing ? await getMembership(existing.id, auth.business.id) : null;
    if (current && !current.disabled_at) return teamError(409, 'this person is already on the team', 'already_member');

    const actor = actorOf(auth.principal);
    const { token, record } = await createEmailToken({
      purpose: 'invite', email, business_id: auth.business.id, role: body.role, invited_by: actor.actor_user_id, supersede: false,
      ...(existing && existing.role !== 'admin' ? { user_id: existing.id } : {}),
    });
    try {
      await sendInviteEmail({
        email, token, businessName: auth.business.name, role: body.role,
        inviterEmail: 'user' in auth.principal ? auth.principal.user?.email : null,
      });
    } catch (err) {
      await prisma.emailToken.updateMany({ where: { id: record.id }, data: { usedAt: new Date() } }); // no live link without a mail
      const f = emailFailure(err);
      if (f) return teamError(f.status, f.error);
      throw err;
    }
    await supersedeInvites(auth.business.id, email, record.id);
    await recordAudit({
      ...actor, business_id: auth.business.id, action: 'user.invite', target: `invite:${record.id}`, ip: auditIp(req),
      meta: { role: body.role, email_domain: email.split('@')[1] },
    });
    const invite = await getPendingInvite(auth.business.id, record.id);
    return NextResponse.json({ ok: true, data: { invite: invite ?? (await listPendingInvites(auth.business.id))[0] ?? null } }, { status: 201 });
  } catch (err) {
    log.error('error', { err });
    return teamError(503, 'service temporarily unavailable');
  }
}
