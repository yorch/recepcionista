import { NextResponse } from 'next/server';
import { auditIp } from '@/lib/account-flows';
import { recordAudit, setSessionActiveBusiness } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/switch-business');
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * POST /api/auth/switch-business   { business_id }
 * Point THIS session at another business the account has an enabled membership in (cookie session only, CSRF-checked by authenticate).
 * The membership is validated in the same UPDATE that stores the choice (setSessionActiveBusiness), so a business the account does not
 * belong to, a disabled membership and a nonexistent id are all the same 404 and nothing changes. Only the caller's own session row
 * changes: their other devices keep working where they were. The role from then on is the membership's role in the new business.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  if (principal.kind !== 'user' || !auth.sessionId) return fail(403, 'forbidden');
  const body = (await req.json().catch(() => ({}))) as { business_id?: unknown };
  if (typeof body.business_id !== 'string' || !body.business_id || body.business_id.length > 64) return fail(422, 'business_id is required');
  const gate = await rateLimit(`auth/switch-business:${principal.user.id}`, 60, 10 * 60_000, { failClosed: true });
  if (!gate.allowed) return fail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');
  try {
    if (!(await setSessionActiveBusiness(auth.sessionId, body.business_id))) return fail(404, 'business not found');
    const role = principal.memberships.find((m) => m.business_id === body.business_id)?.role ?? null;
    if (body.business_id !== principal.business_id) {
      await recordAudit({
        actor_kind: 'user', actor_user_id: principal.user.id, business_id: body.business_id, action: 'auth.business_switched',
        target: `business:${body.business_id}`, ip: auditIp(req), meta: { from: principal.business_id, to: body.business_id, session: auth.sessionId },
      });
    }
    return NextResponse.json({ ok: true, data: { business_id: body.business_id, role } });
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
