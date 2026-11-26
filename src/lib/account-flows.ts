/**
 * Shared plumbing for the account-lifecycle routes (signup, verify, reset, invite): rate-limit helpers,
 * "run after the response" so public endpoints take the same time whether or not an address has an
 * account, and the transactional emails with their single-use links. Node runtime only.
 */
import { after } from 'next/server';
import { clientKey } from '@/lib/auth';
import { createEmailToken } from '@/lib/db/email-tokens';
import { recordAudit } from '@/lib/db';
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
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
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
export async function sendVerificationEmail(user: { id: string; email: string; locale?: Locale }): Promise<void> {
  const { token } = await createEmailToken({ purpose: 'verify', email: user.email, user_id: user.id });
  const t = verifyEmailTemplate({ link: emailLink(VERIFY_PATH, token), locale: user.locale });
  await deliver({ to: user.email, ...t });
}

/**
 * The deferred (after-the-response) verification mail of a public route. The response cannot say whether it went out (the answer must be the same
 * for every address), so a FAILURE must be visible somewhere else: an error log and an audit row (`auth.verification_email_failed`: user and
 * error class only, never the address or the token). The person can always ask again (the resend form, or the banner once signed in), and an
 * operator sees the outage instead of a silent "sent". Never throws.
 */
export async function sendVerificationEmailReported(user: { id: string; email: string; locale?: Locale }, source: 'signup' | 'resend'): Promise<boolean> {
  try {
    await sendVerificationEmail(user);
    return true;
  } catch (err) {
    const kind = err instanceof EmailConfigError ? 'email_not_configured' : err instanceof EmailSendError ? 'email_send_failed' : 'error';
    log.error('verification_email_failed', { source, user: user.id, kind });
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, action: 'auth.verification_email_failed', target: `user:${user.id}`, meta: { source, kind },
    }).catch(() => undefined);
    return false;
  }
}

/** Issue a one-hour, single-use reset link and mail it. */
export async function sendPasswordResetEmail(user: { id: string; email: string; locale?: Locale }): Promise<void> {
  const { token } = await createEmailToken({ purpose: 'reset', email: user.email, user_id: user.id });
  const t = resetPasswordTemplate({ link: emailLink(RESET_PATH, token), locale: user.locale });
  await deliver({ to: user.email, ...t });
}

/** Mail an invitation. `token` comes from createEmailToken({ purpose: 'invite', ... }). `locale`: the business's default language (the invitee has no account yet). */
export async function sendInviteEmail(opts: {
  email: string; token: string; businessName: string; role: 'owner' | 'staff'; inviterEmail?: string | null; locale?: Locale;
}): Promise<void> {
  const t = inviteTemplate({ link: emailLink(INVITE_PATH, opts.token), businessName: opts.businessName, inviterEmail: opts.inviterEmail ?? null, role: opts.role, locale: opts.locale });
  await deliver({ to: opts.email, ...t });
}

function plainMail(subject: string, lines: string[], footer: string): { subject: string; text: string; html: string } {
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">`
    + lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('')
    + `<p style="margin:0;font-size:13px;color:#555">${escapeHtml(footer)}</p></body></html>`;
  return { subject, text: `${lines.join('\n\n')}\n\n${footer}\n`, html };
}

/** Sent instead of a verification mail when someone signs up with an address that already has an account. `locale`: the language of the signup request. */
export async function sendSignupExistsNotice(email: string, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const m = plainMail(t('mail.exists.subject'), [t('mail.exists.l1'), t('mail.exists.l2', { url: `${appBaseUrl()}/login` })], t('mail.exists.footer'));
  await deliver({ to: email, ...m });
}

/** Security notice after a password reset/change. */
export async function sendPasswordChangedNotice(email: string, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const m = plainMail(t('mail.pwChanged.subject'), [t('mail.pwChanged.l1')], t('mail.pwChanged.footer', { url: `${appBaseUrl()}/forgot-password` }));
  await deliver({ to: email, ...m });
}

/** Security notice when two-factor authentication is switched on or off. */
export async function sendTwoFactorNotice(email: string, enabled: boolean, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const m = plainMail(t(enabled ? 'mail.2fa.on.subject' : 'mail.2fa.off.subject'), [t(enabled ? 'mail.2fa.on.l1' : 'mail.2fa.off.l1')], t('mail.2fa.footer'));
  await deliver({ to: email, ...m });
}

/** Sent when the second-factor step of an account keeps getting wrong codes (the password is probably known to someone else). */
export async function sendMfaFailuresNotice(email: string, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const m = plainMail(t('mail.mfaFail.subject'), [t('mail.mfaFail.l1'), t('mail.mfaFail.l2')], t('mail.mfaFail.footer', { url: `${appBaseUrl()}/forgot-password` }));
  await deliver({ to: email, ...m });
}

/** Security notice when a passkey is added to or removed from the account. */
export async function sendPasskeyNotice(email: string, change: 'added' | 'removed', name: string, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const label = name.replace(/[\r\n]+/g, ' ').slice(0, 80);
  const m = plainMail(t(change === 'added' ? 'mail.pk.added.subject' : 'mail.pk.removed.subject'), [t(change === 'added' ? 'mail.pk.added.l1' : 'mail.pk.removed.l1', { name: label })], t('mail.pk.footer', { url: `${appBaseUrl()}/forgot-password` }));
  await deliver({ to: email, ...m });
}

/** Sent when a passkey's signature counter went backwards (the authenticator was probably cloned): every session was signed out. */
export async function sendPasskeyCloneNotice(email: string, name: string, locale: Locale = 'en'): Promise<void> {
  const t = makeT(locale);
  const label = name.replace(/[\r\n]+/g, ' ').slice(0, 80);
  const m = plainMail(t('mail.pkClone.subject'), [t('mail.pkClone.l1', { name: label }), t('mail.pkClone.l2')], t('mail.pkClone.footer', { url: `${appBaseUrl()}/forgot-password` }));
  await deliver({ to: email, ...m });
}
