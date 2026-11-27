import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { auditIp } from '@/lib/account-flows';
import { listTenantKnobs, removeTenantOverride, setTenantOverride, type OverrideActor } from '@/lib/admin/tenant-overrides';
import { SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const errorResponse = (err: unknown) => {
  if (err instanceof SettingsError) return Response.json({ ok: false, error: err.message, code: err.code, ...(err.problems.length ? { problems: err.problems } : {}) }, { status: err.status });
  return authErrorResponse(err) ?? fail(err, 500);
};

/**
 * The OWNER's comfort knobs for their own business (D12): quiet hours (only stricter than the platform window), briefing on/off and hour, thank-you texts on/off, ring seconds
 * within bounds. Each entry shows the platform value, the owner's override, the effective value and the bounds. Caps, budgets and features are platform-only and never
 * listed here. Owner role, own business only (404 otherwise).
 */
export async function GET(req: Request, { params }: Ctx) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    return ok(await listTenantKnobs(id, 'owner'));
  } catch (err) { return errorResponse(err); }
}

const actorOf = (auth: Extract<Awaited<ReturnType<typeof authenticate>>, { ok: true }>, req: Request): OverrideActor => ({
  kind: 'user',
  user_id: auth.principal.kind === 'user' ? auth.principal.user.id : null, ip: auditIp(req), scope: 'owner',
});

/**
 * PUT { key, value }: set the owner's override of one comfort knob. 403 `platform_only` for any key the registry does not give to owners; 422 `out_of_bounds` /
 * `not_stricter` outside the allowed range. Step-up (recent password), rate limited, audited as `settings.tenant_override` with the business id.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  if (auth.principal.kind === 'admin') return fail('administrators change tenant settings through /api/admin/tenant-overrides (role and support-mode rules apply there)', 403);
  const limited = await limitRequest(req, 'business/settings-overrides', 30);
  if (limited) return limited;
  const stale = requireRecentAuth(auth);
  if (stale) return stale;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ key?: unknown; value?: unknown }>(req);
    if (typeof body?.key !== 'string') return fail('key is required', 422);
    return ok(await setTenantOverride({ business_id: id, key: body.key, value: body.value, actor: actorOf(auth, req) }));
  } catch (err) { return errorResponse(err); }
}

/** DELETE { key }: back to the platform value. Same rules as PUT. */
export async function DELETE(req: Request, { params }: Ctx) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  if (auth.principal.kind === 'admin') return fail('administrators change tenant settings through /api/admin/tenant-overrides (role and support-mode rules apply there)', 403);
  const limited = await limitRequest(req, 'business/settings-overrides', 30);
  if (limited) return limited;
  const stale = requireRecentAuth(auth);
  if (stale) return stale;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ key?: unknown }>(req).catch(() => ({} as { key?: unknown }));
    const key = body.key ?? new URL(req.url).searchParams.get('key');
    if (typeof key !== 'string') return fail('key is required', 422);
    return ok(await removeTenantOverride({ business_id: id, key, actor: actorOf(auth, req) }));
  } catch (err) { return errorResponse(err); }
}
