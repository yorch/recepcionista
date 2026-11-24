/** Provider release calls with a fake fetch: Twilio number release and ElevenLabs agent/tool deletion (idempotent, mock-safe). */
import { afterEach, describe, expect, test } from 'bun:test';
import { isMockPoolNumber, releaseNumber as releaseNumberRaw } from '../src/lib/providers/twilio';
import { deleteAgent, deleteAgentTools } from '../src/lib/voice/elevenlabs';

type Call = { url: string; method: string };
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fake(handler: (url: string, method: string) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    return handler(url, method);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const env = (o: Record<string, string> = {}) => ({ NODE_ENV: 'test', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_PHONE_NUMBER: '+13055550100', ...o }) as unknown as NodeJS.ProcessEnv;
const NUM = '+17864129234';
/** Holder check stubbed (no database in this file): no other business holds the number. */
const releaseNumber = (n: string, d: Parameters<typeof releaseNumberRaw>[1] = {}) => releaseNumberRaw(n, { heldByOther: async () => false, ...d });
const savedApp = process.env.APP_URL;
afterEach(() => { if (savedApp === undefined) delete process.env.APP_URL; else process.env.APP_URL = savedApp; });

describe('twilio releaseNumber', () => {
  test('mock mode (no credentials at all, not production) and mock-pool numbers call nothing and succeed', async () => {
    const f = fake(() => J({}));
    expect(await releaseNumber(NUM, { fetchImpl: f.fetchImpl, env: { NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv })).toEqual({ ok: true, mock: true });
    expect(await releaseNumber('+13055551234', { fetchImpl: f.fetchImpl, env: env() })).toEqual({ ok: true, mock: true });
    expect(isMockPoolNumber('+13055551234')).toBe(true);
    expect(isMockPoolNumber(NUM)).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  test('looks the number up then deletes it by sid', async () => {
    const f = fake((url, m) => (m === 'GET' ? J({ incoming_phone_numbers: [{ sid: 'PN123', phone_number: NUM }] }) : new Response(null, { status: 204 })));
    const r = await releaseNumber(NUM, { fetchImpl: f.fetchImpl, env: env() });
    expect(r).toEqual({ ok: true, sid: 'PN123' });
    expect(f.calls[0].url).toContain('/IncomingPhoneNumbers.json?PhoneNumber=%2B17864129234');
    expect(f.calls[1]).toEqual({ url: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/IncomingPhoneNumbers/PN123.json', method: 'DELETE' });
  });
  test('idempotent: not listed, or 404 on delete, is success', async () => {
    const none = fake(() => J({ incoming_phone_numbers: [] }));
    expect(await releaseNumber(NUM, { fetchImpl: none.fetchImpl, env: env() })).toEqual({ ok: true, already_released: true });
    expect(none.calls).toHaveLength(1);
    const gone = fake((u, m) => (m === 'GET' ? J({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: NUM }] }) : J({ message: 'not found' }, 404)));
    expect(await releaseNumber(NUM, { fetchImpl: gone.fetchImpl, env: env() })).toEqual({ ok: true, already_released: true });
    expect((await releaseNumber(NUM, { fetchImpl: fake(() => J({}, 404)).fetchImpl, env: env() })).already_released).toBe(true);
  });
  test('errors are reported (not thrown) and leave the caller able to retry', async () => {
    const r = await releaseNumber(NUM, { fetchImpl: fake(() => J({}, 500)).fetchImpl, env: env() });
    expect(r.ok).toBe(false);
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await releaseNumber(NUM, { fetchImpl: boom, env: env() })).toEqual({ ok: false, error: 'network down' });
    expect((await releaseNumber('nope', { env: env() })).ok).toBe(false);
  });
  test('never releases the platform SMS sender number', async () => {
    const f = fake(() => J({}));
    const r = await releaseNumber('+13055550100', { fetchImpl: f.fetchImpl, env: env() });
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/SMS sender/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('elevenlabs deleteAgent / deleteAgentTools', () => {
  const E = (o: Record<string, string> = {}) => ({ ELEVENLABS_API_KEY: 'xi', ...o }) as unknown as NodeJS.ProcessEnv;
  test('mock mode: no key or mock_ id calls nothing', async () => {
    const f = fake(() => J({}));
    expect(await deleteAgent('mock_agent_1', { fetchImpl: f.fetchImpl, env: {} as NodeJS.ProcessEnv })).toEqual({ ok: true, mock: true });
    expect(await deleteAgent('mock_agent_x', { fetchImpl: f.fetchImpl, env: E() })).toEqual({ ok: true, mock: true });
    expect((await deleteTools(f)).mock).toBe(true);
    expect(f.calls).toHaveLength(0);
    // ...but a REAL agent id with no key is an error (never mock success: the agent would be orphaned and the reference dropped)
    const real = await deleteAgent('agent_1', { fetchImpl: f.fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(real.ok).toBe(false);
    expect(real.mock).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    async function deleteTools(x: ReturnType<typeof fake>) { return deleteAgentTools({ fetchImpl: x.fetchImpl, env: {} as NodeJS.ProcessEnv }); }
  });
  test('deletes the agent; 404 is success; failure is reported', async () => {
    const ok = fake(() => new Response(null, { status: 200 }));
    expect(await deleteAgent('agent_1', { fetchImpl: ok.fetchImpl, env: E() })).toEqual({ ok: true, unbound: false });
    expect(ok.calls).toEqual([{ url: 'https://api.elevenlabs.io/v1/convai/agents/agent_1', method: 'DELETE' }]);
    expect(await deleteAgent('agent_1', { fetchImpl: fake(() => J({}, 404)).fetchImpl, env: E() })).toEqual({ ok: true, already_deleted: true, unbound: false });
    const bad = await deleteAgent('agent_1', { fetchImpl: fake(() => J({}, 500)).fetchImpl, env: E() });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('delete 500');
  });
  test('detaches the shared phone number first only when it is assigned to THIS agent', async () => {
    const mine = fake((u, m) => (u.includes('/phone-numbers/') && m === 'GET' ? J({ assigned_agent: { agent_id: 'agent_1' } }) : new Response('{}', { status: 200 })));
    const r = await deleteAgent('agent_1', { fetchImpl: mine.fetchImpl, env: E({ ELEVENLABS_PHONE_NUMBER_ID: 'phnum_1' }) });
    expect(r).toEqual({ ok: true, unbound: true });
    expect(mine.calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'DELETE']);
    const other = fake((u, m) => (u.includes('/phone-numbers/') && m === 'GET' ? J({ assigned_agent: { agent_id: 'agent_2' } }) : new Response('{}', { status: 200 })));
    await deleteAgent('agent_1', { fetchImpl: other.fetchImpl, env: E({ ELEVENLABS_PHONE_NUMBER_ID: 'phnum_1' }) });
    expect(other.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
  });
  test('deleteAgentTools deletes only this app\'s webhook tools; 404 counts as gone', async () => {
    process.env.APP_URL = 'https://app.example.test';
    const tools = [
      { id: 't1', tool_config: { type: 'webhook', api_schema: { url: 'https://app.example.test/api/voice/tools/book_appointment' } } },
      { id: 't2', tool_config: { type: 'webhook', api_schema: { url: 'https://app.example.test/api/voice/tools/flag_emergency' } } },
      { id: 'other', tool_config: { type: 'webhook', api_schema: { url: 'https://elsewhere.test/api/voice/tools/x' } } },
    ];
    const f = fake((u, m) => (m === 'GET' ? J({ tools }) : u.endsWith('/t2') ? J({}, 404) : new Response('{}', { status: 200 })));
    const r = await deleteAgentTools({ fetchImpl: f.fetchImpl, env: E() });
    expect(r).toEqual({ ok: true, deleted: 1, already_deleted: 1 });
    expect(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop())).toEqual(['t1', 't2']);
    const fail = await deleteAgentTools({ fetchImpl: fake((u, m) => (m === 'GET' ? J({ tools }) : J({}, 500))).fetchImpl, env: E() });
    expect(fail.ok).toBe(false);
  });
});

describe('twilio releaseNumber: guards (docs/review/08 F1, F5, F6)', () => {
  test('F5: the platform sender is compared as E.164, whatever the formatting of TWILIO_PHONE_NUMBER', async () => {
    for (const fmt of ['+1 305 777 0100', '13057770100', '(305) 777-0100', '+13057770100']) {
      const f = fake(() => J({ incoming_phone_numbers: [{ sid: 'PN_PLATFORM', phone_number: '+13057770100' }] }));
      const r = await releaseNumber('+13057770100', { fetchImpl: f.fetchImpl, env: env({ TWILIO_PHONE_NUMBER: fmt }) });
      expect(r.ok).toBe(false);
      expect(r.refused).toMatch(/SMS sender/);
      expect(f.calls).toHaveLength(0);
    }
    // an unparseable sender fails closed: nothing can be proven to differ from it
    const garbled = fake(() => J({}));
    expect((await releaseNumber(NUM, { fetchImpl: garbled.fetchImpl, env: env({ TWILIO_PHONE_NUMBER: 'abc' }) })).refused).toBeDefined();
    expect(garbled.calls).toHaveLength(0);
  });

  test('F1: a number another business holds is never released, and a failed holder check refuses too', async () => {
    const f = fake(() => J({ incoming_phone_numbers: [{ sid: 'PN_A', phone_number: NUM }] }));
    const held = await releaseNumberRaw(NUM, { fetchImpl: f.fetchImpl, env: env(), callerBusinessId: 'biz-b', heldByOther: async () => true });
    expect(held.ok).toBe(false);
    expect(held.refused).toMatch(/another business/);
    const broken = await releaseNumberRaw(NUM, { fetchImpl: f.fetchImpl, env: env(), callerBusinessId: 'biz-b', heldByOther: async () => { throw new Error('db down'); } });
    expect(broken.ok).toBe(false);
    expect(broken.refused).toMatch(/could not verify/);
    expect(f.calls).toHaveLength(0);
    // the caller's own row is not a conflict (the holder check receives the caller id)
    let seen: unknown;
    await releaseNumberRaw(NUM, { fetchImpl: f.fetchImpl, env: env(), callerBusinessId: 'biz-b', heldByOther: async (_n, id) => { seen = id; return false; } });
    expect(seen).toBe('biz-b');
  });

  test('F6: half-configured Twilio (or production without Twilio) is an ERROR, never mock success', async () => {
    const halves: Array<Record<string, string>> = [
      { TWILIO_PHONE_NUMBER: '' }, // SID + token but no platform number
      { TWILIO_AUTH_TOKEN: '' },
      { TWILIO_ACCOUNT_SID: '' },
    ];
    for (const e of halves) {
      const f = fake(() => J({}));
      const r = await releaseNumber(NUM, { fetchImpl: f.fetchImpl, env: env(e) });
      expect(r.ok).toBe(false);
      expect(r.mock).toBeUndefined();
      expect(r.error).toMatch(/incomplete/);
      expect(f.calls).toHaveLength(0);
    }
    const prod = await releaseNumber(NUM, { env: { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv });
    expect(prod.ok).toBe(false);
    // mock-pool numbers never existed at Twilio: success even half-configured
    expect(await releaseNumber('+13055551234', { env: env({ TWILIO_PHONE_NUMBER: '' }) })).toEqual({ ok: true, mock: true });
  });
});
