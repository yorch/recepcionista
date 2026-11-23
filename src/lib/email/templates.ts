/**
 * Email bodies for the account lifecycle: plain text plus a simple HTML alternative.
 * Every interpolated value is HTML-escaped in the HTML part; links are built from APP_URL /
 * PUBLIC_BASE_URL and the raw token is URL-encoded. Pure functions (no I/O).
 */
import { EmailConfigError } from './index';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const escapeHtml = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Public origin of the app: PUBLIC_BASE_URL, else APP_URL. Required in production; localhost elsewhere. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PUBLIC_BASE_URL || env.APP_URL || '').trim().replace(/\/+$/, '');
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

function wrap(title: string, paragraphs: string[], link: string, cta: string, footer: string): string {
  const p = paragraphs.map((t) => `<p style="margin:0 0 12px">${escapeHtml(t)}</p>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">`
    + `<h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>${p}`
    + `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(cta)}</a></p>`
    + `<p style="margin:0 0 12px;font-size:13px;color:#555">If the button does not work, copy this address into your browser:<br>${escapeHtml(link)}</p>`
    + `<p style="margin:0;font-size:13px;color:#555">${escapeHtml(footer)}</p></body></html>`;
}

export function verifyEmailTemplate(opts: { link: string; ttlHours?: number }): RenderedEmail {
  const hours = opts.ttlHours ?? 24;
  const lines = ['Confirm your email address to finish setting up your Recepcionista account.', `This link works once and expires in ${hours} hours.`];
  const footer = 'If you did not create an account, ignore this message.';
  return {
    subject: 'Confirm your email address',
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap('Confirm your email', lines, opts.link, 'Confirm email', footer),
  };
}

export function resetPasswordTemplate(opts: { link: string; ttlMinutes?: number }): RenderedEmail {
  const minutes = opts.ttlMinutes ?? 60;
  const lines = ['We received a request to reset your Recepcionista password.', `This link works once and expires in ${minutes} minutes. Using it signs you out everywhere.`];
  const footer = 'If you did not ask for this, ignore this message: your password has not changed.';
  return {
    subject: 'Reset your password',
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap('Reset your password', lines, opts.link, 'Choose a new password', footer),
  };
}

/**
 * A tenant-chosen name rendered inside a platform email must not carry a phishing payload: URLs, e-mail addresses and
 * phone-number-like digit runs are removed, control characters flattened, the length capped. Callers still QUOTE it.
 */
export function safeDisplayName(name: string, max = 60): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|us|app|dev|xyz|info|biz|ly|me|to|gl|link|click|top)(?:\/\S*)?\b/gi, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max).trim() || 'a Recepcionista account';
}

export function inviteTemplate(opts: { link: string; businessName: string; inviterEmail?: string | null; role: 'owner' | 'staff'; ttlDays?: number }): RenderedEmail {
  const days = opts.ttlDays ?? 7;
  const who = opts.inviterEmail ? `${opts.inviterEmail} invited you` : 'You were invited';
  // The business name is tenant-controlled text: sanitised, quoted as "an account named", and never put in the subject.
  const lines = [`${who} to join an account named \u201c${safeDisplayName(opts.businessName)}\u201d on Recepcionista as ${opts.role}.`, `This invitation works once and expires in ${days} days.`];
  const footer = 'If you were not expecting this invitation, ignore this message.';
  return {
    subject: 'You are invited to join a Recepcionista account',
    text: `${lines.join('\n\n')}\n\n${opts.link}\n\n${footer}\n`,
    html: wrap('You are invited', lines, opts.link, 'Accept invitation', footer),
  };
}
