import { ok, fail } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { MAX_REASON, MIN_REASON, SettingsError } from '@/lib/admin/settings-store';
import { emailFingerprint } from '@/lib/billing/trial';
import { activeSupportGrant } from '@/lib/admin/support';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACTIONS = ['clear_owner_phone_verification', 'clear_trial_fingerprint'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * POST { action, reason }: support clean-ups of one tenant, each audited with the reason.
 *  - clear_owner_phone_verification: the owner phone becomes UNVERIFIED (the owner must verify it again before owner alerts / the owner line work).
 *  - clear_trial_fingerprint: forgets this business's trial fingerprints (card + owner e-mails) so its owner may start a trial again (a support decision, e.g. a mistaken block).
 * Permission: tenants.billing (owner, ops); step-up.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guardAdminRoute(req, { permission: 'tenants.billing', write: true, rate: { name: 'tenant-actions', max: 20 }, business_id: id });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    const action = b.action as Action;
    if (!ACTIONS.includes(action)) return fail(`action must be one of ${ACTIONS.join(', ')}`, 422);
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required`);
    const biz = await prisma.business.findUnique({ where: { id }, select: { id: true } });
    if (!biz) return fail('business not found', 404);
    const user = g.ctx.principal.user;
    let changed = 0;
    if (action === 'clear_owner_phone_verification') {
      changed = (await prisma.business.updateMany({ where: { id, ownerPhoneVerifiedAt: { not: null } }, data: { ownerPhoneVerifiedAt: null } })).count;
    } else {
      const owners = await prisma.user.findMany({ where: { OR: [{ businessId: id }, { memberships: { some: { businessId: id, role: 'owner' } } }] }, select: { email: true } });
      const fps = owners.map((o) => emailFingerprint(o.email));
      changed = (await prisma.trialFingerprint.deleteMany({ where: { businessId: id, OR: [{ kind: 'card' }, ...(fps.length ? [{ kind: 'email', fingerprint: { in: fps } }] : [])] } })).count;
    }
    const grant = user ? await activeSupportGrant(user.id, id) : null;
    await prisma.auditEvent.create({
      data: auditRowData({
        actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, business_id: id, action: `tenant.${action}`, target: `business:${id}`, ip: g.ctx.ip,
        meta: { reason, changed, role: g.ctx.role, support_grant_id: grant?.id ?? null }, meta_trusted: true,
      }),
    });
    return ok({ action, changed });
  } catch (err) { return adminFail(err); }
}
