import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: typeof import('../src/lib/auth'), s: typeof import('../src/lib/session'), proxyMod: any;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ['DATABASE_URL', 'ADMIN_TOKEN']) savedEnv[k] = process.env[k];
  process.env.DATABASE_URL ||= 'postgresql://x:x@127.0.0.1:1/none'; // never connected; only satisfies client construction
  process.env.ADMIN_TOKEN = 'test-admin-token-123';
  auth = await import('../src/lib/auth');
  s = await import('../src/lib/session');
  proxyMod = await import('../src/proxy');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const user = (role: 'owner' | 'staff', biz = 'biz_a') =>
  ({ kind: 'user', role, business_id: biz, user: { id: 'u1', email: 'a@b.co', role, business_id: biz, created_at: '', disabled_at: null, email_verified_at: '2026-01-01T00:00:00Z', phone: null, totp_enabled: false }, email_verified: true }) as import('../src/lib/session').Principal;
const admin = { kind: 'admin', via: 'token' } as import('../src/lib/session').Principal;

describe('checkSameOrigin', () => {
  test('Sec-Fetch-Site decides when present', () => {
    expect(auth.checkSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    for (const v of ['cross-site', 'same-site', 'none']) {
      expect(auth.checkSameOrigin(new Headers({ 'sec-fetch-site': v, origin: 'https://app.test', host: 'app.test' }))).toBe(false);
    }
  });
  test('Origin must match Host', () => {
    expect(auth.checkSameOrigin(new Headers({ origin: 'https://app.test', host: 'app.test' }))).toBe(true);
    expect(auth.checkSameOrigin(new Headers({ origin: 'https://evil.test', host: 'app.test' }))).toBe(false);
    expect(auth.checkSameOrigin(new Headers({ origin: 'null', host: 'app.test' }))).toBe(false);
  });
  test('x-forwarded-host only trusted behind TRUSTED_PROXY', () => {
    const h = new Headers({ origin: 'https://public.test', host: 'internal:3000', 'x-forwarded-host': 'public.test' });
    expect(auth.checkSameOrigin(h)).toBe(false);
    process.env.TRUSTED_PROXY = 'true';
    expect(auth.checkSameOrigin(h)).toBe(true);
    delete process.env.TRUSTED_PROXY;
  });
  test('missing headers: refused only when required', () => {
    expect(auth.checkSameOrigin(new Headers())).toBe(true);
    expect(auth.checkSameOrigin(new Headers(), { requirePresent: true })).toBe(false);
  });
});

describe('roles and tenant scoping', () => {
  test('role ranking', () => {
    expect(s.hasRole(user('staff'), 'staff')).toBe(true);
    expect(s.hasRole(user('staff'), 'owner')).toBe(false);
    expect(s.hasRole(user('owner'), 'owner')).toBe(true);
    expect(s.hasRole(user('owner'), 'admin')).toBe(false);
    expect(s.hasRole(admin, 'admin')).toBe(true);
    expect(() => s.requireRole(user('staff'), 'owner')).toThrow(s.AuthError);
  });
  test('requireBusinessAccess: cross-tenant is a 404, not a 403', () => {
    expect(() => s.requireBusinessAccess(user('owner'), 'biz_a')).not.toThrow();
    try {
      s.requireBusinessAccess(user('owner'), 'biz_b');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(s.AuthError);
      expect((e as InstanceType<typeof s.AuthError>).status).toBe(404);
    }
    expect(() => s.requireBusinessAccess(user('staff'), undefined)).toThrow();
    expect(() => s.requireBusinessAccess(admin, 'anything')).not.toThrow();
  });
  test('scopeBusinessId pins users, passes admins through', () => {
    expect(s.scopeBusinessId(user('owner'), undefined)).toBe('biz_a');
    expect(s.scopeBusinessId(user('owner'), 'biz_a')).toBe('biz_a');
    expect(() => s.scopeBusinessId(user('owner'), 'biz_b')).toThrow(s.AuthError);
    expect(s.scopeBusinessId(admin, 'biz_z')).toBe('biz_z');
    expect(s.scopeBusinessId(admin, undefined)).toBeNull();
  });
});

describe('admin credentials in the Node guard', () => {
  const post = (headers: Record<string, string>) => new Request('http://app.test/api/x', { method: 'POST', headers });
  test('Bearer ADMIN_TOKEN is admin and CSRF-exempt', async () => {
    const r = await s.authenticate(post({ authorization: 'Bearer test-admin-token-123' }), { role: 'admin' });
    expect(r.ok).toBe(true);
  });
  test('bad Bearer is 401 even with an admin-session-shaped cookie (no cookie fallback, no database touched)', async () => {
    const cookie = `${auth.SESSION_COOKIE}=${'a'.repeat(43)}`;
    const r = await s.authenticate(post({ authorization: 'Bearer nope', cookie, 'sec-fetch-site': 'same-origin' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });
  test('the old derived HMAC cookie no longer exists', () => {
    expect((auth as Record<string, unknown>).sessionValue).toBeUndefined();
    expect((auth as Record<string, unknown>).isAuthenticated).toBeUndefined();
  });
  test('no credentials is 401; unset ADMIN_TOKEN fails closed with 503', async () => {
    const r = await s.authenticate(new Request('http://app.test/api/x'));
    expect(!r.ok && r.response.status).toBe(401);
    const saved = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    const r2 = await s.authenticate(new Request('http://app.test/api/x'));
    expect(!r2.ok && r2.response.status).toBe(503);
    process.env.ADMIN_TOKEN = saved;
  });
});

describe('proxy (cheap gate only)', () => {
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    proxyMod.proxy(new NextRequest(`http://app.test${path}`, init));
  const status = (r: Response) => r.headers.get('x-middleware-next') ? 200 : r.status;

  test('no credential: API 401, page redirects to login', async () => {
    expect(status(await call('/api/businesses'))).toBe(401);
    const page = await call('/dashboard');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toContain('/login');
  });
  test('well-formed user cookie passes the proxy (handlers validate for real); malformed does not', async () => {
    const good = `${auth.USER_SESSION_COOKIE}=${'a'.repeat(43)}`;
    expect(status(await call('/api/businesses', { headers: { cookie: good } }))).toBe(200);
    expect(status(await call('/api/businesses', { headers: { cookie: `${auth.USER_SESSION_COOKIE}=short` } }))).toBe(401);
    expect(status(await call('/api/businesses', { headers: { cookie: `${auth.USER_SESSION_COOKIE}=${'a b;'.repeat(10)}` } }))).toBe(401);
  });
  test('admin-session cookie passes the proxy by SHAPE only; malformed does not', async () => {
    const good = `${auth.SESSION_COOKIE}=${'b'.repeat(43)}`;
    expect(status(await call('/api/businesses', { headers: { cookie: good } }))).toBe(200);
    expect(status(await call('/api/businesses', { headers: { cookie: `${auth.SESSION_COOKIE}=short` } }))).toBe(401);
  });
  test('the proxy forwards the path and never trusts a client-supplied x-rc-pathname', async () => {
    const r = await call('/dashboard/team', { headers: { cookie: `${auth.USER_SESSION_COOKIE}=${'a'.repeat(43)}`, 'x-rc-pathname': '/dashboard/security' } });
    expect(r.headers.get('x-middleware-request-x-rc-pathname')).toBe('/dashboard/team');
  });
  test('cookie-authenticated POST must be same-origin; Bearer is exempt', async () => {
    const cookie = `${auth.USER_SESSION_COOKIE}=${'a'.repeat(43)}`;
    expect(status(await call('/api/sms/send', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' } }))).toBe(403);
    expect(status(await call('/api/sms/send', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } }))).toBe(200);
    expect(status(await call('/api/sms/send', { method: 'POST', headers: { authorization: 'Bearer test-admin-token-123' } }))).toBe(200);
  });
  test('public paths stay public; admin bearer passes', async () => {
    expect(status(await call('/api/health'))).toBe(200);
    expect(status(await call('/login'))).toBe(200);
    expect(status(await call('/api/businesses', { headers: { authorization: 'Bearer test-admin-token-123' } }))).toBe(200);
  });
});
