import { getCalendarConnection, listBusyBlocksInRange } from '@/lib/db/calendar';
import { fail, ok } from '@/lib/http';
import { scoped } from '@/lib/integrations/google/route-helpers';

export const dynamic = 'force-dynamic';
const MAX_RANGE_MS = 45 * 86_400_000;

/** GET /api/integrations/google/busy?from=ISO&to=ISO   Staff+ read. Times only (the calendar overlay); [] unless the connection is healthy. */
export async function GET(req: Request) {
  const r = await scoped(req, 'staff');
  if (!r.ok) return r.response;
  try {
    const q = new URL(req.url).searchParams;
    const from = new Date(q.get('from') ?? ''), to = new Date(q.get('to') ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > MAX_RANGE_MS) return fail('from/to must be ISO instants, at most 45 days apart', 422);
    const conn = await getCalendarConnection(r.s.businessId);
    if (!conn || (conn.status !== 'active' && conn.status !== 'error')) return ok({ blocks: [] });
    const blocks = await listBusyBlocksInRange(r.s.businessId, from, to);
    return ok({ blocks: blocks.map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at, all_day: b.all_day })) });
  } catch (err) {
    return fail(err, 500);
  }
}
