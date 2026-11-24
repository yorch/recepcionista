import { fail, ok } from '@/lib/http';
import { disconnectGoogle } from '@/lib/integrations/google/oauth';
import { scoped } from '@/lib/integrations/google/route-helpers';

export const dynamic = 'force-dynamic';

/** DELETE /api/integrations/google/disconnect[?delete_events=true]   OWNER. Revokes at Google, stops the channel, wipes tokens + sync state + busy blocks. Idempotent. */
export async function DELETE(req: Request) {
  const r = await scoped(req, 'owner');
  if (!r.ok) return r.response;
  try {
    const deleteEvents = new URL(req.url).searchParams.get('delete_events') === 'true';
    const changed = await disconnectGoogle(r.s.businessId, r.s.actor, deleteEvents);
    return ok({ disconnected: true, changed });
  } catch (err) {
    return fail(err, 500);
  }
}
