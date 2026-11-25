import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, getDepositPolicy, recordAudit, setDepositPolicy } from '@/lib/db';
import { DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS, type DepositPolicy } from '@/lib/business-config';
import { AI_DEPOSIT_CAP_CENTS } from '@/lib/payments/deposit';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface DepositPolicyResult {
  policy: DepositPolicy;
  /** Platform limits and the cap the AI line applies on top, so the form can show them. */
  limits: { min_cents: number; max_cents: number; ai_cap_cents: number };
}

const limits = () => ({ min_cents: DEPOSIT_MIN_CENTS, max_cents: DEPOSIT_MAX_CENTS, ai_cap_cents: AI_DEPOSIT_CAP_CENTS });

/** GET /api/businesses/:id/deposit-policy   Staff+ (read-only): the business's deposit policy and the platform limits. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const policy = await getDepositPolicy(id);
    if (!policy) return fail('business not found', 404);
    return ok<DepositPolicyResult>({ policy, limits: limits() });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * PUT /api/businesses/:id/deposit-policy   { enabled, mode: 'fixed'|'percent', fixed_cents, percent, min_cents, max_cents }   OWNER (or admin).
 * Replaces the WHOLE policy (validated as a whole: cents 100..100000, percent 1..100, min <= max, a fixed amount inside min/max). The amount a booking asks
 * for is then computed on the server from this policy: neither the AI nor a request can pick another. Audited (`business.deposit_policy_changed`).
 * Same-origin is enforced for cookie sessions by `authenticate` (CSRF).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'businesses/deposit-policy', 20);
  if (limited) return limited;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    if (!(await getBusiness(id))) return fail('business not found', 404);
    const body = await readJson<unknown>(req);
    const before = await getDepositPolicy(id);
    const out = await setDepositPolicy(id, body);
    if (!out.ok) return out.reason === 'not_found' ? fail('business not found', 404) : fail(out.error ?? 'invalid deposit policy', 422);
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.deposit_policy_changed', target: `business:${id}`,
      ip: clientKey(req), meta: { ...actor.meta, from: before, to: out.policy },
    });
    return ok<DepositPolicyResult>({ policy: out.policy, limits: limits() });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
