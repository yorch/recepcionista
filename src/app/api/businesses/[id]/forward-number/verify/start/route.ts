import { NextResponse } from 'next/server';
import { readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, ForwardNumberRejectedError, getBusiness, isOptedOut, setForwardNumberUnverified } from '@/lib/db';
import { checkVerificationStart } from '@/lib/messaging/verify-limits';
import { createOwnerPhoneChallenge } from '@/lib/messaging/owner-verify';
import { sendOwnerVerificationCode } from '@/lib/messaging';
import { vetForwardNumber } from '@/lib/voice/forward-vet';
import { actorOf, announceCallHandlingChange } from '@/lib/voice/call-handling-changes';
import { smsDelivered, SMS_PROVIDER_NOT_CONFIGURED } from '@/lib/messaging/delivery';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('forward-number');
const bad = (error: string, status: number, headers?: Record<string, string>) => NextResponse.json({ ok: false as const, error }, { status, headers });

/**
 * POST /api/businesses/:id/forward-number/verify/start   { phone }
 * Same flow and abuse limits as owner-phone verification (messaging/verify-limits: per business, number, user, IP and
 * platform-wide caps; opted-out numbers refused; needs a verified email), with its own challenge purpose so a code issued here
 * can never confirm the owner phone. The number must pass validateForwardNumber (E.164, allowed country, not premium /
 * short code / the business's own line). It is stored UNVERIFIED and never dialled until /confirm succeeds.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ phone?: unknown }>(req).catch(() => ({} as { phone?: unknown }));
    const business = await getBusiness(id);
    if (!business) return bad('business not found', 404);

    const country = countryForBusiness(business);
    const check = await vetForwardNumber(business, body.phone);
    if (!check.ok) return bad(check.error, 422);
    const e164 = check.e164;
    const stale = requireRecentAuth(auth);
    if (stale) return stale;
    if (await isOptedOut(id, e164, country)) return bad('that number opted out of texts from this business', 422);

    const denied = await checkVerificationStart({
      req, businessId: id, e164, userId: auth.principal.user?.id ?? null, isAdmin: auth.principal.kind === 'admin', purpose: 'forward-number',
    });
    if (denied) return bad(denied.error, denied.status, denied.retryAfterS ? { 'retry-after': String(denied.retryAfterS) } : undefined);

    const { code, challenge, expires_at } = createOwnerPhoneChallenge(id, e164, Date.now(), 'forward-number');
    const sent = await sendOwnerVerificationCode(id, e164, code, 'forward-number');
    if (sent.blocked || !smsDelivered(sent.result.status)) {
      if (sent.result.error === SMS_PROVIDER_NOT_CONFIGURED || sent.result.status === 'mock') return bad(SMS_PROVIDER_NOT_CONFIGURED, 503);
      log.warn('verify.start_failed', { business: id, blocked: sent.blocked ?? null, error: sent.result.error ?? null });
      const country403 = sent.result.error === 'destination country is not allowed';
      return bad(country403 ? 'texts to that country are not enabled for this account' : 'could not send the verification text', country403 ? 422 : 502);
    }
    // Remember the (unverified) number so the dashboard shows what is pending; a different number drops 'forward' back to 'ai'.
    try {
      const change = await setForwardNumberUnverified(id, e164, e164);
      // A different number silently dropped 'forward' back to 'ai': audit that transition and tell the owners.
      if (change) await announceCallHandlingChange({ business: (await getBusiness(id)) ?? business, actor: actorOf(auth), ip: clientKey(req), change, reason: 'forward_number_replaced' });
    } catch (err) {
      if (err instanceof ForwardNumberRejectedError) return bad(err.message, 422);
      throw err;
    }
    return NextResponse.json({ ok: true as const, challenge, expires_at });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    log.error('verify.start_error', { err });
    return bad('internal error', 500);
  }
}
