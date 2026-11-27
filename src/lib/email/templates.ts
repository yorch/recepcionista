/**
 * Email bodies for the account lifecycle: plain text plus a simple HTML alternative.
 * Every interpolated value is HTML-escaped in the HTML part; links are built from APP_URL /
 * PUBLIC_BASE_URL and the raw token is URL-encoded. Pure functions (no I/O).
 */
import { EmailConfigError } from './index';
import { makeT } from '@/lib/i18n';
import type { Locale, TFunction } from '@/lib/i18n/core';
import { configuredBaseUrl } from '@/lib/base-url';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const escapeHtml = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Public origin of the app (the single resolver: APP_URL, else PUBLIC_BASE_URL). Required in production; localhost elsewhere. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = configuredBaseUrl(env);
  if (base) return base;
  if (env.NODE_ENV === 'production') throw new EmailConfigError('APP_URL (or PUBLIC_BASE_URL) is required to build email links');
  return 'http://localhost:3000';
}

/** `<base><path>?token=<token>` (path must start with '/'). */
export function emailLink(path: string, token: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!path.startsWith('/')) throw new Error('emailLink: path must start with /');
  return `${appBaseUrl(env)}${path}?token=${encodeURIComponent(token)}`;
}

export const VERIFY_PATH = '/verify-email';
export const RESET_PATH = '/reset-password';
export const INVITE_PATH = '/accept-invite';

function wrap(title: string, paragraphs: string[], link: string, cta: string, footer: string, t: TFunction): string {
  const p = paragraphs.map((x) => `<p style="margin:0 0 12px">${escapeHtml(x)}</p>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">`
    + `<h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>${p}`
    + `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(cta)}</a></p>`
    + `<p style="margin:0 0 12px;font-size:13px;color:#555">${escapeHtml(t('mail.cta.fallback'))}<br>${escapeHtml(link)}</p>`
    + `<p style="margin:0;font-size:13px;color:#555">${escapeHtml(footer)}</p></body></html>`;
}

export function verifyEmailTemplate(opts: { link: string; ttlHours?: number; locale?: Locale }): RenderedEmail {
  const t = makeT(opts.locale ?? 'en');
  const hours = opts.ttlHours ?? 24;
  const lines = [t('mail.verify.l1'), t('mail.verify.l2', { hours })];
  const footer = t('mail.verify.footer');
  return {
    subject: t('mail.verify.subject'),
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap(t('mail.verify.title'), lines, opts.link, t('mail.verify.cta'), footer, t),
  };
}

export function resetPasswordTemplate(opts: { link: string; ttlMinutes?: number; locale?: Locale }): RenderedEmail {
  const t = makeT(opts.locale ?? 'en');
  const minutes = opts.ttlMinutes ?? 60;
  const lines = [t('mail.reset.l1'), t('mail.reset.l2', { minutes })];
  const footer = t('mail.reset.footer');
  return {
    subject: t('mail.reset.subject'),
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap(t('mail.reset.title'), lines, opts.link, t('mail.reset.cta'), footer, t),
  };
}

/**
 * A tenant-chosen name rendered inside a platform email must not carry a phishing payload: URLs, e-mail addresses and
 * phone-number-like digit runs are removed, control characters flattened, the length capped. Callers still QUOTE it.
 */
export function safeDisplayName(name: string, max = 60, locale: Locale = 'en'): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|us|app|dev|xyz|info|biz|ly|me|to|gl|link|click|top)(?:\/\S*)?\b/gi, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max).trim() || makeT(locale)('mail.fallbackName');
}

export function inviteTemplate(opts: { link: string; businessName: string; inviterEmail?: string | null; role: 'owner' | 'staff'; ttlDays?: number; locale?: Locale }): RenderedEmail {
  const locale = opts.locale ?? 'en';
  const t = makeT(locale);
  const days = opts.ttlDays ?? 7;
  const who = opts.inviterEmail ? t('mail.invite.who', { email: opts.inviterEmail }) : t('mail.invite.whoAnon');
  // The business name is tenant-controlled text: sanitised, quoted as "an account named", and never put in the subject.
  const lines = [t('mail.invite.l1', { who, business: safeDisplayName(opts.businessName, 60, locale), role: t(opts.role === 'owner' ? 'mail.role.owner' : 'mail.role.staff') }), t('mail.invite.l2', { days })];
  const footer = t('mail.invite.footer');
  return {
    subject: t('mail.invite.subject'),
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap(t('mail.invite.title'), lines, opts.link, t('mail.invite.cta'), footer, t),
  };
}
