/**
 * /api/extract and /api/businesses/[id]/provision are owner-accessible (self-signup onboarding), tenant scoped,
 * behind the verified-email and billing gates; `force` and billing bypass stay admin-only.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { confirmGoLive } from '../helpers/golive';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

integration('owner onboarding routes: extract + provision (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let provision: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let extract: (req: Request) => Promise<Response>;
  const userIds: string[] = [];

  beforeAll(async () => {
    await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    provision = (await import('@/app/api/businesses/[id]/provision/route')).POST as any;
    extract = (await import('@/app/api/extract/route')).POST as any;
  });
  afterAll(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'extract' } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'extract' } }, { key: { startsWith: 'businesses/provision' } }] } });
  });

  async function login(businessId: string | null, role: 'owner' | 'staff', verified = true) {
    const user = await users.createUser({
      email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: verified,
    });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}` };
  }
  const req = (path: string, who: { cookie?: string; bearer?: boolean } | null, body: unknown = {}) =>
    new Request(`https://app.example.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie } : {}),
        ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const prov = (id: string, who: { cookie?: string; bearer?: boolean } | null, body: unknown = {}) =>
    provision(req(`/api/businesses/${id}/provision`, who, body), { params: Promise.resolve({ id }) });
  const setBilling = (id: string, billingStatus: string) => prisma.business.update({ where: { id }, data: { billingStatus } });
  const admin = { bearer: true };

  test('provision: owner of a paid business may provision (idempotent, no force)', async () => {
    const biz = await newBusiness();
    await setBilling(biz.id, 'active');
    const owner = await login(biz.id, 'owner');
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      // first run builds the knowledge base from the template; going live then needs the owner's service area and their confirmation of it
      const first = await prov(biz.id, owner);
      expect(first.status).toBe(422);
      expect(((await first.json()) as any).code).toBe('kb_incomplete');
      await confirmGoLive(biz.id);
      const res = await prov(biz.id, owner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.phone).toBe(biz.phone!);
    });
  });

  test('provision: staff 403, unauthenticated 401, unverified owner 403 email_not_verified', async () => {
    const biz = await newBusiness();
    await setBilling(biz.id, 'active');
    expect((await prov(biz.id, await login(biz.id, 'staff'))).status).toBe(403);
    expect((await prov(biz.id, null)).status).toBe(401);
    const unverified = await login(biz.id, 'owner', false);
    const res = await prov(biz.id, unverified);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('email_not_verified');
  });

  test('provision: another tenant\'s business is a 404 (never confirmed), admin may', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const ownerA = await login(a.id, 'owner');
    expect((await prov(b.id, ownerA)).status).toBe(404);
    expect((await prov('does-not-exist', ownerA)).status).toBe(404);
    expect((await prov(b.id, admin)).status).toBe(200);
  });

  test('provision: billing gate answers 402 for an unpaid business when enforced; admin bypasses; off when not enforced', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const res = await prov(biz.id, owner);
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error).toBe('billing_required');
      expect((await prov(biz.id, admin)).status).toBe(200);
    });
    await withEnv({ BILLING_ENFORCED: undefined }, async () => {
      expect((await prov(biz.id, owner)).status).toBe(200);
    });
  });

  test('provision: `force` is honoured for admins only', async () => {
    const biz = await newBusiness();
    await setBilling(biz.id, 'active');
    const owner = await login(biz.id, 'owner');
    expect((await prov(biz.id, admin)).status).toBe(200);
    const kbBefore = await prisma.knowledgeBase.findUniqueOrThrow({ where: { businessId: biz.id } });
    // Owner `force: true` is ignored: the healthy, provisioned business takes the idempotent path (regenerated: false).
    const res = await prov(biz.id, owner, { force: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.regenerated).toBe(false);
    const kbAfter = await prisma.knowledgeBase.findUniqueOrThrow({ where: { businessId: biz.id } });
    expect(kbAfter.updatedAt.getTime()).toBe(kbBefore.updatedAt.getTime());
    // Admin force rebuilds.
    const forced = await prov(biz.id, admin, { force: true });
    expect(((await forced.json()) as any).data.regenerated).toBe(true);
  });

  test('extract: owner reaches the handler (SSRF guard refuses a private URL with 422), staff 403, unauthenticated 401, unverified 403', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id, 'owner');
    const res = await extract(req('/api/extract', owner, { url: 'http://127.0.0.1/', business_id: biz.id }));
    expect(res.status).toBe(422);
    expect((await extract(req('/api/extract', await login(biz.id, 'staff'), { url: 'http://127.0.0.1/' }))).status).toBe(403);
    expect((await extract(req('/api/extract', null, { url: 'http://127.0.0.1/' }))).status).toBe(401);
    expect((await extract(req('/api/extract', await login(biz.id, 'owner', false), { url: 'http://127.0.0.1/' }))).status).toBe(403);
    expect((await extract(req('/api/extract', owner, {}))).status).toBe(400);
  });

  test('extract: another tenant\'s business_id is a 404; the per-tenant budget rate-limits', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const ownerA = await login(a.id, 'owner');
    expect((await extract(req('/api/extract', ownerA, { url: 'http://127.0.0.1/', business_id: b.id }))).status).toBe(404);
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'extract' } } });
    for (let i = 0; i < 15; i++) await rateLimitTouch(a.id);
    const res = await extract(req('/api/extract', ownerA, { url: 'http://127.0.0.1/', business_id: a.id }));
    expect(res.status).toBe(429);
  });

  async function rateLimitTouch(id: string) {
    const { rateLimit } = await import('@/lib/ratelimit');
    await rateLimit(`extract:biz:${id}`, 15, 10 * 60_000);
  }
});
