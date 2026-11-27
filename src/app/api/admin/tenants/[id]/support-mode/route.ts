import { ok, fail } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { enterSupportWrite, exitSupportWrite } from '@/lib/admin/support';
import { SUPPORT_WRITE_MS, SUPPORT_WRITE_SCOPE } from '@/lib/admin/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { reason }: enter WRITE mode for this tenant: 30 minutes, reason required, step-up, audited (enter, exit and every write with the business id). Without it the
 * support view is read-only. Needs a personal admin account (not the break-glass token). Permission: tenants.support_enter.
 */
export async function POST(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'tenants.support_enter', write: true, rate: { name: 'support-mode', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const user = g.ctx.principal.user;
    if (!user) return fail('support mode needs a personal admin account', 403);
    const b = await readBody(req);
    const grant = await enterSupportWrite({ user_id: user.id, business_id: (await params).id, reason: b.reason, ip: g.ctx.ip, role: g.ctx.role });
    return ok({ grant, minutes: SUPPORT_WRITE_MS / 60_000, scope: [...SUPPORT_WRITE_SCOPE] }, 201);
  } catch (err) { return adminFail(err); }
}

/** DELETE: leave write mode now. Permission: tenants.support_enter. */
export async function DELETE(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'tenants.support_enter', write: true, rate: { name: 'support-mode', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const user = g.ctx.principal.user;
    if (!user) return fail('support mode needs a personal admin account', 403);
    return ok(await exitSupportWrite({ user_id: user.id, business_id: (await params).id, ip: g.ctx.ip }));
  } catch (err) { return adminFail(err); }
}
