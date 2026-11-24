/**
 * Language preference against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set):
 *   PATCH /api/me/locale (validation, CSRF, persistence, cookie), the business default (PATCH /api/businesses/:id/settings),
 *   and that signup / invitation / the team list carry the language into the new rows and the emails.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/db/locale.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;

suite('language preference (postgres)', () => {
  let db: any, pw: any, mail: ReturnType<typeof captureMail>;
  let login: any, me: any, settings: any, signup: any, invite: any, accept: any, forgot: any;
  const run = rid();
  const A = `i18n-a-${run}`;
  const email = (n: string) => `${n}-${run}@example.test`;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const extraBiz: string[] = [];
  const extraUsers: string[] = [];

  beforeAll(async () => {
    ({ db, pw } = await loadAuthModules());
    login = await import('../../src/app/api/auth/login/route');
    me = await import('../../src/app/api/me/locale/route');
    settings = await import('../../src/app/api/businesses/[id]/settings/route');
    signup = await import('../../src/app/api/auth/signup/route');
    invite = await import('../../src/app/api/team/invite/route');
    accept = await import('../../src/app/api/auth/accept-invite/route');
    forgot = await import('../../src/app/api/auth/forgot-password/route');
    mail = captureMail();
    await db.prisma.business.create({ data: { id: A, name: `Locale ${run}`, status: 'live' } });
    const hash = await pw.hashPassword(PASSWORD);
    for (const [n, role] of [['owner', 'owner'], ['staff', 'staff']] as const) {
      ids[n] = (await db.createUser({ email: email(n), password_hash: hash, role, business_id: A, email_verified: true })).id;
    }
    await clearLimiter(db, ['auth/login']);
    for (const n of ['owner', 'staff']) {
      await clearLimiter(db, ['auth/login']);
      cookies[n] = cookieFrom(await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password: PASSWORD } }))) as string;
    }
  });
  afterAll(async () => {
    mail.restore();
    const userIds = [...Object.values(ids), ...(await db.prisma.user.findMany({ where: { email: { in: extraUsers } }, select: { id: true } })).map((u: any) => u.id as string)];
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: [A, ...extraBiz] } }, { actorUserId: { in: userIds } }] } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.business.deleteMany({ where: { id: { in: [A, ...extraBiz] } } });
    await clearLimiter(db, ['auth/login', 'auth/signup', 'team/invite', 'auth/forgot-password', 'auth/accept-invite']);
    await db.prisma.$disconnect();
  });

  const patch = (cookie: string | null, json: unknown, headers: Record<string, string> = {}) =>
    me.PATCH(req('/api/me/locale', { method: 'PATCH', json, headers: { ...(cookie ? { cookie } : {}), ...headers } }));
  const localeOf = async (n: string) => (await db.prisma.user.findUnique({ where: { id: ids[n] } })).locale;

  test('a signed-in user stores their language, and gets the rc_locale cookie', async () => {
    expect(await localeOf('owner')).toBe('en');
    const res = await patch(cookies.owner, { locale: 'es' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ locale: 'es', persisted: true });
    expect(await localeOf('owner')).toBe('es');
    const set = res.headers.getSetCookie().find((c: string) => c.startsWith('rc_locale='));
    expect(set).toContain('rc_locale=es');
    expect(set?.toLowerCase()).toContain('samesite=lax');
    expect(set?.toLowerCase()).toContain('path=/');
    expect((await patch(cookies.owner, { locale: 'en' })).status).toBe(200);
    expect(await localeOf('owner')).toBe('en');
  });

  test('staff can change their own language too; it never touches another user', async () => {
    expect((await patch(cookies.staff, { locale: 'es' })).status).toBe(200);
    expect(await localeOf('staff')).toBe('es');
    expect(await localeOf('owner')).toBe('en');
  });

  test('validation: only en / es, JSON object body', async () => {
    for (const bad of [{ locale: 'fr' }, { locale: 'ES ' }, { locale: '' }, { locale: null }, { locale: 1 }, {}]) {
      const r = await patch(cookies.owner, bad);
      expect(r.status).toBe(422);
      expect((await r.json()).error).toMatch(/locale must be one of: en, es/);
    }
    expect((await patch(cookies.owner, [])).status).toBe(400);
    const notJson = await me.PATCH(req('/api/me/locale', { method: 'PATCH', body: 'nope', headers: { cookie: cookies.owner } }));
    expect(notJson.status).toBe(400);
    expect(await localeOf('owner')).toBe('en');
  });

  test('CSRF: a cross-site request with the session cookie is refused and changes nothing', async () => {
    const r = await patch(cookies.owner, { locale: 'es' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' });
    expect(r.status).toBe(403);
    expect(await localeOf('owner')).toBe('en');
  });

  test('not signed in: 401 and nothing is stored', async () => {
    expect((await patch(null, { locale: 'es' })).status).toBe(401);
  });

  test('the break-glass admin token has no user row: the cookie switches, nothing is stored', async () => {
    const r = await patch(null, { locale: 'es' }, { authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ locale: 'es', persisted: false });
  });

  test('the business default language: owner only, validated, persisted', async () => {
    const ctx = { params: Promise.resolve({ id: A }) };
    const owner = await settings.PATCH(req(`/api/businesses/${A}/settings`, { method: 'PATCH', json: { locale_default: 'es' }, headers: { cookie: cookies.owner } }), ctx);
    expect(owner.status).toBe(200);
    expect((await owner.json()).data.locale_default).toBe('es');
    expect((await db.prisma.business.findUnique({ where: { id: A } })).localeDefault).toBe('es');
    const bad = await settings.PATCH(req(`/api/businesses/${A}/settings`, { method: 'PATCH', json: { locale_default: 'fr' }, headers: { cookie: cookies.owner } }), ctx);
    expect(bad.status).toBe(422);
    const staff = await settings.PATCH(req(`/api/businesses/${A}/settings`, { method: 'PATCH', json: { locale_default: 'en' }, headers: { cookie: cookies.staff } }), ctx);
    expect(staff.status).toBe(403);
    expect((await db.prisma.business.findUnique({ where: { id: A } })).localeDefault).toBe('es');
  });

  test('signup in Spanish: the user, the business default and the verification email are Spanish', async () => {
    await clearLimiter(db, ['auth/signup']);
    const addr = email('nuevo');
    extraUsers.push(addr);
    const res = await signup.POST(req('/api/auth/signup', {
      method: 'POST', json: { email: addr, password: PASSWORD, business_name: `Taller ${run}` }, headers: { cookie: 'rc_locale=es', 'accept-language': 'en-US' },
    }));
    expect(res.status).toBe(200);
    const user = await db.prisma.user.findUnique({ where: { email: addr }, include: { business: true } });
    expect(user.locale).toBe('es');
    expect(user.business.localeDefault).toBe('es');
    extraBiz.push(user.businessId);
    await new Promise((r) => setTimeout(r, 50));
    const m = mail.to(addr)[0];
    expect(m?.subject).toBe('Confirme su dirección de correo electrónico');
  });

  test('signup with no cookie follows Accept-Language; unsupported languages fall back to English', async () => {
    await clearLimiter(db, ['auth/signup']);
    const es = email('accept-es');
    const fr = email('accept-fr');
    extraUsers.push(es, fr);
    await signup.POST(req('/api/auth/signup', { method: 'POST', json: { email: es, password: PASSWORD, business_name: `Es ${run}` }, headers: { 'accept-language': 'es-MX,es;q=0.9,en;q=0.5' } }));
    await signup.POST(req('/api/auth/signup', { method: 'POST', json: { email: fr, password: PASSWORD, business_name: `Fr ${run}` }, headers: { 'accept-language': 'fr-FR' } }));
    const u1 = await db.prisma.user.findUnique({ where: { email: es } });
    const u2 = await db.prisma.user.findUnique({ where: { email: fr } });
    expect(u1.locale).toBe('es');
    expect(u2.locale).toBe('en');
    extraBiz.push(u1.businessId, u2.businessId);
  });

  test('password reset email follows the user locale', async () => {
    await clearLimiter(db, ['auth/forgot-password']);
    await patch(cookies.staff, { locale: 'es' });
    mail.mails.length = 0;
    await forgot.POST(req('/api/auth/forgot-password', { method: 'POST', json: { email: email('staff') } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.to(email('staff'))[0]?.subject).toBe('Restablezca su contraseña');
    await patch(cookies.owner, { locale: 'en' });
    mail.mails.length = 0;
    await clearLimiter(db, ['auth/forgot-password']);
    await forgot.POST(req('/api/auth/forgot-password', { method: 'POST', json: { email: email('owner') } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.to(email('owner'))[0]?.subject).toBe('Reset your password');
  });

  test('an invitation is written in the business language and the new member starts in it', async () => {
    // business A's default is Spanish (set above)
    await clearLimiter(db, ['team/invite', 'auth/accept-invite']);
    const guest = email('guest');
    extraUsers.push(guest);
    mail.mails.length = 0;
    const r = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: guest, role: 'staff' }, headers: { cookie: cookies.owner } }));
    expect(r.status).toBe(201);
    const m = mail.to(guest)[0];
    expect(m.subject).toBe('Lo invitaron a unirse a una cuenta de Recepcionista');
    const done = await accept.POST(req('/api/auth/accept-invite', { method: 'POST', json: { token: m.token, password: PASSWORD } }));
    expect(done.status).toBe(200);
    expect((await db.prisma.user.findUnique({ where: { email: guest } })).locale).toBe('es');
  });

  test('R14 L5: the "account already exists" notice is in the ACCOUNT OWNER\'s language, not the requester\'s', async () => {
    const { makeT } = await import('../../src/lib/i18n');
    await db.prisma.user.update({ where: { id: ids.staff }, data: { locale: 'es' } });
    await clearLimiter(db, ['auth/signup']);
    await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'auth/signup:notice:' } } });
    mail.mails.length = 0;
    // the requester (an attacker probing the address) asks in English; the notice must still arrive in the owner's Spanish
    const res = await signup.POST(req('/api/auth/signup', { method: 'POST', json: { email: email('staff'), password: PASSWORD, business_name: `Probe ${run}` }, headers: { cookie: 'rc_locale=en', 'accept-language': 'en-US' } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mail.to(email('staff'))[0]?.subject).toBe(makeT('es')('mail.exists.subject'));
    expect(makeT('es')('mail.exists.subject')).not.toBe(makeT('en')('mail.exists.subject'));
    // a malformed cookie no longer breaks signup (it used to throw inside decodeURIComponent)
    await clearLimiter(db, ['auth/signup']);
    const addr = email('badcookie');
    extraUsers.push(addr);
    const bad = await signup.POST(req('/api/auth/signup', { method: 'POST', json: { email: addr, password: PASSWORD, business_name: `Cookie ${run}` }, headers: { cookie: 'rc_locale=%', 'accept-language': 'es' } }));
    expect(bad.status).toBe(200);
    const created = await db.prisma.user.findUnique({ where: { email: addr } });
    expect(created.locale).toBe('es'); // fell through to Accept-Language
    extraBiz.push(created.businessId);
    await db.prisma.user.update({ where: { id: ids.staff }, data: { locale: 'en' } });
  });
});
