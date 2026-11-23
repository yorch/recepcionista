/**
 * Two-factor, MFA-pending confinement, break-glass admin sessions, session management and hash upgrades
 * against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;
const LIMITER = ['auth/login', 'auth/mfa', 'auth/2fa'];

suite('2FA, sessions and admin sessions (postgres)', () => {
  let db: any, s: any, pw: any, mail: ReturnType<typeof captureMail>, totp: any;
  let login: any, logout: any, mfa: any, enroll: any, confirm: any, disable: any, regen: any, sessionsRoute: any, sessionRoute: any, others: any, revokeAdmin: any, bizRoute: any;
  const run = rid();
  const email = (n: string) => `${n}-${run}@example.test`;
  const bizId = `biz_mfa_${run}`;
  const userIds: string[] = [];

  beforeAll(async () => {
    ({ db, s, pw } = await loadAuthModules());
    totp = await import('../../src/lib/totp');
    login = await import('../../src/app/api/auth/login/route');
    logout = await import('../../src/app/api/auth/logout/route');
    mfa = await import('../../src/app/api/auth/mfa/route');
    enroll = await import('../../src/app/api/auth/2fa/enroll/route');
    confirm = await import('../../src/app/api/auth/2fa/confirm/route');
    disable = await import('../../src/app/api/auth/2fa/disable/route');
    regen = await import('../../src/app/api/auth/2fa/recovery-codes/route');
    sessionsRoute = await import('../../src/app/api/auth/sessions/route');
    sessionRoute = await import('../../src/app/api/auth/sessions/[id]/route');
    others = await import('../../src/app/api/auth/sessions/revoke-others/route');
    revokeAdmin = await import('../../src/app/api/auth/revoke-admin-sessions/route');
    bizRoute = await import('../../src/app/api/businesses/[id]/route');
    mail = captureMail();
    await db.prisma.business.create({ data: { id: bizId, name: 'MFA biz', status: 'live' } });
  });
  afterEach(() => { delete process.env.REQUIRE_2FA_FOR_ADMINS; });
  afterAll(async () => {
    mail.restore();
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: bizId }, { actorUserId: { in: userIds } }] } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.userSession.deleteMany({ where: { kind: 'admin_token' } });
    await db.prisma.business.deleteMany({ where: { id: bizId } });
    await clearLimiter(db, LIMITER);
    await db.prisma.$disconnect();
  });

  async function mk(n: string, role: 'owner' | 'staff' | 'admin' = 'owner', hash?: string) {
    const user = await db.createUser({
      email: email(n), password_hash: hash ?? (await pw.hashPassword(PASSWORD)), role, business_id: role === 'admin' ? null : bizId, email_verified: true,
    });
    userIds.push(user.id);
    return user;
  }
  const loginRes = async (n: string, password = PASSWORD) => {
    await clearLimiter(db, ['auth/login']);
    return login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password } }));
  };
  const post = (mod: any, path: string, json: unknown, cookie?: string) => mod.POST(req(path, { method: 'POST', json, headers: cookie ? { cookie } : {} }));
  const codeFor = async (userId: string, offsetSteps = 0) => {
    const st = await db.getTotpState(userId);
    return totp.generateTotp(totp.decryptSecret(st.secret_enc, userId), Date.now() + offsetSteps * 30_000);
  };
  /** Enable 2FA through the real routes; returns the recovery codes. */
  async function enable2fa(n: string): Promise<{ user: any; cookie: string; codes: string[] }> {
    const user = await mk(n);
    const cookie = cookieFrom(await loginRes(n)) as string;
    const e = await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, cookie);
    expect(e.status).toBe(200);
    const body = (await e.json()).data;
    expect(body.qr_svg).toContain('<svg');
    expect(body.otpauth_uri).toContain('otpauth://totp/');
    const c = await post(confirm, '/api/auth/2fa/confirm', { code: totp.generateTotp(body.secret) }, cookie);
    expect(c.status).toBe(200);
    return { user, cookie, codes: (await c.json()).data.recovery_codes };
  }
  /** The user's login step 1: returns the MFA-pending cookie. */
  async function pendingCookie(n: string): Promise<string> {
    await db.prisma.user.updateMany({ where: { email: email(n) }, data: { totpLastUsedStep: null } }); // tests share one clock step
    const res = await loginRes(n);
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body).toEqual({ authenticated: false, mfa_required: true });
    return cookieFrom(res) as string;
  }

  describe('enrolment', () => {
    test('enroll needs the password; confirm needs a valid code and returns 10 recovery codes once; other sessions are signed out', async () => {
      const user = await mk('enr');
      const cookie = cookieFrom(await loginRes('enr')) as string;
      const other = cookieFrom(await loginRes('enr')) as string;
      expect((await post(enroll, '/api/auth/2fa/enroll', { password: 'wrong-password-123' }, cookie)).status).toBe(403);
      expect((await post(enroll, '/api/auth/2fa/enroll', {}, cookie)).status).toBe(403);
      const e = await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, cookie);
      expect(e.status).toBe(200);
      const st = await db.getTotpState(user.id);
      expect(st.secret_enc.startsWith('v1.')).toBe(true); // stored encrypted
      expect(st.enabled_at).toBeNull();
      expect((await post(confirm, '/api/auth/2fa/confirm', { code: '000000' }, cookie)).status).toBe(400);
      const secret = (await e.json()).data.secret;
      const ok = await post(confirm, '/api/auth/2fa/confirm', { code: totp.generateTotp(secret) }, cookie);
      expect(ok.status).toBe(200);
      const codes = (await ok.json()).data.recovery_codes;
      expect(codes.length).toBe(10);
      expect(await db.countUnusedRecoveryCodes(user.id)).toBe(10);
      expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(true); // this session stays
      expect((await s.resolvePrincipal(new Headers({ cookie: other }))).ok).toBe(false); // the other one is gone
      expect((await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, cookie)).status).toBe(409); // already on
      const audit = await db.listAuditEvents({ actor_user_id: user.id });
      const names = audit.map((a: any) => a.action);
      expect(names.includes('auth.2fa_enroll_started') && names.includes('auth.2fa_enabled')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(secret);
    });

    test('the break-glass token has no personal account to enrol', async () => {
      const r = await enroll.POST(req('/api/auth/2fa/enroll', { method: 'POST', json: { password: 'x' }, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(r.status).toBe(400);
    });
  });

  describe('login second step and confinement', () => {
    test('after the password a 2FA user only holds an MFA-pending session: every API and page resolution refuses it', async () => {
      await enable2fa('conf');
      const pending = await pendingCookie('conf');
      const r = await s.resolvePrincipal(new Headers({ cookie: pending }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe('mfa_required');
      expect((await s.resolvePendingMfa(new Headers({ cookie: pending }))).user.email).toBe(email('conf'));
      const get = await bizRoute.GET(req(`/api/businesses/${bizId}`, { headers: { cookie: pending } }), { params: Promise.resolve({ id: bizId }) });
      expect(get.status).toBe(401);
      expect((await get.json()).code).toBe('mfa_required');
      for (const [mod, path] of [[sessionsRoute, '/api/auth/sessions']] as const) {
        expect((await mod.GET(req(path, { headers: { cookie: pending } }))).status).toBe(401);
      }
      expect((await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, pending)).status).toBe(401);
      expect((await post(disable, '/api/auth/2fa/disable', { password: PASSWORD, code: '123456' }, pending)).status).toBe(401);
      expect((await post(others, '/api/auth/sessions/revoke-others', {}, pending)).status).toBe(401);
      // ...but logout works and kills it
      expect((await post(logout, '/api/auth/logout', {}, pending)).status).toBe(200);
      expect(await s.resolvePendingMfa(new Headers({ cookie: pending }))).toBeNull();
    });

    test('a wrong code is refused; the right code swaps the pending session for a full one (new token); the old token is dead', async () => {
      const { user } = await enable2fa('ok');
      const pending = await pendingCookie('ok');
      expect((await post(mfa, '/api/auth/mfa', { code: '000000' }, pending)).status).toBe(401);
      expect((await post(mfa, '/api/auth/mfa', {}, pending)).status).toBe(401);
      const good = await post(mfa, '/api/auth/mfa', { code: await codeFor(user.id, 1) }, pending);
      expect(good.status).toBe(200);
      const full = cookieFrom(good) as string;
      expect(full).not.toBe(pending);
      expect((await s.resolvePrincipal(new Headers({ cookie: full }))).ok).toBe(true);
      expect(await s.resolvePendingMfa(new Headers({ cookie: pending }))).toBeNull();
      expect((await s.resolvePrincipal(new Headers({ cookie: pending }))).ok).toBe(false);
      const acts = (await db.listAuditEvents({ actor_user_id: user.id })).map((a: any) => a.action);
      expect(acts.includes('auth.mfa_failed') && acts.includes('auth.login')).toBe(true);
    });

    test('TOTP replay: the same code cannot be used twice, even from another pending session', async () => {
      const { user } = await enable2fa('replay');
      const p1 = await pendingCookie('replay');
      const code = await codeFor(user.id, 1);
      expect((await post(mfa, '/api/auth/mfa', { code }, p1)).status).toBe(200);
      const res2 = await loginRes('replay');
      const p2 = cookieFrom(res2) as string;
      expect((await post(mfa, '/api/auth/mfa', { code }, p2)).status).toBe(401);
      expect(await db.claimTotpStep(user.id, totp.totpStep(Date.now() + 30_000))).toBe(false); // the step is burnt
    });

    test('recovery codes work once each, are case/format tolerant, and are audited', async () => {
      const { user, codes } = await enable2fa('rec');
      const p1 = await pendingCookie('rec');
      const r1 = await post(mfa, '/api/auth/mfa', { recovery_code: codes[0].toUpperCase() }, p1);
      expect(r1.status).toBe(200);
      expect((await r1.json()).data.recovery_codes_left).toBe(9);
      const p2 = await pendingCookie('rec');
      expect((await post(mfa, '/api/auth/mfa', { recovery_code: codes[0] }, p2)).status).toBe(401); // single use
      expect((await post(mfa, '/api/auth/mfa', { recovery_code: codes[1].replace('-', ' ') }, p2)).status).toBe(200);
      expect((await db.listAuditEvents({ actor_user_id: user.id })).some((a: any) => a.action === 'auth.recovery_code_used')).toBe(true);
    });

    test('5 wrong codes destroy the pending session; the pair backoff slows guessing from one address', async () => {
      await enable2fa('brute');
      await clearLimiter(db, ['auth/mfa']);
      const pending = await pendingCookie('brute');
      const ip = '203.0.113.77';
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await mfa.POST(req('/api/auth/mfa', { method: 'POST', ip, json: { code: '111111' }, headers: { cookie: pending } }))).status);
      // 3 free failures, then the (account, address) backoff answers 429; either way the session never got through
      expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
      expect(codes).toContain(429);
      expect((await s.resolvePrincipal(new Headers({ cookie: pending }))).ok).toBe(false);
      await clearLimiter(db, ['auth/mfa']);
      // from different addresses the per-session cap kills the session on the 5th wrong code
      const p2 = await pendingCookie('brute');
      const out: number[] = [];
      for (let i = 0; i < 5; i++) out.push((await post(mfa, '/api/auth/mfa', { code: '222222' }, p2)).status);
      expect(out.filter((c) => c === 401).length).toBe(5);
      expect(await s.resolvePendingMfa(new Headers({ cookie: p2 }))).toBeNull();
    });

    test('an expired pending session is useless', async () => {
      const { user } = await enable2fa('exp');
      const { token } = await db.createSession(user.id, { ttlMs: -1000 });
      const cookie = `rc_user_session=${token}`;
      expect(await s.resolvePendingMfa(new Headers({ cookie }))).toBeNull();
      expect((await post(mfa, '/api/auth/mfa', { code: '123456' }, cookie)).status).toBe(401);
    });

    test('disable needs password AND a valid factor; regenerate needs an app code and voids the old recovery codes', async () => {
      const { user, cookie, codes } = await enable2fa('dis');
      await db.prisma.user.update({ where: { id: user.id }, data: { totpLastUsedStep: null } });
      expect((await post(disable, '/api/auth/2fa/disable', { password: 'wrong-password-123', code: await codeFor(user.id, 1) }, cookie)).status).toBe(403);
      expect((await post(disable, '/api/auth/2fa/disable', { password: PASSWORD, code: '000000' }, cookie)).status).toBe(400);
      // regenerate: a recovery code is not accepted, an app code is
      expect((await post(regen, '/api/auth/2fa/recovery-codes', { recovery_code: codes[0] }, cookie)).status).toBe(400);
      const rg = await post(regen, '/api/auth/2fa/recovery-codes', { code: await codeFor(user.id, 1) }, cookie);
      expect(rg.status).toBe(200);
      const fresh = (await rg.json()).data.recovery_codes;
      expect(fresh.length).toBe(10);
      expect(await db.consumeRecoveryCode(user.id, totp.hashRecoveryCode(codes[2]))).toBe(false); // old codes void
      // disable with a recovery code
      const d = await post(disable, '/api/auth/2fa/disable', { password: PASSWORD, recovery_code: fresh[0] }, cookie);
      expect(d.status).toBe(200);
      expect((await db.getUserById(user.id)).totp_enabled).toBe(false);
      expect(await db.countUnusedRecoveryCodes(user.id)).toBe(0);
      // login is single-step again
      const res = await loginRes('dis');
      expect((await res.json()).data.authenticated).toBe(true);
    });

    test('REQUIRE_2FA_FOR_ADMINS: a DB admin without 2FA can only reach the enrolment endpoints', async () => {
      process.env.REQUIRE_2FA_FOR_ADMINS = 'true';
      await mk('adm2fa', 'admin');
      const cookie = cookieFrom(await loginRes('adm2fa')) as string;
      const blocked = await s.authenticate(req('/api/businesses', { headers: { cookie } }), { role: 'admin' });
      expect(!blocked.ok && blocked.response.status).toBe(403);
      expect(!blocked.ok && (await blocked.response.json()).code).toBe('2fa_enrollment_required');
      expect((await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, cookie)).status).toBe(200);
      expect((await sessionsRoute.GET(req('/api/auth/sessions', { headers: { cookie } }))).status).toBe(200);
      // owners are not affected; the flag off lets the admin through
      await mk('own2fa', 'owner');
      const ocookie = cookieFrom(await loginRes('own2fa')) as string;
      expect((await s.authenticate(req('/api/businesses', { headers: { cookie: ocookie } }))).ok).toBe(true);
      delete process.env.REQUIRE_2FA_FOR_ADMINS;
      expect((await s.authenticate(req('/api/businesses', { headers: { cookie } }), { role: 'admin' })).ok).toBe(true);
    });
  });

  describe('sessions', () => {
    test('list shows only my sessions; I can revoke mine, never someone else\'s; revoke-others keeps the current one', async () => {
      await mk('ses1');
      const u2 = await mk('ses2');
      const c1 = cookieFrom(await loginRes('ses1')) as string;
      const c1b = cookieFrom(await loginRes('ses1')) as string;
      const c2 = cookieFrom(await loginRes('ses2')) as string;
      const list = (await (await sessionsRoute.GET(req('/api/auth/sessions', { headers: { cookie: c1 } }))).json()).data.sessions;
      expect(list.length).toBe(2);
      expect(list.filter((x: any) => x.current).length).toBe(1);
      expect(JSON.stringify(list)).not.toMatch(/token/i);
      const theirs = (await db.listUserSessions(u2.id))[0];
      const bad = await sessionRoute.DELETE(req(`/api/auth/sessions/${theirs.id}`, { method: 'DELETE', headers: { cookie: c1 } }), { params: Promise.resolve({ id: theirs.id }) });
      expect(bad.status).toBe(404);
      expect((await s.resolvePrincipal(new Headers({ cookie: c2 }))).ok).toBe(true);
      const o = await post(others, '/api/auth/sessions/revoke-others', {}, c1);
      expect((await o.json()).data.revoked).toBe(1);
      expect((await s.resolvePrincipal(new Headers({ cookie: c1 }))).ok).toBe(true);
      expect((await s.resolvePrincipal(new Headers({ cookie: c1b }))).ok).toBe(false);
      const mine = (await db.listUserSessions((await db.getUserByEmail(email('ses1'))).id))[0];
      const del = await sessionRoute.DELETE(req(`/api/auth/sessions/${mine.id}`, { method: 'DELETE', headers: { cookie: c1 } }), { params: Promise.resolve({ id: mine.id }) });
      expect(del.status).toBe(200);
      expect((await s.resolvePrincipal(new Headers({ cookie: c1 }))).ok).toBe(false);
    });

    test('cross-site session revocation is refused (CSRF)', async () => {
      await mk('csrf');
      const c = cookieFrom(await loginRes('csrf')) as string;
      const r = await others.POST(req('/api/auth/sessions/revoke-others', { method: 'POST', json: {}, headers: { cookie: c, 'sec-fetch-site': 'cross-site' } }));
      expect(r.status).toBe(403);
    });

    test('login upgrades a weak scrypt hash without touching sessions', async () => {
      const salt = crypto.randomBytes(16);
      const weak = crypto.scryptSync('correct horse battery'.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 });
      const hash = `scrypt$1024$8$1$${salt.toString('base64url')}$${weak.toString('base64url')}`;
      const user = await mk('rehash', 'staff', hash);
      expect(pw.needsRehash(hash)).toBe(true);
      const existing = (await db.createSession(user.id)).token;
      const res = await loginRes('rehash');
      expect(res.status).toBe(200);
      const after = (await db.getUserByEmail(email('rehash'))).password_hash;
      expect(after).not.toBe(hash);
      expect(pw.needsRehash(after)).toBe(false);
      expect(await pw.verifyPassword(PASSWORD, after)).toBe(true);
      expect((await s.resolvePrincipal(new Headers({ cookie: `rc_user_session=${existing}` }))).ok).toBe(true); // not revoked
    });
  });

  describe('break-glass admin sessions', () => {
    const adminLogin = (headers: Record<string, string> = {}) => login.POST(req('/api/auth/login', { method: 'POST', json: { token: ADMIN_TOKEN }, headers }));

    test('login creates a server-side admin_token session in a random opaque cookie (12 h); no derived cookie', async () => {
      await clearLimiter(db, ['auth/login']);
      const res = await adminLogin();
      expect(res.status).toBe(200);
      const raw = res.headers.getSetCookie().find((c: string) => c.startsWith('rc_session=') && !c.startsWith('rc_session=;')) as string;
      expect(raw.toLowerCase()).toContain('httponly');
      const token = raw.split(';')[0].split('=')[1];
      expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(token).not.toContain(ADMIN_TOKEN);
      const row = await db.prisma.userSession.findUnique({ where: { tokenHash: db.hashSessionToken(token) } });
      expect(row.kind).toBe('admin_token');
      expect(row.userId).toBeNull();
      const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(ttl).toBeGreaterThan(11.9 * 3600_000);
      expect(ttl).toBeLessThanOrEqual(12 * 3600_000 + 1000);
      const r = await s.resolvePrincipal(new Headers({ cookie: `rc_session=${token}` }));
      expect(r.ok && r.principal.kind === 'admin' && r.principal.via).toBe('cookie');
      expect(r.ok && r.ambient).toBe(true);
      expect((await db.listAuditEvents({ limit: 20 })).some((a: any) => a.action === 'auth.admin_login')).toBe(true);
    });

    test('a cookie that is not a live session (old HMAC value, random, user token in the admin slot) is refused', async () => {
      const hmacLike = crypto.createHmac('sha256', ADMIN_TOKEN).update('recepcionista-admin-session-v1').digest('hex');
      for (const v of [hmacLike, 'a'.repeat(43), ADMIN_TOKEN]) {
        expect((await s.resolvePrincipal(new Headers({ cookie: `rc_session=${v}` }))).ok).toBe(false);
      }
      const u = await mk('swap');
      const { token } = await db.createSession(u.id);
      expect((await s.resolvePrincipal(new Headers({ cookie: `rc_session=${token}` }))).ok).toBe(false); // user session in the admin slot
    });

    test('expired admin sessions are rejected and removed', async () => {
      const { token } = await db.createAdminSession({ ttlMs: -1000 });
      expect((await s.resolvePrincipal(new Headers({ cookie: `rc_session=${token}` }))).ok).toBe(false);
      expect(await db.prisma.userSession.count({ where: { tokenHash: db.hashSessionToken(token) } })).toBe(0);
    });

    test('CSRF: cross-site / header-less POST with the admin cookie is 403; bad Bearer never falls back to the cookie', async () => {
      const { token } = await db.createAdminSession();
      const cookie = `rc_session=${token}`;
      const mk2 = (h: Record<string, string>) => new Request('http://app.test/api/x', { method: 'POST', headers: h });
      expect((await s.authenticate(mk2({ cookie, 'sec-fetch-site': 'same-origin' }), { role: 'admin' })).ok).toBe(true);
      for (const extra of [{ 'sec-fetch-site': 'cross-site' }, {}] as Record<string, string>[]) {
        const r = await s.authenticate(mk2({ cookie, ...extra }));
        expect(!r.ok && r.response.status).toBe(403);
      }
      const bad = await s.authenticate(mk2({ cookie, authorization: 'Bearer nope', 'sec-fetch-site': 'same-origin' }));
      expect(!bad.ok && bad.response.status).toBe(401);
    });

    test('logout revokes the admin session server-side', async () => {
      const { token } = await db.createAdminSession();
      const cookie = `rc_session=${token}`;
      expect((await post(logout, '/api/auth/logout', {}, cookie)).status).toBe(200);
      expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(false);
    });

    test('POST /api/auth/revoke-admin-sessions: admin only; kills every break-glass session', async () => {
      const a = (await db.createAdminSession()).token;
      const b = (await db.createAdminSession()).token;
      const owner = await mk('rvk');
      const oc = cookieFrom(await loginRes('rvk')) as string;
      expect(owner.role).toBe('owner');
      expect((await revokeAdmin.POST(req('/api/auth/revoke-admin-sessions', { method: 'POST', headers: { cookie: oc } }))).status).toBe(403);
      expect((await revokeAdmin.POST(req('/api/auth/revoke-admin-sessions', { method: 'POST' }))).status).toBe(401);
      const r = await revokeAdmin.POST(req('/api/auth/revoke-admin-sessions', { method: 'POST', headers: { cookie: `rc_session=${a}` } }));
      expect(r.status).toBe(200);
      expect((await r.json()).data.revoked).toBeGreaterThanOrEqual(2);
      for (const t of [a, b]) expect((await s.resolvePrincipal(new Headers({ cookie: `rc_session=${t}` }))).ok).toBe(false);
      // Bearer ADMIN_TOKEN still works for the API (break-glass stays)
      const bearer = await revokeAdmin.POST(req('/api/auth/revoke-admin-sessions', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(bearer.status).toBe(200);
    });

    test('logging in as a user replaces an admin cookie and vice versa', async () => {
      await mk('sw');
      const a = (await db.createAdminSession()).token;
      await clearLimiter(db, ['auth/login']);
      const res = await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('sw'), password: PASSWORD }, headers: { cookie: `rc_session=${a}` } }));
      expect(res.status).toBe(200);
      expect((await s.resolvePrincipal(new Headers({ cookie: `rc_session=${a}` }))).ok).toBe(false); // old admin session was dropped
    });
  });
});
