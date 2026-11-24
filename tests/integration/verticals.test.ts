/**
 * Vertical packs against Postgres: choosing the vertical (admin POST, owner PATCH with step-up), what a change does and does not touch,
 * provisioning from a pack, and the agent sync picking the pack up.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

integration('verticals (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let el: typeof import('@/lib/voice/elevenlabs');
  let patch: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let createRoute: (req: Request) => Promise<Response>;
  let provision: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let status: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  const userIds: string[] = [];
  const ENV = { ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_TOOL_SECRET: 'tool-secret-x', LANGUAGE_DETECTION: undefined, ELEVENLABS_AGENT_ID: undefined } as Record<string, string | undefined>;

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    el = await import('@/lib/voice/elevenlabs');
    patch = (await import('@/app/api/businesses/[id]/route')).PATCH as any;
    createRoute = (await import('@/app/api/businesses/route')).POST as any;
    provision = (await import('@/app/api/businesses/[id]/provision/route')).POST as any;
    status = (await import('@/app/api/businesses/[id]/onboarding-status/route')).GET as any;
  });
  afterAll(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'businesses/provision' } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  afterEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'businesses/provision' } } }); });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    const session = await prisma.userSession.findFirst({ where: { userId: user.id } });
    return { cookie: `rc_user_session=${token}`, sessionId: session!.id };
  }
  const headers = (who: { cookie?: string; bearer?: boolean } | null) => ({
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
    ...(who?.cookie ? { cookie: who.cookie } : {}),
    ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
  });
  const send = (method: string, path: string, who: { cookie?: string; bearer?: boolean } | null, body?: unknown) =>
    new Request(`https://app.example.test${path}`, { method, headers: headers(who), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const doPatch = (id: string, who: { cookie?: string; bearer?: boolean } | null, body: unknown) =>
    patch(send('PATCH', `/api/businesses/${id}`, who, body), { params: Promise.resolve({ id }) });
  const admin = { bearer: true };

  async function withKb(id: string, extra: { call_script?: string } = {}) {
    return db.upsertKnowledgeBase(id, {
      services: [{ name: 'My own service', description: 'edited by the owner', base_price: 77, duration_minutes: 45 }],
      faqs: [{ question: 'Owner-written question?', answer: 'Owner-written answer.' }],
      pricing_notes: 'Owner-written pricing note.',
      system_prompt: '', call_script: extra.call_script ?? '',
    });
  }

  test('POST /api/businesses (admin) validates the vertical: unknown rejected, valid stored, default hvac', async () => {
    const bad = await createRoute(send('POST', '/api/businesses', admin, { name: uniq('V'), vertical: 'pirate' }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error).toContain('vertical must be one of');
    const ok = await createRoute(send('POST', '/api/businesses', admin, { name: uniq('V'), vertical: 'dental' }));
    expect(ok.status).toBe(201);
    const created = ((await ok.json()) as any).data;
    expect(created.vertical).toBe('dental');
    const plain = ((await (await createRoute(send('POST', '/api/businesses', admin, { name: uniq('V') }))).json()) as any).data;
    expect(plain.vertical).toBe('hvac');
    await prisma.business.deleteMany({ where: { id: { in: [created.id, plain.id] } } });
  });

  test('PATCH: unknown vertical 422 (nothing stored), staff 403, another tenant 404', async () => {
    const biz = await newBusiness();
    const other = await newBusiness();
    const owner = await login(biz.id);
    const staff = await login(biz.id, 'staff');
    const otherOwner = await login(other.id);
    for (const v of ['pirate', '', 7, null, 'HVAC']) {
      const res = await doPatch(biz.id, owner, { vertical: v });
      expect(res.status).toBe(422);
    }
    expect((await db.getBusiness(biz.id))!.vertical).toBe('hvac');
    expect((await doPatch(biz.id, staff, { vertical: 'plumbing' })).status).toBe(403);
    expect((await doPatch(biz.id, otherOwner, { vertical: 'plumbing' })).status).toBe(404);
    expect((await db.getBusiness(biz.id))!.vertical).toBe('hvac');
  });

  test('PATCH: a vertical change on a set-up business needs a recent proof of identity; the same value never does', async () => {
    const biz = await newBusiness(); // has a number and an agent: it is live-ish
    const owner = await login(biz.id);
    await prisma.userSession.update({ where: { id: owner.sessionId }, data: { sudoAt: new Date(Date.now() - 10 * 60_000) } });
    const stale = await doPatch(biz.id, owner, { vertical: 'electrical' });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as any).code).toBe('reauth_required');
    expect((await db.getBusiness(biz.id))!.vertical).toBe('hvac');
    const same = await doPatch(biz.id, owner, { vertical: 'hvac' }); // unchanged: no step-up
    expect(same.status).toBe(200);
    await prisma.userSession.update({ where: { id: owner.sessionId }, data: { sudoAt: new Date() } });
    const ok = await doPatch(biz.id, owner, { vertical: 'electrical' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).data.vertical).toBe('electrical');
  });

  test('a business still in onboarding (no number, no agent) changes vertical without step-up', async () => {
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { phone: null, phoneKey: null, phoneE164: null } });
    const owner = await login(biz.id);
    await prisma.userSession.update({ where: { id: owner.sessionId }, data: { sudoAt: new Date(Date.now() - 60 * 60_000) } });
    const res = await doPatch(biz.id, owner, { vertical: 'cleaning' });
    expect(res.status).toBe(200);
    expect((await db.getBusiness(biz.id))!.vertical).toBe('cleaning');
  });

  test('changing the vertical rebuilds the derived prompt and generated script but never the owner-edited knowledge; it is audited', async () => {
    const biz = await newBusiness({ agent_id: null });
    const before = await withKb(biz.id);
    const { buildCallScript, buildSystemPrompt } = await import('@/lib/kb');
    await db.upsertKnowledgeBase(biz.id, {
      system_prompt: buildSystemPrompt((await db.getBusiness(biz.id))!, before),
      call_script: buildCallScript(before, (await db.getBusiness(biz.id))!),
    });
    const owner = await login(biz.id);
    const res = await doPatch(biz.id, owner, { vertical: 'plumbing' });
    expect(res.status).toBe(200);
    const kb = (await db.getKnowledgeBase(biz.id))!;
    expect(kb.services).toEqual(before.services);
    expect(kb.faqs).toEqual(before.faqs);
    expect(kb.pricing_notes).toBe(before.pricing_notes);
    expect(kb.system_prompt).toContain('burst or actively leaking pipe');
    expect(kb.system_prompt).not.toMatch(/water leaking from the system|\bHVAC\b|cooling/i);
    expect(kb.system_prompt).toContain('My own service');
    expect(kb.call_script).toContain('I can get a plumber out to you');
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.vertical_changed' } });
    expect(audit?.meta).toMatchObject({ from: 'hvac', to: 'plumbing', prompt_rebuilt: true, call_script_rebuilt: true, kb_content_kept: true });
  });

  test('an owner-edited call script is kept when the vertical changes', async () => {
    const biz = await newBusiness({ agent_id: null });
    await withKb(biz.id, { call_script: 'MY OWN SCRIPT: say hello nicely.' });
    const owner = await login(biz.id);
    expect((await doPatch(biz.id, owner, { vertical: 'dental' })).status).toBe(200);
    const kb = (await db.getKnowledgeBase(biz.id))!;
    expect(kb.call_script).toBe('MY OWN SCRIPT: say hello nicely.');
    expect(kb.system_prompt).toContain('dental trauma');
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.vertical_changed' } });
    expect(audit?.meta).toMatchObject({ prompt_rebuilt: true, call_script_rebuilt: false });
  });

  test('a business with no knowledge base yet: the change just stores the vertical (provisioning builds from it)', async () => {
    const biz = await newBusiness({ agent_id: null });
    const owner = await login(biz.id);
    expect((await doPatch(biz.id, owner, { vertical: 'landscaping' })).status).toBe(200);
    expect(await db.getKnowledgeBase(biz.id)).toBeNull();
  });

  test('onboarding status carries the vertical and locale', async () => {
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'general', localeDefault: 'es' } });
    const owner = await login(biz.id);
    const res = await status(send('GET', `/api/businesses/${biz.id}/onboarding-status`, owner), { params: Promise.resolve({ id: biz.id }) });
    expect(((await res.json()) as any).data).toMatchObject({ vertical: 'general', locale: 'es' });
  });

  test('provisioning with no website builds the knowledge base from the vertical template (editable later)', async () => {
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'dental', billingStatus: 'active' } });
    const owner = await login(biz.id);
    const res = await provision(send('POST', `/api/businesses/${biz.id}/provision`, owner, {}), { params: Promise.resolve({ id: biz.id }) });
    expect(res.status).toBe(200);
    const kb = ((await res.json()) as any).data.knowledge_base;
    expect(kb.services.map((s: any) => s.name)).toContain('Filling');
    expect(kb.system_prompt).toContain('dental trauma');
    expect(kb.system_prompt).not.toMatch(/\bHVAC\b|cooling/i);
    expect(kb.pricing_notes).toMatch(/No deposit is taken by default/);
  });

  test('syncAgent reads the business vertical: the agent prompt carries that trade, and a vertical change re-syncs the live agent', async () => {
    const fake = fakeElevenLabs();
    fake.install();
    try {
      await withEnv(ENV, async () => {
        el.clearToolIdCache(); el.resetInitiationCache();
        const biz = await newBusiness({ agent_id: null });
        await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'cleaning' } });
        const first = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
        expect(first.mock).toBe(false);
        const promptOf = () => fake.agents.get(first.agent_id)!.conversation_config.agent.prompt.prompt as string;
        expect(promptOf()).toContain('does not run emergency dispatch');
        expect(promptOf()).not.toMatch(/\bHVAC\b|cooling|flag_emergency immediately/i);
        expect(promptOf()).toContain('DISCLOSURE, CONSENT AND LIFE SAFETY'); // the 911 rule is in every vertical
        const owner = await login(biz.id);
        await withKb(biz.id);
        const res = await doPatch(biz.id, owner, { vertical: 'electrical' });
        expect(res.status).toBe(200);
        expect(promptOf()).toContain('Sparking, arcing');
        expect(promptOf()).not.toContain('does not run emergency dispatch');
        expect(promptOf()).toContain('My own service'); // the owner's services survived the re-sync
      });
    } finally { fake.restore(); }
  });
});
