import { getCalendarConnection } from '@/lib/db/calendar';
import { fail, ok } from '@/lib/http';
import { listCalendars } from '@/lib/integrations/google/api';
import { scoped } from '@/lib/integrations/google/route-helpers';
import { GoogleApiError } from '@/lib/integrations/google/http';
import { NeedsReauthError } from '@/lib/integrations/google/tokens';

export const dynamic = 'force-dynamic';

/** GET /api/integrations/google/calendars   OWNER. The writable calendars of the connected account (id + name + primary flag only). */
export async function GET(req: Request) {
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  try {
    const conn = await getCalendarConnection(r.s.businessId);
    if (!conn || conn.status === 'revoked') return fail('google calendar is not connected', 404);
    const items = await listCalendars(conn.id);
    return ok({ selected: conn.calendar_id, calendars: items.map((c) => ({ id: c.id, name: c.summary ?? c.id, primary: c.primary === true })) });
  } catch (err) {
    if (err instanceof NeedsReauthError) return fail('google calendar needs to be reconnected', 409);
    if (err instanceof GoogleApiError) return fail('google is not reachable right now', 502);
    return fail(err, 500);
  }
}
