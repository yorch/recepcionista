import { NextResponse } from 'next/server';
import { readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, ForwardNumberRejectedError, getBusiness, isOptedOut, recordAudit, setForwardNumberVerified } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { challengeId, verifyOwnerPhoneChallenge } from '@/lib/messaging/owner-verify';
import { callModeView } from '@/lib/voice/call-mode';
import { vetForwardNumber } from '@/lib/voice/forward-vet';
import { announceCallHandlingChange } from '@/lib/voice/call-handling-changes';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('forward-number');
const bad = (error: string, status: number, headers?: Record<string, string>) => NextResponse.json({ ok: false as const, error }, { status, headers });

/**
 * POST /api/businesses/:id/forward-number/verify/confirm   { phone, code, challenge }
 * Verifies the challenge from /start (purpose 'forward-number': an owner-phone challenge is rejected) and the 6-digit code,
 * then stores the number as the verified forward number. Same attempt limits as the owner phone. Audited.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response;
  const actor = {
    actor_kind: auth.principal.kind === 'user' ? ('user' as const) : ('admin_token' as const),
    actor_user_id: auth.principal.user?.id ?? null,
  };
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ phone?: unknown; code?: unknown; challenge?: unknown }>(req).catch(() => ({} as Record<string, unknown>));
    if (typeof body.phone !== 'string' || typeof body.code !== 'string' || typeof body.challenge !== 'string') return bad('phone, code and challenge are required', 422);
    const business = await getBusiness(id);
    if (!business) return bad('business not found', 404);
    const country = countryForBusiness(business);
    const check = await vetForwardNumber(business, body.phone);
    if (!check.ok) return bad(check.error, 422);
    const e164 = check.e164;
    const denied = requireRecentAuth(auth);
    if (denied) return denied;

    const cid = challengeId(body.challenge, 'forward-number');
    const limits: [string, number, number][] = [
      [`forward-number/confirm:bp:${id}:${e164}`, 10, 10 * 60_000],
      [`forward-number/confirm:b:${id}`, 20, 60 * 60_000],
      ...(cid ? [[`forward-number/confirm:c:${cid}`, 5, 10 * 60_000] as [string, number, number]] : []),
    ];
    for (const [key, limit, windowMs] of limits) {
      const attempts = await rateLimit(key, limit, windowMs, { failClosed: true });
      if (!attempts.allowed) {
        return attempts.error
          ? bad('service temporarily unavailable', 503, { 'retry-after': String(attempts.retryAfterS) })
          : bad('too many attempts; request a new code', 429, { 'retry-after': String(attempts.retryAfterS) });
      }
    }

    const verdict = verifyOwnerPhoneChallenge(body.challenge, id, e164, body.code, Date.now(), 'forward-number');
    if (!verdict.ok) {
      log.warn('verify.rejected', { business: id, reason: verdict.reason });
      void recordAudit({ ...actor, business_id: id, action: 'business.forward_number_verify_failed', target: `business:${id}`, ip: clientKey(req), meta: { reason: verdict.reason } });
      return bad(verdict.reason === 'expired' ? 'the code expired; request a new one' : 'invalid code', 400);
    }
    if (await isOptedOut(id, e164, country)) return bad('that number opted out of texts from this business', 422);

    let change;
    try {
      change = await setForwardNumberVerified(id, e164);
    } catch (err) {
      if (err instanceof ForwardNumberRejectedError) return bad(err.message, 422);
      throw err;
    }
    if (!change) return bad('business not found', 404);
    await recordAudit({
      ...actor, business_id: id, action: 'business.forward_number_verified', target: `business:${id}`, ip: clientKey(req), meta: { phone_last4: e164.slice(-4) },
    });
    const fresh = await getBusiness(id);
    await announceCallHandlingChange({
      business: fresh!, actor: { ...actor, email: auth.principal.user?.email ?? null }, ip: clientKey(req), change, reason: 'forward_number_verified',
    });
    return NextResponse.json({ ok: true as const, verified_at: change.after.forward_number_verified_at, state: callModeView(fresh!, { full: true }) });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    log.error('verify.confirm_error', { err });
    return bad('internal error', 500);
  }
}
