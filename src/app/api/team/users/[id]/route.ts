import { NextResponse } from 'next/server';
import {
  actorOf, authenticateTeam, businessIdsOfUser, changeTeamRole, getTeamUser, removeTeamUser, setTeamUserDisabled, teamError, type TeamChange,
} from '@/lib/team';
import { auditIp } from '@/lib/account-flows';
import { recordAudit } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LAST_OWNER = 'a business must keep at least one active owner';

/**
 * Resolve the target member. Owners are pinned to the session's active business by authenticateTeam (a member of another business is a
 * 404, even one the owner also manages: switch first). Admins name the business (`?business_id=`); without it the user's only
 * membership is used, and a user in several businesses needs the parameter (422).
 */
async function resolveTarget(req: Request, userId: string) {
  const url = new URL(req.url);
  let requested = url.searchParams.get('business_id');
  if (!requested) {
    const ids = userId.length <= 64 ? await businessIdsOfUser(userId) : [];
    if (ids.length === 0) return { ok: false as const, response: teamError(404, 'user not found') }; // admin accounts and strangers are not team members
    if (ids.length === 1) requested = ids[0]; // owners are pinned by authenticateTeam either way
  }
  const auth = await authenticateTeam(req, requested);
  if (!auth.ok) return auth;
  const target = userId.length <= 64 ? await getTeamUser(auth.business.id, userId) : null;
  if (!target) return { ok: false as const, response: teamError(404, 'user not found') };
  return { ok: true as const, auth, target };
}

function outcome(r: TeamChange<unknown>) {
  if (r.ok) return null;
  return r.reason === 'last_owner' ? teamError(409, LAST_OWNER, 'last_owner') : teamError(404, 'user not found');
}

/**
 * `{ role?: "owner"|"staff", disabled?: boolean }`. Owner/admin only. The last active owner cannot be demoted or
 * disabled. You cannot disable yourself here. Disabling or changing the role signs the user out everywhere (their own session survives when they change their own role).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { role?: unknown; disabled?: unknown };
  const t = await resolveTarget(req, id);
  if (!t.ok) return t.response;
  const { auth, target } = t;
  const self = 'user' in auth.principal && auth.principal.user?.id === target.id;
  const actor = actorOf(auth.principal);
  if (body.role === undefined && body.disabled === undefined) return teamError(422, 'nothing to change');
  if (body.role !== undefined && body.role !== 'owner' && body.role !== 'staff') return teamError(422, 'role must be "owner" or "staff"');
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean') return teamError(422, 'disabled must be a boolean');
  if (self && body.disabled === true) return teamError(400, 'you cannot disable your own account');

  if (body.role !== undefined && body.role !== target.role) {
    const r = await changeTeamRole(auth.business.id, target.id, body.role, { keepSessionId: self && auth.sessionId ? auth.sessionId : undefined });
    const bad = outcome(r);
    if (bad) return bad;
    await recordAudit({ ...actor, business_id: auth.business.id, action: 'user.role_changed', target: `user:${target.id}`, ip: auditIp(req), meta: { from: target.role, to: body.role } });
  }
  if (typeof body.disabled === 'boolean' && body.disabled !== Boolean(target.disabled_at)) {
    const r = await setTeamUserDisabled(auth.business.id, target.id, body.disabled);
    const bad = outcome(r);
    if (bad) return bad;
    await recordAudit({ ...actor, business_id: auth.business.id, action: body.disabled ? 'user.disabled' : 'user.enabled', target: `user:${target.id}`, ip: auditIp(req) });
  }
  return NextResponse.json({ ok: true, data: { user: await getTeamUser(auth.business.id, target.id) } });
}

/** Remove a person from THIS business (their account and other businesses stay; an account with no business left is deleted). Not yourself, not the last owner. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = await resolveTarget(req, id);
  if (!t.ok) return t.response;
  const { auth, target } = t;
  if ('user' in auth.principal && auth.principal.user?.id === target.id) return teamError(400, 'you cannot remove your own account');
  const bad = outcome(await removeTeamUser(auth.business.id, target.id));
  if (bad) return bad;
  await recordAudit({
    ...actorOf(auth.principal), business_id: auth.business.id, action: 'user.removed', target: `user:${target.id}`, ip: auditIp(req), meta: { role: target.role },
  });
  return NextResponse.json({ ok: true, data: { removed: true } });
}
