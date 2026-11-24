/**
 * Phase-1 persistence: account lifecycle (tokens, sessions, TOTP state, audit) and billing/usage.
 * Skipped unless TEST_DATABASE_URL names a DISPOSABLE database containing "test" or "scratch" that has
 * the migrations applied:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/db/accounts-billing.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}
const suite = url ? describe : describe.skip;

suite('accounts + billing (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, users: any, tokens: any, audit: any, usage: any, totp: any;
  const run = Math.random().toString(36).slice(2, 8);
  const businessIds: string[] = [];
  const userIds: string[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = await import('../../src/lib/db');
    users = await import('../../src/lib/db/users');
    tokens = await import('../../src/lib/db/email-tokens');
    audit = await import('../../src/lib/db/audit');
    usage = await import('../../src/lib/db/usage');
    totp = await import('../../src/lib/totp');
  });

  afterEach(() => {
    for (const k of ['BILLING_ENFORCED', 'PLAN_SMS_CAP', 'PLAN_CALL_MINUTES_CAP', 'BILLING_PAST_DUE_GRACE_DAYS']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  afterAll(async () => {
    await db.prisma.auditEvent.deleteMany({ where: { action: { startsWith: `t-${run}` } } });
    await db.prisma.userSession.deleteMany({ where: { kind: 'admin_token', userAgent: `t-${run}` } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.business.deleteMany({ where: { id: { in: businessIds } } });
    await db.prisma.$disconnect();
  });

  const newBusiness = async (extra: Record<string, unknown> = {}) => {
    const b = await db.createBusiness({ name: `T ${run}`, ...extra });
    businessIds.push(b.id);
    return b;
  };
  const newUser = async (n: string, extra: Record<string, unknown> = {}) => {
    const biz = await newBusiness();
    const u = await users.createUser({ email: `${n}-${run}@example.test`, password_hash: 'h1', role: 'owner', business_id: biz.id, ...extra });
    userIds.push(u.id);
    return { u, biz };
  };

  // ── email tokens ──────────────────────────────────────────────────────────

  test('email token: stores only the hash, consumes exactly once under 20-way concurrency', async () => {
    const { u } = await newUser('tok');
    const { token, record } = await tokens.createEmailToken({ purpose: 'reset', email: u.email.toUpperCase(), user_id: u.id });
    expect(record.email).toBe(u.email);
    const stored = await db.prisma.emailToken.findUnique({ where: { id: record.id } });
    expect(stored.tokenHash).toBe(tokens.hashEmailToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    const results = await Promise.all(Array.from({ length: 20 }, () => tokens.consumeEmailToken('reset', token)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean).user_id).toBe(u.id);
    expect(await tokens.consumeEmailToken('reset', token)).toBeNull();
  });

  test('email token: wrong purpose, expiry, garbage; peek does not consume; resend supersedes', async () => {
    const { u } = await newUser('tok2');
    const a = await tokens.createEmailToken({ purpose: 'verify', email: u.email, user_id: u.id });
    expect(await tokens.consumeEmailToken('reset', a.token)).toBeNull();
    expect((await tokens.peekEmailToken('verify', a.token))?.id).toBe(a.record.id);
    expect((await tokens.peekEmailToken('verify', a.token))?.id).toBe(a.record.id);
    const b = await tokens.createEmailToken({ purpose: 'verify', email: u.email, user_id: u.id });
    expect(await tokens.consumeEmailToken('verify', a.token)).toBeNull(); // superseded
    expect(await tokens.consumeEmailToken('verify', b.token, new Date(Date.now() + 25 * 3600_000))).toBeNull(); // expired
    expect((await tokens.consumeEmailToken('verify', b.token))?.id).toBe(b.record.id);
    for (const junk of ['', 'x', 'a'.repeat(300), undefined, null]) expect(await tokens.consumeEmailToken('verify', junk as string)).toBeNull();
    expect(await tokens.countRecentEmailTokens('verify', u.email, new Date(Date.now() - 60_000))).toBe(2);
  });

  test('email token: invite shape is validated; invite keeps business and role; supersede=false keeps both', async () => {
    const biz = await newBusiness();
    await expect(tokens.createEmailToken({ purpose: 'invite', email: 'x@y.co' })).rejects.toThrow();
    await expect(tokens.createEmailToken({ purpose: 'reset', email: 'x@y.co' })).rejects.toThrow();
    const i1 = await tokens.createEmailToken({ purpose: 'invite', email: `inv-${run}@y.co`, business_id: biz.id, role: 'staff' });
    const i2 = await tokens.createEmailToken({ purpose: 'invite', email: `inv-${run}@y.co`, business_id: biz.id, role: 'owner', supersede: false });
    const got = await tokens.consumeEmailToken('invite', i1.token);
    expect(got).toMatchObject({ business_id: biz.id, role: 'staff', user_id: null });
    expect((await tokens.consumeEmailToken('invite', i2.token))?.role).toBe('owner');
  });

  // ── users, sessions, passwords ────────────────────────────────────────────

  test('createUser: verified flag and phone; markEmailVerified is idempotent', async () => {
    const { u } = await newUser('ver');
    expect(u.email_verified_at).toBeNull();
    expect(u.totp_enabled).toBe(false);
    await users.markEmailVerified(u.id);
    const first = (await users.getUserById(u.id)).email_verified_at;
    expect(first).not.toBeNull();
    await users.markEmailVerified(u.id, new Date(Date.now() + 5000));
    expect((await users.getUserById(u.id)).email_verified_at).toBe(first);
    const { u: v } = await newUser('ver2', { email_verified: true, phone: '+13055550142' });
    expect(v.email_verified_at).not.toBeNull();
    expect(v.phone).toBe('+13055550142');
    await expect(users.setUserPhone(v.id, '305-555')).rejects.toThrow();
    await users.setUserPhone(v.id, null);
    expect((await users.getUserById(v.id)).phone).toBeNull();
  });

  test('upgradePasswordHash keeps sessions and never clobbers a concurrent change; changePassword revokes', async () => {
    const { u } = await newUser('pw');
    const s1 = await users.createSession(u.id);
    const s2 = await users.createSession(u.id, { ip: '203.0.113.9', userAgent: 'UA' });
    expect(await users.upgradePasswordHash(u.id, 'h1', 'h2')).toBe(true);
    expect((await users.getUserByEmail(u.email)).password_hash).toBe('h2');
    expect(await users.upgradePasswordHash(u.id, 'h1', 'h3')).toBe(false); // stale expectation
    expect((await users.getUserByEmail(u.email)).password_hash).toBe('h2');
    expect(await users.getSessionByToken(s1.token)).not.toBeNull();
    await users.changePassword(u.id, 'h4', { keepSessionId: s2.session.id });
    expect(await users.getSessionByToken(s1.token)).toBeNull();
    expect(await users.getSessionByToken(s2.token)).not.toBeNull();
    await users.setUserPasswordHash(u.id, 'h5'); // deprecated alias revokes everything
    expect(await users.getSessionByToken(s2.token)).toBeNull();
  });

  test('sessions: ip/ua/mfa, listing, scoped revocation, other-device sign-out', async () => {
    const { u } = await newUser('sess');
    const { u: other } = await newUser('sess-other');
    const a = await users.createSession(u.id, { ip: '198.51.100.7', userAgent: 'Agent/1', mfaVerified: true });
    const b = await users.createSession(u.id);
    const c = await users.createSession(other.id);
    expect(a.session).toMatchObject({ kind: 'user', ip: '198.51.100.7', user_agent: 'Agent/1' });
    expect(a.session.mfa_verified_at).not.toBeNull();
    expect(b.session.mfa_verified_at).toBeNull();
    expect(await users.markSessionMfaVerified(b.session.id)).toBe(true);
    expect((await users.listUserSessions(u.id)).map((s: any) => s.id).sort()).toEqual([a.session.id, b.session.id].sort());
    expect(await users.revokeSession(c.session.id, u.id)).toBe(false); // not theirs
    expect(await users.getSessionByToken(c.token)).not.toBeNull();
    expect(await users.revokeOtherSessions(u.id, a.session.id)).toBe(1);
    expect(await users.getSessionByToken(b.token)).toBeNull();
    expect(await users.revokeSession(a.session.id, u.id)).toBe(true);
    expect(await users.listUserSessions(u.id)).toHaveLength(0);
    // an expired session is not listed and is deleted on lookup
    const old = await users.createSession(u.id, { ttlMs: 1000, now: new Date(Date.now() - 10_000) });
    expect(await users.listUserSessions(u.id)).toHaveLength(0);
    expect(await users.getSessionByToken(old.token)).toBeNull();
  });

  test('break-glass admin session: no user, listed, resolvable, hidden from getSessionByToken, revocable', async () => {
    const ua = `t-${run}`;
    const { token, session } = await users.createAdminSession({ ip: '203.0.113.1', userAgent: ua });
    expect(session).toMatchObject({ kind: 'admin_token', user_id: null });
    const r = await users.resolveSessionByToken(token);
    expect(r.kind).toBe('admin_token');
    expect(r.user).toBeNull();
    expect(await users.getSessionByToken(token)).toBeNull();
    expect((await users.listAdminSessions()).some((s: any) => s.id === session.id)).toBe(true);
    expect(await users.revokeSession(session.id)).toBe(true);
    expect(await users.resolveSessionByToken(token)).toBeNull();
    // the DB refuses a user-kind session without a user and an admin-kind one with a user
    const { u } = await newUser('chk');
    await expect((async () => db.prisma.userSession.create({ data: { kind: 'user', userId: null, tokenHash: `x1-${run}`, expiresAt: new Date() } }))()).rejects.toThrow();
    await expect((async () => db.prisma.userSession.create({ data: { kind: 'admin_token', userId: u.id, tokenHash: `x2-${run}`, expiresAt: new Date() } }))()).rejects.toThrow();
  });

  test('disabled users cannot resolve a session', async () => {
    const { u } = await newUser('dis');
    const s = await users.createSession(u.id);
    await users.setUserDisabled(u.id, true);
    expect(await users.resolveSessionByToken(s.token)).toBeNull();
  });

  // ── TOTP state ────────────────────────────────────────────────────────────

  test('totp: enrolment, replay-step claim is atomic, recovery codes are single use', async () => {
    const { u } = await newUser('totp');
    const secret = totp.generateTotpSecret();
    const enc = totp.encryptSecret(secret, u.id);
    expect(await users.confirmTotpEnrollment(u.id, 5, [])).toBe(false); // nothing pending
    expect(await users.beginTotpEnrollment(u.id, enc)).toBe(true);
    const codes = totp.generateRecoveryCodes();
    expect(await users.confirmTotpEnrollment(u.id, 100, codes.map(totp.hashRecoveryCode))).toBe(true);
    expect(await users.confirmTotpEnrollment(u.id, 101, [])).toBe(false); // already active
    expect(await users.beginTotpEnrollment(u.id, enc)).toBe(false);
    const st = await users.getTotpState(u.id);
    expect(st.enabled_at).not.toBeNull();
    expect(st.last_used_step).toBe(100);
    expect(totp.decryptSecret(st.secret_enc, u.id)).toBe(secret);
    expect((await users.getUserById(u.id)).totp_enabled).toBe(true);

    const claims = await Promise.all(Array.from({ length: 15 }, () => users.claimTotpStep(u.id, 101)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await users.claimTotpStep(u.id, 101)).toBe(false);
    expect(await users.claimTotpStep(u.id, 99)).toBe(false);
    expect(await users.claimTotpStep(u.id, 102)).toBe(true);

    const h = totp.hashRecoveryCode(codes[0]);
    const used = await Promise.all(Array.from({ length: 10 }, () => users.consumeRecoveryCode(u.id, h)));
    expect(used.filter(Boolean)).toHaveLength(1);
    expect(await users.countUnusedRecoveryCodes(u.id)).toBe(9);
    await users.replaceRecoveryCodes(u.id, ['a'.repeat(64), 'b'.repeat(64)]);
    expect(await users.countUnusedRecoveryCodes(u.id)).toBe(2);

    await users.disableTotp(u.id);
    expect(await users.getTotpState(u.id)).toEqual({ secret_enc: null, enabled_at: null, last_used_step: null });
    expect(await users.countUnusedRecoveryCodes(u.id)).toBe(0);
    expect(await users.claimTotpStep(u.id, 500)).toBe(false); // not enabled
  });

  // ── audit ─────────────────────────────────────────────────────────────────

  test('audit: records, lists newest first, redacts secret-looking meta, never throws', async () => {
    const { u, biz } = await newUser('aud');
    const action = `t-${run}.login`;
    expect(await audit.recordAudit({ actor_kind: 'user', actor_user_id: u.id, business_id: biz.id, action, target: `user:${u.id}`, ip: '203.0.113.5', meta: { method: 'password', token: 'SECRET', nested: { password: 'p', ok: 1 } } })).toBe(true);
    expect(await audit.recordAudit({ actor_kind: 'system', business_id: biz.id, action: `${action}2` })).toBe(true);
    const rows = await audit.listAuditEvents({ business_id: biz.id });
    expect(rows.map((r: any) => r.action)).toEqual([`${action}2`, action]);
    expect(rows[1].meta).toEqual({ method: 'password', token: '[redacted]', nested: { password: '[redacted]', ok: 1 } });
    expect(await audit.recordAudit({ actor_kind: 'bogus' as never, action: `${action}3` })).toBe(false); // CHECK violation, swallowed
    // the trail outlives the user
    await db.prisma.user.delete({ where: { id: u.id } });
    expect((await audit.listAuditEvents({ actor_user_id: u.id })).length).toBe(1);
  });

  // ── billing + usage ───────────────────────────────────────────────────────

  test('usage: concurrent increments are atomic and the period is the business-timezone month', async () => {
    const b = await newBusiness({ timezone: 'America/Los_Angeles' });
    await Promise.all([
      ...Array.from({ length: 40 }, () => usage.recordSms(b.id)),
      ...Array.from({ length: 30 }, () => usage.recordCallSeconds(b.id, 7)),
      usage.recordSms(b.id, 5),
    ]);
    const u = await usage.getUsage(b.id);
    expect(u).toMatchObject({ sms_count: 45, call_seconds: 210 });
    expect(await db.prisma.usageCounter.count({ where: { businessId: b.id } })).toBe(1);

    // 2027-03-01T03:00Z is still February 28 in Los Angeles; one hour later is March.
    const feb = new Date('2027-03-01T03:00:00Z');
    const mar = new Date('2027-03-01T09:00:00Z');
    await usage.recordSms(b.id, 3, feb);
    await usage.recordSms(b.id, 2, mar);
    expect(await usage.getUsage(b.id, feb)).toMatchObject({ period_start: '2027-02-01', sms_count: 3 });
    expect(await usage.getUsage(b.id, mar)).toMatchObject({ period_start: '2027-03-01', sms_count: 2 });
    expect(await usage.getUsage(b.id, new Date('2027-04-15T00:00:00Z'))).toMatchObject({ sms_count: 0, call_seconds: 0 });
    // other timezone, same instant: Auckland is already March
    const nz = await newBusiness({ timezone: 'Pacific/Auckland' });
    expect((await usage.recordSms(nz.id, 1, feb))?.period_start).toBe('2027-03-01');
    expect(await usage.recordSms('does-not-exist', 1)).toBeNull();
    expect(await usage.getUsage('does-not-exist')).toBeNull();
    await expect(usage.recordSms(b.id, -1)).rejects.toThrow();
  });

  test('caps and plan gate: unenforced allows everything; enforced honours status, caps, overrides', async () => {
    const b = await newBusiness();
    await usage.recordSms(b.id, 3);
    await usage.recordCallSeconds(b.id, 120);
    // BILLING_ENFORCED unset: allowed even with status 'none', but numbers are still reported
    expect(await usage.checkSmsAllowed(b.id)).toEqual({ ok: true, used: 3, cap: 500 });
    expect(await usage.checkCallAllowed(b.id)).toEqual({ ok: true, used: 120, cap: 300 * 60 });
    process.env.BILLING_ENFORCED = 'false';
    expect((await usage.checkSmsAllowed(b.id)).ok).toBe(true);

    process.env.BILLING_ENFORCED = 'true';
    expect(await usage.checkSmsAllowed(b.id)).toEqual({ ok: false, reason: 'no_plan', used: 3, cap: 500 });
    for (const status of ['canceled', 'unpaid', 'none']) {
      await db.setBillingState(b.id, { billing_status: status });
      expect((await usage.checkCallAllowed(b.id)).reason).toBe('no_plan');
    }
    await db.setBillingState(b.id, { billing_status: 'trialing' });
    expect((await usage.checkSmsAllowed(b.id)).ok).toBe(true);
    await db.setBillingState(b.id, { billing_status: 'active' });
    process.env.PLAN_SMS_CAP = '3';
    expect(await usage.checkSmsAllowed(b.id)).toEqual({ ok: false, reason: 'cap_reached', used: 3, cap: 3 });
    await db.setBillingState(b.id, { sms_cap_override: 4 });
    expect((await usage.checkSmsAllowed(b.id)).ok).toBe(true);
    await db.setBillingState(b.id, { sms_cap_override: 0 });
    expect((await usage.checkSmsAllowed(b.id)).reason).toBe('cap_reached'); // 0 is a real cap, not "unset"
    await db.setBillingState(b.id, { sms_cap_override: null });
    process.env.PLAN_CALL_MINUTES_CAP = '2'; // 120 s used
    expect(await usage.checkCallAllowed(b.id)).toEqual({ ok: false, reason: 'cap_reached', used: 120, cap: 120 });
    await db.setBillingState(b.id, { call_minutes_cap_override: 3 });
    expect(await usage.checkCallAllowed(b.id)).toEqual({ ok: true, used: 120, cap: 180 });
    expect(await usage.checkSmsAllowed('does-not-exist')).toMatchObject({ ok: false, reason: 'no_plan' });
  });

  test('past_due grace: allowed inside BILLING_PAST_DUE_GRACE_DAYS, refused after; since is maintained', async () => {
    process.env.BILLING_ENFORCED = 'true';
    const b = await newBusiness();
    const t0 = new Date('2027-01-10T12:00:00Z');
    let cur = await db.setBillingState(b.id, { billing_status: 'past_due' }, t0);
    expect(cur.past_due_since).toBe(t0.toISOString());
    cur = await db.setBillingState(b.id, { billing_status: 'past_due' }, new Date('2027-01-12T00:00:00Z'));
    expect(cur.past_due_since).toBe(t0.toISOString()); // unchanged while it stays past due
    expect((await usage.checkSmsAllowed(b.id, new Date('2027-01-14T00:00:00Z'))).ok).toBe(true);
    expect((await usage.checkSmsAllowed(b.id, new Date('2027-01-15T13:00:00Z'))).reason).toBe('no_plan');
    expect(db.isProvisioningAllowed(cur, new Date('2027-01-11T00:00:00Z'))).toBe(true);
    expect(db.isProvisioningAllowed(cur, new Date('2027-02-01T00:00:00Z'))).toBe(false);
    process.env.BILLING_PAST_DUE_GRACE_DAYS = '30';
    expect((await usage.checkSmsAllowed(b.id, new Date('2027-01-31T00:00:00Z'))).ok).toBe(true);
    cur = await db.setBillingState(b.id, { billing_status: 'active' });
    expect(cur.past_due_since).toBeNull();
    // no start recorded -> fail closed
    expect(usage.billingStateAllows({ billing_status: 'past_due', past_due_since: null })).toBe(false);
  });

  test('setBillingState / getBusinessByStripeCustomer / isProvisioningAllowed', async () => {
    const b = await newBusiness();
    const cus = `cus_${run}`;
    const cur = await db.setBillingState(b.id, {
      billing_status: 'trialing', plan: 'starter', stripe_customer_id: cus, stripe_subscription_id: `sub_${run}`,
      trial_ends_at: '2027-02-01T00:00:00Z', current_period_end: new Date('2027-02-01T00:00:00Z'), cancel_at_period_end: true,
      owner_phone_verified_at: new Date('2027-01-01T00:00:00Z'),
    });
    expect(cur).toMatchObject({ billing_status: 'trialing', plan: 'starter', stripe_customer_id: cus, cancel_at_period_end: true, trial_ends_at: '2027-02-01T00:00:00.000Z' });
    expect(cur.owner_phone_verified_at).toBe('2027-01-01T00:00:00.000Z');
    expect((await db.getBusinessByStripeCustomer(cus)).id).toBe(b.id);
    expect(await db.getBusinessByStripeCustomer(`cus_none_${run}`)).toBeNull();
    expect(await db.setBillingState('does-not-exist', { plan: 'x' })).toBeNull();
    await expect(db.setBillingState(b.id, { billing_status: 'bogus' })).rejects.toThrow(); // CHECK constraint
    // not enforced -> provisioning allowed regardless; enforced -> only paying/trial
    expect(db.isProvisioningAllowed({ billing_status: 'none', past_due_since: null })).toBe(true);
    process.env.BILLING_ENFORCED = 'true';
    expect(db.isProvisioningAllowed({ billing_status: 'none', past_due_since: null })).toBe(false);
    expect(db.isProvisioningAllowed(cur)).toBe(true);
  });

  test('createBusiness / patch dual-write E.164 columns', async () => {
    const b = await newBusiness({ phone: '(305) 555-0142', owner_phone: 'not a phone' });
    const row = await db.prisma.business.findUnique({ where: { id: b.id } });
    expect(row.phoneE164).toBe('+13055550142');
    expect(row.ownerPhoneE164).toBeNull();
    const upd = await db.updateBusiness(b.id, { owner_phone: '+1 305 555 0199' });
    expect(upd.owner_phone_e164).toBe('+13055550199');
  });
});
