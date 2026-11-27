import { ok, fail, readJson } from '@/lib/http';
import { requireRecentAuth } from '@/lib/session';
import { adminFail, guardAdminRoute } from '@/lib/admin/guard';
import { recordAudit } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { runRetentionNow, retentionJobEnabled } from '@/lib/retention-job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only: run the retention purge by hand. `{ "dry_run": true }` (the default) deletes nothing and reports what
 * WOULD be purged; `{ "dry_run": false }` really purges (irreversible: a cookie session needs a recent re-authentication, `reauth_required`).
 * Works whether or not RETENTION_JOB=on. Rate limited (6/min per client); audited as `admin.retention_run` (dry_run flag and counts only).
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'retention.run', rate: { name: 'retention', max: 6 } }); // permission retention.run
  if (!g.ok) return g.response;
  const auth = g.ctx.auth;
  try {
    const body = await readJson<{ dry_run?: unknown }>(req).catch(() => ({} as { dry_run?: unknown }));
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    const dryRun = body.dry_run !== false;
    if (!dryRun) {
      const stale = requireRecentAuth(auth);
      if (stale) return stale;
    }
    const res = await runRetentionNow(dryRun);
    if (!res.acquired) return fail('another purge is already running', 409);
    const user = auth.principal.kind === 'admin' ? auth.principal.user : null;
    await recordAudit({
      actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, action: 'admin.retention_run', target: 'retention', ip: auditIp(req),
      meta: { dry_run: dryRun, counts: res.counts ?? null },
    });
    return ok({ dry_run: dryRun, automatic_job: retentionJobEnabled() ? 'on' : 'off', counts: res.counts });
  } catch (err) {
    return adminFail(err);
  }
}
