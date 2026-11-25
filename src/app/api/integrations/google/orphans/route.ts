import { recordAudit } from '@/lib/db';
import { dismissOrphanedEvents } from '@/lib/db/calendar';
import { fail, ok, readJson } from '@/lib/http';
import { scoped } from '@/lib/integrations/google/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/integrations/google/orphans   { ids?: string[] }   OWNER. "I removed them in Google Calendar" / "forget this": dismisses the
 * list of events that could not be removed from a previous Google account (all of them when `ids` is omitted). Only deletes our reminder rows
 * of THIS business; nothing is sent to Google. Audited.
 */
export async function DELETE(req: Request) {
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  try {
    const body = await readJson<{ ids?: unknown }>(req).catch(() => ({} as { ids?: unknown }));
    let ids: string[] | undefined;
    if (body && body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.length > 200 || !body.ids.every((x) => typeof x === 'string' && x.length <= 64)) return fail('ids must be a list of at most 200 ids', 422);
      ids = body.ids as string[];
    }
    const dismissed = await dismissOrphanedEvents(r.s.businessId, ids);
    if (dismissed > 0) await recordAudit({ actor_kind: r.s.actor.kind, actor_user_id: r.s.actor.user_id, business_id: r.s.businessId, action: 'calendar.orphans_dismissed', target: `business:${r.s.businessId}`, ip: r.s.ip, meta: { count: dismissed } });
    return ok({ dismissed });
  } catch (err) {
    return fail(err, 500);
  }
}
