import { NextResponse } from 'next/server';
import { auditIp, limitIp } from '@/lib/account-flows';
import { recordAudit, setSessionActiveBusiness } from '@/lib/db';
import { createBusinessForOwner, maxBusinessesFor } from '@/lib/db/locations';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { validateBusinessName } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('businesses/mine');
const fail = (status: number, error: string, code?: string) => NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });

/**
 * POST /api/businesses/mine   { name }   "Add another location".
 * An account that OWNS at least one business creates an additional one: business + owner membership in one transaction, billing 'none',
 * nothing provisioned (each business subscribes and gets its number on its own). Needs a verified email, is rate limited per account and
 * per client, and capped at MAX_BUSINESSES_PER_USER (default 10) owner memberships per account (409 `limit_reached`). The caller's session
 * moves to the new business so onboarding starts there. Admins have no memberships and cannot use this (creating tenants for them is
 * POST /api/businesses).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { verifiedEmail: true });
  if (!auth.ok) return auth.response;
  const { principal } = auth;
  if (principal.kind !== 'user') return fail(403, 'forbidden');
  const limited = await limitIp(req, 'businesses/mine', 30);
  if (limited) return limited;
  const gate = await rateLimit(`businesses/mine:${principal.user.id}`, 5, 60 * 60_000, { failClosed: true });
  if (!gate.allowed) return fail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = validateBusinessName(body.name);
  if (!name.ok) return fail(422, name.error);
  try {
    const r = await createBusinessForOwner(principal.user.id, { name: name.value });
    if (!r.ok) {
      if (r.reason === 'limit_reached') return fail(409, `you can manage at most ${await maxBusinessesFor(principal.user.id)} businesses`, 'limit_reached');
      return fail(403, 'only an owner can add another location', r.reason);
    }
    if (auth.sessionId) await setSessionActiveBusiness(auth.sessionId, r.business.id);
    await recordAudit({
      actor_kind: 'user', actor_user_id: principal.user.id, business_id: r.business.id, action: 'business.created_additional',
      target: `business:${r.business.id}`, ip: auditIp(req), meta: { from_business: principal.business_id },
    });
    return NextResponse.json({ ok: true, data: { business: { id: r.business.id, name: r.business.name }, onboarding: '/onboarding' } }, { status: 201 });
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
