/**
 * Transactional email. Node runtime only (never import from proxy.ts).
 *
 *   EMAIL_PROVIDER = resend | smtp | log
 *
 *   resend  REST API via fetch (RESEND_API_KEY, EMAIL_FROM)
 *   smtp    nodemailer (SMTP_URL, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE; EMAIL_FROM)
 *   log     writes the message (including its link) to the application log. Development default.
 *           REFUSED in production: the links are credentials.
 *
 * In production an unset provider fails closed with EmailConfigError (callers answer 503) instead of
 * pretending the mail went out. Any send failure throws EmailSendError.
 */
import { configEnv, pinnedByEnv } from '@/lib/config';
import { assertPublicSmtpTarget, smtpTargetOfUrl } from '@/lib/admin/ssrf';
import { logger } from '@/lib/log';

const log = logger('email');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  provider: EmailProvider;
  /** Provider message id when it returned one. */
  id: string | null;
}

export type EmailProvider = 'resend' | 'smtp' | 'log';

/** Email is not (correctly) configured. Surface as 503 "email not configured". */
export class EmailConfigError extends Error {
  readonly code = 'email_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

/** The provider accepted no delivery (network error, timeout, 4xx/5xx). Surface as 502/503. */
export class EmailSendError extends Error {
  readonly code = 'email_send_failed';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EmailSendError';
  }
}

const SEND_TIMEOUT_MS = 10_000;
const ADDRESS = /^[^\s<>@,;"']+@[^\s<>@,;"']+\.[^\s<>@,;"']+$/;

/** Which provider will be used, or throws EmailConfigError. Does not send anything. */
export function resolveEmailProvider(env: NodeJS.ProcessEnv = configEnv()): EmailProvider {
  const production = env.NODE_ENV === 'production';
  const raw = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (!raw) {
    if (production) throw new EmailConfigError('EMAIL_PROVIDER is not set (resend or smtp required in production)');
    return 'log';
  }
  if (raw !== 'resend' && raw !== 'smtp' && raw !== 'log') {
    throw new EmailConfigError(`EMAIL_PROVIDER must be resend, smtp or log (got "${raw}")`);
  }
  if (raw === 'log') {
    if (production) throw new EmailConfigError('EMAIL_PROVIDER=log is not allowed in production');
    return 'log';
  }
  if (!(env.EMAIL_FROM ?? '').trim()) throw new EmailConfigError('EMAIL_FROM is required');
  if (raw === 'resend' && !(env.RESEND_API_KEY ?? '').trim()) throw new EmailConfigError('RESEND_API_KEY is required');
  if (raw === 'smtp' && !(env.SMTP_URL ?? '').trim() && !(env.SMTP_HOST ?? '').trim()) {
    throw new EmailConfigError('SMTP_URL or SMTP_HOST is required');
  }
  return raw;
}

/** True when email can be sent (a real provider, or the dev log provider). Never throws. */
export function emailConfigured(env: NodeJS.ProcessEnv = configEnv()): boolean {
  try {
    resolveEmailProvider(env);
    return true;
  } catch {
    return false;
  }
}

function validate(msg: EmailMessage): void {
  if (!ADDRESS.test(msg.to) || msg.to.length > 254) throw new EmailSendError('invalid recipient address');
  if (/[\r\n]/.test(msg.subject) || !msg.subject.trim()) throw new EmailSendError('invalid subject');
  if (!msg.text.trim()) throw new EmailSendError('empty body');
}

/**
 * `env`: the transport configuration to send through (default: the live configuration). The admin console's notifications pass the configuration that was
 * active BEFORE a change (or the raw environment), so a notification about an email-provider change never travels over the provider being changed.
 */
export async function sendEmail(msg: EmailMessage, env: NodeJS.ProcessEnv = configEnv()): Promise<EmailResult> {
  const provider = resolveEmailProvider(env); // throws EmailConfigError first: config problems beat input problems
  validate(msg);
  if (provider === 'log') return sendLog(msg);
  if (provider === 'resend') return sendResend(msg, env);
  return sendSmtp(msg, env);
}

function sendLog(msg: EmailMessage): EmailResult {
  const link = msg.text.match(/https?:\/\/\S+/)?.[0] ?? null;
  log.info('email.logged', { to: msg.to, subject: msg.subject, link });
  return { provider: 'log', id: null };
}

async function sendResend(msg: EmailMessage, env: NodeJS.ProcessEnv): Promise<EmailResult> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('email.resend_failed', { error: (err as Error).name });
    throw new EmailSendError('resend request failed');
  }
  if (!res.ok) {
    log.warn('email.resend_rejected', { status: res.status });
    throw new EmailSendError(`resend rejected the message (${res.status})`, res.status);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return { provider: 'resend', id: typeof body.id === 'string' ? body.id : null };
}

async function sendSmtp(msg: EmailMessage, env: NodeJS.ProcessEnv): Promise<EmailResult> {
  try {
    // SSRF (24e T3): a relay set from the CONSOLE must be a public address on an SMTP port, re-checked at every connect (DNS may have changed since it was saved).
    // An operator's own SMTP_HOST / SMTP_URL (environment pin, e.g. a local relay) is trusted as before.
    if (!pinnedByEnv('SMTP_HOST') && !pinnedByEnv('SMTP_URL')) {
      const rawUrl = (env.SMTP_URL ?? '').trim();
      const target = rawUrl ? smtpTargetOfUrl(rawUrl) : { host: env.SMTP_HOST ?? '', port: Number(env.SMTP_PORT) || 587 };
      if (!target) throw new Error('smtp target refused');
      await assertPublicSmtpTarget(target.host, target.port);
    }
    const nodemailer = await import('nodemailer');
    const timeouts = { connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS * 2 };
    const url = (env.SMTP_URL ?? '').trim();
    const transport = url
      // nodemailer parses a `url` option like a connection string and still honours the timeouts beside it
      ? nodemailer.createTransport({ url, ...timeouts } as unknown as import('nodemailer').TransportOptions)
      : nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT) || 587,
          secure: env.SMTP_SECURE === 'true',
          ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
          ...timeouts,
        });
    const info = await transport.sendMail({ from: env.EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
    transport.close();
    return { provider: 'smtp', id: typeof info.messageId === 'string' ? info.messageId : null };
  } catch (err) {
    log.warn('email.smtp_failed', { error: (err as Error).message });
    throw new EmailSendError('smtp send failed');
  }
}
