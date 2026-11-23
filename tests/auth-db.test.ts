/**
 * Login / session / tenant-isolation tests against a DISPOSABLE Postgres (skipped unless set):
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/auth-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}
const suite = url ? describe : describe.skip;

suite('per-tenant auth (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, s: any, pw: any, login: any, logout: any, users: any, bizRoute: any, smsSend: any;
  const run = Math.random().toString(36).slice(2, 8);
  const A = `biz_ta_${run}`;
  const B = `biz_tb_${run}`;
  const PASSWORD = 'correct horse battery';
  const email = (n: string) => `${n}-${run}@example.test`;
  const ids: string[] = [];

  const req = (path: string, init: RequestInit = {}) =>
    new Request(`http://app.test${path}`, { ...init, headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(init.headers as object) } });
  const loginReq = (body: unknown) => req('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
  const cookieOf = (res: Response) => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith('rc_user_session=') && !x.startsWith('rc_user_session=;'));
    return c ? c.split(';')[0] : null;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_TOKEN = 'test-admin-token-123';
    db = await import('../src/lib/db');
    s = await import('../src/lib/session');
    pw = await import('../src/lib/password');
    users = await import('../src/lib/db/users');
    login = await import('../src/app/api/auth/login/route');
    logout = await import('../src/app/api/auth/logout/route');
    bizRoute = await import('../src/app/api/businesses/[id]/route');
    smsSend = await import('../src/app/api/sms/send/route');
    for (const id of [A, B]) {
      await db.prisma.business.create({ data: { id, name: `Tenant ${id}`, status: 'live' } });
    }
    const hash = await pw.hashPassword(PASSWORD);
    for (const [n, role, biz] of [['ownerA', 'owner', A], ['staffA', 'staff', A], ['ownerB', 'owner', B]] as const) {
      ids.push((await db.createUser({ email: email(n), password_hash: hash, role, business_id: biz })).id);
    }
    ids.push((await db.createUser({ email: email('root'), password_hash: hash, role: 'admin' })).id);
  });

  afterAll(async () => {
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/login' } } });
    await db.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
    await db.prisma.$disconnect();
  });

  async function signIn(n: string): Promise<string> {
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/login' } } }); // the limiter is real; reset it between sign-ins
    const res = await login.POST(loginReq({ email: email(n), password: PASSWORD }));
    expect(res.status).toBe(200);
    const c = cookieOf(res);
    expect(c).toBeTruthy();
    return c as string;
  }

  test('login is rate limited per account', async () => {
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/login' } } });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login.POST(loginReq({ email: email('ratelimited'), password: 'bad-password-xx' }))).status;
    expect(last).toBe(429);
  });

  test('login sets an httpOnly lax cookie; DB stores only the hash', async () => {
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/login' } } });
    const res = await login.POST(loginReq({ email: email('ownerA').toUpperCase(), password: PASSWORD }));
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((x: string) => x.startsWith('rc_user_session=') && !x.includes('=;')) as string;
    expect(raw.toLowerCase()).toContain('httponly');
    expect(raw.toLowerCase()).toContain('samesite=lax');
    const token = raw.split(';')[0].split('=')[1];
    const rows = await db.prisma.userSession.findMany({ where: { tokenHash: users.hashSessionToken(token) } });
    expect(rows.length).toBe(1);
    expect(await db.prisma.userSession.count({ where: { tokenHash: token } })).toBe(0);
  });

  test('wrong password, unknown email and disabled account are indistinguishable', async () => {
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/login' } } });
    const bad = await login.POST(loginReq({ email: email('ownerA'), password: 'wrong-password-123' }));
    const unknown = await login.POST(loginReq({ email: `nobody-${run}@example.test`, password: PASSWORD }));
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await bad.json()).toEqual(await unknown.json());
    const uid = (await users.getUserByEmail(email('staffA'))).id;
    await users.setUserDisabled(uid, true);
    const disabled = await login.POST(loginReq({ email: email('staffA'), password: PASSWORD }));
    expect(disabled.status).toBe(401);
    await users.setUserDisabled(uid, false);
  });

  test('owner sees only their business; cross-tenant is 404; admin sees all', async () => {
    const cookie = await signIn('ownerA');
    const own = await bizRoute.GET(req(`/api/businesses/${A}`, { headers: { cookie } }), { params: Promise.resolve({ id: A }) });
    expect(own.status).toBe(200);
    const other = await bizRoute.GET(req(`/api/businesses/${B}`, { headers: { cookie } }), { params: Promise.resolve({ id: B }) });
    expect(other.status).toBe(404);
    const adm = await bizRoute.GET(req(`/api/businesses/${B}`, { headers: { authorization: 'Bearer test-admin-token-123' } }), { params: Promise.resolve({ id: B }) });
    expect(adm.status).toBe(200);
    const rootCookie = await signIn('root');
    const r = await s.resolvePrincipal(new Headers({ cookie: rootCookie }));
    expect(r.ok && r.principal.kind).toBe('admin');
  });

  test('staff cannot PATCH settings or send SMS (403) but can read', async () => {
    const cookie = await signIn('staffA');
    const get = await bizRoute.GET(req(`/api/businesses/${A}`, { headers: { cookie } }), { params: Promise.resolve({ id: A }) });
    expect(get.status).toBe(200);
    const patch = await bizRoute.PATCH(req(`/api/businesses/${A}`, { method: 'PATCH', headers: { cookie }, body: JSON.stringify({ name: 'x' }) }), { params: Promise.resolve({ id: A }) });
    expect(patch.status).toBe(403);
    const sms = await smsSend.POST(req('/api/sms/send', { method: 'POST', headers: { cookie }, body: JSON.stringify({ to: '+13055550123', body: 'hi' }) }));
    expect(sms.status).toBe(403);
  });

  test('owner PATCH works for own business and 404s for another', async () => {
    const cookie = await signIn('ownerA');
    const ok = await bizRoute.PATCH(req(`/api/businesses/${A}`, { method: 'PATCH', headers: { cookie }, body: JSON.stringify({ name: 'Renamed A' }) }), { params: Promise.resolve({ id: A }) });
    expect(ok.status).toBe(200);
    const no = await bizRoute.PATCH(req(`/api/businesses/${B}`, { method: 'PATCH', headers: { cookie }, body: JSON.stringify({ name: 'pwned' }) }), { params: Promise.resolve({ id: B }) });
    expect(no.status).toBe(404);
    expect((await db.getBusiness(B)).name).not.toBe('pwned');
  });

  test('cookie-authenticated cross-site POST is refused', async () => {
    const cookie = await signIn('ownerA');
    const res = await bizRoute.PATCH(
      new Request(`http://app.test/api/businesses/${A}`, { method: 'PATCH', headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{"name":"x"}' }),
      { params: Promise.resolve({ id: A }) },
    );
    expect(res.status).toBe(403);
  });

  test('logout deletes the server-side session; the old cookie is dead', async () => {
    const cookie = await signIn('ownerB');
    expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(true);
    const out = await logout.POST(req('/api/auth/logout', { method: 'POST', headers: { cookie } }));
    expect(out.status).toBe(200);
    expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(false);
  });

  test('disabling a user and changing the password revoke sessions', async () => {
    const cookie = await signIn('staffA');
    const uid = (await users.getUserByEmail(email('staffA'))).id;
    await users.setUserDisabled(uid, true);
    expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(false);
    await users.setUserDisabled(uid, false);
    const c2 = await signIn('staffA');
    await users.setUserPasswordHash(uid, await pw.hashPassword('another long passphrase'));
    expect((await s.resolvePrincipal(new Headers({ cookie: c2 }))).ok).toBe(false);
  });

  test('expired sessions are rejected', async () => {
    const uid = (await users.getUserByEmail(email('ownerA'))).id;
    const { token } = await users.createSession(uid, { ttlMs: -1000 });
    expect((await s.resolvePrincipal(new Headers({ cookie: `rc_user_session=${token}` }))).ok).toBe(false);
  });
});
