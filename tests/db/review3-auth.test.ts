/**
 * Round-3 review fixes for accounts, against a DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set):
 *  M2 signup capacity cannot be switched off by one client, M4 pre-account squatting (no 2FA while unverified, reset
 *  clears 2FA planted before verification, stale unverified signups are replaced, verified ones never).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;
const LIMITER = ['auth/signup', 'auth/forgot-password', 'auth/reset-password', 'auth/login', 'auth/2fa'];

suite('round-3 account fixes (postgres)', () => {
  let db: any, pw: any, mail: ReturnType<typeof captureMail>, sg: any;
  let signup: any, forgot: any, reset: any, login: any, enroll: any, confirm: any;
  const run = rid();
  const email = (n: string) => `r3-${n}-${run}@example.test`;
  const bizIds: string[] = [];
  const userEmails: string[] = [];

  beforeAll(async () => {
    ({ db, pw } = await loadAuthModules());
    sg = await import('../../src/lib/signup');
    signup = await import('../../src/app/api/auth/signup/route');
    forgot = await import('../../src/app/api/auth/forgot-password/route');
    reset = await import('../../src/app/api/auth/reset-password/route');
    login = await import('../../src/app/api/auth/login/route');
    enroll = await import('../../src/app/api/auth/2fa/enroll/route');
    confirm = await import('../../src/app/api/auth/2fa/confirm/route');
    mail = captureMail();
    await clearLimiter(db, LIMITER);
  });
  afterEach(async () => {
    delete process.env.SIGNUP_MAX_PER_HOUR;
    mail.mails.length = 0;
    await clearLimiter(db, LIMITER);
  });
  afterAll(async () => {
    mail.restore();
    const ids = (await db.prisma.user.findMany({ where: { email: { in: userEmails } }, select: { id: true } })).map((u: any) => u.id);
    await db.prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: bizIds } }, { actorUserId: { in: ids } }] } });
    await db.prisma.user.deleteMany({ where: { email: { in: userEmails } } });
    await db.prisma.business.deleteMany({ where: { id: { in: bizIds } } });
    await db.prisma.$disconnect();
  });

  const post = (mod: any, path: string, json: unknown, extra: Record<string, string> = {}, ip?: string) =>
    mod.POST(req(path, { method: 'POST', json, headers: extra, ip }));
  const doSignup = (e: string, ip?: string) => post(signup, '/api/auth/signup', { email: e, password: PASSWORD, business_name: `Biz ${run}` }, {}, ip);

  async function owner(n: string, opts: { verified: boolean; ageHours?: number }) {
    const biz = await db.prisma.business.create({ data: { id: `biz_r3_${n}_${run}`, name: `R3 ${n}`, status: 'live' } });
    bizIds.push(biz.id);
    userEmails.push(email(n));
    const user = await db.createUser({ email: email(n), password_hash: await pw.hashPassword(PASSWORD), role: 'owner', business_id: biz.id, email_verified: opts.verified });
    if (opts.ageHours) await db.prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date(Date.now() - opts.ageHours * 3600_000) } });
    return { biz, user };
  }

  describe('M2: signup capacity', () => {
    test('only CREATED accounts count; an existing address or a honeypot hit never consumes capacity', async () => {
      process.env.SIGNUP_MAX_PER_HOUR = '10';
      const existing = await owner('cap-exist', { verified: true });
      expect(existing.user.id).toBeTruthy();
      for (let i = 0; i < 3; i++) expect((await doSignup(email('cap-exist'))).status).toBe(200);
      expect(Math.round(await (await import('../../src/lib/ratelimit')).peekRateLimit('auth/signup:created:global', 3600_000))).toBe(0);
    });

    test('one client is stopped by its own share long before the global cap; other clients still sign up', async () => {
      process.env.SIGNUP_MAX_PER_HOUR = '10'; // per-client share = 2
      const attacker = '203.0.113.50';
      const out: number[] = [];
      for (let i = 0; i < 4; i++) {
        const e = email(`atk${i}`);
        userEmails.push(e);
        out.push((await doSignup(e, attacker)).status);
      }
      expect(out).toEqual([200, 200, 429, 429]);
      const real = email('real-after-attack');
      userEmails.push(real);
      expect((await doSignup(real, '203.0.113.99')).status).toBe(200);
      const ok = await sg.checkSignupCapacity('203.0.113.77');
      expect(ok.ok).toBe(true);
    });

    test('degrades at 70% (a client that already created one gets no second) and stops for everybody only at 100%', async () => {
      process.env.SIGNUP_MAX_PER_HOUR = '10';
      for (let i = 0; i < 7; i++) await sg.recordSignupCreated(`10.0.0.${i}`);
      const first = await sg.checkSignupCapacity('10.9.9.9');
      expect(first).toEqual({ ok: true, level: 'degraded' });
      expect((await sg.checkSignupCapacity('10.0.0.1')).ok).toBe(false); // already created one this hour
      for (let i = 7; i < 10; i++) await sg.recordSignupCreated(`10.0.0.${i}`);
      const stopped = await sg.checkSignupCapacity('10.9.9.9');
      expect(stopped).toMatchObject({ ok: false, reason: 'global_cap' });
    });
  });

  describe('M4: pre-account squatting', () => {
    test('an unverified account cannot enrol 2FA (403 email_not_verified); a verified one can', async () => {
      await owner('sq-unv', { verified: false });
      const res = await post(login, '/api/auth/login', { email: email('sq-unv'), password: PASSWORD });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res) as string;
      const e = await post(enroll, '/api/auth/2fa/enroll', { password: PASSWORD }, { cookie });
      expect(e.status).toBe(403);
      expect((await e.json()).error).toBe('email_not_verified');
      expect((await post(confirm, '/api/auth/2fa/confirm', { code: '123456' }, { cookie })).status).toBe(403);
    });

    async function resetFor(n: string) {
      mail.mails.length = 0;
      await post(forgot, '/api/auth/forgot-password', { email: email(n) });
      const m = mail.to(email(n)).find((x) => x.subject.includes('Reset'))!;
      expect(m).toBeTruthy();
      await clearLimiter(db, ['auth/reset-password']);
      return post(reset, '/api/auth/reset-password', { token: m.token, password: 'a brand new passphrase 99' });
    }

    test('a reset on an account whose 2FA was planted while UNVERIFIED removes it, audits it and emails the owner', async () => {
      const { user } = await owner('sq-reset', { verified: false });
      await db.prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.planted', totpEnabledAt: new Date(), totpLastUsedStep: 1 } });
      await db.prisma.recoveryCode.create({ data: { userId: user.id, codeHash: `h-${run}` } });
      expect((await resetFor('sq-reset')).status).toBe(200);
      const st = await db.getTotpState(user.id);
      expect(st.enabled_at).toBeNull();
      expect(st.secret_enc).toBeNull();
      expect(await db.countUnusedRecoveryCodes(user.id)).toBe(0);
      expect((await db.getUserById(user.id)).email_verified_at).not.toBeNull();
      expect((await db.listAuditEvents({ actor_user_id: user.id })).some((a: any) => a.action === 'auth.2fa_cleared_on_reset')).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(mail.to(email('sq-reset')).some((m: any) => /two-factor|2fa/i.test(m.subject))).toBe(true);
    });

    test('2FA enrolled BEFORE the email was verified (legacy account) is cleared too; 2FA enrolled AFTER verification survives a reset', async () => {
      const early = await owner('sq-early', { verified: true });
      await db.prisma.user.update({ where: { id: early.user.id }, data: { emailVerifiedAt: new Date(), totpSecretEnc: 'v1.x', totpEnabledAt: new Date(Date.now() - 3600_000) } });
      await db.prisma.user.update({ where: { id: early.user.id }, data: { emailVerifiedAt: new Date(Date.now() + 1000) } });
      expect((await resetFor('sq-early')).status).toBe(200);
      expect((await db.getTotpState(early.user.id)).enabled_at).toBeNull();

      const late = await owner('sq-late', { verified: true });
      await db.prisma.user.update({ where: { id: late.user.id }, data: { emailVerifiedAt: new Date(Date.now() - 7200_000), totpSecretEnc: 'v1.y', totpEnabledAt: new Date(Date.now() - 3600_000) } });
      expect((await resetFor('sq-late')).status).toBe(200);
      expect((await db.getTotpState(late.user.id)).enabled_at).not.toBeNull();
    });

    test('a stale (>24h) UNVERIFIED signup is REPLACED by a new signup for the same address; the squatter is gone', async () => {
      const squat = await owner('sq-stale', { verified: false, ageHours: 30 });
      expect((await doSignup(email('sq-stale'))).status).toBe(200);
      const now = await db.getUserByEmail(email('sq-stale'));
      expect(now.id).not.toBe(squat.user.id);
      expect(now.business_id).not.toBe(squat.biz.id);
      expect(now.email_verified_at).toBeNull();
      expect(await db.prisma.business.count({ where: { id: squat.biz.id } })).toBe(0);
      bizIds.push(now.business_id);
      expect(mail.to(email('sq-stale')).some((m: any) => /verify|confirm/i.test(m.subject))).toBe(true);
      expect((await db.listAuditEvents({ actor_user_id: now.id })).some((a: any) => a.action === 'auth.signup')).toBe(true);
    });

    test('NEVER replaced: a fresh unverified signup, a verified one, one with a number/agent/plan or a second member', async () => {
      const fresh = await owner('sq-fresh', { verified: false, ageHours: 2 });
      const verified = await owner('sq-ver', { verified: true, ageHours: 100 });
      const paid = await owner('sq-paid', { verified: false, ageHours: 100 });
      await db.prisma.business.update({ where: { id: paid.biz.id }, data: { agentId: `agent_${run}` } });
      for (const [n, o] of [['sq-fresh', fresh], ['sq-ver', verified], ['sq-paid', paid]] as const) {
        expect((await doSignup(email(n))).status).toBe(200); // same answer for everybody (no enumeration)
        expect((await db.getUserByEmail(email(n))).id).toBe(o.user.id);
        expect(await db.prisma.business.count({ where: { id: o.biz.id } })).toBe(1);
      }
    });
  });
});
