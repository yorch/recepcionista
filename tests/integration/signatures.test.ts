/**
 * Provider webhook authentication: Twilio (/api/voice/incoming) and ElevenLabs (/api/voice/post-call),
 * including every post-call payload shape.
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_DISCLOSURE } from '../../src/lib/kb/disclosure';
import {
  cleanup, elevenLabsSignature, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq,
} from '../helpers/fixtures';

integration('provider webhook signatures (postgres)', () => {
  let incoming: (req: Request) => Promise<Response>;
  let postCall: (req: Request) => Promise<Response>;
  let legacyWebhook: (req: Request) => Promise<Response>;
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
    postCall = (await import('@/app/api/voice/post-call/route')).POST;
    legacyWebhook = (await import('@/app/api/voice/webhook/route')).POST;
  });
  afterAll(cleanup);

  // ------------------------------------------------------------------ Twilio

  const INCOMING_URL = `${SECRETS.publicBase}/api/voice/incoming`;

  function twilioPost(params: Record<string, string>, sig: string | null, url = INCOMING_URL) {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (sig) headers['x-twilio-signature'] = sig;
    return incoming(new Request(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() }));
  }
  const twilioParams = (to: string, from = phone()) => ({
    AccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ApiVersion: '2010-04-01', CallSid: uniq('CA'),
    CallStatus: 'ringing', Called: to, Caller: from, Direction: 'inbound', From: from, To: to,
  });

  test('Twilio: a correctly signed call is routed to the business that owns the number', async () => {
    const biz = await newBusiness();
    const params = twilioParams(biz.phone!);
    const res = await twilioPost(params, twilioSignature(INCOMING_URL, params));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { business_id: string; call_id: string; caller_phone: string; mock: boolean } };
    expect(body.data).toMatchObject({ business_id: biz.id, caller_phone: params.From, mock: true });
    const call = await db.getCall(body.data.call_id);
    expect(call).toMatchObject({ business_id: biz.id, caller_phone: params.From, status: 'in_progress' });
    expect(outboundCalls).toEqual([]);
  });

  test('Twilio: invalid token, tampered params, wrong URL and missing header are all 403 and create no call', async () => {
    const biz = await newBusiness();
    const params = twilioParams(biz.phone!);
    const good = twilioSignature(INCOMING_URL, params);
    const before = await prisma.call.count({ where: { businessId: biz.id } });

    const cases: Record<string, Response> = {
      'missing header': await twilioPost(params, null),
      'garbage signature': await twilioPost(params, 'AAAA'),
      'signed with another token': await twilioPost(params, twilioSignature(INCOMING_URL, params, 'someone-elses-token')),
      'tampered From': await twilioPost({ ...params, From: '+13055550000' }, good),
      'extra param added': await twilioPost({ ...params, Extra: '1' }, good),
      'signed for another path': await twilioPost(params, twilioSignature(`${SECRETS.publicBase}/api/voice/webhook`, params)),
      'signed for another host': await twilioPost(params, twilioSignature('https://evil.example/api/voice/incoming', params)),
      'http instead of https': await twilioPost(params, twilioSignature('http://app.example.test/api/voice/incoming', params)),
      'query string not signed': await twilioPost(params, good, `${INCOMING_URL}?x=1`),
    };
    for (const [name, res] of Object.entries(cases)) expect([name, res.status]).toEqual([name, 403]);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(before);
  });

  test('Twilio: the signature is also accepted over the request URL when no public base URL is configured', async () => {
    const biz = await newBusiness();
    const params = twilioParams(biz.phone!);
    const direct = 'http://localhost:3000/api/voice/incoming';
    await withEnv({ PUBLIC_BASE_URL: undefined }, async () => {
      expect((await twilioPost(params, twilioSignature(direct, params), direct)).status).toBe(200);
      expect((await twilioPost(params, twilioSignature(INCOMING_URL, params), direct)).status).toBe(403);
    });
  });

  test('Twilio: with no auth token configured the route fails closed (403)', async () => {
    const biz = await newBusiness();
    const params = twilioParams(biz.phone!);
    await withEnv({ TWILIO_AUTH_TOKEN: undefined }, async () => {
      expect((await twilioPost(params, twilioSignature(INCOMING_URL, params))).status).toBe(403);
      expect((await twilioPost(params, null)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------- ElevenLabs

  function elPost(
    body: string, sig: string | null | undefined, path: 'post-call' | 'webhook' = 'post-call',
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const header = sig === undefined ? elevenLabsSignature(body) : sig;
    if (header) headers['elevenlabs-signature'] = header;
    const req = new Request(`${SECRETS.publicBase}/api/voice/${path}`, { method: 'POST', headers, body });
    return (path === 'post-call' ? postCall : legacyWebhook)(req);
  }
  const resJson = async (res: Response) => (await res.json()) as { ok: boolean; data?: { call?: Record<string, unknown> | null; ignored?: string }; error?: string };
  const envelope = (agentId: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => JSON.stringify({
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: agentId,
      conversation_id: uniq('conv'),
      status: 'done',
      transcript: [
        { role: 'agent', message: `${DEFAULT_DISCLOSURE} — Thanks for calling, how can I help?`, time_in_call_secs: 0 },
        { role: 'user', message: 'My AC is leaking water into the hallway.', time_in_call_secs: 4 },
      ],
      metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 120, call_duration_secs: 95, main_language: 'en' },
      analysis: { transcript_summary: 'Caller reports an AC leak; booking requested.', call_successful: 'success' },
      ...data,
    },
    ...extra,
  });

  test('ElevenLabs: valid signature, real envelope shape -> transcript stored on the right tenant', async () => {
    const biz = await newBusiness();
    const raw = envelope(biz.agent_id!);
    const res = await elPost(raw, undefined);
    expect(res.status).toBe(200);
    const call = (await resJson(res)).data!.call!;
    expect(call).toMatchObject({
      business_id: biz.id, status: 'completed', duration_sec: 95, language: 'en', urgency: 'emergency',
      summary: 'Caller reports an AC leak; booking requested.',
    });
    expect(String(call.transcript)).toContain('Thanks for calling');
    expect(String(call.transcript)).toContain('user: My AC is leaking');
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
    expect(outboundCalls).toEqual([]);
  });

  test('ElevenLabs: the legacy /api/voice/webhook alias enforces the same signature', async () => {
    const biz = await newBusiness();
    const raw = envelope(biz.agent_id!);
    expect((await elPost(raw, 'garbage', 'webhook')).status).toBe(401);
    expect((await elPost(raw, undefined, 'webhook')).status).toBe(200);
  });

  test('ElevenLabs: stale and future timestamps, tampered body, wrong secret and missing header are 401', async () => {
    const biz = await newBusiness();
    const raw = envelope(biz.agent_id!);
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, Response> = {
      'missing header': await elPost(raw, null),
      'garbage header': await elPost(raw, 'v0=abc'),
      'stale (1h old)': await elPost(raw, elevenLabsSignature(raw, { t: now - 3600 })),
      'future (1h ahead)': await elPost(raw, elevenLabsSignature(raw, { t: now + 3600 })),
      'wrong secret': await elPost(raw, elevenLabsSignature(raw, { secret: 'not-the-secret' })),
      'tampered body': await elPost(raw.replace('leaking', 'dripping'), elevenLabsSignature(raw)),
      'signed body, header from a v1 scheme': await elPost(raw, elevenLabsSignature(raw).replace('v0=', 'v1=')),
    };
    for (const [name, res] of Object.entries(cases)) expect([name, res.status]).toEqual([name, 401]);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);
    // within tolerance (5 minutes old) is fine
    expect((await elPost(raw, elevenLabsSignature(raw, { t: now - 300 }))).status).toBe(200);
  });

  test('ElevenLabs: no webhook secret configured fails closed', async () => {
    const biz = await newBusiness();
    const raw = envelope(biz.agent_id!);
    await withEnv({ ELEVENLABS_WEBHOOK_SECRET: undefined }, async () => {
      expect((await elPost(raw, elevenLabsSignature(raw))).status).toBe(401);
      expect((await elPost(raw, null)).status).toBe(401);
    });
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);
  });

  test('post-call shapes: legacy flat body with call_id, string transcript, duration_sec', async () => {
    const biz = await newBusiness();
    const live = await db.createCall({ business_id: biz.id, caller_phone: phone(), consent_status: 'disclosed', recording_disclosed: true });
    const raw = JSON.stringify({
      call_id: live.id, agent_id: biz.agent_id, transcript: 'Caller: hola, mi aire no enfría. Agent: Le mando un técnico mañana.',
      duration_sec: 61, language: 'es-MX', recording_url: 'https://audio.example.test/r.mp3',
    });
    const res = await elPost(raw, undefined);
    expect(res.status).toBe(200);
    const call = (await resJson(res)).data!.call!;
    expect(call).toMatchObject({ id: live.id, duration_sec: 61, language: 'es', recording_url: 'https://audio.example.test/r.mp3', status: 'completed' });
    expect(String(call.summary)).toBeTruthy(); // fallback summary: no LLM key -> deterministic text
    expect(outboundCalls).toEqual([]);
  });

  test('post-call shapes: a tool-created call keyed by conversation id is completed, not duplicated', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    const live = await db.createCall({ business_id: biz.id, conversation_id: conv, status: 'handed_off' });
    const res = await elPost(envelope(biz.agent_id!, {}, { conversation_id: conv }), undefined);
    expect(res.status).toBe(200);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
    expect((await resJson(res)).data!.call).toMatchObject({ id: live.id, status: 'handed_off' }); // handoff status is preserved
  });

  test('post-call shapes: dynamic-variable business id, audio events, unattachable payloads', async () => {
    const biz = await newBusiness();
    // no agent mapping: falls back to the platform-set dynamic variable
    const dyn = envelope('agent_unmapped', {}, {
      conversation_initiation_client_data: { dynamic_variables: { business_id: biz.id } },
    });
    expect((await elPost(dyn, undefined)).status).toBe(200);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);

    // audio / failure events carry no transcript: acknowledged and ignored
    const audio = JSON.stringify({ type: 'post_call_audio', data: { agent_id: biz.agent_id, conversation_id: uniq('c'), full_audio: 'AAAA' } });
    const ignored = await resJson(await elPost(audio, undefined));
    expect(ignored.data).toEqual({ ignored: 'post_call_audio' });
    const failure = JSON.stringify({ type: 'call_initiation_failure', data: { agent_id: biz.agent_id } });
    expect((await resJson(await elPost(failure, undefined))).data).toEqual({ ignored: 'call_initiation_failure' });

    // an unknown agent with no other hint cannot be attached to any tenant
    const unknown = await elPost(envelope('agent_nobody_owns'), undefined);
    expect(unknown.status).toBe(400);
    // empty / non-JSON bodies are treated the same way (validly signed, nothing to attach)
    expect((await elPost('', undefined)).status).toBe(400);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
  });

  test('post-call: a call_id belonging to another business is never updated', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const victim = await db.createCall({ business_id: b.id, caller_phone: phone() });
    const raw = envelope(a.agent_id!, {}, { call_id: victim.id });
    expect((await elPost(raw, undefined)).status).toBe(200);
    expect((await db.getCall(victim.id))?.transcript).toBeNull();
    expect(await prisma.call.count({ where: { businessId: a.id } })).toBe(1);
  });

  test('post-call: replaying the same conversation id is ignored', async () => {
    const biz = await newBusiness();
    const raw = envelope(biz.agent_id!);
    expect((await elPost(raw, undefined)).status).toBe(200);
    const replay = await resJson(await elPost(raw, undefined));
    expect(replay.data).toEqual({ ignored: 'duplicate' });
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
  });
});
