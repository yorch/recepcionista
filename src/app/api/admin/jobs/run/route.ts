import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { getBusiness, recordAudit } from '@/lib/db';
import { isJobName, JOB_NAMES, runJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Admin-only: run one background job by hand. `{ "job": "daily_briefing" | "gratitude_sweep" | "cleanup" | "retention",
 * "business_id"?: string, "dry_run"?: boolean }`. `dry_run` defaults to TRUE (reports what would happen, changes nothing);
 * `dry_run:false` really runs it. A manual run bypasses only the time-of-day gate (so a briefing can be generated before 18:00);
 * billing, consent, quiet-hours, caps and idempotency still apply. Works whether or not JOBS=on.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson<{ job?: unknown; business_id?: unknown; dry_run?: unknown }>(req).catch(() => ({} as { job?: unknown; business_id?: unknown; dry_run?: unknown }));
    if (!isJobName(body.job)) return fail(`job must be one of: ${JOB_NAMES.join(', ')}`, 422);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    if (body.business_id !== undefined && (typeof body.business_id !== 'string' || !body.business_id)) return fail('business_id must be a non-empty string', 422);
    if (body.business_id !== undefined && body.job !== 'daily_briefing' && body.job !== 'gratitude_sweep') return fail('business_id only applies to daily_briefing and gratitude_sweep', 422);
    const dryRun = body.dry_run !== false;
    const businessId = body.business_id as string | undefined;
    if (businessId && !(await getBusiness(businessId))) return fail('business not found', 404);

    const report = await runJob(body.job, { dryRun, businessId, force: true });
    if (!dryRun) {
      await recordAudit({
        actor_kind: auth.principal.kind === 'admin' && auth.principal.user ? 'user' : 'admin_token',
        actor_user_id: auth.principal.kind === 'admin' ? auth.principal.user?.id ?? null : null,
        business_id: businessId ?? null, action: 'jobs.manual_run', target: `job:${body.job}`,
        meta: { processed: report.processed, errors: report.errors },
      });
    }
    return ok(report);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
