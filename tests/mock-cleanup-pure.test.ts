/**
 * Mock cleanup (docs/review/18f section 4): a 'mock' SMS is never "delivered" in production, DEMO_MODE is inert in production, a bought number
 * carries its SMS/Voice webhooks (and an idempotent repair exists), webhook / tool auth skips need ALLOW_INSECURE_DEV, a failing Stripe is an error
 * unless DEMO_MODE, and the readiness probes tell the truth.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { smsDelivered, SMS_PROVIDER_NOT_CONFIGURED } from '../src/lib/messaging/delivery';
import { configureNumberWebhooks, numberWebhooks, provisionNumber, sendSms } from '../src/lib/providers/twilio';
import { demoModeEnabled } from '../src/lib/auth';
import { verifyElevenLabsSignature, verifyToolSecret } from '../src/lib/voice/elevenlabs';
import { createPaymentLink } from '../src/lib/providers/stripe';
import { readiness } from '../src/lib/http';

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
});
const setEnv = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const E = (o: Record<string, string> = {}) => ({ NODE_ENV: 'test', ...o }) as unknown as NodeJS.ProcessEnv;
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('smsDelivered: a mock is never delivered in production', () => {
  test('sent is delivered; failed and unknown are not; mock only outside production', () => {
    expect(smsDelivered('sent', E())).toBe(true);
    expect(smsDelivered('failed', E())).toBe(false);
    expect(smsDelivered('blocked_cap', E())).toBe(false);
    expect(smsDelivered(undefined, E())).toBe(false);
    expect(smsDelivered('mock', E())).toBe(true);
    expect(smsDelivered('mock', E({ NODE_ENV: 'development' }))).toBe(true);
    expect(smsDelivered('mock', E({ NODE_ENV: 'production' }))).toBe(false);
    expect(smsDelivered('mock', E({ NODE_ENV: 'production', DEMO_MODE: 'true' }))).toBe(false); // even a leaked demo flag
    expect(smsDelivered('sent', E({ NODE_ENV: 'production' }))).toBe(true);
  });

  test('sendSms in production without Twilio FAILS with sms_provider_not_configured (never a mock success); outside production it is a mock', async () => {
    setEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_PHONE_NUMBER: undefined, NODE_ENV: 'production', DEMO_MODE: 'true' });
    const prod = await sendSms('+13055550142', 'hello');
    expect(prod).toEqual({ id: '', status: 'failed', error: SMS_PROVIDER_NOT_CONFIGURED });
    setEnv({ NODE_ENV: 'test', DEMO_MODE: undefined });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      const dev = await sendSms('+13055550142', 'hello');
      expect(dev.status).toBe('mock');
    } finally { console.log = orig; }
    expect(lines.join('\n')).toContain('hello');
  });

  test('production never echoes a text body to the console (no Twilio, DEMO_MODE leaked)', async () => {
    setEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_PHONE_NUMBER: undefined, NODE_ENV: 'production', DEMO_MODE: 'true' });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { await sendSms('+13055550142', 'secret code 123456'); } finally { console.log = orig; }
    expect(lines.join('\n')).not.toContain('123456');
  });
});

describe('demoModeEnabled is inert in production', () => {
  test('DEMO_MODE=true counts only outside production', () => {
    setEnv({ DEMO_MODE: 'true', NODE_ENV: 'production' });
    expect(demoModeEnabled()).toBe(false);
    setEnv({ NODE_ENV: 'development' });
    expect(demoModeEnabled()).toBe(true);
    setEnv({ NODE_ENV: 'test' });
    expect(demoModeEnabled()).toBe(true);
    setEnv({ DEMO_MODE: undefined });
    expect(demoModeEnabled()).toBe(false);
    setEnv({ DEMO_MODE: 'yes' });
    expect(demoModeEnabled()).toBe(false);
  });
});

describe('number webhooks', () => {
  const BASE = { PUBLIC_BASE_URL: 'https://app.example.test/', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_PHONE_NUMBER: '+13055550100' };
  test('SMS URL always; Voice URL only on the webhook line; none without a public base URL', () => {
    expect(numberWebhooks(E({ ...BASE }))).toEqual({
      SmsUrl: 'https://app.example.test/api/sms/inbound', SmsMethod: 'POST',
      VoiceUrl: 'https://app.example.test/api/voice/incoming', VoiceMethod: 'POST',
    });
    expect(numberWebhooks(E({ ...BASE, ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'pn_1' }))).toEqual({ SmsUrl: 'https://app.example.test/api/sms/inbound', SmsMethod: 'POST' });
    expect(numberWebhooks(E({ ...BASE, VOICE_LINE_KIND: 'native' }))).toEqual({ SmsUrl: 'https://app.example.test/api/sms/inbound', SmsMethod: 'POST' });
    expect(numberWebhooks(E({ ...BASE, PUBLIC_BASE_URL: '', APP_URL: 'https://x.example.test' }))?.SmsUrl).toBe('https://x.example.test/api/sms/inbound');
    expect(numberWebhooks(E({ TWILIO_ACCOUNT_SID: 'AC' }))).toBeNull();
  });

  test('a purchase sends SmsUrl (and VoiceUrl on the webhook line) with the number', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const u = String(url);
      if (u.includes('AvailablePhoneNumbers')) return J({ available_phone_numbers: [{ phone_number: '+17864129234' }] });
      if (init?.method === 'POST') { bodies.push(String(init.body)); return J({ phone_number: '+17864129234' }, 201); }
      return J({});
    }) as unknown as typeof fetch;
    const r = await provisionNumber('786', { fetchImpl, env: E(BASE) });
    expect(r).toMatchObject({ ok: true, phone: '+17864129234', mock: false });
    const p = new URLSearchParams(bodies[0]);
    expect(p.get('SmsUrl')).toBe('https://app.example.test/api/sms/inbound');
    expect(p.get('SmsMethod')).toBe('POST');
    expect(p.get('VoiceUrl')).toBe('https://app.example.test/api/voice/incoming');
    bodies.length = 0;
    await provisionNumber('786', { fetchImpl, env: E({ ...BASE, VOICE_LINE_KIND: 'native' }) });
    const n = new URLSearchParams(bodies[0]);
    expect(n.get('SmsUrl')).toBe('https://app.example.test/api/sms/inbound');
    expect(n.get('VoiceUrl')).toBeNull(); // the native line's Voice URL belongs to ElevenLabs
  });

  function twilio(have: Record<string, string | null> | null) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url), ...(init?.body ? { body: String(init.body) } : {}) });
      if (method === 'GET') return J({ incoming_phone_numbers: have ? [{ sid: 'PN1', phone_number: '+17864129234', ...have }] : [] });
      return J({ sid: 'PN1' });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const NATIVE = E({ ...BASE, VOICE_LINE_KIND: 'native' });

  test('repair: dry run reports what would change and writes nothing; a real run updates only differing fields; running again is a no-op', async () => {
    const f = twilio({ sms_url: '', sms_method: 'POST' });
    expect(await configureNumberWebhooks('+17864129234', { dryRun: true, fetchImpl: f.fetchImpl, env: NATIVE })).toEqual({ outcome: 'would_update', changed: ['SmsUrl'] });
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(await configureNumberWebhooks('+17864129234', { fetchImpl: f.fetchImpl, env: NATIVE })).toEqual({ outcome: 'updated', changed: ['SmsUrl'] });
    const post = f.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/IncomingPhoneNumbers/PN1.json');
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({ SmsUrl: 'https://app.example.test/api/sms/inbound' });
    const right = twilio({ sms_url: 'https://app.example.test/api/sms/inbound', sms_method: 'POST' });
    expect(await configureNumberWebhooks('+17864129234', { fetchImpl: right.fetchImpl, env: NATIVE })).toEqual({ outcome: 'ok' });
    expect(right.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('repair: webhook line also fixes the Voice URL; unknown numbers, the platform sender and mock-pool numbers are left alone', async () => {
    const f = twilio({ sms_url: 'https://app.example.test/api/sms/inbound', sms_method: 'POST', voice_url: 'https://demo.twilio.com/welcome', voice_method: 'GET' });
    const r = await configureNumberWebhooks('+17864129234', { fetchImpl: f.fetchImpl, env: E(BASE) });
    expect(r.outcome).toBe('updated');
    expect(r.changed).toEqual(['VoiceUrl', 'VoiceMethod']);
    expect((await configureNumberWebhooks('+17864129234', { fetchImpl: twilio(null).fetchImpl, env: E(BASE) })).outcome).toBe('not_found');
    const calls = twilio({});
    expect((await configureNumberWebhooks('+13055550100', { fetchImpl: calls.fetchImpl, env: E(BASE) })).outcome).toBe('skipped'); // TWILIO_PHONE_NUMBER
    expect((await configureNumberWebhooks('+13055551234', { fetchImpl: calls.fetchImpl, env: E(BASE) })).outcome).toBe('skipped'); // mock pool
    expect((await configureNumberWebhooks('+17864129234', { fetchImpl: calls.fetchImpl, env: E({ TWILIO_ACCOUNT_SID: 'AC' }) })).outcome).toBe('skipped');
    expect(calls.calls).toHaveLength(0);
    expect((await configureNumberWebhooks('+17864129234', { fetchImpl: (async () => J({}, 500)) as unknown as typeof fetch, env: E(BASE) })).outcome).toBe('failed');
  });
});

describe('ElevenLabs webhook / tool auth: a skip needs ALLOW_INSECURE_DEV, not just a non-production NODE_ENV', () => {
  const toolReq = () => new Request('http://app.test/api/voice/tools/x', { method: 'POST' });
  test('no secret: refused unless the explicit dev opt-in is on (and never in production)', () => {
    setEnv({ ELEVENLABS_WEBHOOK_SECRET: undefined, ELEVENLABS_TOOL_SECRET: undefined, ALLOW_INSECURE_DEV: undefined, NODE_ENV: 'development' });
    expect(verifyElevenLabsSignature('{}', null)).toMatchObject({ ok: false });
    expect(verifyToolSecret(toolReq())).toMatchObject({ ok: false });
    setEnv({ ALLOW_INSECURE_DEV: 'true' });
    expect(verifyElevenLabsSignature('{}', null)).toEqual({ ok: true, skipped: true });
    expect(verifyToolSecret(toolReq())).toEqual({ ok: true, skipped: true });
    setEnv({ NODE_ENV: 'production' });
    expect(verifyElevenLabsSignature('{}', null)).toMatchObject({ ok: false });
    expect(verifyToolSecret(toolReq())).toMatchObject({ ok: false });
  });
});

describe('a failing Stripe is an error unless DEMO_MODE', () => {
  test('non-production + real key + Stripe error: throws; with DEMO_MODE it falls back to the mock checkout; never in production', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => J({ error: { message: 'boom' } }, 500)) as unknown as typeof fetch;
    try {
      setEnv({ STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'development', DEMO_MODE: undefined, APP_URL: 'https://app.example.test' });
      await expect(createPaymentLink(5000, 'deposit')).rejects.toThrow('boom');
      setEnv({ DEMO_MODE: 'true' });
      expect(await createPaymentLink(5000, 'deposit')).toMatchObject({ mock: true });
      setEnv({ NODE_ENV: 'production' });
      await expect(createPaymentLink(5000, 'deposit')).rejects.toThrow('boom');
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('readiness probes', () => {
  test('200 when ready, 503 when not; never a bare "ready: true"', async () => {
    const ok = readiness(true, { accepts: ['application/json'] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, data: { ready: true, accepts: ['application/json'] } });
    const no = readiness(false);
    expect(no.status).toBe(503);
    expect(await no.json()).toEqual({ ok: false, data: { ready: false } });
  });
  test('each webhook GET reports whether its secret is configured', async () => {
    const { GET: incoming } = await import('../src/app/api/voice/incoming/route');
    const { GET: postCall } = await import('../src/app/api/voice/post-call/route');
    const { GET: webhook } = await import('../src/app/api/voice/webhook/route');
    const { GET: initiation } = await import('../src/app/api/voice/initiation/route');
    setEnv({ TWILIO_AUTH_TOKEN: undefined, ELEVENLABS_WEBHOOK_SECRET: undefined, ELEVENLABS_TOOL_SECRET: undefined, ALLOW_INSECURE_DEV: undefined });
    for (const g of [incoming, postCall, webhook, initiation]) expect((await g()).status).toBe(503);
    setEnv({ TWILIO_AUTH_TOKEN: 't', ELEVENLABS_WEBHOOK_SECRET: 's', ELEVENLABS_TOOL_SECRET: 'x' });
    for (const g of [incoming, postCall, webhook, initiation]) expect((await g()).status).toBe(200);
  });
});
