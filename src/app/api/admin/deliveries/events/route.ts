import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { eventOverview } from '@/lib/admin/deliveries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Webhook / event delivery log: the idempotency table (`processed_events`) per source: how many claims, how many finished, how many are still `processing`, and which ones are STUCK
 * (a claim whose lease ran out: the handler died or failed without releasing it). GET ?hours=1..720 (default 24). Permission: system.read. Read only.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'deliveries-events', max: 60 } });
  if (!g.ok) return g.response;
  try {
    return ok(await eventOverview({ hours: int(new URL(req.url).searchParams.get('hours'), 24, 1, 720) }));
  } catch (err) { return adminFail(err); }
}
