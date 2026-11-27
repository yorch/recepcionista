import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail } from '@/lib/admin/guard';
import { getChangeSet, SettingsError } from '@/lib/admin/settings-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One change set with its per-key before / after (non-secret values; secrets as fingerprints, `can_rollback_secret` while the 7-day envelope is retained). Permission: settings.read. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdminRoute(req, { permission: 'settings.read', rate: { name: 'settings-history', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const cs = await getChangeSet((await params).id);
    if (!cs) throw new SettingsError(404, 'not_found', 'change set not found');
    if (!g.ctx.revealSecretMeta && cs.revisions) for (const r of cs.revisions) { r.old_fingerprint = null; r.new_fingerprint = null; r.can_rollback_secret = false; }
    return ok(cs);
  } catch (err) { return adminFail(err); }
}
