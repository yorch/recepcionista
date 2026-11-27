import { configEnv } from '@/lib/config';
import { ok } from '@/lib/http';
import { adminFail, guardAdminRoute } from '@/lib/admin/guard';
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
  const g = await guardAdminRoute(req, { permission: 'jobs.read', rate: { name: 'jobs', max: 60 } }); // permission jobs.read
  if (!g.ok) return g.response;
  try {
    // `diagnostics`: configuration that fails safe but misleads (VOICE_LINE_KIND against the real line) and the recording-deletion queue.
    const mismatch = lineKindMismatch();
    return ok({
      ...(await jobsStatus()),
      diagnostics: {
        voice_line: { effective: lineKind(), forced: (configEnv().VOICE_LINE_KIND ?? '').trim().toLowerCase() || null, mismatch },
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
    return adminFail(err);
  }
}
