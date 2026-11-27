/**
 * Phase 0 hardening against a real database: step-up (`requireRecentAuth`) on every admin WRITE for cookie sessions, the Bearer ADMIN_TOKEN
 * unchanged, rate limits on admin/jobs, jobs/run and retention, the new retention audit row, the values in the billing override audit, and the
 * knowledge-base PUT that no longer cuts silently to 20 / 15. Nothing here depends on the time of day; no outbound call is made.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('phase 0: admin step-up, limits and audit (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  const route: Record<string, (req: Request) => Promise<Response>> = {};
  let jobsGet: (req: Request) => Promise<Response>;
  let knowledgePut: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  const userIds: string[] = [];
  const auditCutoff = new Date(Date.now() - 1000);

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    route.billing = (await import('@/app/api/admin/billing/route')).POST;
    route.users = (await import('@/app/api/admin/users/route')).POST;
    route.jobsRun = (await import('@/app/api/admin/jobs/run/route')).POST;
    route.release = (await import('@/app/api/admin/release-tenant/route')).POST;
    route.repair = (await import('@/app/api/admin/repair-numbers/route')).POST;
    route.resync = (await import('@/app/api/admin/resync-agents/route')).POST;
    route.retention = (await import('@/app/api/admin/retention/route')).POST;
    jobsGet = (await import('@/app/api/admin/jobs/route')).GET;
    knowledgePut = (await import('@/app/api/businesses/[id]/knowledge/route')).PUT as typeof knowledgePut;
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/' } } });
  });
  afterEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/' } } }); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]); // no test here may reach a provider
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { action: 'admin.retention_run', at: { gte: auditCutoff } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  async function login(businessId: string | null, role: 'owner' | 'admin') {
    const user = await users.createUser({ email: `${uniq('p0')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { user, cookie: `rc_user_session=${token}` };
  }
  /** Make the session's last proof of identity older than the 5 minute window (or fresh again). */
  const setSudo = (userId: string, ageMs: number) => prisma.userSession.updateMany({ where: { userId }, data: { sudoAt: new Date(Date.now() - ageMs) } });
  const STALE = 10 * 60_000;
  const post = (path: string, who: { cookie?: string } | 'bearer', body?: unknown) =>
    new Request(`https://app.example.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
        ...(who === 'bearer' ? { authorization: `Bearer ${SECRETS.adminToken}` } : who.cookie ? { cookie: who.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (res: Response) => (await res.json()) as any;

  test('cookie admin with a STALE proof: every admin write is 403 reauth_required; dry runs and the Bearer token are unaffected', async () => {
    const biz = await newBusiness({ agent_id: null });
    const a = await login(null, 'admin');
    await setSudo(a.user.id, STALE);

    const writes: [string, string, unknown][] = [
      ['billing', '/api/admin/billing', { business_id: biz.id, sms_cap_override: 5 }],
      ['users', '/api/admin/users', { email: `${uniq('new')}@example.test`, password: 'correct horse battery', role: 'staff', business_id: biz.id }],
      ['jobsRun', '/api/admin/jobs/run', { job: 'cleanup', dry_run: false }],
      ['release', '/api/admin/release-tenant', { business_id: biz.id, dry_run: false }],
      ['repair', '/api/admin/repair-numbers', { dry_run: false }],
      ['resync', '/api/admin/resync-agents', { dry_run: false }],
      ['retention', '/api/admin/retention', { dry_run: false }],
    ];
    for (const [name, path, body] of writes) {
      const res = await route[name](post(path, a, body));
      expect([name, res.status]).toEqual([name, 403]);
      expect([name, (await json(res)).code]).toEqual([name, 'reauth_required']);
    }
    // Nothing was written by the refused calls.
    expect((await db.getBusiness(biz.id))?.sms_cap_override ?? null).toBeNull();
    expect(await prisma.user.count({ where: { businessId: biz.id } })).toBe(0);

    // Dry runs (the default) are read-only: no step-up. (repair / resync dry runs answer without a provider call.)
    for (const [name, path, body] of [
      ['jobsRun', '/api/admin/jobs/run', { job: 'cleanup' }],
      ['release', '/api/admin/release-tenant', { business_id: biz.id }],
      ['resync', '/api/admin/resync-agents', {}],
      ['retention', '/api/admin/retention', {}],
    ] as [string, string, unknown][]) {
      const res = await route[name](post(path, a, body));
      expect([name, res.status]).toEqual([name, 200]);
    }
    const dryRepair = await route.repair(post('/api/admin/repair-numbers', a, { dry_run: true }));
    expect(dryRepair.status).not.toBe(403); // 503 without Twilio config: past the guard

    // Bearer ADMIN_TOKEN: behaviour unchanged (no step-up).
    const bearer = await route.billing(post('/api/admin/billing', 'bearer', { business_id: biz.id, sms_cap_override: 7 }));
    expect(bearer.status).toBe(200);
    expect((await db.getBusiness(biz.id))?.sms_cap_override).toBe(7);
    const bearerRetention = await route.retention(post('/api/admin/retention', 'bearer', { dry_run: true }));
    expect(bearerRetention.status).toBe(200);
  });

  test('a fresh proof (within 5 minutes) passes the guard; an expired one does not; re-stamping restores access', async () => {
    const biz = await newBusiness({ agent_id: null });
    const a = await login(null, 'admin');
    await setSudo(a.user.id, 60_000); // 1 minute ago: fresh
    const ok1 = await route.billing(post('/api/admin/billing', a, { business_id: biz.id, sms_cap_override: 11 }));
    expect(ok1.status).toBe(200);
    const email = `${uniq('created')}@example.test`;
    const made = await route.users(post('/api/admin/users', a, { email, password: 'correct horse battery', role: 'staff', business_id: biz.id }));
    expect(made.status).toBe(201);
    await setSudo(a.user.id, 6 * 60_000); // 6 minutes: expired
    expect((await route.billing(post('/api/admin/billing', a, { business_id: biz.id, sms_cap_override: 12 }))).status).toBe(403);
    await setSudo(a.user.id, 0);
    expect((await route.billing(post('/api/admin/billing', a, { business_id: biz.id, sms_cap_override: 12 }))).status).toBe(200);
  });

  test('billing.admin_override audit meta carries the new caps and dates (sanitized), before and after', async () => {
    const biz = await newBusiness({ agent_id: null });
    const a = await login(null, 'admin');
    const trialEnd = '2031-05-06T07:08:09.000Z';
    const res = await route.billing(post('/api/admin/billing', a, {
      business_id: biz.id, billing_status: 'trialing', plan: 'comp', trial_ends_at: trialEnd, current_period_end: null,
      sms_cap_override: 321, call_minutes_cap_override: 45, note: 'support grant',
    }));
    expect(res.status).toBe(200);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'billing.admin_override', businessId: biz.id }, orderBy: { at: 'desc' } });
    const meta = row.meta as any;
    expect(row.actorUserId).toBe(a.user.id);
    expect(meta.changed.sort()).toEqual(['billing_status', 'call_minutes_cap_override', 'current_period_end', 'plan', 'sms_cap_override', 'trial_ends_at']);
    expect(meta.to).toEqual({
      billing_status: 'trialing', plan: 'comp', trial_ends_at: trialEnd, current_period_end: null, sms_cap_override: 321, call_minutes_cap_override: 45,
    });
    expect(meta.from.sms_cap_override).toBeNull();
    expect(meta.from.trial_ends_at).toBeNull();
    expect(meta.note).toBe('support grant');
    // Second change: `from` is the previous state.
    await route.billing(post('/api/admin/billing', 'bearer', { business_id: biz.id, sms_cap_override: null }));
    const row2 = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'billing.admin_override', businessId: biz.id }, orderBy: { at: 'desc' } });
    expect((row2.meta as any).from.sms_cap_override).toBe(321);
    expect((row2.meta as any).to.sms_cap_override).toBeNull();
    expect(row2.actorKind).toBe('admin_token');
  });

  test('admin/retention is audited (admin and Bearer) and rate limited (6 per minute)', async () => {
    const a = await login(null, 'admin');
    const r1 = await route.retention(post('/api/admin/retention', a, {}));
    expect(r1.status).toBe(200);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'admin.retention_run', actorUserId: a.user.id } });
    expect(row.actorKind).toBe('user');
    expect(row.target).toBe('retention');
    expect((row.meta as any).dry_run).toBe(true);
    expect((row.meta as any).counts).toEqual((await json(r1)).data.counts);
    const r2 = await route.retention(post('/api/admin/retention', 'bearer', { dry_run: true }));
    expect(r2.status).toBe(200);
    const bearerRow = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'admin.retention_run', actorKind: 'admin_token', at: { gte: auditCutoff } } });
    expect(bearerRow.actorUserId).toBeNull();
    // 6 allowed per window (2 used); the 7th is refused
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await route.retention(post('/api/admin/retention', 'bearer', { dry_run: true }))).status);
    expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    // a refused request writes no audit row
    const before = await prisma.auditEvent.count({ where: { action: 'admin.retention_run', at: { gte: auditCutoff } } });
    expect((await route.retention(post('/api/admin/retention', 'bearer', { dry_run: true }))).status).toBe(429);
    expect(await prisma.auditEvent.count({ where: { action: 'admin.retention_run', at: { gte: auditCutoff } } })).toBe(before);
  });

  test('admin/jobs/run (12 per minute) and admin/jobs GET (60 per minute) are rate limited', async () => {
    let last = 0;
    let firstLimited = -1;
    for (let i = 0; i < 14; i++) {
      last = (await route.jobsRun(post('/api/admin/jobs/run', 'bearer', {}))).status; // invalid job: 422, but it counts
      if (last === 429 && firstLimited < 0) firstLimited = i;
    }
    expect(firstLimited).toBe(12);
    expect(last).toBe(429);

    const get = () => jobsGet(new Request('https://app.example.test/api/admin/jobs', { headers: { authorization: `Bearer ${SECRETS.adminToken}` } }));
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await get()).status);
    expect(codes.slice(0, 59).every((c) => c === 200)).toBe(true); // 60 per minute (59 is clear of any window edge)
    expect(codes[61]).toBe(429);
  });

  test('knowledge PUT: more than the saved-list limit is a 422 (not a silent cut); 25 services are kept whole', async () => {
    const biz = await newBusiness({ agent_id: null });
    await db.upsertKnowledgeBase(biz.id, { services: [], faqs: [], pricing_notes: '', system_prompt: 'x', call_script: '' } as any);
    const owner = await login(biz.id, 'owner');
    await setSudo(owner.user.id, 0);
    const put = (body: unknown) => knowledgePut(
      new Request(`https://app.example.test/api/businesses/${biz.id}/knowledge`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', cookie: owner.cookie },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: biz.id }) },
    );
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Service ${i}`, base_price: 100 }));
    const faqs = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}` }));

    const fine = await put({ services: mk(25), faqs: faqs(18) });
    expect(fine.status).toBe(200);
    const saved = await db.getKnowledgeBase(biz.id);
    expect(saved?.services).toHaveLength(25);
    expect(saved?.faqs).toHaveLength(18);

    const tooMany = await put({ services: mk(201) });
    expect(tooMany.status).toBe(422);
    expect((await json(tooMany)).error).toBe('services must be a list of at most 200');
    const tooManyFaqs = await put({ faqs: faqs(201) });
    expect(tooManyFaqs.status).toBe(422);
    expect((await db.getKnowledgeBase(biz.id))?.services).toHaveLength(25); // the refused call changed nothing
  });
});
