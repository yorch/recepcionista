import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { evaluateAlerts } from '@/lib/admin/alerts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Alerts center: the alerts computed from live state right now (stuck recording deletions, SMS delivery failures, job errors, decrypt / MAC failures, settings drift between instances,
 * stuck webhook claims, unhealthy providers, failed notifications, freeze / maintenance) with severity, count, since, the page that fixes it and the acknowledgement state.
 * Permission: system.read. Read only.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'alerts', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok(await evaluateAlerts()); } catch (err) { return adminFail(err); }
}
