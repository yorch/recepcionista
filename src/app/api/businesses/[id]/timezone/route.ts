import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, prisma, recordAudit, setBusinessTimeZone } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { inferTimeZoneFromPhone } from '@/lib/tz-infer';
import { syncPromptAfterEdit, type PromptSyncOutcome } from '@/lib/voice/agent-resync';
import { DEFAULT_TIMEZONE, tzOf } from '@/lib/time';
import type { Business } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface TimeZoneView {
  timezone: string;
  /** A hint from the owner's phone area code (null when unknown or ambiguous): it is never applied without the owner saving it. */
  suggested: string | null;
  now: string;
  /** The owner (or an admin) already chose this zone (it differs from the default, or a change was audited): the onboarding suggestion must never override it. */
  chosen: boolean;
}

const view = (b: Business, chosen: boolean): TimeZoneView => ({
  timezone: tzOf(b),
  chosen,
  suggested: inferTimeZoneFromPhone(b.owner_phone_e164 ?? b.owner_phone ?? null),
  now: new Date().toISOString(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const b = await getBusiness(id);
    if (!b) return fail('business not found', 404);
    const chosen = tzOf(b) !== DEFAULT_TIMEZONE || (await prisma.auditEvent.count({ where: { businessId: id, action: 'business.timezone_changed' } })) > 0;
    return ok<TimeZoneView>(view(b, chosen));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * PUT { timezone: "America/Chicago" }: the business time zone (IANA names only; "EST", "+01:00" and "GMT+2" are refused). Owner only, same-origin,
 * rate limited, audited. Bookings are absolute instants and do not move; opening hours and holiday closures are wall-clock times in the NEW
 * zone from now on, so the answer says `hours_recheck`. The live agent is told (its prompt names the zone and the hours): a failed push is queued.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const limited = await limitRequest(req, 'businesses/timezone', 20, 60_000);
    if (limited) return limited;
    const body = await readJson<{ timezone?: unknown }>(req);
    if (!body || typeof body !== 'object' || !('timezone' in body)) return fail('timezone is required', 422);
    const before = await getBusiness(id);
    if (!before) return fail('business not found', 404);
    const res = await setBusinessTimeZone(id, body.timezone);
    if (!res.ok) return fail(res.reason === 'not_found' ? 'business not found' : (res.error ?? 'invalid time zone'), res.reason === 'not_found' ? 404 : 422);
    const changed = res.timezone !== before.timezone;
    if (changed) {
      const actor = auditActorOf(auth.principal);
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.timezone_changed', target: `business:${id}`, ip: clientKey(req),
        meta: { ...actor.meta, from: before.timezone, to: res.timezone },
      });
    }
    const agentSync: PromptSyncOutcome | null = changed ? await syncPromptAfterEdit(id) : null;
    const after = await getBusiness(id);
    return ok<TimeZoneView & { changed: boolean; hours_recheck: boolean; agent_sync?: PromptSyncOutcome }>({
      ...view(after ?? before, true), changed, hours_recheck: changed, ...(agentSync ? { agent_sync: agentSync } : {}),
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
