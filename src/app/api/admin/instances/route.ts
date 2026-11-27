import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { instancesOverview } from '@/lib/admin/instances';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Instances: one row per running process (heartbeat) with its applied settings version, build SHA, canary and whether it is current; mixed builds flagged. Permission: system.read. Read only. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'system.read', rate: { name: 'instances', max: 60 } });
  if (!g.ok) return g.response;
  try { return ok(await instancesOverview()); } catch (err) { return adminFail(err); }
}
