import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, getSchedulingConfig, recordAudit, setSchedulingConfig } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import type { SchedulingConfig } from '@/lib/business-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const cfg = await getSchedulingConfig(id);
    if (!cfg) return fail('business not found', 404);
    return ok<SchedulingConfig>(cfg);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * PUT any subset of { slot_minutes (15|30|60), min_lead_minutes (0..10080), horizon_days (1..180), buffer_minutes (0..240), crews (1..20) }.
 * Owner only, same-origin, rate limited, audited (before / after). Unknown or invalid fields are a 422 (nothing is written); lowering `crews`
 * below a crew that still has an upcoming booking is a 409 `crew_in_use` (move those bookings first). Availability, the voice tools and booking
 * validation read these values on the next request.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const limited = await limitRequest(req, 'businesses/scheduling', 30, 60_000);
    if (limited) return limited;
    const body = await readJson<unknown>(req);
    const before = await getSchedulingConfig(id);
    if (!before || !(await getBusiness(id))) return fail('business not found', 404);
    const res = await setSchedulingConfig(id, body);
    if (!res.ok) {
      if (res.reason === 'not_found') return fail('business not found', 404);
      if (res.reason === 'crew_in_use') return Response.json({ ok: false, error: res.error ?? 'crew in use', code: 'crew_in_use' }, { status: 409 });
      return fail(res.error ?? 'invalid scheduling settings', 422);
    }
    const changed = (Object.keys(res.config) as (keyof SchedulingConfig)[]).filter((k) => res.config[k] !== before[k]);
    if (changed.length > 0) {
      const actor = auditActorOf(auth.principal);
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.scheduling_changed', target: `business:${id}`, ip: clientKey(req),
        meta: { ...actor.meta, changed, before, after: res.config },
      });
    }
    return ok<SchedulingConfig>(res.config);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
