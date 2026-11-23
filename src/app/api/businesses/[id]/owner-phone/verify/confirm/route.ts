import { NextResponse } from 'next/server';
import { readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, getBusiness, isOptedOut, recordAudit, setOwnerPhoneVerified } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { challengeId, verifyOwnerPhoneChallenge } from '@/lib/messaging/owner-verify';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('owner-phone');

const bad = (error: string, status: number, headers?: Record<string, string>) =>
  NextResponse.json({ ok: false as const, error }, { status, headers });

/**
 * POST /api/businesses/:id/owner-phone/verify/confirm   { phone, code, challenge }
 * Verifies the challenge from /start and the 6-digit code (constant time), then stores the number as the owner phone
 * (owner_phone + owner_phone_e164) and sets owner_phone_verified_at. Returns { ok: true, verified_at }.
 * At most 5 attempts per (server-verified) challenge, 10 per business+phone per 10 min, 20 per business per hour (Postgres limiter, fails closed). Audited as `business.owner_phone_verified`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ phone?: unknown; code?: unknown; challenge?: unknown }>(req).catch(() => ({} as Record<string, unknown>));
    if (typeof body.phone !== 'string' || typeof body.code !== 'string' || typeof body.challenge !== 'string') {
      return bad('phone, code and challenge are required', 422);
    }
    const business = await getBusiness(id);
    if (!business) return bad('business not found', 404);
    const country = countryForBusiness(business);
    const e164 = toE164(body.phone, country);
    if (!e164) return bad('phone must be a valid number', 422);

    // Attempt limits that a re-spelled challenge cannot dodge: per (business, phone), per business, and per challenge
    // keyed on the nonce the SERVER signed (an inauthentic challenge only ever burns the business/phone buckets).
    const cid = challengeId(body.challenge);
    const limits: [string, number, number][] = [
      [`owner-phone/confirm:bp:${id}:${e164}`, 10, 10 * 60_000],
      [`owner-phone/confirm:b:${id}`, 20, 60 * 60_000],
      ...(cid ? [[`owner-phone/confirm:c:${cid}`, 5, 10 * 60_000] as [string, number, number]] : []),
    ];
    for (const [key, limit, windowMs] of limits) {
      const attempts = await rateLimit(key, limit, windowMs, { failClosed: true });
      if (!attempts.allowed) {
        return attempts.error
          ? bad('service temporarily unavailable', 503, { 'retry-after': String(attempts.retryAfterS) })
          : bad('too many attempts; request a new code', 429, { 'retry-after': String(attempts.retryAfterS) });
      }
    }

    const verdict = verifyOwnerPhoneChallenge(body.challenge, id, e164, body.code);
    if (!verdict.ok) {
      log.warn('verify.rejected', { business: id, reason: verdict.reason });
      void recordAudit({
        actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token', actor_user_id: auth.principal.kind === 'user' ? auth.principal.user.id : auth.principal.user?.id ?? null,
        business_id: id, action: 'business.owner_phone_verify_failed', target: `business:${id}`, ip: clientKey(req), meta: { reason: verdict.reason },
      });
      return bad(verdict.reason === 'expired' ? 'the code expired; request a new one' : 'invalid code', 400);
    }
    if (await isOptedOut(id, e164, country)) return bad('that number opted out of texts from this business', 422);

    const at = await setOwnerPhoneVerified(id, e164);
    if (!at) return bad('business not found', 404);
    await recordAudit({
      actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token', actor_user_id: auth.principal.kind === 'user' ? auth.principal.user.id : auth.principal.user?.id ?? null,
      business_id: id, action: 'business.owner_phone_verified', target: `business:${id}`, ip: clientKey(req),
      meta: { phone_last4: e164.slice(-4) },
    });
    return NextResponse.json({ ok: true as const, verified_at: at.toISOString() });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    log.error('verify.confirm_error', { err });
    return bad('internal error', 500);
  }
}
