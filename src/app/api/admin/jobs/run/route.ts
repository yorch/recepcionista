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
    const body = await readJson<{ job?: unknown; business_id?: unknown; dry_run?: unknown; before?: unknown }>(req).catch(() => ({} as { job?: unknown; business_id?: unknown; dry_run?: unknown; before?: unknown }));
    if (!isJobName(body.job)) return fail(`job must be one of: ${JOB_NAMES.join(', ')}`, 422);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    if (body.business_id !== undefined && (typeof body.business_id !== 'string' || !body.business_id)) return fail('business_id must be a non-empty string', 422);
    if (body.business_id !== undefined && body.job !== 'daily_briefing' && body.job !== 'gratitude_sweep' && body.job !== 'tenant_release') return fail('business_id only applies to daily_briefing, gratitude_sweep and tenant_release', 422);
    if (body.before !== undefined && (body.job !== 'grandfather' || typeof body.before !== 'string' || Number.isNaN(new Date(body.before).getTime()))) return fail('before (an ISO date-time) only applies to grandfather', 422);
    const dryRun = body.dry_run !== false;
    const businessId = body.business_id as string | undefined;
    if (businessId && !(await getBusiness(businessId))) return fail('business not found', 404);

    // tenant_release / grandfather: a real run (`dry_run:false`) also needs TENANT_RELEASE_JOB=on; otherwise the report says `refused_not_enabled` and nothing changes.
    const report = await runJob(body.job, { dryRun, businessId, force: true, before: typeof body.before === 'string' ? body.before : undefined });
    if (!report.dry_run) {
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
