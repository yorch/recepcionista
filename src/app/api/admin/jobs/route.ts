import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { jobsStatus } from '@/lib/jobs';
import { lineKind, lineKindMismatch } from '@/lib/voice/line';
import { prisma, recordingDeletionStatus } from '@/lib/db';
import { tenantReleaseSetting } from '@/lib/jobs/tenants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only: the background jobs (daily briefing, gratitude sweep, cleanup, retention, recording deletions): whether this instance runs them,
 * when each last did work (and its newest recorded result), and when each is next due.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/jobs', 60);
  if (limited) return limited;
  try {
    // `diagnostics`: configuration that fails safe but misleads (VOICE_LINE_KIND against the real line) and the recording-deletion queue.
    const mismatch = lineKindMismatch();
    return ok({
      ...(await jobsStatus()),
      diagnostics: {
        voice_line: { effective: lineKind(), forced: (process.env.VOICE_LINE_KIND ?? '').trim().toLowerCase() || null, mismatch },
        recording_deletions: await recordingDeletionStatus(),
        // The newest tenant-release / grandfather run reports (audit rows; counts only, no secrets): what the job would do or did.
        tenant_release: {
          setting: tenantReleaseSetting(),
          last_report: await prisma.auditEvent.findFirst({ where: { action: 'jobs.tenant_release_report' }, orderBy: { at: 'desc' }, select: { at: true, meta: true } }),
          last_grandfather_report: await prisma.auditEvent.findFirst({ where: { action: 'jobs.grandfather_report' }, orderBy: { at: 'desc' }, select: { at: true, meta: true } }),
        },
      },
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
