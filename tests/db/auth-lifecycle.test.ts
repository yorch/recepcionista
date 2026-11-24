/**
 * Account lifecycle against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set):
 * signup (no enumeration, abuse controls), email verification, password reset, invitations.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/db/auth-lifecycle.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;
const LIMITER = ['auth/signup', 'auth/verify-email', 'auth/resend-verification', 'auth/forgot-password', 'auth/reset-password', 'auth/accept-invite', 'team/invite', 'auth/login'];

suite('account lifecycle (postgres)', () => {
  let db: any, s: any, pw: any, mail: ReturnType<typeof captureMail>;
  let signup: any, verify: any, resend: any, forgot: any, reset: any, accept: any, login: any, invite: any;
  const run = rid();
  const email = (n: string) => `${n}-${run}@example.test`;
  const bizIds: string[] = [];
  const userEmails: string[] = [];

  beforeAll(async () => {
    ({ db, s, pw } = await loadAuthModules());
    signup = await import('../../src/app/api/auth/signup/route');
    verify = await import('../../src/app/api/auth/verify-email/route');
    resend = await import('../../src/app/api/auth/resend-verification/route');
    forgot = await import('../../src/app/api/auth/forgot-password/route');
    reset = await import('../../src/app/api/auth/reset-password/route');
    accept = await import('../../src/app/api/auth/accept-invite/route');
    login = await import('../../src/app/api/auth/login/route');
    invite = await import('../../src/app/api/team/invite/route');
    mail = captureMail();
    await clearLimiter(db, LIMITER);
  });
  afterEach(async () => {
    delete process.env.SIGNUP_MAX_PER_HOUR;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    mail.mails.length = 0;
    await clearLimiter(db, ['auth/signup:']);
  });
  afterAll(async () => {
    mail.restore();
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: bizIds } }, { actorUserId: { in: (await db.prisma.user.findMany({ where: { email: { in: userEmails } }, select: { id: true } })).map((u: any) => u.id) } }] } });
    await db.prisma.user.deleteMany({ where: { email: { in: userEmails } } });
    await db.prisma.business.deleteMany({ where: { id: { in: bizIds } } });
    await clearLimiter(db, [...LIMITER, 'team/invite-resend']);
    await db.prisma.$disconnect();
  });

  const post = (mod: any, path: string, json: unknown, extra: Record<string, string> = {}) => mod.POST(req(path, { method: 'POST', json, headers: extra }));
  const doSignup = (e: string, extra: Record<string, unknown> = {}) =>
    post(signup, '/api/auth/signup', { email: e, password: PASSWORD, business_name: `Biz ${run}`, ...extra });
  async function newOwner(n: string, opts: { verified?: boolean } = {}) {
    const biz = await db.prisma.business.create({ data: { id: `biz_lc_${n}_${run}`, name: `LC ${n}`, status: 'live' } });
    bizIds.push(biz.id);
    userEmails.push(email(n));
    const user = await db.createUser({ email: email(n), password_hash: await pw.hashPassword(PASSWORD), role: 'owner', business_id: biz.id, email_verified: opts.verified ?? true });
    return { biz, user };
  }
  async function signIn(n: string): Promise<string> {
    await clearLimiter(db, ['auth/login']);
    const res = await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email(n), password: PASSWORD } }));
    expect(res.status).toBe(200);
    return cookieFrom(res) as string;
  }

  describe('signup', () => {
    test('creates a business (billing none) and an UNVERIFIED owner, mails a verification link, issues no session', async () => {
      const e = email('new1');
      userEmails.push(e);
      const res = await doSignup(e);
      expect(res.status).toBe(200);
      expect(cookieFrom(res)).toBeNull();
      const user = await db.getUserByEmail(e);
      expect(user.role).toBe('owner');
      expect(user.email_verified_at).toBeNull();
      bizIds.push(user.business_id);
      const biz = await db.getBusiness(user.business_id);
      expect(biz.name).toBe(`Biz ${run}`);
      expect(biz.billing_status).toBe('none');
      expect(biz.agent_id ?? null).toBeNull();
      expect(biz.phone ?? null).toBeNull();
      const m = mail.to(e);
      expect(m.length).toBe(1);
      expect(m[0].link).toContain('/verify-email?token=');
      // the stored token is only a hash
      expect(await db.prisma.emailToken.count({ where: { tokenHash: m[0].token } })).toBe(0);
    });

    test('an existing address gets the SAME response, no new business, and one notice per hour', async () => {
      const e = email('dup');
      userEmails.push(e);
      const first = await doSignup(e);
      const bizBefore = await db.prisma.business.count();
      const user = await db.getUserByEmail(e);
      bizIds.push(user.business_id);
      mail.mails.length = 0;
      const again = await doSignup(e);
      expect(again.status).toBe(first.status);
      expect(await again.json()).toEqual(await first.json());
      expect(await db.prisma.business.count()).toBe(bizBefore);
      expect(mail.to(e).length).toBe(1);
      expect(mail.to(e)[0].subject).toContain('Someone tried');
      expect(mail.to(e)[0].link).not.toContain('token=');
      await doSignup(e);
      expect(mail.to(e).length).toBe(1); // second notice inside the hour is suppressed
    });

    describe('production captcha requirement', () => {
      const KEYS = ['NODE_ENV', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'SIGNUP_ALLOW_WITHOUT_CAPTCHA'] as const;
      const saved: Record<string, string | undefined> = {};
      const env = process.env as Record<string, string | undefined>;
      beforeAll(() => { for (const k of KEYS) saved[k] = env[k]; });
      afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; } });

      test('production without captcha config: 503 signup_disabled and nothing is created', async () => {
        env.NODE_ENV = 'production'; delete env.TURNSTILE_SECRET_KEY; delete env.NEXT_PUBLIC_TURNSTILE_SITE_KEY; delete env.SIGNUP_ALLOW_WITHOUT_CAPTCHA;
        const e = email('prod-nocaptcha');
        userEmails.push(e);
        const res = await doSignup(e);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ ok: false, error: 'signup_disabled' });
        expect(await db.getUserByEmail(e)).toBeNull();
        expect(mail.to(e).length).toBe(0);
      });

      test('production with the Turnstile pair: signup works (and a failed captcha is still refused)', async () => {
        env.NODE_ENV = 'production'; env.TURNSTILE_SECRET_KEY = 'ts-secret'; env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'ts-site'; delete env.SIGNUP_ALLOW_WITHOUT_CAPTCHA;
        const e = email('prod-captcha');
        userEmails.push(e);
        expect((await doSignup(e)).status).toBe(400); // no token: fails closed
        const res = await doSignup(e, { turnstile_token: 'tok' });
        expect(res.status).toBe(200);
        const user = await db.getUserByEmail(e);
        expect(user).not.toBeNull();
        bizIds.push(user.business_id);
      });

      test('production with the explicit opt-out: signup works without a token', async () => {
        env.NODE_ENV = 'production'; delete env.TURNSTILE_SECRET_KEY; delete env.NEXT_PUBLIC_TURNSTILE_SITE_KEY; env.SIGNUP_ALLOW_WITHOUT_CAPTCHA = 'true';
        const e = email('prod-waived');
        userEmails.push(e);
        expect((await doSignup(e)).status).toBe(200);
        const user = await db.getUserByEmail(e);
        expect(user).not.toBeNull();
        bizIds.push(user.business_id);
      });
    });

    test('atomic: a failure creating the owner rolls the business back (no orphan business)', async () => {
      const { createSignupAccount } = await import('../../src/lib/signup');
      const name = `Orphan Check ${run}`;
      await expect(createSignupAccount({ email: 'no-at-sign', passwordHash: 'x'.repeat(20), businessName: name })).rejects.toThrow();
      expect(await db.prisma.business.count({ where: { name } })).toBe(0);
      const e = email('atomic');
      userEmails.push(e);
      const ok = await createSignupAccount({ email: e, passwordHash: 'x'.repeat(20), businessName: name });
      bizIds.push(ok!.businessId);
      expect(ok!.user.business_id).toBe(ok!.businessId);
      expect(await db.prisma.business.count({ where: { name } })).toBe(1);
      expect(await createSignupAccount({ email: e, passwordHash: 'x'.repeat(20), businessName: name })).toBeNull(); // existing address
      expect(await db.prisma.business.count({ where: { name } })).toBe(1);
    });

    test('validation: weak password, junk email, junk business name', async () => {
      expect((await doSignup(email('v1'), { password: 'short' })).status).toBe(422);
      expect((await doSignup(email('v2'), { password: 'aaaaaaaaaaaaaaaa' })).status).toBe(422);
      expect((await doSignup(email('v3'), { password: 'password1234' })).status).toBe(422);
      expect((await doSignup('not-an-email')).status).toBe(422);
      expect((await doSignup(email('v4'), { business_name: ' ' })).status).toBe(422);
      expect((await doSignup(email('v5'), { business_name: '<script>' })).status).toBe(422);
      expect(await db.getUserByEmail(email('v1'))).toBeNull();
    });

    test('honeypot: looks like success, creates nothing, sends nothing', async () => {
      const e = email('bot');
      const res = await doSignup(e, { company_website: 'http://spam.test' });
      expect(res.status).toBe(200);
      expect(await db.getUserByEmail(e)).toBeNull();
      expect(mail.mails.length).toBe(0);
    });

    test('cross-site signup is refused', async () => {
      const res = await signup.POST(req('/api/auth/signup', { method: 'POST', json: {}, headers: { 'sec-fetch-site': 'cross-site' } }));
      expect(res.status).toBe(403);
    });

    test('global hourly cap (SIGNUP_MAX_PER_HOUR) stops mass creation', async () => {
      process.env.SIGNUP_MAX_PER_HOUR = '2';
      await clearLimiter(db, ['auth/signup:']);
      const statuses: number[] = [];
      for (const n of ['cap1', 'cap2', 'cap3']) {
        const e = email(n);
        userEmails.push(e);
        statuses.push((await doSignup(e)).status);
        const u = await db.getUserByEmail(e);
        if (u) bizIds.push(u.business_id);
      }
      expect(statuses).toEqual([200, 200, 429]);
      expect(await db.getUserByEmail(email('cap3'))).toBeNull();
    });

    test('per-IP limit and per-address limit', async () => {
      const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await signup.POST(req('/api/auth/signup', { method: 'POST', ip, json: { email: 'not-valid', password: 'x', business_name: 'x' } }))).status);
      expect(codes.slice(0, 5).every((c) => c === 422)).toBe(true);
      expect(codes[6]).toBe(429);
      // per address: 3 per hour no matter the IP
      const e = email('rate');
      userEmails.push(e);
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await doSignup(e)).status);
      expect(out).toEqual([200, 200, 200, 429]);
      const u = await db.getUserByEmail(e);
      if (u) bizIds.push(u.business_id);
    });

    test('Turnstile: secret WITHOUT a site key (no widget can exist, e.g. the captcha waiver) does not demand a token', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'ts-secret'; // site key deliberately unset
      const e = email('tsnowidget');
      userEmails.push(e);
      expect((await doSignup(e)).status).toBe(200);
      const u = await db.getUserByEmail(e);
      expect(u).not.toBeNull();
      bizIds.push(u.business_id);
    });

    test('Turnstile: enabled -> missing/failed token is refused (fail closed), valid token passes', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'ts-secret';
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'ts-site';
      const e = email('ts1');
      userEmails.push(e);
      expect((await doSignup(e)).status).toBe(400); // no token
      mail.restore();
      mail = captureMail({ turnstile: false });
      expect((await doSignup(e, { turnstile_token: 'bad' })).status).toBe(400);
      expect(await db.getUserByEmail(e)).toBeNull();
      mail.restore();
      mail = captureMail({ turnstile: true });
      process.env.TURNSTILE_SECRET_KEY = 'ts-secret';
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'ts-site';
      expect((await doSignup(e, { turnstile_token: 'good' })).status).toBe(200);
      const u = await db.getUserByEmail(e);
      expect(u).not.toBeNull();
      bizIds.push(u.business_id);
    });

    test('mail provider not configured: signup refuses BEFORE creating anything (same for any address)', async () => {
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      const e = email('nomail');
      expect((await doSignup(e)).status).toBe(503);
      expect(await db.getUserByEmail(e)).toBeNull();
      process.env.RESEND_API_KEY = saved;
    });
  });

  describe('email verification', () => {
    test('GET-style peek does not consume; POST consumes once; the user becomes verified; links are superseded by a resend', async () => {
      const { user } = await newOwner('ver', { verified: false });
      const r1 = await post(resend, '/api/auth/resend-verification', { email: email('ver') });
      expect(r1.status).toBe(200);
      const first = mail.to(email('ver')).at(-1)!.token as string;
      expect(await db.peekEmailToken('verify', first)).not.toBeNull();
      expect(await db.peekEmailToken('verify', first)).not.toBeNull(); // landing page view does not burn it
      await clearLimiter(db, ['auth/resend-verification']);
      await post(resend, '/api/auth/resend-verification', { email: email('ver') });
      const second = mail.to(email('ver')).at(-1)!.token as string;
      expect(second).not.toBe(first);
      expect((await post(verify, '/api/auth/verify-email', { token: first })).status).toBe(400); // superseded
      const ok = await post(verify, '/api/auth/verify-email', { token: second });
      expect(ok.status).toBe(200);
      expect((await db.getUserById(user.id)).email_verified_at).not.toBeNull();
      expect((await post(verify, '/api/auth/verify-email', { token: second })).status).toBe(400); // single use
      expect((await post(verify, '/api/auth/verify-email', { token: 'x'.repeat(40) })).status).toBe(400);
    });

    test('resend never reveals whether an address exists or is already verified', async () => {
      await newOwner('ver2', { verified: true });
      const known = await post(resend, '/api/auth/resend-verification', { email: email('ver2') });
      const unknown = await post(resend, '/api/auth/resend-verification', { email: `nobody-${run}@example.test` });
      const junk = await post(resend, '/api/auth/resend-verification', { email: 'junk' });
      for (const r of [known, unknown, junk]) expect(r.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());
      expect(mail.to(email('ver2')).length).toBe(0); // verified accounts get nothing
    });

    test('an expired verification token is rejected', async () => {
      const { user } = await newOwner('ver3', { verified: false });
      const { token } = await db.createEmailToken({ purpose: 'verify', email: email('ver3'), user_id: user.id, now: new Date(Date.now() - 48 * 3600_000) });
      expect((await post(verify, '/api/auth/verify-email', { token })).status).toBe(400);
    });
  });

  describe('password reset', () => {
    test('same response for known/unknown; link single use, 1h; weak password does not burn it; revokes sessions; notifies', async () => {
      const { user } = await newOwner('rst');
      const cookie = await signIn('rst');
      const known = await post(forgot, '/api/auth/forgot-password', { email: email('rst') });
      const unknown = await post(forgot, '/api/auth/forgot-password', { email: `ghost-${run}@example.test` });
      expect(known.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());
      expect(mail.to(`ghost-${run}@example.test`).length).toBe(0);
      const m = mail.to(email('rst')).find((x) => x.subject.includes('Reset'))!;
      expect(m.link).toContain('/reset-password?token=');
      const rec = await db.peekEmailToken('reset', m.token);
      expect(new Date(rec.expires_at).getTime() - new Date(rec.created_at).getTime()).toBeLessThanOrEqual(3600_000 + 1000);

      expect((await post(reset, '/api/auth/reset-password', { token: m.token, password: 'short' })).status).toBe(422);
      expect(await db.peekEmailToken('reset', m.token)).not.toBeNull(); // still usable

      const NEW = 'a brand new long passphrase';
      const done = await post(reset, '/api/auth/reset-password', { token: m.token, password: NEW });
      expect(done.status).toBe(200);
      expect((await s.resolvePrincipal(new Headers({ cookie }))).ok).toBe(false); // every session revoked
      expect((await post(reset, '/api/auth/reset-password', { token: m.token, password: NEW })).status).toBe(400); // single use
      expect(mail.to(email('rst')).some((x) => x.subject.includes('password was changed'))).toBe(true);
      await clearLimiter(db, ['auth/login']);
      expect((await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('rst'), password: PASSWORD } }))).status).toBe(401);
      expect((await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('rst'), password: NEW } }))).status).toBe(200);
      const audit = await db.listAuditEvents({ actor_user_id: user.id });
      expect(audit.some((a: any) => a.action === 'auth.password_reset')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(m.token);
    });

    test('a newer reset link supersedes the older; disabled users get no link', async () => {
      const { user } = await newOwner('rst2');
      await post(forgot, '/api/auth/forgot-password', { email: email('rst2') });
      await clearLimiter(db, ['auth/forgot-password']);
      await post(forgot, '/api/auth/forgot-password', { email: email('rst2') });
      const [a, b] = mail.to(email('rst2')).map((x) => x.token as string);
      expect((await post(reset, '/api/auth/reset-password', { token: a, password: 'another long passphrase' })).status).toBe(400);
      expect((await post(reset, '/api/auth/reset-password', { token: b, password: 'another long passphrase' })).status).toBe(200);
      await db.setUserDisabled(user.id, true);
      mail.mails.length = 0;
      await clearLimiter(db, ['auth/forgot-password']);
      expect((await post(forgot, '/api/auth/forgot-password', { email: email('rst2') })).status).toBe(200);
      expect(mail.mails.length).toBe(0);
    });

    test('an email provider failure stays generic on the public endpoint', async () => {
      await newOwner('rst3');
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      await clearLimiter(db, ['auth/forgot-password']);
      const r = await post(forgot, '/api/auth/forgot-password', { email: email('rst3') });
      expect(r.status).toBe(200);
      expect(JSON.stringify(await r.json())).not.toMatch(/configured|resend/i);
      process.env.RESEND_API_KEY = saved;
    });

    test('per-IP limit', async () => {
      const ip = '203.0.113.7';
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await forgot.POST(req('/api/auth/forgot-password', { method: 'POST', ip, json: { email: `x${i}-${run}@example.test` } }))).status);
      expect(out[0]).toBe(200);
      expect(out[11]).toBe(429);
    });
  });

  describe('invitations', () => {
    test('owner invites staff; link bound to business+role; accept creates a VERIFIED user and signs in; single use', async () => {
      const { biz } = await newOwner('inv');
      const cookie = await signIn('inv');
      const e = email('invitee');
      userEmails.push(e);
      const res = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: e, role: 'staff' }, headers: { cookie } }));
      expect(res.status).toBe(201);
      const m = mail.to(e)[0];
      expect(m.link).toContain('/accept-invite?token=');
      const peek = await db.peekEmailToken('invite', m.token);
      expect(peek.business_id).toBe(biz.id);
      expect(peek.role).toBe('staff');

      expect((await post(accept, '/api/auth/accept-invite', { token: m.token, password: 'x' })).status).toBe(422);
      const ok = await post(accept, '/api/auth/accept-invite', { token: m.token, password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(cookieFrom(ok)).toBeTruthy();
      const user = await db.getUserByEmail(e);
      expect(user.business_id).toBe(biz.id);
      expect(user.role).toBe('staff');
      expect(user.email_verified_at).not.toBeNull();
      expect((await post(accept, '/api/auth/accept-invite', { token: m.token, password: PASSWORD })).status).toBe(400);
      const audit = await db.listAuditEvents({ business_id: biz.id });
      const acts = audit.map((a: any) => a.action);
      expect(acts.includes('user.invite') && acts.includes('user.invite_accepted')).toBe(true);
    });

    test('an address that already has an account: a password-only accept is refused (login required), the invitation is NOT consumed', async () => {
      const { biz } = await newOwner('inv2');
      await newOwner('already'); // an account in ANOTHER business with the invited address
      const cookie = await signIn('inv2');
      const res = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('already'), role: 'owner' }, headers: { cookie } }));
      expect(res.status).toBe(201);
      const m = mail.to(email('already')).at(-1)!;
      const r = await post(accept, '/api/auth/accept-invite', { token: m.token, password: PASSWORD });
      expect(r.status).toBe(401);
      expect((await r.json()).code).toBe('login_required');
      expect(await db.peekEmailToken('invite', m.token)).not.toBeNull();
      expect((await db.getUserByEmail(email('already'))).business_id).not.toBe(biz.id);
      expect(await db.getMembership((await db.getUserByEmail(email('already'))).id, biz.id)).toBeNull();
    });

    test('race: an account for the address appears AFTER the pre-check: 409 and the token is NOT burned (atomic accept)', async () => {
      const { biz } = await newOwner('inv-race');
      const cookie = await signIn('inv-race');
      const e = email('racer');
      userEmails.push(e);
      expect((await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: e, role: 'staff' }, headers: { cookie } }))).status).toBe(201);
      const m = mail.to(e).at(-1)!;
      const orig = pw.hashPassword;
      let injected = false;
      const spy = spyOn(pw, 'hashPassword').mockImplementation(async (...args: any[]) => {
        if (!injected) { // the window between the pre-check and the transaction
          injected = true;
          await db.createUser({ email: e, password_hash: 'x'.repeat(20), role: 'owner', business_id: (await newOwner('racer-biz')).biz.id, email_verified: true });
        }
        return orig(...args);
      });
      try {
        const r = await post(accept, '/api/auth/accept-invite', { token: m.token, password: PASSWORD });
        expect(injected).toBe(true);
        expect(r.status).toBe(409);
        expect((await r.json()).code).toBe('account_exists');
      } finally { spy.mockRestore(); }
      expect(await db.peekEmailToken('invite', m.token)).not.toBeNull(); // not consumed
      expect((await db.getUserByEmail(e)).business_id).not.toBe(biz.id);
    });

    test('inviting someone already on the team is a 409; expired and revoked invitations fail', async () => {
      const { biz, user } = await newOwner('inv3');
      const cookie = await signIn('inv3');
      expect((await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('inv3'), role: 'staff' }, headers: { cookie } }))).status).toBe(409);
      const { token } = await db.createEmailToken({ purpose: 'invite', email: email('late'), business_id: biz.id, role: 'staff', invited_by: user.id, now: new Date(Date.now() - 8 * 86400_000) });
      expect((await post(accept, '/api/auth/accept-invite', { token, password: PASSWORD })).status).toBe(400);
      const { token: t2, record } = await db.createEmailToken({ purpose: 'invite', email: email('gone'), business_id: biz.id, role: 'staff', invited_by: user.id });
      await db.prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
      expect((await post(accept, '/api/auth/accept-invite', { token: t2, password: PASSWORD })).status).toBe(400);
    });

    test('email provider failure on an invite is reported (503 email_not_configured) and leaves no live invitation', async () => {
      const { biz } = await newOwner('inv4');
      const cookie = await signIn('inv4');
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      const res = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('nomail2'), role: 'staff' }, headers: { cookie } }));
      process.env.RESEND_API_KEY = saved;
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('email_not_configured');
      expect(await db.prisma.emailToken.count({ where: { businessId: biz.id, usedAt: null } })).toBe(0);
    });

    test('an unverified owner cannot invite (email_not_verified); a staff cannot invite (403)', async () => {
      const { biz } = await newOwner('inv5', { verified: false });
      const cookie = await signIn('inv5');
      const res = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('x1'), role: 'staff' }, headers: { cookie } }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('email_not_verified');
      userEmails.push(email('stf'));
      await db.createUser({ email: email('stf'), password_hash: await pw.hashPassword(PASSWORD), role: 'staff', business_id: biz.id, email_verified: true });
      const sc = await signIn('stf');
      expect((await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('x2'), role: 'staff' }, headers: { cookie: sc } }))).status).toBe(403);
    });

    test('an admin token can invite into any business by naming it; an owner naming another business gets 404', async () => {
      const { biz } = await newOwner('inv6');
      const { biz: other } = await newOwner('inv7');
      const asAdmin = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('adm-inv'), role: 'staff', business_id: biz.id }, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(asAdmin.status).toBe(201);
      const noBiz = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('adm-inv2'), role: 'staff' }, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
      expect(noBiz.status).toBe(422);
      const cookie = await signIn('inv6');
      const cross = await invite.POST(req('/api/team/invite', { method: 'POST', json: { email: email('adm-inv3'), role: 'staff', business_id: other.id }, headers: { cookie } }));
      expect(cross.status).toBe(404);
    });
  });

  test('login still works for unverified users and exposes email_verified', async () => {
    await newOwner('unv', { verified: false });
    await clearLimiter(db, ['auth/login']);
    const res = await login.POST(req('/api/auth/login', { method: 'POST', json: { email: email('unv'), password: PASSWORD } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.email_verified).toBe(false);
    const r = await s.resolvePrincipal(new Headers({ cookie: cookieFrom(res) as string }));
    expect(r.ok && r.principal.email_verified).toBe(false);
    expect(() => s.requireVerifiedEmail(r.principal)).toThrow();
    const gated = await s.authenticate(new Request('http://app.test/api/x', { headers: { cookie: cookieFrom(res) as string } }), { verifiedEmail: true });
    expect(!gated.ok && gated.response.status).toBe(403);
  });
});
