import { NextResponse } from 'next/server';
import { readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { countryForBusiness, getBusiness, isOptedOut } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { checkVerificationStart } from '@/lib/messaging/verify-limits';
import { createOwnerPhoneChallenge } from '@/lib/messaging/owner-verify';
import { sendOwnerVerificationCode } from '@/lib/messaging';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('owner-phone');

const bad = (error: string, status: number, headers?: Record<string, string>) =>
  NextResponse.json({ ok: false as const, error }, { status, headers });

/**
 * POST /api/businesses/:id/owner-phone/verify/start   { phone }
 * Texts a 6-digit code to `phone` and returns { ok: true, challenge, expires_at }. Echo the challenge to /confirm with
 * the code. Owner of the business (or admin) only; cookie sessions are same-origin checked by `authenticate`.
 * Needs a VERIFIED email. The text is a fixed template (no tenant-controlled characters). Limits (messaging/verify-limits):
 * per business+phone+client, business, user, client IP, destination number across businesses, and platform-wide per
 * hour/day; numbers that opted out anywhere or were verified by another business recently are refused. The destination
 * country allow-list (SMS_ALLOWED_COUNTRY_CODES) applies to this text (the number is not yet proven).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ phone?: unknown }>(req).catch(() => ({} as { phone?: unknown }));
    if (typeof body.phone !== 'string' || !body.phone.trim()) return bad('phone is required', 422);
    const business = await getBusiness(id);
    if (!business) return bad('business not found', 404);

    const country = countryForBusiness(business);
    const e164 = toE164(body.phone, country);
    if (!e164) return bad('phone must be a valid number (include the country code for non-US numbers)', 422);
    // Same rule as PATCH: an alert destination must not be a number that opted out of this business's texts.
    if (await isOptedOut(id, e164, country)) return bad('that number opted out of texts from this business', 422);

    const denied = await checkVerificationStart({
      req, businessId: id, e164, userId: auth.principal.user?.id ?? null, isAdmin: auth.principal.kind === 'admin',
    });
    if (denied) {
      return bad(denied.error, denied.status, denied.retryAfterS ? { 'retry-after': String(denied.retryAfterS) } : undefined);
    }

    const { code, challenge, expires_at } = createOwnerPhoneChallenge(id, e164);
    const sent = await sendOwnerVerificationCode(id, e164, code);
    if (sent.blocked || sent.result.status === 'failed') {
      log.warn('verify.start_failed', { business: id, blocked: sent.blocked ?? null, error: sent.result.error ?? null });
      const msg = sent.result.error === 'destination country is not allowed'
        ? 'texts to that country are not enabled for this account'
        : 'could not send the verification text';
      return bad(msg, sent.result.error === 'destination country is not allowed' ? 422 : 502);
    }
    return NextResponse.json({ ok: true as const, challenge, expires_at });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    log.error('verify.start_error', { err });
    return bad('internal error', 500);
  }
}
