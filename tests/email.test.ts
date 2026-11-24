import { afterEach, describe, expect, test } from 'bun:test';
import { emailConfigured, EmailConfigError, EmailSendError, resolveEmailProvider, sendEmail } from '../src/lib/email';
import { appBaseUrl, emailLink, escapeHtml, inviteTemplate, resetPasswordTemplate, verifyEmailTemplate } from '../src/lib/email/templates';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('provider resolution', () => {
  test('dev default is log; production fails closed', () => {
    expect(resolveEmailProvider(env({ NODE_ENV: 'development' }))).toBe('log');
    expect(() => resolveEmailProvider(env({ NODE_ENV: 'production' }))).toThrow(EmailConfigError);
    expect(() => resolveEmailProvider(env({ NODE_ENV: 'production', EMAIL_PROVIDER: 'log' }))).toThrow(EmailConfigError);
    expect(emailConfigured(env({ NODE_ENV: 'production' }))).toBe(false);
  });
  test('resend and smtp need their settings and EMAIL_FROM', () => {
    expect(() => resolveEmailProvider(env({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }))).toThrow(/EMAIL_FROM/);
    expect(() => resolveEmailProvider(env({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co' }))).toThrow(/RESEND_API_KEY/);
    expect(resolveEmailProvider(env({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.co', RESEND_API_KEY: 'k', NODE_ENV: 'production' }))).toBe('resend');
    expect(() => resolveEmailProvider(env({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.co' }))).toThrow(/SMTP/);
    expect(resolveEmailProvider(env({ EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.co', SMTP_URL: 'smtp://x' }))).toBe('smtp');
    expect(() => resolveEmailProvider(env({ EMAIL_PROVIDER: 'carrier-pigeon' }))).toThrow(EmailConfigError);
  });
});

describe('sendEmail', () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    globalThis.fetch = realFetch;
  });

  test('resend: posts JSON with bearer key and maps failures to EmailSendError', async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'App <no-reply@x.co>', RESEND_API_KEY: 'rk_1' });
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendEmail({ to: 'u@x.com', subject: 'Hi', text: 'body' });
    expect(r).toEqual({ provider: 'resend', id: 'em_1' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer rk_1');
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ to: ['u@x.com'], subject: 'Hi' });
    expect(calls[0].init.signal).toBeDefined();

    globalThis.fetch = (async () => new Response('no', { status: 422 })) as unknown as typeof fetch;
    await expect(sendEmail({ to: 'u@x.com', subject: 'Hi', text: 'b' })).rejects.toBeInstanceOf(EmailSendError);
    globalThis.fetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(sendEmail({ to: 'u@x.com', subject: 'Hi', text: 'b' })).rejects.toBeInstanceOf(EmailSendError);
  });

  test('rejects header injection and bad recipients; config errors come first', async () => {
    process.env.EMAIL_PROVIDER = 'log';
    await expect(sendEmail({ to: 'u@x.com', subject: 'a\r\nBcc: z@z.com', text: 'b' })).rejects.toBeInstanceOf(EmailSendError);
    await expect(sendEmail({ to: 'u@x.com, v@x.com', subject: 'a', text: 'b' })).rejects.toBeInstanceOf(EmailSendError);
    await expect(sendEmail({ to: 'u@x.com', subject: 'a', text: 'http://l/x' })).resolves.toEqual({ provider: 'log', id: null });
    process.env.EMAIL_PROVIDER = 'bogus';
    await expect(sendEmail({ to: 'u@x.com', subject: 'a', text: 'b' })).rejects.toBeInstanceOf(EmailConfigError);
  });
});

describe('templates', () => {
  test('links come from PUBLIC_BASE_URL then APP_URL; token is encoded', () => {
    expect(emailLink('/verify-email', 'a+b/c', env({ APP_URL: 'https://app.x.com/' }))).toBe('https://app.x.com/verify-email?token=a%2Bb%2Fc');
    expect(appBaseUrl(env({ PUBLIC_BASE_URL: 'https://pub.x.com', APP_URL: 'https://app.x.com' }))).toBe('https://pub.x.com');
    expect(() => appBaseUrl(env({ NODE_ENV: 'production' }))).toThrow(EmailConfigError);
    expect(appBaseUrl(env({}))).toBe('http://localhost:3000');
  });
  test('every interpolation is escaped in HTML', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const t = inviteTemplate({ link: 'https://x.co/a?token=1&y="2"', businessName: evil, inviterEmail: evil, role: 'staff' });
    expect(t.html).not.toContain('<img');
    expect(t.html).toContain(escapeHtml(evil));
    expect(t.html).toContain('token=1&amp;y=&quot;2&quot;');
    expect(t.subject).not.toMatch(/[\r\n]/);
    expect(t.text).toContain('https://x.co/a?token=1&y="2"');
  });
  test('verify and reset contain the link in both parts', () => {
    for (const t of [verifyEmailTemplate({ link: 'https://x.co/t?token=abc' }), resetPasswordTemplate({ link: 'https://x.co/t?token=abc' })]) {
      expect(t.text).toContain('https://x.co/t?token=abc');
      expect(t.html).toContain('https://x.co/t?token=abc');
      expect(t.subject.length).toBeGreaterThan(5);
    }
  });
});
