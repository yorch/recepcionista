/**
 * Billing routes against a real database: checkout/portal/status/mock-activate/admin comp, tenant scoping,
 * verified-email and role requirements, mock mode refused in production, provisioning gate.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('billing routes (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let checkout: (req: Request) => Promise<Response>;
  let portal: (req: Request) => Promise<Response>;
  let status: (req: Request) => Promise<Response>;
  let mockActivate: (req: Request) => Promise<Response>;
  let adminBilling: (req: Request) => Promise<Response>;
  let gate: typeof import('@/lib/billing/gate');
  const userIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    checkout = (await import('@/app/api/billing/checkout/route')).POST;
    portal = (await import('@/app/api/billing/portal/route')).POST;
    status = (await import('@/app/api/billing/status/route')).GET;
    mockActivate = (await import('@/app/api/billing/mock-activate/route')).GET;
    adminBilling = (await import('@/app/api/admin/billing/route')).POST;
    gate = await import('@/lib/billing/gate');
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'billing/' } } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  // The limiter keys on client address (one shared bucket without a trusted proxy): reset it between tests.
  afterEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'billing/' } } }); });

  async function login(businessId: string | null, role: 'owner' | 'staff' | 'admin', verified = true) {
    const user = await users.createUser({
      email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: verified,
    });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { user, cookie: `rc_user_session=${token}` };
  }
  const req = (method: string, path: string, who: { cookie?: string; bearer?: boolean } | null, body?: unknown) =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie } : {}),
        ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data?: any; error?: string; checkout?: string };
  const row = (id: string) => prisma.business.findUniqueOrThrow({ where: { id } });
  const admin = { bearer: true };

  test('checkout: owner of the business, verified email, mock mode (non-production)', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const res = await checkout(req('POST', '/api/billing/checkout', owner, {}));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.mock).toBe(true);
    expect(body.data.url).toBe(`https://app.example.test/api/billing/mock-activate?business_id=${biz.id}`);
  });

  test('checkout refuses: unauthenticated, staff, unverified email', async () => {
    const biz = await newBusiness();
    expect((await checkout(req('POST', '/api/billing/checkout', null, {}))).status).toBe(401);
    const staff = await login(biz.id, 'staff');
    expect((await checkout(req('POST', '/api/billing/checkout', staff, {}))).status).toBe(403);
    const unverified = await login(biz.id, 'owner', false);
    const res = await checkout(req('POST', '/api/billing/checkout', unverified, {}));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('email_not_verified');
  });

  test('checkout refuses a cross-site cookie request (CSRF)', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const r = new Request('https://app.example.test/api/billing/checkout', {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' }, body: '{}',
    });
    expect((await checkout(r)).status).toBe(403);
  });

  test('tenant scoping: another business id is a 404 for users, an owner cannot start billing for a stranger', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const ownerA = await login(a.id, 'owner');
    expect((await checkout(req('POST', '/api/billing/checkout', ownerA, { business_id: b.id }))).status).toBe(404);
    expect((await portal(req('POST', '/api/billing/portal', ownerA, { business_id: b.id }))).status).toBe(404);
    expect((await status(req('GET', `/api/billing/status?business_id=${b.id}`, ownerA))).status).toBe(404);
    // admins must name a business; a named one works
    expect((await checkout(req('POST', '/api/billing/checkout', admin, {}))).status).toBe(422);
    expect((await checkout(req('POST', '/api/billing/checkout', admin, { business_id: b.id }))).status).toBe(200);
  });

  test('mock mode is refused in production (503) and missing price is a config error', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const res = await checkout(req('POST', '/api/billing/checkout', owner, {}));
      expect(res.status).toBe(503);
      expect((await json(res)).error).toBe('billing is not configured');
    });
    await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: undefined }, async () => {
      expect((await checkout(req('POST', '/api/billing/checkout', owner, {}))).status).toBe(503);
    });
  });

  test('live checkout: creates one customer, reuses it, grants the trial once, audits', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const real = globalThis.fetch;
    const calls: { url: string; body: URLSearchParams }[] = [];
    let customers = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as URLSearchParams });
      if (url.endsWith('/customers')) { customers++; return new Response(JSON.stringify({ id: `cus_live_${biz.id.slice(0, 8)}` }), { status: 200 }); }
      if (url.endsWith('/checkout/sessions')) return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/c/1' }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x', BILLING_TRIAL_DAYS: '7' }, async () => {
        const res = await checkout(req('POST', '/api/billing/checkout', owner, {}));
        expect(res.status).toBe(200);
        expect((await json(res)).data).toEqual({ url: 'https://checkout.stripe.test/c/1', mock: false });
        const session = calls.find((c) => c.url.endsWith('/checkout/sessions'))!.body;
        expect(session.get('customer')).toBe(`cus_live_${biz.id.slice(0, 8)}`);
        expect(session.get('client_reference_id')).toBe(biz.id);
        expect(session.get('subscription_data[trial_period_days]')).toBe('7');
        expect((await row(biz.id)).stripeCustomerId).toBe(`cus_live_${biz.id.slice(0, 8)}`);
        expect((await prisma.auditEvent.findMany({ where: { businessId: biz.id, action: 'billing.checkout_started' } })).length).toBe(1);

        // second attempt: same customer, no new customer call
        await checkout(req('POST', '/api/billing/checkout', owner, {}));
        expect(customers).toBe(1);

        // a business that already used its trial gets no second one
        await prisma.business.update({ where: { id: biz.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000), billingStatus: 'canceled' } });
        await checkout(req('POST', '/api/billing/checkout', owner, {}));
        const last = [...calls].reverse().find((c) => c.url.endsWith('/checkout/sessions'))!.body;
        expect(last.get('subscription_data[trial_period_days]')).toBeNull();
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  test('checkout answers 409 for an already-subscribed business; portal needs a customer', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    expect((await portal(req('POST', '/api/billing/portal', owner, {}))).status).toBe(409);
    await db.setBillingState(biz.id, { billing_status: 'trialing' });
    expect((await checkout(req('POST', '/api/billing/checkout', owner, {}))).status).toBe(409);
  });

  test('portal: owner only, returns the Stripe URL', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const staff = await login(biz.id, 'staff');
    await db.setBillingState(biz.id, { billing_status: 'active', stripe_customer_id: uniq('cus') });
    expect((await portal(req('POST', '/api/billing/portal', staff, {}))).status).toBe(403);
    const real = globalThis.fetch;
    let form: URLSearchParams | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      form = init.body as URLSearchParams;
      return new Response(JSON.stringify({ url: 'https://billing.stripe.test/p/1' }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_x' }, async () => {
        const res = await portal(req('POST', '/api/billing/portal', owner, {}));
        expect((await json(res)).data).toEqual({ url: 'https://billing.stripe.test/p/1' });
        expect((form as unknown as URLSearchParams).get('return_url')).toBe('https://app.example.test/dashboard/billing');
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  test('status: billing state, usage versus caps, provisioning_allowed; staff may read it', async () => {
    const biz = await newBusiness();
    const staff = await login(biz.id, 'staff');
    await db.setBillingState(biz.id, { billing_status: 'trialing', plan: 'standard', trial_ends_at: new Date(Date.now() + 3 * 86_400_000), sms_cap_override: 10 });
    await db.recordSms(biz.id, 3);
    await db.recordCallSeconds(biz.id, 150);
    const res = await status(req('GET', '/api/billing/status', staff));
    expect(res.status).toBe(200);
    const d = (await json(res)).data;
    expect(d).toMatchObject({
      billing_status: 'trialing', plan: 'standard', cancel_at_period_end: false, provisioning_allowed: true, enforced: false,
      usage: { sms: { used: 3, cap: 10 }, call_minutes: { used: 2, used_seconds: 150, cap: 300 } },
    });
    expect(d.trial_ends_at).toBeTruthy();
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      await db.setBillingState(biz.id, { billing_status: 'canceled' });
      expect((await json(await status(req('GET', '/api/billing/status', staff)))).data).toMatchObject({ enforced: true, provisioning_allowed: false });
    });
  });

  test('mock-activate: 404 unless DEMO_MODE, never in production or with a Stripe key; sets trialing for the owner', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const url = `/api/billing/mock-activate?business_id=${biz.id}`;
    expect((await mockActivate(req('GET', url, owner))).status).toBe(404); // DEMO_MODE unset
    await withEnv({ DEMO_MODE: 'true', NODE_ENV: 'production' }, async () => {
      expect((await mockActivate(req('GET', url, owner))).status).toBe(404);
    });
    await withEnv({ DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
      expect((await mockActivate(req('GET', url, owner))).status).toBe(404);
    });
    expect((await row(biz.id)).billingStatus).toBe('none');
    await withEnv({ DEMO_MODE: 'true' }, async () => {
      const other = await newBusiness();
      expect((await mockActivate(req('GET', `/api/billing/mock-activate?business_id=${other.id}`, owner))).status).toBe(404); // cross-tenant
      expect((await mockActivate(req('GET', url, null))).status).toBe(401);
      const cross = new Request(`https://app.example.test${url}`, { headers: { cookie: owner.cookie, 'sec-fetch-site': 'cross-site' } });
      expect((await mockActivate(cross)).status).toBe(403);
      const res = await mockActivate(req('GET', url, owner));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://app.example.test/dashboard/billing?checkout=success');
      const r = await row(biz.id);
      expect(r.billingStatus).toBe('trialing');
      expect(r.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect((await mockActivate(req('GET', url, owner))).status).toBe(409); // already subscribed
    });
  });

  test('admin comp: admin only, validated, audited; caps and null clearing', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    expect((await adminBilling(req('POST', '/api/admin/billing', owner, { business_id: biz.id, billing_status: 'active' }))).status).toBe(403);
    expect((await adminBilling(req('POST', '/api/admin/billing', null, { business_id: biz.id, billing_status: 'active' }))).status).toBe(401);
    expect((await adminBilling(req('POST', '/api/admin/billing', admin, { business_id: biz.id, billing_status: 'gold' }))).status).toBe(422);
    expect((await adminBilling(req('POST', '/api/admin/billing', admin, { business_id: biz.id }))).status).toBe(422);
    expect((await adminBilling(req('POST', '/api/admin/billing', admin, { business_id: biz.id, sms_cap_override: -1 }))).status).toBe(422);
    expect((await adminBilling(req('POST', '/api/admin/billing', admin, { business_id: 'nope', billing_status: 'active' }))).status).toBe(404);

    const res = await adminBilling(req('POST', '/api/admin/billing', admin, {
      business_id: biz.id, billing_status: 'active', plan: 'comp', sms_cap_override: 5000, call_minutes_cap_override: 1000, note: 'grandfathered',
    }));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ billing_status: 'active', plan: 'comp', usage: { sms: { cap: 5000 }, call_minutes: { cap: 1000 } } });
    const r = await row(biz.id);
    expect(r).toMatchObject({ billingStatus: 'active', plan: 'comp', smsCapOverride: 5000, callMinutesCapOverride: 1000 });
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'billing.admin_override' } });
    expect(audit).not.toBeNull();
    expect((audit!.meta as any).note).toBe('grandfathered');

    await adminBilling(req('POST', '/api/admin/billing', admin, { business_id: biz.id, sms_cap_override: null, plan: null }));
    expect(await row(biz.id)).toMatchObject({ smsCapOverride: null, plan: null, billingStatus: 'active' });
  });

  test('provisioning gate: 402 billing_required body, admin bypass, off when not enforced', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const principal: any = { kind: 'user', user: owner.user, business_id: biz.id, role: 'owner', email_verified: true };
    const adminPrincipal: any = { kind: 'admin', via: 'token', email_verified: true };
    const planless = (await db.getBusiness(biz.id))!;
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      let thrown: unknown;
      try { gate.assertProvisioningAllowed(principal, planless); } catch (e) { thrown = e; }
      const res = gate.billingRequiredResponse(thrown)!;
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ ok: false, error: 'billing_required', checkout: '/api/billing/checkout' });
      expect(() => gate.assertProvisioningAllowed(adminPrincipal, planless)).not.toThrow();
      const trialing = (await db.setBillingState(biz.id, { billing_status: 'trialing' }))!;
      expect(() => gate.assertProvisioningAllowed(principal, trialing)).not.toThrow();
    });
    expect(() => gate.assertProvisioningAllowed(principal, planless)).not.toThrow(); // not enforced
  });

  test('provision route: admin passes the gate with BILLING_ENFORCED=true (comp), no outbound calls', async () => {
    const biz = await newBusiness({ agent_id: null });
    const route = (await import('@/app/api/businesses/[id]/provision/route')).POST;
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const res = await route(req('POST', `/api/businesses/${biz.id}/provision`, admin, {}), { params: Promise.resolve({ id: biz.id }) });
      expect(res.status).not.toBe(402);
    });
  });
});
