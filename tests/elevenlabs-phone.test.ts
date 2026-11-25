/** voice/elevenlabs-phone.ts (the ONLY module that knows the provider's phone-number shapes), assistant name, per-business transfer gating. No network, no database. */
import { describe, expect, test } from 'bun:test';
import { deleteRemoteNumber, getRemoteNumber, importTwilioNumber, listRemoteNumbers, parseRemoteNumber, registerTwilioCall, setNumberAgent } from '../src/lib/voice/elevenlabs-phone';
import { assistantNameOf, cleanAssistantName, DEFAULT_ASSISTANT_NAME } from '../src/lib/voice/assistant-name';
import { forwardingSupported, lineKind, lineKindFor, tenantLinesDefault } from '../src/lib/voice/line';
import { transferEnabledFor } from '../src/lib/voice/transfer';
import { lineApplicable } from '../src/lib/voice/tenant-line';
import { lineNoticeTwiml } from '../src/lib/voice/twiml';

const ENV = { ELEVENLABS_API_KEY: 'xi-key', TWILIO_ACCOUNT_SID: 'ACabc', TWILIO_AUTH_TOKEN: 'tw-secret-token', TWILIO_PHONE_NUMBER: '+13055550100' } as unknown as NodeJS.ProcessEnv;
type Call = { method: string; path: string; body: Record<string, unknown> | null };

function fake(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const c: Call = { method: init?.method ?? 'GET', path: String(url).replace('https://api.elevenlabs.io/v1', ''), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('parseRemoteNumber is tolerant of the unverified shape', () => {
  test('reads id/phone/agent under the plausible field names, rejects junk', () => {
    expect(parseRemoteNumber({ phone_number_id: 'phnum_1', phone_number: '+13055550001', assigned_agent: { agent_id: 'a1' } })).toEqual({ phone_number_id: 'phnum_1', phone_number: '+13055550001', agent_id: 'a1' });
    expect(parseRemoteNumber({ id: 'phnum_2', agent_id: 'a2' })).toEqual({ phone_number_id: 'phnum_2', phone_number: null, agent_id: 'a2' });
    expect(parseRemoteNumber({ phone_number_id: 'phnum_3', assigned_agent: null })?.agent_id).toBeNull();
    for (const bad of [null, undefined, 'x', 3, {}, { phone_number: '+1' }]) expect(parseRemoteNumber(bad)).toBeNull();
  });
});

describe('importTwilioNumber', () => {
  test('imports once with the documented body; the Twilio token is only in that body and never in a result or error', async () => {
    const f = fake((c) => (c.method === 'GET' ? Response.json([]) : Response.json({ phone_number_id: 'phnum_new' })));
    const r = await importTwilioNumber({ phone: '+13055550111', label: 'Cool Air' }, { env: ENV, fetchImpl: f.fetchImpl });
    expect(r).toEqual({ ok: true, phone_number_id: 'phnum_new', adopted: false });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/convai/phone-numbers');
    expect(post.body).toMatchObject({ provider: 'twilio', phone_number: '+13055550111', label: 'Cool Air', sid: 'ACabc', token: 'tw-secret-token' });
    expect(JSON.stringify(r)).not.toContain('tw-secret-token');
  });

  test('a number already imported is ADOPTED (no second import) unless another account owns that id', async () => {
    const f = fake(() => Response.json([{ phone_number_id: 'phnum_x', phone_number: '+13055550111' }]));
    expect(await importTwilioNumber({ phone: '+13055550111', label: 'a' }, { env: ENV, fetchImpl: f.fetchImpl })).toEqual({ ok: true, phone_number_id: 'phnum_x', adopted: true });
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    const owned = await importTwilioNumber({ phone: '+13055550111', label: 'a', isOwnedElsewhere: async () => true }, { env: ENV, fetchImpl: f.fetchImpl });
    expect(owned).toMatchObject({ ok: false, status: 409, retryable: false });
    const throwing = await importTwilioNumber({ phone: '+13055550111', label: 'a', isOwnedElsewhere: async () => { throw new Error('db down'); } }, { env: ENV, fetchImpl: f.fetchImpl });
    expect(throwing).toMatchObject({ ok: false }); // unknown ownership fails closed
  });

  test('graceful, secret-free errors: missing key / Twilio creds / bad number / 4xx / 5xx / unreadable answer / network', async () => {
    expect(await importTwilioNumber({ phone: '+13055550111', label: 'a' }, { env: { ...ENV, ELEVENLABS_API_KEY: '' } as NodeJS.ProcessEnv })).toMatchObject({ ok: false, error: expect.stringContaining('ELEVENLABS_API_KEY') });
    expect(await importTwilioNumber({ phone: '+13055550111', label: 'a' }, { env: { ...ENV, TWILIO_AUTH_TOKEN: '' } as NodeJS.ProcessEnv })).toMatchObject({ ok: false, error: expect.stringContaining('Twilio credentials') });
    expect(await importTwilioNumber({ phone: '3055550111', label: 'a' }, { env: ENV })).toMatchObject({ ok: false, error: 'not an E.164 number' });
    const cases: [Response | 'throw', RegExp, boolean][] = [
      [new Response('{"detail":"token tw-secret-token rejected"}', { status: 422 }), /import phone number 422/, false],
      [new Response('x', { status: 503 }), /import phone number 503/, true],
      [Response.json({}), /no phone_number_id/, true],
      ['throw', /network error/, true],
    ];
    for (const [answer, msg, retryable] of cases) {
      const f = fake((c) => { if (c.method === 'GET') return Response.json([]); if (answer === 'throw') throw new Error('socket tw-secret-token'); return answer; });
      const r = await importTwilioNumber({ phone: '+13055550111', label: 'a' }, { env: ENV, fetchImpl: f.fetchImpl });
      expect(r).toMatchObject({ ok: false, retryable });
      expect((r as { error: string }).error).toMatch(msg);
      expect(JSON.stringify(r)).not.toContain('tw-secret-token'); // the provider's echo of the token never reaches the caller
    }
  });
});

describe('list / get / bind / delete', () => {
  test('list accepts an array or {phone_numbers}; anything else is an error, not an empty list', async () => {
    expect(await listRemoteNumbers({ env: ENV, fetchImpl: fake(() => Response.json({ phone_numbers: [{ phone_number_id: 'p1', phone_number: '+1' }] })).fetchImpl })).toMatchObject({ ok: true, numbers: [{ phone_number_id: 'p1' }] });
    expect(await listRemoteNumbers({ env: ENV, fetchImpl: fake(() => Response.json({ weird: 1 })).fetchImpl })).toMatchObject({ ok: false });
    expect(await listRemoteNumbers({ env: ENV, fetchImpl: fake(() => new Response('', { status: 401 })).fetchImpl })).toMatchObject({ ok: false, status: 401, retryable: false });
  });
  test('get: 404 is a clean "not there"', async () => {
    expect(await getRemoteNumber('phnum_gone', { env: ENV, fetchImpl: fake(() => new Response('', { status: 404 })).fetchImpl })).toEqual({ ok: true, number: null });
  });
  test('bind PATCHes THAT id with the agent (and null detaches); ids are URL-encoded', async () => {
    const f = fake(() => Response.json({}));
    expect(await setNumberAgent('phnum_1', 'agent_1', { env: ENV, fetchImpl: f.fetchImpl })).toMatchObject({ ok: true });
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', path: '/convai/phone-numbers/phnum_1', body: { agent_id: 'agent_1' } });
    await setNumberAgent('a/b', null, { env: ENV, fetchImpl: f.fetchImpl });
    expect(f.calls[1].path).toBe('/convai/phone-numbers/a%2Fb');
    expect(f.calls[1].body).toEqual({ agent_id: null });
    expect(await setNumberAgent('phnum_1', 'agent_1', { env: ENV, fetchImpl: fake(() => new Response('', { status: 500 })).fetchImpl })).toMatchObject({ ok: false, retryable: true });
  });
  test('delete detaches then deletes; 404 is success; a failure is reported', async () => {
    const f = fake((c) => (c.method === 'DELETE' ? new Response('', { status: 404 }) : Response.json({})));
    expect(await deleteRemoteNumber('phnum_1', { env: ENV, fetchImpl: f.fetchImpl })).toEqual({ ok: true, already_deleted: true });
    expect(f.calls.map((c) => c.method)).toEqual(['PATCH', 'DELETE']);
    expect(await deleteRemoteNumber('phnum_1', { env: ENV, fetchImpl: fake((c) => (c.method === 'DELETE' ? new Response('', { status: 500 }) : Response.json({}))).fetchImpl })).toMatchObject({ ok: false });
    expect(await deleteRemoteNumber('phnum_1', { env: { ...ENV, ELEVENLABS_API_KEY: '' } as NodeJS.ProcessEnv })).toMatchObject({ ok: false });
  });
});

describe('registerTwilioCall (webhook-line AI answer)', () => {
  const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x"/></Connect></Response>';
  test('returns provider TwiML only when it really is a <Response> document; sends the agent and numbers', async () => {
    const f = fake(() => new Response(TWIML));
    const r = await registerTwilioCall({ agentId: 'agent_1', from: '+13055550001', to: '+13055550002', dynamicVariables: { business_id: 'b1' } }, { env: ENV, fetchImpl: f.fetchImpl });
    expect(r).toEqual({ ok: true, twiml: TWIML });
    expect(f.calls[0]).toMatchObject({ path: '/convai/twilio/register-call', body: { agent_id: 'agent_1', from_number: '+13055550001', to_number: '+13055550002', direction: 'inbound', conversation_initiation_client_data: { dynamic_variables: { business_id: 'b1' } } } });
    for (const bad of ['{"detail":"x"}', '<html>oops</html>', '<Response>cut off']) {
      expect(await registerTwilioCall({ agentId: 'agent_1', from: 'a', to: 'b' }, { env: ENV, fetchImpl: fake(() => new Response(bad)).fetchImpl })).toMatchObject({ ok: false });
    }
    expect(await registerTwilioCall({ agentId: 'mock_agent_x', from: 'a', to: 'b' }, { env: ENV })).toMatchObject({ ok: false });
    expect(await registerTwilioCall({ agentId: 'a', from: 'a', to: 'b' }, { env: ENV, fetchImpl: fake(() => new Response('', { status: 500 })).fetchImpl })).toMatchObject({ ok: false, retryable: true });
  });
});

describe('assistant name', () => {
  test('default Maria; owner value used; cleaned of line breaks, quotes and braces (it lands inside a prompt)', () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe('Maria');
    expect(assistantNameOf({})).toBe('Maria');
    expect(assistantNameOf({ assistant_name: null })).toBe('Maria');
    expect(assistantNameOf({ assistant_name: '   ' })).toBe('Maria');
    expect(assistantNameOf({ assistant_name: 'Sofía' })).toBe('Sofía');
    expect(cleanAssistantName('Ana\n{{x}} "quoted" <b>')).toBe('Ana x quoted b');
    expect(cleanAssistantName('x'.repeat(100))).toHaveLength(40);
    expect(cleanAssistantName(null)).toBeNull();
  });
});

describe('line kind and per-business transfer gating (pure)', () => {
  test('tenant lines make a keyed deployment native unless switched off; a tenant with its own number is always native', () => {
    expect(tenantLinesDefault({ ELEVENLABS_API_KEY: 'k' })).toBe(true);
    expect(tenantLinesDefault({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_TENANT_LINES: 'off' })).toBe(false);
    expect(tenantLinesDefault({})).toBe(false);
    expect(lineKind({ ELEVENLABS_API_KEY: 'k', VOICE_LINE_KIND: 'webhook' })).toBe('webhook'); // explicit webhook (register-call) deployments stay webhook
    expect(lineKindFor({ elevenlabs_phone_number_id: 'phnum_1' }, { VOICE_LINE_KIND: 'webhook' })).toBe('native');
    expect(lineKindFor({ elevenlabs_phone_number_id: null }, { VOICE_LINE_KIND: 'webhook' })).toBe('webhook');
  });
  test('forwarding on the native line needs the capability AND the business opt-in; a webhook line always can', () => {
    const on = { NATIVE_TRANSFER: 'on' };
    expect(forwardingSupported('webhook', {}, { native_transfer_enabled: false })).toBe(true);
    expect(forwardingSupported('native', {}, { native_transfer_enabled: true })).toBe(false); // capability off
    expect(forwardingSupported('native', on, { native_transfer_enabled: false })).toBe(false);
    expect(forwardingSupported('native', on, { native_transfer_enabled: true })).toBe(true);
    expect(forwardingSupported('native', on)).toBe(true); // unknown business: the global answer
    expect(transferEnabledFor({ native_transfer_enabled: true }, {})).toBe(false);
    expect(transferEnabledFor({ native_transfer_enabled: false }, on)).toBe(false);
    expect(transferEnabledFor(null, on)).toBe(false);
    expect(transferEnabledFor({ native_transfer_enabled: true }, on)).toBe(true);
  });
  test('lineApplicable: only a real Twilio number with a real agent; never mock-pool or the platform sender', () => {
    const env = { TWILIO_PHONE_NUMBER: '+13055550100' } as unknown as NodeJS.ProcessEnv;
    expect(lineApplicable({ phone: '+17864129234', agent_id: 'agent_1' }, env)).toEqual({ ok: true, e164: '+17864129234' });
    expect(lineApplicable({ phone: '+13055550142', agent_id: 'agent_1' }, env)).toMatchObject({ ok: false }); // mock pool (555)
    expect(lineApplicable({ phone: '+13055550100', agent_id: 'agent_1' }, env)).toMatchObject({ ok: false }); // platform sender
    expect(lineApplicable({ phone: '+17864129234', agent_id: 'mock_agent_1' }, env)).toMatchObject({ ok: false });
    expect(lineApplicable({ phone: null, agent_id: 'agent_1' }, env)).toMatchObject({ ok: false });
  });
});

describe('webhook-line notices are valid TwiML', () => {
  test('owner and ai notices: a <Say> in both languages and a hangup, nothing recorded', () => {
    for (const kind of ['owner', 'ai'] as const) {
      const x = lineNoticeTwiml(kind);
      expect(x).toStartWith('<?xml');
      expect(x).toContain('<Response>');
      expect(x).toContain('language="en-US"');
      expect(x).toContain('language="es-MX"');
      expect(x).toContain('<Hangup/>');
      expect(x).not.toContain('<Record');
    }
  });
});
