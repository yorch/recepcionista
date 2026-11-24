/**
 * ONE syncAgent path: against a fake ElevenLabs the FINAL agent config holds everything (every tool by id, system tools, language, voice,
 * dynamic-variable placeholders, initiation webhook + override flags); syncing again changes nothing; concurrent syncs do not duplicate tools;
 * and POST /api/admin/resync-agents re-registers all agents (dry run by default, batched, rate limited, audited, admin only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

integration('agent sync (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let el: typeof import('@/lib/voice/elevenlabs');
  let resync: (req: Request) => Promise<Response>;
  const userIds: string[] = [];
  const ENV = { ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_TOOL_SECRET: 'tool-secret-x', NATIVE_TRANSFER: 'on', OWNER_CALLIN_ENABLED: 'true', LANGUAGE_DETECTION: undefined, ELEVENLABS_AGENT_ID: undefined } as Record<string, string | undefined>;

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    el = await import('@/lib/voice/elevenlabs');
    resync = (await import('@/app/api/admin/resync-agents/route')).POST as any;
  });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await cleanup(); });
  afterEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } }); });

  const EXPECTED_TOOLS = [
    'cancel-booking', 'check-availability', 'create-booking', 'create-payment-link', 'flag-emergency', 'get-pricing', 'handoff-to-human',
    'list-recent-changes', 'propose-kb-change', 'reschedule-booking', 'send-sms', 'transfer-to-human', 'undo-last-change',
  ];

  async function withFake<T>(fn: (f: ReturnType<typeof fakeElevenLabs>) => Promise<T>, env: Record<string, string | undefined> = {}): Promise<T> {
    const fake = fakeElevenLabs();
    fake.install();
    try { return await withEnv({ ...ENV, ...env }, async () => { el.clearToolIdCache(); el.resetInitiationCache(); return fn(fake); }); } finally { fake.restore(); }
  }

  test('the final agent config contains every tool, system tool, language, voice, placeholder and override flag', async () => {
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      await prisma.business.update({ where: { id: biz.id }, data: { voiceId: 'voice_custom_1', voiceName: 'Custom' } });
      const business = (await db.getBusiness(biz.id))!;
      const r = await el.syncAgent({ business, kb: null });
      expect(r).toMatchObject({ mock: false, created: true });
      expect(r.tools!.slice().sort()).toEqual(EXPECTED_TOOLS);
      const agent = fake.agents.get(r.agent_id)!;
      expect(fake.agentToolNames(r.agent_id)).toEqual(EXPECTED_TOOLS); // every tool is REFERENCED by id on the agent
      expect(fake.toolNames()).toEqual(EXPECTED_TOOLS);               // ...and exists once in the workspace
      const cfg = agent.conversation_config;
      // dynamic variable placeholders
      const ph = cfg.agent.dynamic_variables.dynamic_variable_placeholders;
      for (const k of ['business_id', 'owner_mode', 'transfer_destination', 'transfer_mode', 'call_sid', 'caller_phone']) expect(Object.keys(ph)).toContain(k);
      expect(ph).toMatchObject({ business_id: biz.id, owner_mode: 'false', transfer_mode: 'off', transfer_destination: '' });
      // system tools + language
      expect(cfg.agent.prompt.built_in_tools.language_detection).toMatchObject({ type: 'system', params: { system_tool_type: 'language_detection' } });
      expect(cfg.agent.prompt.built_in_tools.transfer_to_number.params.transfer_rules[0].provider_configs[0].config.transfer_destination.destination).toBe('{{transfer_destination}}');
      expect(cfg.language_presets.es.overrides.agent.first_message.length).toBeGreaterThan(10);
      expect(cfg.agent.prompt.prompt).toContain('# Live transfer');
      // voice
      expect(cfg.tts.voice_id).toBe('voice_custom_1');
      // every tool is bound to the tenant + call keys by the platform, never by the model
      for (const t of fake.tools.values()) {
        const props = t.config.api_schema.request_body_schema.properties;
        expect(props.business_id).toEqual({ type: 'string', dynamic_variable: 'business_id' });
        expect(props.call_sid.dynamic_variable).toBe('system__call_sid');
        expect(props.caller_phone.dynamic_variable).toBe('system__caller_id');
        expect(t.config.api_schema.request_headers['x-recepcionista-tool-secret']).toBe('tool-secret-x');
        expect(t.config.api_schema.url).toBe(`https://app.example.test/api/voice/tools/${t.config.name.replace(/-/g, '_')}`);
      }
      // the owner tools carry the structured fields (hours / closed dates / service area)
      const propose = [...fake.tools.values()].find((t) => t.config.name === 'propose-kb-change')!.config.api_schema.request_body_schema.properties;
      for (const k of ['days', 'open_time', 'close_time', 'closed', 'dates', 'areas', 'change_type', 'confirmed']) expect(Object.keys(propose)).toContain(k);
      for (const t of ['set_hours', 'add_closed_dates', 'remove_closed_dates', 'set_service_area']) expect(propose.change_type.enum).toContain(t);
      // initiation webhook (workspace) + per-call override flags (agent)
      expect(fake.settings.webhook).toMatchObject({ url: 'https://app.example.test/api/voice/initiation', request_headers: { 'x-recepcionista-tool-secret': 'tool-secret-x' } });
      expect(agent.platform_settings.overrides).toMatchObject({
        enable_conversation_initiation_client_data_from_webhook: true,
        conversation_config_override: { agent: { first_message: true, prompt: { prompt: true } }, conversation: { max_duration_seconds: true } },
      });
      // the id is stored on the business
      expect((await db.getBusiness(biz.id))!.agent_id).toBe(r.agent_id);
    });
  });

  test('without NATIVE_TRANSFER / owner call-in the agent simply carries fewer tools (and none of the optional ones)', async () => {
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      const r = await el.syncAgent({ business: biz, kb: null });
      expect(fake.agentToolNames(r.agent_id)).toEqual(EXPECTED_TOOLS.filter((n) => !['transfer-to-human', 'propose-kb-change', 'list-recent-changes', 'undo-last-change'].includes(n)));
      expect(fake.agents.get(r.agent_id)!.conversation_config.agent.prompt.built_in_tools.transfer_to_number).toBeUndefined();
    }, { NATIVE_TRANSFER: undefined, OWNER_CALLIN_ENABLED: 'false' });
  });

  test('idempotent: syncing again updates the same agent, creates no duplicate tools or agents and keeps the same tool ids; a changed voice is picked up', async () => {
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      const first = await el.syncAgent({ business: biz, kb: null });
      const idsBefore = [...fake.agents.get(first.agent_id)!.conversation_config.agent.prompt.tool_ids].sort();
      const again = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      expect(again).toMatchObject({ agent_id: first.agent_id, created: false, mock: false });
      expect(fake.agents.size).toBe(1);
      expect(fake.tools.size).toBe(EXPECTED_TOOLS.length);
      expect([...fake.agents.get(first.agent_id)!.conversation_config.agent.prompt.tool_ids].sort()).toEqual(idsBefore);
      expect(fake.calls.filter((c) => c === 'POST /convai/tools').length).toBe(EXPECTED_TOOLS.length); // each tool created once, ever
      // a restart (empty tool-id cache) finds the existing tools by name+URL instead of creating them again
      el.clearToolIdCache();
      await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      expect(fake.tools.size).toBe(EXPECTED_TOOLS.length);
      await prisma.business.update({ where: { id: biz.id }, data: { voiceId: 'voice_changed' } });
      await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      expect(fake.agents.get(first.agent_id)!.conversation_config.tts.voice_id).toBe('voice_changed');
    });
  });

  test('concurrent syncs of different businesses do not register duplicate workspace tools', async () => {
    await withFake(async (fake) => {
      const bizs = await Promise.all([newBusiness({ agent_id: null }), newBusiness({ agent_id: null }), newBusiness({ agent_id: null })]);
      const results = await Promise.all(bizs.map((b) => el.syncAgent({ business: b, kb: null })));
      expect(results.every((r) => !r.mock)).toBe(true);
      expect(fake.agents.size).toBe(3);
      expect(fake.tools.size).toBe(EXPECTED_TOOLS.length);
      for (const r of results) expect(fake.agentToolNames(r.agent_id)).toEqual(EXPECTED_TOOLS);
    });
  });

  // ------------------------------------------------------------------ POST /api/admin/resync-agents
  const post = (body: unknown, who: 'admin' | 'none' | 'owner' = 'admin', cookie?: string) => new Request('https://app.example.test/api/admin/resync-agents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test',
      ...(who === 'admin' ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}), ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = async (res: Response) => ((await res.json()) as any).data;

  test('resync: admin only; dry run is the default and touches no provider; real runs sync in batches via next_cursor; idempotent; audited; validated', async () => {
    await withFake(async (fake) => {
      const mine: string[] = [];
      for (let i = 0; i < 3; i++) { const b = await newBusiness({ agent_id: uniq('agent-old') }); mine.push(b.id); }
      mine.sort();
      const users = await import('@/lib/db/users');
      const owner = await users.createUser({ email: `${uniq('o')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: mine[0], email_verified: true });
      userIds.push(owner.id);
      const { token } = await users.createSession(owner.id);
      expect((await resync(post({}, 'none'))).status).toBe(401);
      expect((await resync(post({}, 'none', `rc_user_session=${token}`))).status).toBe(403);

      // dry run (default, empty body too)
      const dry = await data(await resync(post({ business_ids: mine })));
      expect(dry).toMatchObject({ dry_run: true, configured: true, next_cursor: null });
      expect(dry.items.map((i: any) => i.business_id)).toEqual(mine);
      expect(dry.items.every((i: any) => i.outcome === 'would_sync')).toBe(true);
      for (const t of ['propose_kb_change', 'reschedule_booking', 'transfer_to_human']) expect(dry.tools).toContain(t);
      expect(fake.calls).toEqual([]);                      // no provider call, nothing registered
      expect(fake.agents.size).toBe(0);
      expect(await data(await resync(post(undefined)))).toMatchObject({ dry_run: true });

      // real run, one business per batch, following next_cursor
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const res = await resync(post({ dry_run: false, business_ids: mine, limit: 1, ...(cursor ? { cursor } : {}) }));
        expect(res.status).toBe(200);
        const d = await data(res);
        expect(d.items.length).toBeLessThanOrEqual(1);
        for (const it of d.items) { seen.push(it.business_id); expect(['synced', 'created']).toContain(it.outcome); }
        cursor = d.next_cursor;
        await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } });
        if (!cursor) break;
      }
      expect(seen).toEqual(mine);
      // the old (non-existent) agent ids were recreated: the final state holds every tool on every agent
      expect(fake.tools.size).toBe(EXPECTED_TOOLS.length);
      for (const a of fake.agents.values()) expect(fake.agentToolNames(a.id)).toEqual(EXPECTED_TOOLS);
      const audits = await prisma.auditEvent.findMany({ where: { action: 'admin.resync_agents' }, orderBy: { at: 'desc' }, take: 6 });
      expect(audits.some((a) => (a.meta as any).dry_run === false && (a.meta as any).synced === 1)).toBe(true);
      expect(audits.every((a) => a.actorKind === 'admin_token')).toBe(true);

      // "after a deploy": a tool vanished from the workspace -> resync registers it again and re-points the agent; running twice changes nothing
      const dropped = [...fake.tools.values()].find((t) => t.config.name === 'reschedule-booking')!;
      fake.tools.delete(dropped.id);
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } });
      const r1 = await data(await resync(post({ dry_run: false, business_ids: [mine[0]] })));
      expect(r1.items[0].outcome).toMatch(/synced|created/);
      expect(fake.toolNames()).toEqual(EXPECTED_TOOLS);
      const fixedAgent = (await db.getBusiness(mine[0]))!.agent_id!;
      expect(fake.agentToolNames(fixedAgent)).toEqual(EXPECTED_TOOLS); // this agent was re-pointed at the new tool; the other two still reference the deleted one
      expect([...fake.agents.values()].filter((a) => a.id !== fixedAgent).every((a) => (a.conversation_config.agent.prompt.tool_ids as string[]).some((id) => !fake.tools.has(id)))).toBe(true);
      const sizeAfter = fake.tools.size;
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } });
      await resync(post({ dry_run: false, business_ids: [mine[0]] }));
      expect(fake.tools.size).toBe(sizeAfter);
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } });
      const rest = await data(await resync(post({ dry_run: false, business_ids: mine })));
      expect(rest.items.map((i: any) => i.outcome).every((o: string) => o === 'synced' || o === 'created')).toBe(true);
      for (const a of fake.agents.values()) expect(fake.agentToolNames(a.id)).toEqual(EXPECTED_TOOLS); // one resync after the "deploy" repaired every agent
      expect(fake.tools.size).toBe(sizeAfter);

      // validation
      for (const bad of [{ dry_run: 'no' }, { limit: 0 }, { limit: 26 }, { limit: 1.5 }, { business_ids: [] }, { business_ids: [1] }, { cursor: '' }, { nope: 1 }]) {
        await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/resync-agents' } } });
        expect((await resync(post(bad))).status).toBe(422);
      }
    });
  });

  test('resync: a real run without an ElevenLabs key is refused (503), and the route is rate limited', async () => {
    await withEnv({ ELEVENLABS_API_KEY: undefined }, async () => {
      expect((await resync(post({ dry_run: false }))).status).toBe(503);
      expect((await data(await resync(post({})))).configured).toBe(false); // a dry run still works and says so
    });
    let limited = 0;
    for (let i = 0; i < 9; i++) if ((await resync(post({}))).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(1);
  });
});
