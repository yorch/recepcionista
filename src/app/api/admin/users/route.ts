import { NextResponse } from 'next/server';
import { ok, fail, readJson } from '@/lib/http';
import { adminFail, guardAdminRoute } from '@/lib/admin/guard';
import { createUser, EmailTakenError, getBusiness, recordAudit } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { hashPassword } from '@/lib/password';
import { validateEmail, validateNewPassword } from '@/lib/user-policy';
import type { User } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin-only: create an owner or staff login for a business. (Admin accounts are created with scripts/create-user.ts.) */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'tenants.users.create', write: true, rate: { name: 'users', max: 20 } }); // permission tenants.users.create
  if (!g.ok) return g.response;
  const auth = g.ctx.auth;
  // An admin-chosen password has no time box and no owner confirmation: only an owner admin (or the break-glass token / dev mode) may set one. Everyone else invites the person (POST /api/team/invite: a link, the person chooses the password).
  if (g.ctx.role !== 'owner' && g.ctx.role !== 'bearer') return NextResponse.json({ ok: false as const, error: 'only an owner administrator may create a login with a chosen password; invite the person instead (team invitation)', code: 'owner_required' }, { status: 403 });
  try {
    const body = await readJson<{ email?: unknown; password?: unknown; role?: unknown; business_id?: unknown }>(req);
    const bad = validateEmail(body.email) ?? validateNewPassword(body.password);
    if (bad) return fail(bad, 422);
    if (body.role !== 'owner' && body.role !== 'staff') return fail('role must be "owner" or "staff"', 422);
    if (typeof body.business_id !== 'string' || !body.business_id) return fail('business_id is required', 422);
    if (!(await getBusiness(body.business_id))) return fail('business not found', 404);

    const user = await createUser({
      email: body.email as string,
      password_hash: await hashPassword(body.password as string),
      role: body.role,
      business_id: body.business_id,
      email_verified: true, // the admin vouches for the address; the person can still change nothing without the password
    });
    await recordAudit({
      actor_kind: auth.principal.kind === 'admin' && auth.principal.user ? 'user' : 'admin_token',
      actor_user_id: auth.principal.kind === 'admin' ? auth.principal.user?.id ?? null : null,
      business_id: body.business_id, action: 'user.create', target: `user:${user.id}`, ip: auditIp(req), meta: { role: body.role, login_set_by_admin: true, admin_role: g.ctx.role, via: g.ctx.actor.via },
    });
    return ok<User>(user, 201); // User has no password_hash
  } catch (err) {
    if (err instanceof EmailTakenError) return fail('email already registered', 409);
    return adminFail(err);
  }
}
