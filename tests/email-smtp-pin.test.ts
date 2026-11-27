/**
 * M3: the SMTP send path (a relay set from the console) resolves the host ONCE, validates every answer and connects to that address with the original name as the TLS servername,
 * so there is no second lookup a rebinding DNS server could answer differently. An operator-pinned SMTP_HOST (environment) is trusted and untouched.
 */
import * as bunTest from 'bun:test';
import * as realDns from 'node:dns/promises';
import * as realNodemailer from 'nodemailer';

const { afterAll, describe, expect, test } = bunTest;
const mock = (bunTest as unknown as { mock: { module: (id: string, factory: () => unknown) => void } }).mock;

let answers: string[] = ['8.8.4.4'];
let lookups = 0;
mock.module('node:dns/promises', () => {
  const lookup = async () => { lookups++; return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
  return { default: { lookup }, lookup };
});
const transports: Record<string, unknown>[] = [];
mock.module('nodemailer', () => {
  const createTransport = (o: Record<string, unknown>) => {
    transports.push(o);
    return { sendMail: async () => ({ messageId: '<m1>' }), close: () => undefined };
  };
  return { default: { createTransport }, createTransport };
});

// module mocks are process-wide in bun: put the real modules back for every other test file
afterAll(() => {
  mock.module('node:dns/promises', () => realDns);
  mock.module('nodemailer', () => realNodemailer);
});

describe('SMTP send: pinned to the validated address', () => {
  const msg = { to: 'a@example.com', subject: 'hi', text: 'hello' };
  const consoleEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'App <app@example.com>', SMTP_HOST: 'smtp.relay.example', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', ...over } as NodeJS.ProcessEnv);

  test('connects to the resolved address, keeps the name for the certificate, looks the name up exactly once', async () => {
    const { sendEmail } = await import('../src/lib/email');
    transports.length = 0; lookups = 0; answers = ['8.8.4.4'];
    const r = await sendEmail(msg, consoleEnv());
    expect(r).toEqual({ provider: 'smtp', id: '<m1>' });
    expect(lookups).toBe(1);
    expect(transports).toHaveLength(1);
    expect(transports[0]).toMatchObject({ host: '8.8.4.4', port: 587, tls: { servername: 'smtp.relay.example' }, auth: { user: 'u', pass: 'p' } });
  });
  test('the URL form is pinned the same way and keeps its login and implicit TLS', async () => {
    const { sendEmail } = await import('../src/lib/email');
    transports.length = 0; lookups = 0; answers = ['8.8.4.4'];
    await sendEmail(msg, consoleEnv({ SMTP_HOST: '', SMTP_URL: 'smtps://user:pa%20ss@smtp.relay.example:465' }));
    expect(transports[0]).toMatchObject({ host: '8.8.4.4', port: 465, secure: true, tls: { servername: 'smtp.relay.example' }, auth: { user: 'user', pass: 'pa ss' } });
    expect(lookups).toBe(1);
  });
  test('a private answer, or a private answer among public ones, is refused and nothing connects', async () => {
    const { sendEmail } = await import('../src/lib/email');
    for (const bad of [['127.0.0.1'], ['8.8.4.4', '::ffff:7f00:1'], ['0:0:0:0:0:0:0:1'], ['169.254.169.254']]) {
      transports.length = 0; answers = bad;
      await expect(sendEmail(msg, consoleEnv())).rejects.toThrow(/smtp send failed/);
      expect(transports).toHaveLength(0);
    }
  });
});
