/** Pure tests for the signup/account policy: no database, no network. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import QRCode from 'qrcode';
import { validateBusinessName, validatePublicEmail, validateStrongPassword } from '../src/lib/user-policy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let signup: any, session: any, throttle: any;
const saved = { DATABASE_URL: process.env.DATABASE_URL, ADMIN_TOKEN: process.env.ADMIN_TOKEN };
beforeAll(async () => {
  process.env.DATABASE_URL ||= 'postgresql://x:x@127.0.0.1:1/none';
  process.env.ADMIN_TOKEN = 'test-admin-token-123';
  signup = await import('../src/lib/signup');
  session = await import('../src/lib/session');
  throttle = await import('../src/lib/login-throttle');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('validation', () => {
  test('passwords: length, trivial, common, equal to the email', () => {
    expect(validateStrongPassword('short')).not.toBeNull();
    expect(validateStrongPassword('a'.repeat(20))).not.toBeNull();
    expect(validateStrongPassword('Password1234')).not.toBeNull();
    expect(validateStrongPassword('x'.repeat(257))).not.toBeNull();
    expect(validateStrongPassword('maria.lopez@acme.test', 'maria.lopez@acme.test')).not.toBeNull();
    expect(validateStrongPassword('marialopez', 'marialopez@acme.test')).not.toBeNull(); // too short anyway
    expect(validateStrongPassword('correct horse battery staple', 'a@b.co')).toBeNull();
    expect(validateStrongPassword(undefined)).not.toBeNull();
  });
  test('emails', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.com']) expect(validatePublicEmail(ok)).toBeNull();
    for (const bad of ['', 'a', 'a@b', 'a b@c.co', 'a@@b.co', '<x>@b.co', 'a@b..co', '.a@b.co', 'a..b@c.co', 'a@-b.co', `${'a'.repeat(65)}@b.co`, 'a@b.co\nBcc: x@y.z', 42, null]) {
      expect([bad, validatePublicEmail(bad)].slice(1)[0]).not.toBeNull();
    }
  });
  test('business names', () => {
    expect(validateBusinessName('  Lopez   Plumbing  ')).toEqual({ ok: true, value: 'Lopez Plumbing' });
    for (const bad of ['', ' ', 'x', 'a'.repeat(121), '<b>x</b>', 'a\u0000b', 5]) expect(validateBusinessName(bad).ok).toBe(false);
  });
});

describe('parseSignupBody', () => {
  const good = { email: ' Owner@Example.COM ', password: 'correct horse battery', business_name: 'Acme  HVAC' };
  test('normalises and accepts', () => {
    expect(signup.parseSignupBody(good)).toMatchObject({ ok: true, email: 'owner@example.com', businessName: 'Acme HVAC', honeypot: false });
  });
  test('honeypot short-circuits validation (a bot learns nothing)', () => {
    expect(signup.parseSignupBody({ company_website: 'http://x', email: 'bad' })).toMatchObject({ ok: true, honeypot: true });
    expect(signup.parseSignupBody({ ...good, company_website: '   ' })).toMatchObject({ honeypot: false });
  });
  test('rejects bad input without echoing secrets', () => {
    for (const body of [null, 'x', [], { ...good, email: 'x' }, { ...good, password: 'short' }, { ...good, business_name: '' }]) {
      const r = signup.parseSignupBody(body);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('correct horse');
    }
  });
});

describe('Turnstile and caps', () => {
  const env = (o: Record<string, string>) => ({ ...o }) as unknown as NodeJS.ProcessEnv;
  test('enabled only with a secret', () => {
    expect(signup.turnstileEnabled(env({}))).toBe(false);
    expect(signup.turnstileEnabled(env({ TURNSTILE_SECRET_KEY: ' ' }))).toBe(false);
    expect(signup.turnstileEnabled(env({ TURNSTILE_SECRET_KEY: 's' }))).toBe(true);
  });
  test('verification fails closed: no token, http error, network error, timeout, success:false', async () => {
    const e = env({ TURNSTILE_SECRET_KEY: 's' });
    const json = (b: unknown, status = 200) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;
    expect(await signup.verifyTurnstile(null, null, { env: e, fetchImpl: json({ success: true }) })).toBe(false);
    expect(await signup.verifyTurnstile('t', null, { env: e, fetchImpl: json({ success: true }, 500) })).toBe(false);
    expect(await signup.verifyTurnstile('t', null, { env: e, fetchImpl: json({ success: false }) })).toBe(false);
    expect(await signup.verifyTurnstile('t', null, { env: e, fetchImpl: json('nope') })).toBe(false);
    expect(await signup.verifyTurnstile('t', null, { env: e, fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch })).toBe(false);
    expect(await signup.verifyTurnstile('t', null, { env: env({}), fetchImpl: json({ success: true }) })).toBe(false); // no secret
    expect(await signup.verifyTurnstile('t', null, { env: e, fetchImpl: json({ success: true }) })).toBe(true);
  });
  test('the secret and response go to Cloudflare as a form, with the client address', async () => {
    let seen: { url: string; body: string } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return new Response('{"success":true}');
    }) as unknown as typeof fetch;
    await signup.verifyTurnstile('tok', '203.0.113.9', { env: env({ TURNSTILE_SECRET_KEY: 'sek' }), fetchImpl: f });
    expect(seen!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(new URLSearchParams(seen!.body).get('secret')).toBe('sek');
    expect(new URLSearchParams(seen!.body).get('remoteip')).toBe('203.0.113.9');
  });
  test('SIGNUP_MAX_PER_HOUR default and bounds', () => {
    expect(signup.signupMaxPerHour(env({}))).toBe(30);
    expect(signup.signupMaxPerHour(env({ SIGNUP_MAX_PER_HOUR: '5' }))).toBe(5);
    expect(signup.signupMaxPerHour(env({ SIGNUP_MAX_PER_HOUR: '0' }))).toBe(30);
    expect(signup.signupMaxPerHour(env({ SIGNUP_MAX_PER_HOUR: 'abc' }))).toBe(30);
  });
});

describe('principal helpers', () => {
  const user = (verified: boolean) => ({ kind: 'user', role: 'owner', business_id: 'b', user: {}, email_verified: verified }) as never;
  test('requireVerifiedEmail', () => {
    expect(() => session.requireVerifiedEmail(user(false))).toThrow(session.AuthError);
    expect(() => session.requireVerifiedEmail(user(true))).not.toThrow();
    expect(() => session.requireVerifiedEmail({ kind: 'admin', via: 'token', email_verified: true } as never)).not.toThrow();
    try { session.requireVerifiedEmail(user(false)); } catch (e) { expect((e as { status: number; message: string }).status).toBe(403); expect((e as Error).message).toBe('email_not_verified'); }
  });
  test('MFA throttle keys are separate from login keys and never hold the raw id', () => {
    const r = new Request('http://x/');
    const k = throttle.mfaPairKey('user-123', r);
    expect(k.startsWith('auth/mfa:pair:')).toBe(true);
    expect(k).not.toContain('user-123');
    expect(k.endsWith(':untrusted')).toBe(true);
    expect(throttle.pairKey('user-123', r).startsWith('auth/login:pair:')).toBe(true);
  });
});

describe('QR rendering', () => {
  test('the otpauth URI renders as a server-side SVG', async () => {
    const svg = await QRCode.toString('otpauth://totp/Recepcionista:a%40b.co?secret=JBSWY3DPEHPK3PXP', { type: 'svg', margin: 1 });
    expect(svg.startsWith('<svg') || svg.includes('<svg')).toBe(true);
    expect(svg).not.toContain('<script');
  });
});
