import { NextResponse } from 'next/server';
import { readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, getBusiness, isOptedOut } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { createOwnerPhoneChallenge, OWNER_PHONE_CODE_TTL_MS } from '@/lib/messaging/owner-verify';
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
 * Limits: 5 texts per hour per business+phone+client, 10 per hour per business. The destination country allow-list
 * (SMS_ALLOWED_COUNTRY_CODES) applies to this text (the number is not yet proven).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
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

    const perPhone = await rateLimit(`owner-phone/start:${id}:${e164}:${clientKey(req)}`, 5, 60 * 60_000, { failClosed: true });
    const perBusiness = perPhone.allowed ? await rateLimit(`owner-phone/start:${id}:*`, 10, 60 * 60_000, { failClosed: true }) : perPhone;
    if (!perPhone.allowed || !perBusiness.allowed) {
      const blocked = perPhone.allowed ? perBusiness : perPhone;
      return blocked.error
        ? bad('service temporarily unavailable', 503, { 'retry-after': String(blocked.retryAfterS) })
        : bad('too many verification texts; try again later', 429, { 'retry-after': String(blocked.retryAfterS) });
    }

    const { code, challenge, expires_at } = createOwnerPhoneChallenge(id, e164);
    const sent = await sendOwnerVerificationCode(
      id, e164, `${business.name}: your verification code is ${code}. It expires in ${OWNER_PHONE_CODE_TTL_MS / 60_000} minutes.`,
    );
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
