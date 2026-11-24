import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { jobsStatus } from '@/lib/jobs';
import { lineKind, lineKindMismatch } from '@/lib/voice/line';
import { recordingDeletionStatus } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only: the background jobs (daily briefing, gratitude sweep, cleanup, retention, recording deletions): whether this instance runs them,
 * when each last did work (and its newest recorded result), and when each is next due.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  try {
    // `diagnostics`: configuration that fails safe but misleads (VOICE_LINE_KIND against the real line) and the recording-deletion queue.
    const mismatch = lineKindMismatch();
    return ok({
      ...(await jobsStatus()),
      diagnostics: {
        voice_line: { effective: lineKind(), forced: (process.env.VOICE_LINE_KIND ?? '').trim().toLowerCase() || null, mismatch },
        recording_deletions: await recordingDeletionStatus(),
      },
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
