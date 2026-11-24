/**
 * Review 14, report 14 (verticals, i18n, migrations, jobs): vertical change failure + durable retry + concurrency, the transcript consent race,
 * the agent re-sync only recreating on 404, the usage-warning job cadence, and post-call urgency end to end.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, uniq } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

integration('review 14: verticals, consent race, agent sync, jobs (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let el: typeof import('@/lib/voice/elevenlabs');
  let patch: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let resync: (req: Request) => Promise<Response>;
  let change: typeof import('@/lib/verticals/change');
  let agents: typeof import('@/lib/voice/agent-resync');
  const userIds: string[] = [];
  const ENV = { ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_TOOL_SECRET: 'tool-secret-x', LANGUAGE_DETECTION: undefined, ELEVENLABS_AGENT_ID: undefined } as Record<string, string | undefined>;

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    el = await import('@/lib/voice/elevenlabs');
    patch = (await import('@/app/api/businesses/[id]/route')).PATCH as any;
    resync = (await import('@/app/api/admin/resync-agents/route')).POST as any;
    change = await import('@/lib/verticals/change');
    agents = await import('@/lib/voice/agent-resync');
  });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await cleanup(); });
  afterEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } }); });

  async function login(businessId: string) {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}` };
  }
  const send = (method: string, path: string, who: { cookie?: string; bearer?: boolean }, body?: unknown) => new Request(`https://app.example.test${path}`, {
    method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', ...(who.cookie ? { cookie: who.cookie } : {}), ...(who.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const withKb = (id: string) => db.upsertKnowledgeBase(id, { services: [{ name: 'My own service', base_price: 77, duration_minutes: 45 }], faqs: [], pricing_notes: 'Notes.', system_prompt: '', call_script: '' });

  /** A fake ElevenLabs whose agent PATCH can be made to fail with a status (503 / 429 / 404 ...). */
  function flakyAgents(fake: ReturnType<typeof fakeElevenLabs>) {
    const state = { patchStatus: null as number | null, creates: 0 };
    const inner = fake.fetchImpl;
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = String(input).replace('https://api.elevenlabs.io/v1', '');
      const method = init?.method ?? 'GET';
      if (/^\/convai\/agents\/[^/]+$/.test(path) && method === 'PATCH' && state.patchStatus) return new Response('{}', { status: state.patchStatus });
      if (path === '/convai/agents/create' && method === 'POST') state.creates++;
      return inner(input as never, init as never);
    }) as typeof fetch;
    return state;
  }

  test('R14 M2: a vertical change whose agent sync fails says so, queues a retry, and the reconcile job re-syncs it (with backoff, then done)', async () => {
    const fake = fakeElevenLabs();
    fake.install();
    try {
      await withEnv(ENV, async () => {
        el.clearToolIdCache(); el.resetInitiationCache();
        const biz = await newBusiness({ agent_id: null });
        await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'hvac' } });
        const first = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
        await withKb(biz.id);
        const owner = await login(biz.id);
        const flaky = flakyAgents(fake);
        flaky.patchStatus = 503; // ElevenLabs is having a bad moment
        const res = await patch(send('PATCH', `/api/businesses/${biz.id}`, owner, { vertical: 'electrical' }), { params: Promise.resolve({ id: biz.id }) });
        expect(res.status).toBe(200);
        const body = (await res.json() as any).data;
        expect(body.vertical).toBe('electrical');
        expect(body.vertical_sync).toMatchObject({ prompt_rebuilt: true, agent: 'failed', retry_queued: true }); // the dashboard warns instead of "saved"
        expect((await prisma.knowledgeBase.findUnique({ where: { businessId: biz.id } }))!.systemPrompt).toContain('Sparking, arcing'); // the stored prompt is already the new trade's
        expect(fake.agents.get(first.agent_id)!.conversation_config.agent.prompt.prompt).not.toContain('Sparking, arcing'); // the live agent is not
        expect(await prisma.processedEvent.count({ where: { source: { startsWith: 'agent-dirty:' }, id: biz.id } })).toBe(1);

        // the reconcile job tick: still failing -> backs off; recovered -> synced and the marker is gone
        const { runReconcileJob } = await import('@/lib/jobs/reconcile');
        const now = new Date();
        let r = await runReconcileJob({ now, env: { ...process.env } as never });
        expect(r.counts!.agents_failed).toBeGreaterThanOrEqual(1);
        const row = (await prisma.processedEvent.findFirst({ where: { source: { startsWith: 'agent-dirty:' }, id: biz.id } }))!;
        expect(row.source).toBe('agent-dirty:1');
        expect(row.claimedAt.getTime()).toBeGreaterThan(now.getTime() + 60_000); // backed off
        r = await runReconcileJob({ now: new Date(now.getTime() + 60_000), env: { ...process.env } as never });
        expect(r.counts!.agents_considered ?? 0).toBe(0); // not due yet
        flaky.patchStatus = null;
        r = await runReconcileJob({ now: new Date(now.getTime() + 3 * 3600_000), env: { ...process.env } as never });
        expect(r.counts!.agents_synced).toBeGreaterThanOrEqual(1);
        expect(await prisma.processedEvent.count({ where: { source: { startsWith: 'agent-dirty:' }, id: biz.id } })).toBe(0);
        expect(fake.agents.get(first.agent_id)!.conversation_config.agent.prompt.prompt).toContain('Sparking, arcing');
        expect(flaky.creates).toBe(0); // and no second agent was ever created
      });
    } finally { fake.restore(); }
  });

  test('R14 L4: two quick vertical changes leave the prompt of the FINAL trade (the prompt is rebuilt from the current business, serialised)', async () => {
    const fake = fakeElevenLabs();
    fake.install();
    try {
      await withEnv(ENV, async () => {
        el.clearToolIdCache(); el.resetInitiationCache();
        const biz = await newBusiness({ agent_id: null });
        await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
        await withKb(biz.id);
        const before = (await db.getBusiness(biz.id))!;
        const toPlumbing = await db.updateBusiness(biz.id, { vertical: 'plumbing' } as never);
        const toDental = await db.updateBusiness(biz.id, { vertical: 'dental' } as never);
        // the two requests' applyVerticalChange calls overlap, each holding the business row it saw
        await Promise.all([change.applyVerticalChange(before, toPlumbing!), change.applyVerticalChange(toPlumbing!, toDental!)]);
        await agents.drainDirtyAgents({ now: new Date(Date.now() + 3600_000) }); // anything that lost the lease is rebuilt by the retry
        const prompt = (await prisma.knowledgeBase.findUnique({ where: { businessId: biz.id } }))!.systemPrompt;
        expect(prompt).toMatch(/dental|severe pain|toothache/i);
        expect(prompt).not.toMatch(/burst pipe|sewage/i);
      });
    } finally { fake.restore(); }
  });

  test('R14 M3: a decline that races a transcript insert cannot leave transcript rows behind (the insert and the decline serialise on the call row)', async () => {
    const biz = await newBusiness();
    const call = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), conversationId: uniq('conv'), callerPhone: phone(), status: 'in_progress', consentStatus: 'disclosed', recordingDisclosed: true } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => { inserted = r; });
    // T1: inserts while consent is still 'disclosed' and does not commit yet
    const t1 = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO "call_transcript_events" ("id","call_id","seq","role","text","at","is_final") SELECT gen_random_uuid()::text, c."id", 0, 'caller', 'I do not want', now(), true FROM "calls" c WHERE c."id" = ${call.id} AND c."consent_status" <> 'declined'`;
      inserted();
      await gate;
    }, { timeout: 20_000 });
    await insertedP;
    // T2: the caller declines
    let declined = false;
    const t2 = prisma.call.update({ where: { id: call.id }, data: { consentStatus: 'declined' } }).then(() => { declined = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(declined).toBe(false); // the decline WAITS for the in-flight insert (it used to run straight through)
    release();
    await Promise.all([t1, t2]);
    expect(declined).toBe(true);
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0); // the purge saw the committed row
    // and the other order: a decline in flight makes the insert skip
    const call2 = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), conversationId: uniq('conv'), callerPhone: phone(), status: 'in_progress', consentStatus: 'disclosed', recordingDisclosed: true } });
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    let updated!: () => void;
    const updatedP = new Promise<void>((r) => { updated = r; });
    const d1 = prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: call2.id }, data: { consentStatus: 'declined' } });
      updated();
      await gate2;
    }, { timeout: 20_000 });
    await updatedP;
    const ins = db.appendTranscriptEvents(call2.id, [{ seq: 0, role: 'caller', text: 'x', at: new Date() }]);
    await new Promise((r) => setTimeout(r, 200));
    release2();
    await d1; await ins;
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call2.id } })).toBe(0);
  }, 30_000);

  test('R14 M4: a transient PATCH failure never creates a second agent; only a 404 (agent gone) recreates, and the resync endpoint finishes the new agent', async () => {
    const fake = fakeElevenLabs();
    fake.install();
    try {
      await withEnv(ENV, async () => {
        el.clearToolIdCache(); el.resetInitiationCache();
        const biz = await newBusiness({ agent_id: null });
        const first = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
        const state = flakyAgents(fake);
        for (const status of [429, 500, 503, 422]) {
          state.patchStatus = status;
          const r = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
          expect(r).toMatchObject({ mock: true, agent_id: first.agent_id, error: `update ${status}` });
          expect(state.creates).toBe(0);
          expect((await db.getBusiness(biz.id))!.agent_id).toBe(first.agent_id); // still points at the old (bound) agent
        }
        // through the admin endpoint: reported as failed, nothing created
        state.patchStatus = 503;
        const out = await (await resync(send('POST', '/api/admin/resync-agents', { bearer: true }, { dry_run: false, business_ids: [biz.id] }))).json() as any;
        expect(out.data.items[0].outcome).toBe('failed');
        expect(state.creates).toBe(0);
        // the agent really is gone at the provider (404): a new one is created and the operator is told what was (not) done for it
        state.patchStatus = 404;
        const gone = await (await resync(send('POST', '/api/admin/resync-agents', { bearer: true }, { dry_run: false, business_ids: [biz.id] }))).json() as any;
        expect(gone.data.items[0].outcome).toBe('created');
        expect(gone.data.items[0].detail).toContain('NEW agent created');
        expect(state.creates).toBe(1);
        expect((await db.getBusiness(biz.id))!.agent_id).not.toBe(first.agent_id);
        const audit = await prisma.auditEvent.findFirst({ where: { action: 'admin.resync_agents' }, orderBy: { at: 'desc' } });
        expect((audit!.meta as any).created).toBe(1);
      });
    } finally { fake.restore(); }
  });

  test('R14 L6: the usage-warning safety net runs every 10 minutes (not every tick), one instance at a time', async () => {
    const jobs = await import('@/lib/jobs');
    const t0 = new Date('2031-03-01T12:00:00Z');
    await prisma.processedEvent.deleteMany({ where: { source: 'job-state', id: 'usage_warnings' } });
    const env = { NODE_ENV: 'production', JOBS: 'on' } as any;
    const ran = async (now: Date) => (await jobs.runJobTick({ now, env, jobs: ['usage_warnings'] })).length;
    expect(await ran(t0)).toBe(1);
    expect(await ran(new Date(t0.getTime() + 60_000))).toBe(0);
    expect(await ran(new Date(t0.getTime() + 9 * 60_000))).toBe(0);
    expect(await ran(new Date(t0.getTime() + 10 * 60_000 + 1))).toBe(1);
    // another instance already holds the pass: this one skips it
    const { acquireLease, releaseLease } = await import('@/lib/db');
    const lease = (await acquireLease('usage-warnings-job', 60_000))!;
    try {
      const { runUsageWarningsJob } = await import('@/lib/jobs/reconcile');
      const r = await runUsageWarningsJob({ now: t0 });
      expect(r.items.map((i) => i.outcome)).toContain('skipped_other_instance_running');
    } finally { await releaseLease(lease); }
    await prisma.processedEvent.deleteMany({ where: { source: 'job-state', id: 'usage_warnings' } });
  });

  test('R14 verticals M1 end to end: an HVAC call where the agent asks the triage question and the caller says "no" is stored as routine; a caller who reports sparks is an emergency', async () => {
    const postcall = await import('@/lib/voice/postcall');
    const biz = await newBusiness({ agent_id: uniq('agent') });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'electrical' } });
    const mk = (transcript: unknown[]) => prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), conversationId: uniq('conv'), callerPhone: phone(), status: 'in_progress', consentStatus: 'disclosed', recordingDisclosed: true } })
      .then(async (c) => { await postcall.processPostCall({ type: 'post_call_transcription', data: { conversation_id: c.conversationId!, agent_id: biz.agent_id!, call_sid: c.callSid!, transcript, metadata: { call_duration_secs: 40 }, analysis: { transcript_summary: 's' } } } as never); return (await prisma.call.findUnique({ where: { id: c.id } }))!; });
    const routine = await mk([{ role: 'agent', message: 'Are there any sparks or a burning smell?', time_in_call_secs: 1 }, { role: 'user', message: 'No, I just want a ceiling fan installed.', time_in_call_secs: 5 }]);
    expect(routine.urgency).toBe('routine');
    const urgent = await mk([{ role: 'agent', message: 'Are there any sparks or a burning smell?', time_in_call_secs: 1 }, { role: 'user', message: 'Yes, the panel is sparking and smells like burning.', time_in_call_secs: 5 }]);
    expect(urgent.urgency).toBe('emergency');
  });
});
