import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { listTenantKnobs, removeTenantOverride, setTenantOverride } from '@/lib/admin/tenant-overrides';
import { SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET ?business_id=: every overridable key of a tenant with platform value, override, effective value, bounds and who may edit it. Permission: tenants.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'tenants.read', rate: { name: 'tenant-overrides', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const id = new URL(req.url).searchParams.get('business_id');
    if (!id) throw new SettingsError(422, 'invalid_body', 'business_id is required');
    return ok(await listTenantKnobs(id, 'platform'));
  } catch (err) { return adminFail(err); }
}

const overrideActor = (g: Extract<Awaited<ReturnType<typeof guardAdminRoute>>, { ok: true }>) => ({
  kind: g.ctx.actor.kind as 'user' | 'admin_token', user_id: g.ctx.actor.user_id, ip: g.ctx.ip, scope: 'platform' as const, role: g.ctx.role, support_grant_id: g.ctx.grant?.id ?? null,
});

/**
 * PUT { business_id, key, value, reason? } sets a tenant override of a `platform+tenant` key (caps, budgets, comfort knobs). Out of the platform bounds is 422
 * `out_of_bounds`; quiet hours must stay stricter than the platform window. A support user needs an open write grant FOR THAT TENANT (POST /tenants/{id}/support-mode).
 * Permission: tenants.overrides.write (owner, ops) or tenants.overrides.write inside a support grant.
 */
export async function PUT(req: Request) {
  const peek = await req.clone().json().catch(() => ({} as Record<string, unknown>));
  const g = await guardAdminRoute(req, { permission: 'tenants.overrides.write', write: true, frozenBlocks: true, business_id: typeof peek?.business_id === 'string' ? peek.business_id : undefined, rate: { name: 'tenant-overrides-write', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    if (typeof b.business_id !== 'string' || typeof b.key !== 'string') throw new SettingsError(422, 'invalid_body', 'business_id and key are required');
    return ok(await setTenantOverride({ business_id: b.business_id, key: b.key, value: b.value, reason: typeof b.reason === 'string' ? b.reason : undefined, actor: overrideActor(g) }));
  } catch (err) { return adminFail(err); }
}

/** DELETE { business_id, key, reason? }: back to the platform value. Same permission and grant rules as PUT. */
export async function DELETE(req: Request) {
  const peek = await req.clone().json().catch(() => ({} as Record<string, unknown>));
  const g = await guardAdminRoute(req, { permission: 'tenants.overrides.write', write: true, frozenBlocks: true, business_id: typeof peek?.business_id === 'string' ? peek.business_id : undefined, rate: { name: 'tenant-overrides-write', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const b = await readBody(req);
    if (typeof b.business_id !== 'string' || typeof b.key !== 'string') throw new SettingsError(422, 'invalid_body', 'business_id and key are required');
    return ok(await removeTenantOverride({ business_id: b.business_id, key: b.key, reason: typeof b.reason === 'string' ? b.reason : undefined, actor: overrideActor(g) }));
  } catch (err) { return adminFail(err); }
}
