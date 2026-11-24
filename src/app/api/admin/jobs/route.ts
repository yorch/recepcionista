import { ok, fail } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { jobsStatus } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin-only: the background jobs (daily briefing, gratitude sweep, cleanup, retention): whether this instance runs them,
 * when each last did work (and its newest recorded result), and when each is next due.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  try {
    return ok(await jobsStatus());
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
