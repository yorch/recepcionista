import { ok } from '@/lib/http';
import { recordAudit } from '@/lib/db/audit';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { exportSettings } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Non-secret export (console-held settings, plans, secret FINGERPRINTS; schema_version 1). Audited as `settings.export`. Permission: settings.export. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'settings.export', rate: { name: 'settings-export', max: 10 } });
  if (!g.ok) return g.response;
  try {
    const doc = await exportSettings();
    await recordAudit({ actor_kind: g.ctx.actor.kind, actor_user_id: g.ctx.actor.user_id, action: 'settings.export', target: 'settings', ip: g.ctx.ip, meta: { keys: Object.keys(doc.settings).length, plans: doc.plans.length, role: g.ctx.role } });
    if (!g.ctx.revealSecretMeta) doc.secret_fingerprints = {};
    return ok(doc);
  } catch (err) { return adminFail(err); }
}
