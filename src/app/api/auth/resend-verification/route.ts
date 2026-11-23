import { NextResponse } from 'next/server';
import { checkSameOrigin } from '@/lib/auth';
import { afterResponse, allowPerEmail, emailFailure, limitIp, sendVerificationEmail } from '@/lib/account-flows';
import { getUserByEmail, normalizeEmail } from '@/lib/db';
import { authenticate } from '@/lib/session';
import { validatePublicEmail } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/resend-verification');
const generic = () => NextResponse.json({ ok: true, data: { sent: true } });
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * Send a fresh verification link. Two callers:
 *  - signed in (no body): the caller's own address; email problems are shown (503 email_not_configured).
 *  - anyone, `{ email }`: always the same generic 200 (no enumeration, no provider details), rate limited per
 *    IP and per address; the previous link is superseded.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/resend-verification', 10);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };

  if (body.email === undefined) {
    const auth = await authenticate(req, { allowEnrollment: true });
    if (!auth.ok) return auth.response;
    const { principal } = auth;
    if (!('user' in principal) || !principal.user) return fail(400, 'no email address on this credential');
    if (principal.user.email_verified_at) return NextResponse.json({ ok: true, data: { sent: false, already_verified: true } });
    if (!(await allowPerEmail('auth/resend-verification', principal.user.email, 5))) return fail(429, 'too many attempts, try again later');
    try {
      await sendVerificationEmail(principal.user);
      return generic();
    } catch (err) {
      const f = emailFailure(err);
      if (f) return NextResponse.json({ ok: false, error: f.error }, { status: f.status });
      log.error('error', { err });
      return fail(503, 'service temporarily unavailable');
    }
  }

  if (validatePublicEmail(body.email)) return generic(); // junk gets the same answer as everything else
  const email = normalizeEmail(body.email as string);
  if (!(await allowPerEmail('auth/resend-verification', email, 3))) return generic();
  try {
    const user = await getUserByEmail(email);
    if (user && !user.email_verified_at && !user.disabled_at) {
      await afterResponse('resend.verification', () => sendVerificationEmail(user));
    }
  } catch (err) {
    log.error('error', { err });
  }
  return generic();
}
