/**
 * Cached ElevenLabs tool ids can go stale when ANOTHER instance deletes/recreates the workspace tools (docs/review/08 suspicion):
 * the provider rejects the agent body (422), and createOrUpdateAgent must flush its cache and retry once with fresh ids.
 */
import { integration, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, newBusiness } from '../helpers/fixtures';

integration('stale cached tool ids (postgres)', () => {
  let el: typeof import('@/lib/voice/elevenlabs');
  let db: Awaited<ReturnType<typeof loadDb>>;
  beforeAll(async () => { db = await loadDb(); el = await import('@/lib/voice/elevenlabs'); });
  afterAll(cleanup);

  /** A tiny ElevenLabs: workspace tools (id by name) and agents that must reference EXISTING tool ids. */
  function fakeEleven() {
    let gen = 1;
    const tools = new Map<string, { id: string; name: string; url: string }>();
    const log: string[] = [];
    let agents = 0;
    const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const path = url.replace('https://api.elevenlabs.io/v1', '');
      log.push(`${method} ${path}`);
      if (path === '/convai/tools' && method === 'GET') {
        return Response.json({ tools: [...tools.values()].map((t) => ({ id: t.id, tool_config: { type: 'webhook', name: t.name, api_schema: { url: t.url } } })) });
      }
      if (path === '/convai/tools' && method === 'POST') {
        const cfg = JSON.parse(String(init?.body)).tool_config;
        const id = `tool_${gen++}`;
        tools.set(id, { id, name: cfg.name, url: cfg.api_schema.url });
        return Response.json({ id });
      }
      if (path.startsWith('/convai/tools/') && method === 'PATCH') return Response.json({});
      if (path === '/convai/agents/create' && method === 'POST') {
        const ids: string[] = JSON.parse(String(init?.body)).conversation_config.agent.prompt.tool_ids;
        if (ids.some((id) => !tools.has(id))) return new Response(JSON.stringify({ detail: 'tool not found' }), { status: 422 });
        return Response.json({ agent_id: `agent_real_${++agents}` });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { fetchImpl, tools, log, agentCreates: () => log.filter((l) => l === 'POST /convai/agents/create').length };
  }

  test('a 422 caused by deleted tools flushes the cache and retries once with fresh ids', async () => {
    const eleven = fakeEleven();
    const prev = globalThis.fetch;
    globalThis.fetch = eleven.fetchImpl;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_AGENT_ID: undefined }, async () => {
        el.clearToolIdCache();
        const a = await newBusiness({ agent_id: null });
        const first = await el.createOrUpdateAgent({ business: a, kb: null });
        expect(first).toMatchObject({ mock: false, created: true });
        expect(eleven.agentCreates()).toBe(1);

        // another instance deleted and recreated every workspace tool: this process's cached ids are now dead
        eleven.tools.clear();
        const b = await newBusiness({ agent_id: null });
        const second = await el.createOrUpdateAgent({ business: b, kb: null });
        expect(second).toMatchObject({ mock: false, created: true });
        expect(eleven.agentCreates()).toBe(3); // first, rejected (stale), retried with fresh ids
        expect(eleven.tools.size).toBe(7); // the tools were registered again
        // the cache now holds the fresh ids: the next agent needs no retry and no tool lookups
        const before = eleven.agentCreates();
        const c = await newBusiness({ agent_id: null });
        expect((await el.createOrUpdateAgent({ business: c, kb: null })).mock).toBe(false);
        expect(eleven.agentCreates()).toBe(before + 1);
      });
    } finally {
      globalThis.fetch = prev;
    }
    expect(db).toBeDefined();
  });

  test('a genuine failure (not tool ids) is not retried forever: one fresh attempt at most, then a clear error', async () => {
    const prev = globalThis.fetch;
    let creates = 0;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.endsWith('/convai/tools') && (init?.method ?? 'GET') === 'GET') return Response.json({ tools: [] });
      if (url.endsWith('/convai/tools')) return Response.json({ id: `t_${Math.random()}` });
      if (url.endsWith('/convai/agents/create')) { creates++; return new Response('bad', { status: 422 }); }
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_AGENT_ID: undefined }, async () => {
        el.clearToolIdCache();
        const a = await newBusiness({ agent_id: null });
        await el.createOrUpdateAgent({ business: a, kb: null }); // fills the cache (422 on a cold cache: no retry)
        expect(creates).toBe(1);
        const r = await el.createOrUpdateAgent({ business: await newBusiness({ agent_id: null }), kb: null });
        expect(r.error).toBe('create 422');
        expect(creates).toBe(3); // exactly one retry for the second call
      });
    } finally {
      globalThis.fetch = prev;
    }
  });
});
