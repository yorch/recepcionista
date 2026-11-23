/**
 * Shared plumbing for the account-lifecycle routes (signup, verify, reset, invite): rate-limit helpers,
 * "run after the response" so public endpoints take the same time whether or not an address has an
 * account, and the transactional emails with their single-use links. Node runtime only.
 */
import { after } from 'next/server';
import { clientKey } from '@/lib/auth';
import { createEmailToken } from '@/lib/db/email-tokens';
import { accountId } from '@/lib/login-throttle';
import { limitRequest, rateLimit } from '@/lib/ratelimit';
import { normalizeEmail } from '@/lib/db/users';
import {
  EmailConfigError, EmailSendError, sendEmail, type EmailMessage,
} from '@/lib/email';
import {
  emailLink, escapeHtml, INVITE_PATH, inviteTemplate, RESET_PATH, resetPasswordTemplate, VERIFY_PATH, verifyEmailTemplate,
  appBaseUrl,
} from '@/lib/email/templates';
import { logger } from '@/lib/log';

const log = logger('account-flows');

export const HOUR_MS = 60 * 60_000;

/**
 * Run `fn` after the response is sent (Next `after()`), so a public endpoint's latency does not depend on
 * whether an email was actually sent. Outside a request scope (unit tests, scripts) it simply runs inline.
 * Never throws: failures are logged without the payload.
 */
export async function afterResponse(label: string, fn: () => Promise<unknown>): Promise<void> {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      log.warn('deferred_failed', { label, error: err instanceof Error ? err.name : 'unknown' });
    }
  };
  try {
    after(run);
  } catch {
    await run();
  }
}

/**
 * Per-client-IP limiter for a public route. Without TRUSTED_PROXY every client shares the `untrusted` key,
 * so the cap is multiplied (like the login limiter) instead of becoming a platform-wide switch. Fails closed.
 */
export function limitIp(req: Request, route: string, perWindow: number, windowMs = HOUR_MS): Promise<Response | null> {
  const limit = clientKey(req) === 'untrusted' ? perWindow * 20 : perWindow;
  return limitRequest(req, route, limit, windowMs, { failClosed: true });
}

/** Per-address limiter (the address is hashed into the key). True when the attempt is allowed. Fails closed. */
export async function allowPerEmail(route: string, email: string, limit: number, windowMs = HOUR_MS): Promise<boolean> {
  const r = await rateLimit(`${route}:email:${accountId(normalizeEmail(email))}`, limit, windowMs, { failClosed: true });
  return r.allowed;
}

/** Client address for audit rows (null behind no trusted proxy: the shared "untrusted" key is not an address). */
export function auditIp(req: Request): string | null {
  const k = clientKey(req);
  return k === 'untrusted' ? null : k;
}

export function userAgentOf(req: Request): string | null {
  return req.headers.get('user-agent');
}

/** Map an email failure to a response body for ADMIN-FACING actions (owner/admin invites): the cause is shown. */
export function emailFailure(err: unknown): { status: 503; error: 'email_not_configured' | 'email_send_failed' } | null {
  if (err instanceof EmailConfigError) return { status: 503, error: 'email_not_configured' };
  if (err instanceof EmailSendError) return { status: 503, error: 'email_send_failed' };
  return null;
}

async function deliver(msg: EmailMessage): Promise<void> {
  await sendEmail(msg);
}

/** Issue a fresh verification link (older ones stop working) and mail it. Throws EmailConfigError/EmailSendError. */
export async function sendVerificationEmail(user: { id: string; email: string }): Promise<void> {
  const { token } = await createEmailToken({ purpose: 'verify', email: user.email, user_id: user.id });
  const t = verifyEmailTemplate({ link: emailLink(VERIFY_PATH, token) });
  await deliver({ to: user.email, ...t });
}

/** Issue a one-hour, single-use reset link and mail it. */
export async function sendPasswordResetEmail(user: { id: string; email: string }): Promise<void> {
  const { token } = await createEmailToken({ purpose: 'reset', email: user.email, user_id: user.id });
  const t = resetPasswordTemplate({ link: emailLink(RESET_PATH, token) });
  await deliver({ to: user.email, ...t });
}

/** Mail an invitation. `token` comes from createEmailToken({ purpose: 'invite', ... }). */
export async function sendInviteEmail(opts: {
  email: string; token: string; businessName: string; role: 'owner' | 'staff'; inviterEmail?: string | null;
}): Promise<void> {
  const t = inviteTemplate({ link: emailLink(INVITE_PATH, opts.token), businessName: opts.businessName, inviterEmail: opts.inviterEmail ?? null, role: opts.role });
  await deliver({ to: opts.email, ...t });
}

function plainMail(subject: string, lines: string[], footer: string): { subject: string; text: string; html: string } {
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">`
    + lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('')
    + `<p style="margin:0;font-size:13px;color:#555">${escapeHtml(footer)}</p></body></html>`;
  return { subject, text: `${lines.join('\n\n')}\n\n${footer}\n`, html };
}

/** Sent instead of a verification mail when someone signs up with an address that already has an account. */
export async function sendSignupExistsNotice(email: string): Promise<void> {
  const m = plainMail(
    'Someone tried to create an account with your email',
    [
      'Someone just tried to sign up for Recepcionista with this email address, but it already has an account.',
      `If that was you, sign in instead (${appBaseUrl()}/login) or reset your password if you forgot it.`,
    ],
    'If it was not you, you can ignore this message: nothing changed.',
  );
  await deliver({ to: email, ...m });
}

/** Security notice after a password reset/change. */
export async function sendPasswordChangedNotice(email: string): Promise<void> {
  const m = plainMail(
    'Your password was changed',
    ['The password for your Recepcionista account was just changed and all your sessions were signed out.'],
    `If this was not you, reset your password right away at ${appBaseUrl()}/forgot-password and contact your team admin.`,
  );
  await deliver({ to: email, ...m });
}

/** Security notice when two-factor authentication is switched on or off. */
export async function sendTwoFactorNotice(email: string, enabled: boolean): Promise<void> {
  const m = plainMail(
    enabled ? 'Two-factor authentication was turned on' : 'Two-factor authentication was turned off',
    [enabled
      ? 'Two-factor authentication is now active on your Recepcionista account.'
      : 'Two-factor authentication was removed from your Recepcionista account.'],
    'If this was not you, reset your password right away and contact your team admin.',
  );
  await deliver({ to: email, ...m });
}
