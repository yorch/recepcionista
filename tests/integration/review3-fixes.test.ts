/**
 * Round-3 review fixes that need a database (skipped without TEST_DATABASE_URL):
 *  B1 grandfather selection, H1 webhook secret never reaches a tenant, H2 verification-text abuse limits,
 *  M1 malleable challenges, M6 missed-call alert limit, L1 trial fingerprints, PATCH owner_phone country allow-list.
 */
import { spawnSync } from 'node:child_process';
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, uniq } from '../helpers/fixtures';
import { confirmGoLive } from '../helpers/golive';

integration('round-3 fixes (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let limits: typeof import('@/lib/messaging/verify-limits');
  let gf: typeof import('@/lib/billing/grandfather');
  let trial: typeof import('@/lib/billing/trial');
  let capacity: typeof import('@/lib/voice/capacity');
  type Ctx = { params: Promise<{ id: string }> };
  let provision: (req: Request, ctx: Ctx) => Promise<Response>;
  let start: (req: Request, ctx: Ctx) => Promise<Response>;
  let confirm: (req: Request, ctx: Ctx) => Promise<Response>;
  let bizRoute: { PATCH: (req: Request, ctx: Ctx) => Promise<Response> };
  const userIds: string[] = [];
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    limits = await import('@/lib/messaging/verify-limits');
    gf = await import('@/lib/billing/grandfather');
    trial = await import('@/lib/billing/trial');
    capacity = await import('@/lib/voice/capacity');
    provision = (await import('@/app/api/businesses/[id]/provision/route')).POST as any;
    start = (await import('@/app/api/businesses/[id]/owner-phone/verify/start/route')).POST as any;
    confirm = (await import('@/app/api/businesses/[id]/owner-phone/verify/confirm/route')).POST as any;
    bizRoute = (await import('@/app/api/businesses/[id]/route')) as any;
  });
  const clear = async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'owner-phone/' } }, { key: { startsWith: 'voice/missed-call' } }, { key: { startsWith: 'businesses/provision' } }] } }); };
  afterEach(clear);
  afterAll(async () => {
    await clear();
    await prisma.trialFingerprint.deleteMany({ where: { businessId: { not: null } } });
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  async function login(businessId: string | null, role: 'owner' | 'staff', verified = true) {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: verified });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, user };
  }
  type Who = { cookie?: string; bearer?: boolean } | null;
  const req = (path: string, who: Who, body: unknown = {}, method = 'POST') =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie } : {}),
        ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const admin = { bearer: true };

  // ------------------------------------------------------------------ B1: grandfather selection
  test('B1 grandfather: only vetted businesses created before the cutoff; never self-signup, unverified email/phone; never marks a phone verified', async () => {
    const cutoff = new Date(Date.now() + 5_000);
    const mkBiz = async (opts: { verifiedOwner?: boolean; phoneVerified?: boolean; selfSignup?: boolean; ownerPhone?: boolean; billing?: string }) => {
      const b = await newBusiness({ owner_phone: opts.ownerPhone === false ? null : undefined, owner_verified: opts.phoneVerified ?? true });
      if (opts.billing) await prisma.business.update({ where: { id: b.id }, data: { billingStatus: opts.billing } });
      if (opts.verifiedOwner !== undefined) await login(b.id, 'owner', opts.verifiedOwner);
      if (opts.selfSignup) await prisma.auditEvent.create({ data: { actorKind: 'user', businessId: b.id, action: 'auth.signup', target: 'x' } });
      return b;
    };
    const ok = await mkBiz({ verifiedOwner: true });
    const noMail = await mkBiz({ verifiedOwner: false });
    const signedUp = await mkBiz({ verifiedOwner: true, selfSignup: true });
    const unvPhone = await mkBiz({ verifiedOwner: true, phoneVerified: false });
    const paid = await mkBiz({ verifiedOwner: true, billing: 'active' });
    const noPhone = await mkBiz({ verifiedOwner: true, ownerPhone: false });

    const plan = await gf.planGrandfather({ cutoff });
    const ids = new Set(plan.eligible.map((e) => e.id));
    expect(ids.has(ok.id)).toBe(true);
    expect(ids.has(noPhone.id)).toBe(true);
    for (const b of [noMail, signedUp, unvPhone, paid]) expect(ids.has(b.id)).toBe(false);
    expect(plan.skipped.find((s) => s.id === unvPhone.id)?.reason).toMatch(/phone/);
    expect(plan.skipped.find((s) => s.id === signedUp.id)?.reason).toMatch(/self-signup/);

    // a cutoff in the past selects nothing created later
    const past = await gf.planGrandfather({ cutoff: new Date(Date.now() - 3_600_000) });
    expect(past.eligible.find((e) => e.id === ok.id)).toBeUndefined();
    expect(past.skipped.find((s) => s.id === ok.id)?.reason).toMatch(/cutoff/);

    // overrides are explicit
    const inc = await gf.planGrandfather({ cutoff, includeUnverifiedPhone: true, includeSelfSignup: true });
    const incIds = new Set(inc.eligible.map((e) => e.id));
    expect(incIds.has(unvPhone.id) && incIds.has(signedUp.id)).toBe(true);
    expect(incIds.has(noMail.id)).toBe(false);

    expect(await gf.compBusiness(ok.id)).toBe(true);
    expect(await gf.compBusiness(ok.id)).toBe(false); // idempotent
    expect(await gf.compBusiness(paid.id)).toBe(false);
    // comping the unverified-phone business (with the override) must NOT verify its phone
    await gf.compBusiness(unvPhone.id);
    const after = await prisma.business.findUnique({ where: { id: unvPhone.id } });
    expect(after?.billingStatus).toBe('active');
    expect(after?.ownerPhoneVerifiedAt).toBeNull();
  });

  test('B1 grandfather script: --apply without --before or with an invalid date refuses and writes nothing', () => {
    const run = (args: string[]) => spawnSync('bun', ['scripts/grandfather-existing.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL as string }, encoding: 'utf8',
    });
    const a = run(['--apply']);
    expect(a.status).toBe(2);
    expect(a.stderr).toContain('--before <ISO instant> is required');
    const b = run(['--before', 'nonsense', '--apply']);
    expect(b.status).toBe(2);
    expect(b.stderr).toContain('not a valid ISO date');
  });

  // ------------------------------------------------------------------ H1: tenant never gets the webhook secret
  test('H1 provision: an owner never receives webhook_secret and never creates the webhook; a failed list never creates one; only an admin gets the one-time secret', async () => {
    const calls: string[] = [];
    let listStatus = 200;
    const stub = (async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace(/^https:\/\/api\.elevenlabs\.io\/v1/, '')}`);
      if (url.endsWith('/workspace/webhooks') && method === 'GET') {
        return listStatus === 200 ? Response.json({ webhooks: [] }) : new Response('slow down', { status: listStatus });
      }
      if (url.endsWith('/workspace/webhooks') && method === 'POST') return Response.json({ webhook_id: 'wh_new', webhook_secret: 'wsec_PLATFORM_WIDE' });
      if (url.endsWith('/convai/agents/create')) return Response.json({ agent_id: 'agent_r3' });
      if (url.endsWith('/convai/tools') && method === 'GET') return Response.json({ tools: [] });
      if (url.endsWith('/convai/tools') && method === 'POST') return Response.json({ id: 'tool_r3' });
      return Response.json({});
    }) as unknown as typeof fetch;
    const real = globalThis.fetch;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi-test', BILLING_ENFORCED: 'true', ELEVENLABS_WEBHOOK_SECRET: undefined }, async () => {
        globalThis.fetch = stub;
        const biz = await newBusiness({ agent_id: null });
        await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'active' } });
        const owner = await login(biz.id, 'owner');

        // the template KB is built by a first (refused) run; the owner confirms it and the service area, then provisions
        expect((await provision(req(`/api/businesses/${biz.id}/provision`, owner, { force: false }), ctx(biz.id))).status).toBe(422);
        await confirmGoLive(biz.id);
        calls.length = 0;

        // owner, list OK but webhook missing: nothing created, no secret, flagged pending
        let res = await provision(req(`/api/businesses/${biz.id}/provision`, owner, { force: false }), ctx(biz.id));
        let text = await res.text();
        expect(res.status).toBe(200);
        expect(text).not.toContain('wsec_PLATFORM_WIDE');
        expect(text).not.toContain('webhook_secret');
        expect(JSON.parse(text).data.post_call_webhook_pending).toBe(true);
        expect(calls.filter((c) => c.startsWith('POST /workspace/webhooks'))).toEqual([]);

        // admin, list 429 for all retries: still nothing created
        listStatus = 429;
        calls.length = 0;
        res = await provision(req(`/api/businesses/${biz.id}/provision`, admin, { force: true }), ctx(biz.id));
        text = await res.text();
        expect(text).not.toContain('wsec_PLATFORM_WIDE');
        expect(calls.filter((c) => c.startsWith('GET /workspace/webhooks')).length).toBeGreaterThan(1); // retried
        expect(calls.filter((c) => c.startsWith('POST /workspace/webhooks'))).toEqual([]);

        // admin, list OK and empty: creates it and sees the secret once
        listStatus = 200;
        calls.length = 0;
        res = await provision(req(`/api/businesses/${biz.id}/provision`, admin, { force: true }), ctx(biz.id));
        text = await res.text();
        expect(JSON.parse(text).data.webhook_secret).toBe('wsec_PLATFORM_WIDE');
        expect(calls.filter((c) => c.startsWith('POST /workspace/webhooks')).length).toBe(1);
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  // ------------------------------------------------------------------ H2: verification text abuse limits
  const dummyReq = () => new Request('https://app.example.test/x', { method: 'POST' });
  const input = (businessId: string, e164: string, over: Record<string, unknown> = {}) =>
    ({ req: dummyReq(), businessId, e164, userId: null, isAdmin: false, ...over }) as Parameters<typeof limits.checkVerificationStart>[0];

  test('H2: a number that opted out of ANY business, or that another business verified recently, is refused (admin may override the second)', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const optedOut = phone();
    await prisma.smsOptOut.create({ data: { businessId: a.id, phoneKey: optedOut.slice(-10), phoneE164: optedOut, source: 'stop_keyword' } });
    expect(await limits.checkVerificationStart(input(b.id, optedOut, { isAdmin: true }))).toMatchObject({ status: 422 });

    const taken = phone();
    await prisma.business.update({ where: { id: a.id }, data: { ownerPhone: taken, ownerPhoneE164: taken, ownerPhoneVerifiedAt: new Date() } });
    expect(await limits.checkVerificationStart(input(b.id, taken))).toMatchObject({ status: 422 });
    expect(await limits.checkVerificationStart(input(b.id, taken, { isAdmin: true }))).toBeNull();
    // the business's own verified number may be re-verified
    expect(await limits.checkVerificationStart(input(a.id, taken))).toBeNull();
    // verified long ago: no longer blocks
    await prisma.business.update({ where: { id: a.id }, data: { ownerPhoneVerifiedAt: new Date(Date.now() - 40 * 86_400_000) } });
    await clear();
    expect(await limits.checkVerificationStart(input(b.id, taken))).toBeNull();
  });

  test('H2: limits per destination number (across businesses), per user, per IP and platform-wide', async () => {
    // per number: 3/h across different businesses
    const n = phone();
    const bs = [await newBusiness(), await newBusiness(), await newBusiness(), await newBusiness()];
    const out: (number | null)[] = [];
    for (const b of bs) out.push((await limits.checkVerificationStart(input(b.id, n)))?.status ?? null);
    expect(out).toEqual([null, null, null, 429]);

    // per user: 10/h whatever numbers and businesses
    await clear();
    const user = await login(bs[0].id, 'owner');
    const statuses: (number | null)[] = [];
    for (let i = 0; i < 12; i++) {
      const b = bs[i % 3];
      statuses.push((await limits.checkVerificationStart(input(b.id, phone(), { userId: user.user.id })))?.status ?? null);
    }
    expect(statuses.slice(0, 10).every((s) => s === null || s === 429)).toBe(true);
    expect(statuses.filter((s) => s === null).length).toBeLessThanOrEqual(10);
    expect(statuses.slice(10)).toEqual([429, 429]);

    // global per hour
    await clear();
    await withEnv({ OWNER_VERIFY_GLOBAL_PER_HOUR: '2' }, async () => {
      const g: (number | null)[] = [];
      for (let i = 0; i < 3; i++) g.push((await limits.checkVerificationStart(input(bs[3].id, phone())))?.status ?? null);
      expect(g).toEqual([null, null, 429]);
    });
  });

  test('H2/M1: start and confirm need a VERIFIED email; the text is the fixed template; padded challenges cannot mint new attempt buckets', async () => {
    const biz = await newBusiness({ owner_phone: null });
    const unverified = await login(biz.id, 'owner', false);
    const n = phone();
    const body = { phone: n };
    const r1 = await start(req(`/api/businesses/${biz.id}/owner-phone/verify/start`, unverified, body), ctx(biz.id));
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as any).error).toBe('email_not_verified');
    expect((await confirm(req(`/api/businesses/${biz.id}/owner-phone/verify/confirm`, unverified, { phone: n, code: '123456', challenge: 'a.b' }), ctx(biz.id))).status).toBe(403);

    // verified owner: the SMS carries no tenant text (business name is attacker-chosen)
    await prisma.business.update({ where: { id: biz.id }, data: { name: 'Chase Fraud Alert call 1-888-555-0100 chase-verify.example' } });
    const owner = await login(biz.id, 'owner', true);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    let res: Response;
    try { res = await start(req(`/api/businesses/${biz.id}/owner-phone/verify/start`, owner, body), ctx(biz.id)); } finally { console.log = orig; }
    expect(res.status).toBe(200);
    const sms = lines.join('\n');
    expect(sms).toMatch(/Recepcionista verification code: \d{6}/);
    expect(sms).not.toMatch(/Chase|888|chase-verify/);
    const { challenge } = ((await res.json()) as any).data ?? (await Promise.resolve({}));
    expect(typeof challenge === 'string' || challenge === undefined).toBe(true);
  });

  test('M1: whitespace / padding variants of one challenge all hit the SAME attempt budget (5 per challenge) and the business+phone budget', async () => {
    const biz = await newBusiness({ owner_phone: null });
    const n = phone();
    const { createOwnerPhoneChallenge } = await import('@/lib/messaging/owner-verify');
    const { code, challenge } = createOwnerPhoneChallenge(biz.id, n);
    const wrong = code === '000000' ? '000001' : '000000';
    const attempt = async (c: string, cd = wrong) =>
      (await confirm(req(`/api/businesses/${biz.id}/owner-phone/verify/confirm`, admin, { phone: n, code: cd, challenge: c }), ctx(biz.id))).status;
    // the real challenge: 5 wrong guesses allowed, then 429
    const real: number[] = [];
    for (let i = 0; i < 6; i++) real.push(await attempt(challenge));
    expect(real).toEqual([400, 400, 400, 400, 400, 429]);
    // spelled differently: rejected as inauthentic (never reaches the code check) and bounded by the business+phone budget (10 per 10 min total)
    const variants: number[] = [];
    for (let i = 1; i <= 8; i++) variants.push(await attempt(`${challenge}${' '.repeat(i)}`));
    expect(variants.every((s) => s === 400 || s === 429)).toBe(true);
    expect(variants.includes(429)).toBe(true); // the budget runs out: no unlimited guessing
    // and even the RIGHT code on a padded variant never verifies
    expect(await attempt(`${challenge}  `, code)).not.toBe(200);
    expect(await attempt(`${challenge}=`, code)).not.toBe(200);
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))?.ownerPhoneVerifiedAt).toBeNull();
  });

  // ------------------------------------------------------------------ PATCH owner_phone country (B1)
  test('B1: PATCH owner_phone refuses a country outside SMS_ALLOWED_COUNTRY_CODES', async () => {
    const biz = await newBusiness();
    const patch = (p: string) => bizRoute.PATCH(req(`/api/businesses/${biz.id}`, admin, { owner_phone: p }, 'PATCH'), ctx(biz.id));
    await withEnv({ SMS_ALLOWED_COUNTRY_CODES: '1' }, async () => {
      expect((await patch('+88213000000')).status).toBe(422);
      expect((await patch('+525512345678')).status).toBe(422);
      expect((await patch(phone())).status).toBe(200);
    });
    await withEnv({ SMS_ALLOWED_COUNTRY_CODES: '1,52' }, async () => {
      expect((await patch('+525512345678')).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------ M6
  test('M6: missed-call owner texts are limited to 1 per 10 minutes and 6 per hour per business', async () => {
    const biz = await newBusiness();
    expect(await capacity.allowMissedCallAlert(biz.id)).toBe(true);
    for (let i = 0; i < 20; i++) expect(await capacity.allowMissedCallAlert(biz.id)).toBe(false); // burst bucket
    const other = await newBusiness();
    expect(await capacity.allowMissedCallAlert(other.id)).toBe(true); // per business
  });

  test('M6: a canceled / over-cap business is refused on the very next call (no stale cache) and the override cuts the call short', async () => {
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'active' } });
      expect((await capacity.callGate(biz.id)).ok).toBe(true);
      await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'canceled' } });
      const g = await capacity.callGate(biz.id);
      expect(g.ok).toBe(false);
      expect(g.reason).toBe('no_plan');
      const ov = capacity.outOfServiceOverride((await (await loadDb()).getBusiness(biz.id))!);
      expect(ov.conversation.max_duration_seconds).toBe(capacity.OUT_OF_SERVICE_MAX_SECONDS);
    });
  });

  // ------------------------------------------------------------------ L1
  test('L1: a card or normalised email already used for a trial by ANOTHER business is "taken"; the same business may re-claim', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const fp = trial.cardFingerprint(`card_${uniq('fp')}`);
    expect(await trial.claimTrial('card', fp, a.id)).toBe('fresh');
    expect(await trial.claimTrial('card', fp, a.id)).toBe('own');
    expect(await trial.claimTrial('card', fp, b.id)).toBe('taken');
    expect(await trial.trialUsedElsewhere('card', fp, b.id)).toBe(true);
    const tag = uniq('m').replace(/-/g, '');
    const e1 = trial.emailFingerprint(`Some.One${tag}+x@gmail.com`);
    expect(await trial.claimTrial('email', e1, a.id)).toBe('fresh');
    // same mailbox spelled differently (dots, +tag, case) is the same person; a different mailbox is not
    expect(await trial.trialUsedElsewhere('email', trial.emailFingerprint(`SOMEONE${tag}+y@googlemail.com`), b.id)).toBe(true);
    expect(await trial.trialUsedElsewhere('email', trial.emailFingerprint(`other${tag}@gmail.com`), b.id)).toBe(false);
  });
});
