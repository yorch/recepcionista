import { ok, fail } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { deletePlan, getPlan, setPlanArchived, updatePlan } from '@/lib/admin/plans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ key: string }> };

/** Permission: plans.read. */
export async function GET(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'plans.read', rate: { name: 'plans', max: 60 } });
  if (!g.ok) return g.response;
  try { const p = await getPlan((await params).key); return p ? ok(p) : fail('plan not found', 404); } catch (err) { return adminFail(err); }
}

/** PATCH { reason, ...fields, archived?: boolean }. `archived` archives / restores the plan (businesses on it keep working). Permission: plans.write. */
export async function PATCH(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'plans.write', write: true, frozenBlocks: true, rate: { name: 'plans-write', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const key = (await params).key;
    const { reason, archived, ...patch } = await readBody(req);
    const r = typeof reason === 'string' ? reason : '';
    if (archived !== undefined) {
      if (typeof archived !== 'boolean') return fail('archived must be true or false', 422);
      const p = await setPlanArchived(key, archived, { actor: g.ctx.actor, reason: r });
      return ok(Object.keys(patch).length ? await updatePlan(key, patch, { actor: g.ctx.actor, reason: r }) : p);
    }
    return ok(await updatePlan(key, patch, { actor: g.ctx.actor, reason: r }));
  } catch (err) { return adminFail(err); }
}

/** DELETE { reason }: only a plan nobody uses and never `standard` (archive instead). Permission: plans.write. */
export async function DELETE(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: 'plans.write', write: true, frozenBlocks: true, rate: { name: 'plans-write', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    await deletePlan((await params).key, { actor: g.ctx.actor, reason: typeof body.reason === 'string' ? body.reason : '' });
    return ok({ deleted: true });
  } catch (err) { return adminFail(err); }
}
