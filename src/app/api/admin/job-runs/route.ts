import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { listJobRuns } from '@/lib/admin/job-runs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET ?job=&status=ok|error|skipped&trigger=schedule|manual|api&dry_run=true|false&before=<iso>&limit=1..200. Job run history. Permission: jobs.read. */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'jobs.read', rate: { name: 'job-runs', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    const dry = q.get('dry_run');
    return ok(await listJobRuns({ job: q.get('job') ?? undefined, status: q.get('status') ?? undefined, trigger: q.get('trigger') ?? undefined, dry_run: dry === null ? undefined : dry === 'true', before: q.get('before') ?? undefined, limit: int(q.get('limit'), 50, 1, 200) }));
  } catch (err) { return adminFail(err); }
}
