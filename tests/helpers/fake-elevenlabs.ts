/**
 * A small fake of the ElevenLabs ConvAI API (just what syncAgent talks to): workspace tools (list / create / patch), agents (create /
 * patch, rejecting tool ids that do not exist like the real API does) and the workspace + agent settings PATCHes. It keeps the FINAL state, so a
 * test can assert what the provider would actually hold after any sequence of syncs. Install with `fake.install()` (replaces globalThis.fetch).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Ids are unique across fakes (a business row keeps its agent id; two tests must never hand out the same one). */
const RUN = Math.random().toString(36).slice(2, 8);
let GLOBAL_SEQ = 0;

export function fakeElevenLabs(opts: { failToolsOnce?: boolean; failImport?: boolean; registerCall?: 'twiml' | 'fail' } = {}) {
  const tools = new Map<string, { id: string; config: any }>();
  const agents = new Map<string, { id: string; conversation_config: any; platform_settings: any; name: string; tags: string[] }>();
  const settings: { webhook?: any } = {};
  /** Imported phone numbers (POST /convai/phone-numbers), by phone_number_id. `importBodies` keeps what was sent (the Twilio token is in it: tests assert it never leaks elsewhere). */
  const phones = new Map<string, { phone_number_id: string; phone_number: string; label: string; agent_id: string | null }>();
  const importBodies: any[] = [];
  /** Bodies of PATCH { sid, token } (credential refresh): the token is in them, tests assert it goes nowhere else. */
  const credentialPatches: any[] = [];
  const registerCalls: any[] = [];
  const calls: string[] = [];
  let failTools = opts.failToolsOnce === true;

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input).replace('https://api.elevenlabs.io/v1', '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/convai/tools' && method === 'GET') {
      return Response.json({ tools: [...tools.values()].map((t) => ({ id: t.id, tool_config: t.config })) });
    }
    if (path === '/convai/tools' && method === 'POST') {
      if (failTools) { failTools = false; return new Response('boom', { status: 500 }); }
      const id = `tool_${RUN}_${++GLOBAL_SEQ}`;
      tools.set(id, { id, config: body.tool_config });
      return Response.json({ id });
    }
    const toolPatch = /^\/convai\/tools\/([^/]+)$/.exec(path);
    if (toolPatch && method === 'PATCH') {
      const t = tools.get(toolPatch[1]);
      if (!t) return new Response('not found', { status: 404 });
      t.config = body.tool_config;
      return Response.json({ id: t.id });
    }
    if (path === '/convai/settings' && method === 'PATCH') { Object.assign(settings, { webhook: body.conversation_initiation_client_data_webhook }); return Response.json({}); }
    const checkIds = (ids: string[]) => ids.every((id) => tools.has(id));
    if (path === '/convai/agents/create' && method === 'POST') {
      if (!checkIds(body.conversation_config.agent.prompt.tool_ids)) return new Response(JSON.stringify({ detail: 'tool not found' }), { status: 422 });
      const id = `agent_${RUN}_${++GLOBAL_SEQ}`;
      agents.set(id, { id, conversation_config: body.conversation_config, platform_settings: {}, name: body.name, tags: body.tags });
      return Response.json({ agent_id: id });
    }
    const agentPatch = /^\/convai\/agents\/([^/]+)$/.exec(path);
    if (agentPatch && method === 'PATCH') {
      const a = agents.get(agentPatch[1]);
      if (!a) return new Response('not found', { status: 404 });
      if (body.conversation_config) {
        if (!checkIds(body.conversation_config.agent.prompt.tool_ids)) return new Response(JSON.stringify({ detail: 'tool not found' }), { status: 422 });
        a.conversation_config = body.conversation_config; a.name = body.name ?? a.name; a.tags = body.tags ?? a.tags;
      }
      if (body.platform_settings) a.platform_settings = { ...a.platform_settings, ...body.platform_settings };
      return Response.json({ agent_id: a.id });
    }
    if (path === '/convai/phone-numbers' && method === 'GET') {
      return Response.json([...phones.values()].map((p) => ({ phone_number_id: p.phone_number_id, phone_number: p.phone_number, label: p.label, provider: 'twilio', assigned_agent: p.agent_id ? { agent_id: p.agent_id } : null })));
    }
    if (path === '/convai/phone-numbers' && method === 'POST') {
      importBodies.push(body);
      if (opts.failImport) return new Response(JSON.stringify({ detail: 'twilio credentials rejected' }), { status: 422 });
      const id = `phnum_${RUN}_${++GLOBAL_SEQ}`;
      phones.set(id, { phone_number_id: id, phone_number: body.phone_number, label: body.label, agent_id: null });
      return Response.json({ phone_number_id: id });
    }
    const phoneOne = /^\/convai\/phone-numbers\/([^/]+)$/.exec(path);
    if (phoneOne) {
      const ph = phones.get(decodeURIComponent(phoneOne[1]));
      if (!ph) return new Response('not found', { status: 404 });
      if (method === 'GET') return Response.json({ phone_number_id: ph.phone_number_id, phone_number: ph.phone_number, assigned_agent: ph.agent_id ? { agent_id: ph.agent_id } : null });
      if (method === 'PATCH' && ('sid' in body || 'token' in body)) { credentialPatches.push(body); return Response.json({ phone_number_id: ph.phone_number_id }); } // refresh of the stored Twilio credentials: the agent binding is untouched
      if (method === 'PATCH') { ph.agent_id = body.agent_id ?? null; return Response.json({ phone_number_id: ph.phone_number_id }); }
      if (method === 'DELETE') { phones.delete(ph.phone_number_id); return Response.json({}); }
    }
    if (path === '/convai/twilio/register-call' && method === 'POST') {
      registerCalls.push(body);
      if (opts.registerCall === 'fail') return new Response('nope', { status: 500 });
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.elevenlabs.io/x"/></Connect></Response>', { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;

  let prev: typeof fetch | undefined;
  return {
    tools, agents, settings, calls, fetchImpl, phones, importBodies, credentialPatches, registerCalls,
    install() { prev = globalThis.fetch; globalThis.fetch = fetchImpl; },
    restore() { if (prev) globalThis.fetch = prev; },
    toolNames: () => [...tools.values()].map((t) => t.config.name as string).sort(),
    /** The tools an agent references, by wire name. */
    agentToolNames: (agentId: string) => (agents.get(agentId)!.conversation_config.agent.prompt.tool_ids as string[]).map((id) => tools.get(id)!.config.name as string).sort(),
  };
}
