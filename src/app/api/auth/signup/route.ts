import { NextResponse } from 'next/server';
import { checkSameOrigin, clientKey } from '@/lib/auth';
import {
  afterResponse, allowPerEmail, auditIp, limitIp, sendSignupExistsNotice, sendVerificationEmail,
} from '@/lib/account-flows';
import { recordAudit } from '@/lib/db';
import { emailConfigured } from '@/lib/email';
import { accountId } from '@/lib/login-throttle';
import { hashPassword } from '@/lib/password';
import { rateLimit } from '@/lib/ratelimit';
import { checkSignupCapacity, createSignupAccount, parseSignupBody, recordSignupCreated, captchaRequired, signupAvailability, verifyTurnstile } from '@/lib/signup';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/signup');

/** The one success answer: identical for a new address, an existing one and a bot that filled the honeypot. */
const accepted = () => NextResponse.json({ ok: true, data: { status: 'verification_sent' } });
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * Open self-signup: `{ email, password, business_name }` -> business (billing_status 'none', nothing paid provisioned)
 * + owner (email unverified) + verification email. Never reveals whether the address already has an account
 * (an existing one gets a "someone tried to sign up" notice, at most once an hour). No session is issued: the
 * new owner signs in after verifying (a cookie here would tell new from existing addresses apart).
 *
 * Abuse controls: per-IP and per-address Postgres limits, a honeypot field, Cloudflare Turnstile when
 * Turnstile is fully configured, secret + site key (fails closed), and graceful platform-wide capacity (SIGNUP_MAX_PER_HOUR, default 60): only
 * CREATED accounts count, each client has its own smaller share, signup degrades at 70% and stops only at 100%
 * (lib/signup checkSignupCapacity). A stale (>24h) UNVERIFIED account holding the address is replaced, so squatting a
 * victim's address never locks them out; a verified account is never replaced.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/signup', 5);
  if (limited) return limited;

  if (!signupAvailability().open) {
    // Production without a captcha (and without the explicit opt-out): public signup is off. Invites still work.
    return NextResponse.json({ ok: false, error: 'signup_disabled' }, { status: 503, headers: { 'retry-after': '3600' } });
  }

  const body = await req.json().catch(() => null);
  const input = parseSignupBody(body);
  if (!input.ok) return fail(422, input.error);
  if (input.honeypot) {
    log.warn('honeypot', {});
    return accepted(); // pretend; a bot learns nothing and nothing is created
  }

  if (captchaRequired() && !(await verifyTurnstile(input.turnstileToken, auditIp(req)))) {
    return fail(400, 'captcha_failed');
  }
  if (!(await allowPerEmail('auth/signup', input.email, 3))) return fail(429, 'too many attempts, try again later');
  const client = clientKey(req);
  const gate = await checkSignupCapacity(client);
  if (!gate.ok) {
    // A client over ITS OWN share is told so; only a genuinely exhausted platform answers "unavailable" (and that is logged loudly).
    return NextResponse.json(
      { ok: false, error: gate.reason === 'client_limit' ? 'too many attempts, try again later' : 'signups are temporarily unavailable, try again later' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfterS) } },
    );
  }
  // Same answer for every address, so a missing mail provider is not an existence oracle: refuse BEFORE creating anything.
  if (!emailConfigured()) {
    log.error('email_not_configured', {});
    return fail(503, 'signup is temporarily unavailable');
  }

  try {
    const passwordHash = await hashPassword(input.password); // always: same CPU cost for new and existing addresses
    const created = await createSignupAccount({ email: input.email, passwordHash, businessName: input.businessName });
    if (!created) {
      // Existing address: no account is touched. One notice per hour at most.
      const may = await rateLimit(`auth/signup:notice:${accountId(input.email)}`, 1, 60 * 60_000);
      await afterResponse('signup.exists_notice', async () => {
        if (may.allowed) await sendSignupExistsNotice(input.email);
      });
      return accepted();
    }
    await recordSignupCreated(client); // only accounts that were really created consume capacity
    await recordAudit({
      actor_kind: 'user', actor_user_id: created.user.id, business_id: created.businessId, action: 'auth.signup',
      target: `user:${created.user.id}`, ip: auditIp(req), ...(created.replacedStale ? { meta: { replaced_stale_unverified: true } } : {}),
    });
    await afterResponse('signup.verification', () => sendVerificationEmail(created.user));
    return accepted();
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'signup is temporarily unavailable');
  }
}

