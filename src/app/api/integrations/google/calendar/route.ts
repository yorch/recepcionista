import { recordAudit } from '@/lib/db';
import { getCalendarConnection } from '@/lib/db/calendar';
import { fail, ok, readJson } from '@/lib/http';
import { listCalendars } from '@/lib/integrations/google/api';
import { changeCalendar } from '@/lib/integrations/google/oauth';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { setBlockOnBusy } from '@/lib/integrations/google/settings';
import { GoogleApiError } from '@/lib/integrations/google/http';
import { NeedsReauthError } from '@/lib/integrations/google/tokens';
import { syncConnection } from '@/lib/integrations/google/sync';
import { ensureWatch } from '@/lib/integrations/google/watch';
import { reconcileConnection } from '@/lib/integrations/google/push';

export const dynamic = 'force-dynamic';

/** PATCH /api/integrations/google/calendar  { calendar_id?: string, block_on_busy?: boolean }   OWNER. */
export async function PATCH(req: Request) {
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  try {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'calendar_id' && k !== 'block_on_busy') return fail(`field "${k}" cannot be updated here`, 422);
    if (body.block_on_busy !== undefined && typeof body.block_on_busy !== 'boolean') return fail('block_on_busy must be a boolean', 422);
    if (body.calendar_id !== undefined && (typeof body.calendar_id !== 'string' || !body.calendar_id || body.calendar_id.length > 300)) return fail('calendar_id must be a calendar id', 422);
    if (body.block_on_busy === undefined && body.calendar_id === undefined) return fail('nothing to update', 422);
    const conn = await getCalendarConnection(r.s.businessId);
    if (!conn || conn.status === 'revoked') return fail('google calendar is not connected', 404);

    if (typeof body.block_on_busy === 'boolean') await setBlockOnBusy(r.s.businessId, body.block_on_busy, r.s.actor);
    if (typeof body.calendar_id === 'string' && body.calendar_id !== conn.calendar_id) {
      const allowed = (await listCalendars(conn.id)).some((c) => c.id === body.calendar_id); // only a calendar this account can write
      if (!allowed) return fail('that calendar is not available on the connected account', 422);
      await changeCalendar(conn, body.calendar_id);
      await recordAudit({ actor_kind: r.s.actor.kind, actor_user_id: r.s.actor.user_id, business_id: r.s.businessId, action: 'calendar.calendar_changed', target: `calendar:${conn.id}`, ip: r.s.ip });
      void (async () => { try { await ensureWatch(conn.id); await syncConnection(conn.id); const c = await getCalendarConnection(r.s.businessId); if (c) await reconcileConnection(c); } catch { /* the poll job retries */ } })();
    }
    return ok({ updated: true });
  } catch (err) {
    if (err instanceof NeedsReauthError) return fail('google calendar needs to be reconnected', 409);
    if (err instanceof GoogleApiError) return fail('google is not reachable right now', 502);
    return fail(err, 500);
  }
}
