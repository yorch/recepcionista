import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireRecentAuth } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
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
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/retention', 6);
  if (limited) return limited;
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
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
