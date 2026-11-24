import { getCalendarConnection } from '@/lib/db/calendar';
import { fail, ok, readJson } from '@/lib/http';
import { googleMockEnabled } from '@/lib/integrations/google/config';
import { addMockGoogleEvent, deleteMockGoogleEvent } from '@/lib/integrations/google/mock';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { syncConnection } from '@/lib/integrations/google/sync';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/google/mock-event   OWNER. LOCAL / END-TO-END ONLY: exists only while GOOGLE_OAUTH_MOCK=true outside production (404 otherwise,
 * so as far as a prober can tell the route does not exist). Plays "the owner added (or deleted) an event in their Google Calendar" against the in-memory
 * fake Google, then runs the real sync, so the busy block appears exactly as it would from the real thing.
 *   { start: ISO instant, end: ISO instant, summary?, transparency?: 'opaque' | 'transparent' }  -> { id }
 *   { delete_id: string }                                                                          -> { deleted }
 */
export async function POST(req: Request) {
  if (!googleMockEnabled()) return fail('not found', 404);
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  try {
    const body = await readJson<Record<string, unknown>>(req).catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const conn = await getCalendarConnection(r.s.businessId);
    if (!conn || conn.status === 'revoked') return fail('google calendar is not connected', 404);
    if (typeof body.delete_id === 'string') {
      const deleted = deleteMockGoogleEvent(conn.calendar_id, body.delete_id);
      const sync = await syncConnection(conn.id);
      return ok({ deleted, sync: sync.outcome });
    }
    const start = new Date(String(body.start ?? '')), end = new Date(String(body.end ?? ''));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return fail('start and end must be ISO instants, end after start', 422);
    if (body.transparency !== undefined && body.transparency !== 'opaque' && body.transparency !== 'transparent') return fail('transparency must be opaque or transparent', 422);
    const id = addMockGoogleEvent(conn.calendar_id, {
      start: start.toISOString(), end: end.toISOString(), summary: typeof body.summary === 'string' ? body.summary.slice(0, 100) : undefined,
      transparency: body.transparency as 'opaque' | 'transparent' | undefined,
    });
    const sync = await syncConnection(conn.id);
    return ok({ id, sync: sync.outcome });
  } catch (err) {
    return fail(err, 500);
  }
}
