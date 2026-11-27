import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { createPlan, listPlans } from '@/lib/admin/plans';
import { PLAN_FEATURES } from '@/lib/admin/plan-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET ?archived=1: the plans (caps, features, Stripe price ids, how many businesses use each) and the known feature names. Permission: plans.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'plans.read', rate: { name: 'plans', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok({ plans: await listPlans({ includeArchived: new URL(req.url).searchParams.get('archived') === '1' }), features: PLAN_FEATURES }); } catch (err) { return adminFail(err); }
}

/** POST { key, name, reason, public?, is_comped?, trial_days?, sms_cap?, call_minutes_cap?, voicemail_minutes_cap?, forward_minutes_cap?, max_locations?, features?, stripe_price_id?, stripe_price_id_annual?, sort? }. Permission: plans.write. */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'plans.write', write: true, frozenBlocks: true, rate: { name: 'plans-write', max: 20 } });
  if (!g.ok) return g.response;
  try {
    const { reason, ...plan } = await readBody(req);
    return ok(await createPlan(plan, { actor: g.ctx.actor, reason: typeof reason === 'string' ? reason : '' }), 201);
  } catch (err) { return adminFail(err); }
}
