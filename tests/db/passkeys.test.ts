/**
 * Passkeys (WebAuthn) end to end through the real route handlers and the real @simplewebauthn/server verification, with a simulated
 * authenticator (tests/helpers/virtual-authenticator.ts). Needs a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';
import { VirtualAuthenticator } from '../helpers/virtual-authenticator';

const suite = TEST_URL ? describe : describe.skip;
const ORIGIN = 'https://app.test';
const RP = 'app.test';
const LIMITER = ['auth/login', 'auth/passkeys', 'auth/reauth', 'auth/mfa'];

suite('passkeys (postgres)', () => {
  let db: any, s: any, pw: any, mail: ReturnType<typeof captureMail>;
  const m: Record<string, any> = {};
  const run = rid();
  const email = (n: string) => `${n}-${run}@example.test`.toLowerCase();
  const BIZ = `biz_pk_${run}`;
  const ids: Record<string, string> = {};
  const env0 = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, WEBAUTHN_ORIGINS: process.env.WEBAUTHN_ORIGINS, WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID };

  beforeAll(async () => {
    ({ db, s, pw } = await loadAuthModules());
    m.login = await import('../../src/app/api/auth/login/route');
    m.regOpt = await import('../../src/app/api/auth/passkeys/register/options/route');
    m.regVer = await import('../../src/app/api/auth/passkeys/register/verify/route');
    m.logOpt = await import('../../src/app/api/auth/passkeys/login/options/route');
    m.logVer = await import('../../src/app/api/auth/passkeys/login/verify/route');
    m.reOpt = await import('../../src/app/api/auth/passkeys/reauth/options/route');
    m.reVer = await import('../../src/app/api/auth/passkeys/reauth/verify/route');
    m.item = await import('../../src/app/api/auth/passkeys/[id]/route');
    m.list = await import('../../src/app/api/auth/passkeys/route');
    m.mfa = await import('../../src/app/api/auth/mfa/route');
    m.reauth = await import('../../src/app/api/auth/reauth/route');
    mail = captureMail();
    process.env.APP_URL = ORIGIN;
    delete process.env.PUBLIC_BASE_URL; delete process.env.WEBAUTHN_ORIGINS; delete process.env.WEBAUTHN_RP_ID;
    await db.prisma.business.create({ data: { id: BIZ, name: `PK ${run}`, status: 'live' } });
    const hash = await pw.hashPassword(PASSWORD);
    for (const n of ['alice', 'bob', 'totp', 'gone', 'nomem', 'squat']) {
      ids[n] = (await db.createUser({ email: email(n), password_hash: hash, role: 'owner', business_id: BIZ, email_verified: n !== 'squat' })).id;
    }
    await db.beginTotpEnrollment(ids.totp, 'v1:secret-not-used');
    expect(await db.confirmTotpEnrollment(ids.totp, 1, ['h1', 'h2'])).toBe(true);
    await clearLimiter(db, LIMITER);
  });
  afterAll(async () => {
    mail.restore();
    for (const [k, v] of Object.entries(env0)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: BIZ }, { actorUserId: { in: Object.values(ids) } }] } });
    await db.prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await db.prisma.business.deleteMany({ where: { id: BIZ } });
    await clearLimiter(db, LIMITER);
    await db.prisma.$disconnect();
  });

  async function signIn(n: string): Promise<string> {
    await clearLimiter(db, ['auth/login']);
    const res = await m.login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password: PASSWORD } }));
    expect(res.status).toBe(200);
    return cookieFrom(res) as string;
  }
  const post = (mod: any, path: string, cookie: string | null, json: unknown = {}, headers: Record<string, string> = {}) =>
    mod.POST(req(path, { method: 'POST', json, headers: { ...(cookie ? { cookie } : {}), ...headers } }));
  const data = async (r: Response) => (await r.json()).data;

  /** Register `auth` for the user behind `cookie`; returns the stored passkey. */
  async function register(cookie: string, auth: VirtualAuthenticator, name = 'Test key'): Promise<any> {
    const o = await post(m.regOpt, '/api/auth/passkeys/register/options', cookie);
    expect(o.status).toBe(200);
    const { options } = await data(o);
    const v = await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: auth.create(options, { origin: ORIGIN, rpId: RP }), name });
    expect(v.status).toBe(201);
    return (await data(v)).passkey;
  }
  async function loginWith(auth: VirtualAuthenticator, o: Parameters<VirtualAuthenticator['get']>[1] & { cookie?: string } = { origin: ORIGIN, rpId: RP }) {
    await clearLimiter(db, ['auth/login']);
    const opt = await post(m.logOpt, '/api/auth/passkeys/login/options', null);
    expect(opt.status).toBe(200);
    const { options } = await data(opt);
    return post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: auth.get(options, o) }, o.cookie ? { cookie: o.cookie } : {});
  }

  test('registration: needs auth + CSRF; stores the credential, audits, emails a notice, excludes it next time', async () => {
    expect((await post(m.regOpt, '/api/auth/passkeys/register/options', null)).status).toBe(401);
    const cookie = await signIn('alice');
    const noCsrf = await m.regOpt.POST(new Request('http://app.test/api/auth/passkeys/register/options', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }));
    expect(noCsrf.status).toBe(403);
    const o1 = await data(await post(m.regOpt, '/api/auth/passkeys/register/options', cookie));
    expect(o1.options.rp.id).toBe(RP);
    expect(o1.options.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' });
    expect(o1.options.excludeCredentials).toEqual([]);
    const auth = new VirtualAuthenticator();
    const v = await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: auth.create(o1.options, { origin: ORIGIN, rpId: RP }), name: 'Laptop <b>' });
    expect(v.status).toBe(201);
    const pk = (await data(v)).passkey;
    expect(pk.name).toBe('Laptop b'); // markup stripped
    expect(JSON.stringify(pk)).not.toMatch(/public_key|publicKey/);
    expect(mail.to(email('alice')).some((x) => /passkey was added/i.test(x.subject))).toBe(true);
    const audit = await db.listAuditEvents({ actor_user_id: ids.alice });
    expect(audit.map((a: any) => a.action)).toContain('auth.passkey_added');
    const o2 = await data(await post(m.regOpt, '/api/auth/passkeys/register/options', cookie));
    expect(o2.options.excludeCredentials.map((c: any) => c.id)).toEqual([auth.id]);
    // the same authenticator again is refused
    const dup = await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: auth.create(o2.options, { origin: ORIGIN, rpId: RP }) });
    expect(dup.status).toBe(409);
    const listed = await data(await m.list.GET(req('/api/auth/passkeys', { headers: { cookie } })));
    expect(listed.passkeys.length).toBe(1);
  });

  test('registration rejects: replayed challenge, wrong origin, wrong rpID, no user verification, challenge of another purpose/user, stale session', async () => {
    const cookie = await signIn('alice');
    const reg = async (mut: (a: VirtualAuthenticator, opts: any) => Record<string, unknown>) => {
      const { options } = await data(await post(m.regOpt, '/api/auth/passkeys/register/options', cookie));
      return post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: mut(new VirtualAuthenticator(), options) });
    };
    expect((await reg((a, o) => a.create(o, { origin: 'https://evil.test', rpId: RP }))).status).toBe(400);
    expect((await reg((a, o) => a.create(o, { origin: ORIGIN, rpId: 'evil.test' }))).status).toBe(400);
    expect((await reg((a, o) => a.create(o, { origin: ORIGIN, rpId: RP, flags: { uv: false } }))).status).toBe(400);
    expect((await reg((a, o) => a.create(o, { origin: ORIGIN, rpId: RP, challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))).status).toBe(400); // never issued
    expect((await reg((a, o) => a.create(o, { origin: ORIGIN, rpId: RP, type: 'webauthn.get' }))).status).toBe(400);
    // replay: a good response works once, the same challenge never again
    const { options } = await data(await post(m.regOpt, '/api/auth/passkeys/register/options', cookie));
    const a = new VirtualAuthenticator();
    const good = a.create(options, { origin: ORIGIN, rpId: RP });
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: good })).status).toBe(201);
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: new VirtualAuthenticator().create(options, { origin: ORIGIN, rpId: RP }) })).status).toBe(400);
    // a challenge issued to another account cannot be redeemed by this one
    const bobCookie = await signIn('bob');
    const bobOpt = (await data(await post(m.regOpt, '/api/auth/passkeys/register/options', bobCookie))).options;
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: new VirtualAuthenticator().create(bobOpt, { origin: ORIGIN, rpId: RP }) })).status).toBe(400);
    // a 'login' challenge cannot register
    const loginOpt = (await data(await post(m.logOpt, '/api/auth/passkeys/login/options', null))).options;
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: new VirtualAuthenticator().create(loginOpt, { origin: ORIGIN, rpId: RP }) })).status).toBe(400);
    // an expired challenge
    const exp = (await data(await post(m.regOpt, '/api/auth/passkeys/register/options', cookie))).options;
    await db.prisma.webauthnChallenge.updateMany({ where: { challengeHash: db.hashChallenge(exp.challenge) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: new VirtualAuthenticator().create(exp, { origin: ORIGIN, rpId: RP }) })).status).toBe(400);
    // adding a passkey needs a recent proof of identity
    const row = await db.resolveSessionByToken(cookie.split('=')[1]);
    await db.prisma.userSession.update({ where: { id: row.session.id }, data: { sudoAt: new Date(Date.now() - 6 * 60_000) } });
    const stale = await post(m.regOpt, '/api/auth/passkeys/register/options', cookie);
    expect(stale.status).toBe(403);
    expect((await stale.json()).code).toBe('reauth_required');
  });

  test('at most 20 passkeys per account', async () => {
    const cookie = await signIn('gone');
    for (let i = 0; i < 20; i++) await db.addPasskey({ user_id: ids.gone, credential_id: `cred-${run}-${i}`, public_key: new Uint8Array([1, 2, 3]) });
    await clearLimiter(db, ['auth/passkeys']);
    const r = await post(m.regOpt, '/api/auth/passkeys/register/options', cookie);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('passkey_limit');
    await db.prisma.passkeyCredential.deleteMany({ where: { userId: ids.gone } });
  });

  test('passkey login: usernameless, uniform options, session is MFA-verified even for a 2FA account, previous session replaced', async () => {
    const cookie = await signIn('totp'); // password login of a 2FA account is MFA-PENDING
    expect((await m.reauth.POST(req('/api/auth/reauth', { method: 'POST', json: { password: PASSWORD }, headers: { cookie } }))).status).toBe(401);
    // register a passkey for the 2FA account (needs a full session: mark this one verified like the second step would)
    const pend = await db.resolveSessionByToken(cookie.split('=')[1]);
    await db.markSessionMfaVerified(pend.session.id);
    const auth = new VirtualAuthenticator();
    await register(cookie, auth, 'Phone');
    // login options are identical for everyone: no allowCredentials, no account hint
    const o1 = (await data(await post(m.logOpt, '/api/auth/passkeys/login/options', null))).options;
    expect(o1.allowCredentials ?? []).toEqual([]);
    expect(o1.userVerification).toBe('required');
    const stale = await signIn('alice'); // an existing session in this browser must not survive (fixation)
    const res = await loginWith(auth, { origin: ORIGIN, rpId: RP, cookie: stale });
    expect(res.status).toBe(200);
    const body = await data(res);
    expect(body).toMatchObject({ authenticated: true, kind: 'user', method: 'passkey', business_id: BIZ, role: 'owner' });
    const fresh = cookieFrom(res) as string;
    expect(fresh).toBeTruthy();
    expect(await db.resolveSessionByToken(stale.split('=')[1])).toBeNull();
    const resolved = await db.resolveSessionByToken(fresh.split('=')[1]);
    expect(resolved.session.mfa_verified_at).not.toBeNull();
    const r = await s.resolvePrincipal(new Headers({ cookie: fresh }));
    expect(r.ok).toBe(true); // not "mfa_required"
    const audit = await db.listAuditEvents({ actor_user_id: ids.totp, action: 'auth.login' });
    expect(audit.some((a: any) => a.meta?.method === 'passkey')).toBe(true);
    // an authenticator that always reports counter 0 keeps working
    const zero = new VirtualAuthenticator({ counterAlwaysZero: true });
    await register(await signIn('bob'), zero, 'Zero');
    expect((await loginWith(zero)).status).toBe(200);
    expect((await loginWith(zero)).status).toBe(200);
  });

  test('passkey login rejects: replay, wrong origin/rpID, no UV, bad signature, unknown credential, wrong purpose, expired', async () => {
    const cookie = await signIn('alice');
    const auth = new VirtualAuthenticator();
    await register(cookie, auth);
    const attempt = async (o: Parameters<VirtualAuthenticator['get']>[1]) => (await loginWith(auth, o)).status;
    expect(await attempt({ origin: 'https://evil.test', rpId: RP })).toBe(401);
    expect(await attempt({ origin: 'http://app.test', rpId: RP })).toBe(401); // scheme must match too
    expect(await attempt({ origin: ORIGIN, rpId: 'evil.test' })).toBe(401);
    expect(await attempt({ origin: ORIGIN, rpId: RP, flags: { uv: false } })).toBe(401);
    expect(await attempt({ origin: ORIGIN, rpId: RP, tamper: true })).toBe(401);
    expect(await attempt({ origin: ORIGIN, rpId: RP, type: 'webauthn.create' })).toBe(401);
    expect(await attempt({ origin: ORIGIN, rpId: RP, userHandle: Buffer.from('someone-else').toString('base64url') })).toBe(401);
    expect((await loginWith(new VirtualAuthenticator())).status).toBe(401); // unknown credential: same generic answer
    // replay: capture a good assertion, use it, then send the identical bytes again
    await clearLimiter(db, ['auth/login']);
    const { options } = await data(await post(m.logOpt, '/api/auth/passkeys/login/options', null));
    const assertion = auth.get(options, { origin: ORIGIN, rpId: RP });
    expect((await post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: assertion })).status).toBe(200);
    expect((await post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: assertion })).status).toBe(401);
    // an expired challenge
    const o2 = (await data(await post(m.logOpt, '/api/auth/passkeys/login/options', null))).options;
    await db.prisma.webauthnChallenge.updateMany({ where: { challengeHash: db.hashChallenge(o2.challenge) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: auth.get(o2, { origin: ORIGIN, rpId: RP }) })).status).toBe(401);
    // a challenge issued for reauth cannot be used to log in
    const re = (await data(await post(m.reOpt, '/api/auth/passkeys/reauth/options', cookie))).options;
    expect((await post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: auth.get(re, { origin: ORIGIN, rpId: RP }) })).status).toBe(401);
    // and the 401 body never says which part failed
    const bad = await loginWith(auth, { origin: 'https://evil.test', rpId: RP });
    expect(await bad.json()).toEqual({ ok: false, error: 'passkey sign-in failed' });
  });

  test('counter regression = cloned authenticator: refused, every session revoked, audited, user emailed; the next honest use works', async () => {
    const cookie = await signIn('bob');
    const auth = new VirtualAuthenticator();
    const pk = await register(cookie, auth, 'Clone me');
    expect((await loginWith(auth, { origin: ORIGIN, rpId: RP, counter: 10 })).status).toBe(200);
    const other = await signIn('bob');
    mail.mails.length = 0;
    const res = await loginWith(auth, { origin: ORIGIN, rpId: RP, counter: 5 }); // went backwards
    expect(res.status).toBe(401);
    expect(await db.resolveSessionByToken(other.split('=')[1])).toBeNull();
    expect(await db.resolveSessionByToken(cookie.split('=')[1])).toBeNull();
    const audit = await db.listAuditEvents({ actor_user_id: ids.bob, action: 'auth.passkey_clone_suspected' });
    expect(audit.length).toBe(1);
    expect(audit[0].meta.passkey_id).toBe(pk.id);
    expect(mail.to(email('bob')).some((x) => /may have been copied/i.test(x.subject))).toBe(true);
    expect((await loginWith(auth, { origin: ORIGIN, rpId: RP, counter: 5 })).status).toBe(401); // equal to the stored one: still refused
    expect((await loginWith(auth, { origin: ORIGIN, rpId: RP, counter: 11 })).status).toBe(200);
    // two concurrent assertions with the SAME counter: exactly one wins (atomic compare-and-set)
    await clearLimiter(db, ['auth/login']);
    const opts = await Promise.all([1, 2].map(async () => (await data(await post(m.logOpt, '/api/auth/passkeys/login/options', null))).options));
    const [a1, a2] = opts.map((o) => auth.get(o, { origin: ORIGIN, rpId: RP, counter: 50 }));
    const rs = await Promise.all([a1, a2].map((a) => post(m.logVer, '/api/auth/passkeys/login/verify', null, { response: a })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  test('disabled accounts, accounts without membership and unverified email', async () => {
    const auth = new VirtualAuthenticator();
    await register(await signIn('nomem'), auth, 'x');
    expect((await loginWith(auth)).status).toBe(200);
    await db.prisma.membership.updateMany({ where: { userId: ids.nomem }, data: { disabledAt: new Date() } }); // disabled in its only business
    expect((await loginWith(auth)).status).toBe(401);
    await db.prisma.membership.updateMany({ where: { userId: ids.nomem }, data: { disabledAt: null } });
    await db.prisma.user.update({ where: { id: ids.nomem }, data: { disabledAt: new Date() } });
    const r = await loginWith(auth);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: 'passkey sign-in failed' });
    await db.prisma.user.update({ where: { id: ids.nomem }, data: { disabledAt: null } });
    // unverified email still signs in (the dashboard shows the banner), exactly like a password login
    const bobAuth = new VirtualAuthenticator();
    await register(await signIn('bob'), bobAuth, 'b');
    await db.prisma.user.update({ where: { id: ids.bob }, data: { emailVerifiedAt: null } }); // (registration itself needs a verified address, see the R14 test)
    const rb = await loginWith(bobAuth);
    expect(rb.status).toBe(200);
    expect((await data(rb)).email_verified).toBe(false);
    await db.prisma.user.update({ where: { id: ids.bob }, data: { emailVerifiedAt: new Date() } });
  });

  test('step-up with a passkey counts as the recent-auth proof; deleting a passkey needs it; ownership is enforced', async () => {
    const cookie = await signIn('alice');
    const auth = new VirtualAuthenticator();
    const pk = await register(cookie, auth, 'Step up');
    const row = await db.resolveSessionByToken(cookie.split('=')[1]);
    const setStale = () => db.prisma.userSession.update({ where: { id: row.session.id }, data: { sudoAt: new Date(Date.now() - 10 * 60_000) } });
    await setStale();
    const del = () => m.item.DELETE(req(`/api/auth/passkeys/${pk.id}`, { method: 'DELETE', headers: { cookie } }), { params: Promise.resolve({ id: pk.id }) });
    const denied = await del();
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('reauth_required');
    // the step-up: options -> assertion
    const o = (await data(await post(m.reOpt, '/api/auth/passkeys/reauth/options', cookie))).options;
    expect(o.allowCredentials.map((c: any) => c.id)).toContain(auth.id);
    const bad = await post(m.reVer, '/api/auth/passkeys/reauth/verify', cookie, { response: auth.get(o, { origin: 'https://evil.test', rpId: RP }) });
    expect(bad.status).toBe(401);
    const o2 = (await data(await post(m.reOpt, '/api/auth/passkeys/reauth/options', cookie))).options;
    expect((await post(m.reVer, '/api/auth/passkeys/reauth/verify', cookie, { response: auth.get(o2, { origin: ORIGIN, rpId: RP, flags: { uv: false } }) })).status).toBe(401);
    const o3 = (await data(await post(m.reOpt, '/api/auth/passkeys/reauth/options', cookie))).options;
    const ok = await post(m.reVer, '/api/auth/passkeys/reauth/verify', cookie, { response: auth.get(o3, { origin: ORIGIN, rpId: RP }) });
    expect(ok.status).toBe(200);
    expect((await data(ok)).reauthenticated).toBe(true);
    const after = await db.resolveSessionByToken(cookie.split('=')[1]);
    expect(Date.now() - new Date(after.session.sudo_at).getTime()).toBeLessThan(60_000);
    // another account's passkey cannot be used to step up THIS session, nor renamed or deleted
    const bobCookie = await signIn('bob');
    const bobAuth = new VirtualAuthenticator();
    const bobPk = await register(bobCookie, bobAuth, 'Bob');
    const o4 = (await data(await post(m.reOpt, '/api/auth/passkeys/reauth/options', cookie))).options;
    expect((await post(m.reVer, '/api/auth/passkeys/reauth/verify', cookie, { response: bobAuth.get(o4, { origin: ORIGIN, rpId: RP }) })).status).toBe(401);
    const ctxB = { params: Promise.resolve({ id: bobPk.id }) };
    expect((await m.item.PATCH(req(`/api/auth/passkeys/${bobPk.id}`, { method: 'PATCH', json: { name: 'x' }, headers: { cookie } }), ctxB)).status).toBe(404);
    expect((await m.item.DELETE(req(`/api/auth/passkeys/${bobPk.id}`, { method: 'DELETE', headers: { cookie } }), ctxB)).status).toBe(404);
    // rename (no step-up needed) and delete (fresh now)
    expect((await m.item.PATCH(req(`/api/auth/passkeys/${pk.id}`, { method: 'PATCH', json: { name: 'Renamed' }, headers: { cookie } }), { params: Promise.resolve({ id: pk.id }) })).status).toBe(200);
    expect((await data(await m.list.GET(req('/api/auth/passkeys', { headers: { cookie } })))).passkeys.find((p: any) => p.id === pk.id).name).toBe('Renamed');
    mail.mails.length = 0;
    expect((await del()).status).toBe(200);
    expect(mail.to(email('alice')).some((x) => /passkey was removed/i.test(x.subject))).toBe(true);
    // the account still signs in with its password (cannot be locked out)
    expect(await signIn('alice')).toBeTruthy();
    // a passkey step-up for an account with no passkeys: clear 409
    await db.prisma.passkeyCredential.deleteMany({ where: { userId: ids.alice } });
    const none = await post(m.reOpt, '/api/auth/passkeys/reauth/options', await signIn('alice'));
    expect(none.status).toBe(409);
  });

  test('rate limits: login options per client', async () => {
    await clearLimiter(db, ['auth/passkeys']);
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await post(m.logOpt, '/api/auth/passkeys/login/options', null, {}, { 'x-forwarded-for': '203.0.113.77' })).status;
    expect(last).toBe(429);
  });

  test('not configured: 503 (production without APP_URL never falls back to the request host)', async () => {
    const saved = { app: process.env.APP_URL, node: process.env.NODE_ENV };
    delete process.env.APP_URL;
    (process.env as any).NODE_ENV = 'production';
    try {
      const r = await post(m.logOpt, '/api/auth/passkeys/login/options', null);
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('passkeys_not_configured');
    } finally {
      process.env.APP_URL = saved.app;
      (process.env as any).NODE_ENV = saved.node;
    }
  });

  test('R14 H1: a squatter on an unverified account cannot plant a passkey, and one planted earlier does not survive the real owner\'s password reset', async () => {
    // (a) registration needs a verified email address
    const cookie = await signIn('squat');
    expect((await post(m.regOpt, '/api/auth/passkeys/register/options', cookie)).status).toBe(403);
    expect((await post(m.regVer, '/api/auth/passkeys/register/verify', cookie, { response: { id: 'x' } })).status).toBe(403);
    // (b) a credential that WAS planted while the address was unverified (an older deployment, or any other route in): the reset clears it
    const planted = new VirtualAuthenticator();
    await db.prisma.user.update({ where: { id: ids.squat }, data: { emailVerifiedAt: new Date() } });
    await register(await signIn('squat'), planted, 'attacker key');
    await db.prisma.user.update({ where: { id: ids.squat }, data: { emailVerifiedAt: null } });
    await db.prisma.passkeyCredential.updateMany({ where: { userId: ids.squat }, data: { createdAt: new Date(Date.now() - 3600_000) } });
    expect((await loginWith(planted)).status).toBe(200); // the attacker can sign in with it today
    const reset = await import('../../src/app/api/auth/reset-password/route');
    const { createEmailToken } = await import('../../src/lib/db/email-tokens');
    const tok = await createEmailToken({ email: email('squat'), purpose: 'reset', user_id: ids.squat });
    await clearLimiter(db, ['auth/reset-password']);
    const r = await reset.POST(req('/api/auth/reset-password', { method: 'POST', json: { token: tok.token, password: 'a brand new passphrase 123' } }));
    expect(r.status).toBe(200);
    expect(await db.prisma.passkeyCredential.count({ where: { userId: ids.squat } })).toBe(0);
    expect((await loginWith(planted)).status).toBe(401); // the planted key is dead
    expect((await db.listAuditEvents({ actor_user_id: ids.squat })).map((a: any) => a.action)).toContain('auth.passkeys_cleared_on_reset');
    expect(mail.to(email('squat')).some((x) => /passkey was removed/i.test(x.subject))).toBe(true);
    // (c) a passkey registered AFTER the address was verified is kept by a reset (like TOTP enrolled after verification)
    const honest = new VirtualAuthenticator();
    await clearLimiter(db, ['auth/login']);
    const again = await m.login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('squat'), password: 'a brand new passphrase 123' } }));
    expect(again.status).toBe(200);
    await register(cookieFrom(again) as string, honest, 'honest key'); // the reset marked the address verified
    const tok2 = await createEmailToken({ email: email('squat'), purpose: 'reset', user_id: ids.squat });
    await clearLimiter(db, ['auth/reset-password']);
    expect((await reset.POST(req('/api/auth/reset-password', { method: 'POST', json: { token: tok2.token, password: 'another new passphrase 456' } }))).status).toBe(200);
    expect(await db.prisma.passkeyCredential.count({ where: { userId: ids.squat } })).toBe(1);
  });
});
