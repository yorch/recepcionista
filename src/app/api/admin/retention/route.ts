import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { runRetentionNow, retentionJobEnabled } from '@/lib/retention-job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only: run the retention purge by hand. `{ "dry_run": true }` (the default) deletes nothing and reports what
 * WOULD be purged; `{ "dry_run": false }` really purges. Works whether or not RETENTION_JOB=on.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson<{ dry_run?: unknown }>(req).catch(() => ({} as { dry_run?: unknown }));
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    const dryRun = body.dry_run !== false;
    const res = await runRetentionNow(dryRun);
    if (!res.acquired) return fail('another purge is already running', 409);
    return ok({ dry_run: dryRun, automatic_job: retentionJobEnabled() ? 'on' : 'off', counts: res.counts });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
