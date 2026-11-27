/**
 * Admin console, providers and secrets (agent B): the connection tests against a fake transport (coarse results only, hard-coded provider hosts, SMTP under the SSRF rules,
 * no credential or remote text in any result), the test-before-save verifier, the live self-test cache, the follow-up arithmetic, the batch loop and the page model.
 * No database, no network: every request goes to the injected fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allSettings, settingDef } from '../src/lib/config/registry';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import {
  candidateOf, clearLiveCache, liveSelftest, providerWriteChecks, secretVerifier, setProviderTestDeps, stripeOrphanRisk, testProvider, verificationEnabled, type TestDeps,
} from '../src/lib/admin/provider-tests';
import { CARDS, PAIRS, SECRET_TEST, WEBHOOKS, pendingFollowUps, secretFormatOk, webhookUrl, windowOpenUntil } from '../src/lib/admin/provider-meta';
import { canSaveSecret, cardStatus, estimatePercent, hintKeyOf, isPartnerField, labelKeyOf, orphanRisk, runBatches, testsFor, type BatchPage } from '../src/lib/admin/provider-ui';

const ALLOWED_HOSTS = new Set([
  'api.twilio.com', 'messaging.twilio.com', 'api.elevenlabs.io', 'api.stripe.com', 'api.openai.com', 'api.anthropic.com', 'api.resend.com', 'oauth2.googleapis.com', 'challenges.cloudflare.com',
]);

interface Call { url: string; init: RequestInit }
function fake(routes: Array<[RegExp, number | (() => Response | Promise<Response>), unknown?]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    for (const [re, status, body] of routes) {
      if (!re.test(u)) continue;
      if (typeof status === 'function') return status();
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 599 });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetch: fetchImpl, timeoutMs: 500, countCustomers: async () => 3 } satisfies TestDeps };
}

const SID = `AC${'a'.repeat(32)}`;
const MG = `MG${'b'.repeat(32)}`;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const ENVS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'ELEVENLABS_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_PRICE_ID_ANNUAL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LLM_MODEL', 'ANTHROPIC_MODEL',
  'RESEND_API_KEY', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'SMTP_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'];
beforeEach(() => { for (const k of ENVS) setEnv(k, undefined); clearLiveCache(); setProviderTestDeps(null); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } setProviderTestDeps(null); });

const BANNER = 'REMOTE-BANNER-MUST-NOT-LEAK';
const TOKEN = 'tok_' + 'z'.repeat(30);
const noLeak = (r: unknown, ...secrets: string[]) => { const s = JSON.stringify(r); expect(s).not.toContain(BANNER); for (const x of secrets) expect(s).not.toContain(x); };

describe('twilio', () => {
  test('ok: GET /Accounts/{sid}.json with basic auth on the hard-coded host; the candidate is used, nothing leaks', async () => {
    const f = fake([[/api\.twilio\.com\/2010-04-01\/Accounts\/AC.*\.json$/, 200, { status: 'active', note: BANNER }]]);
    const r = await testProvider('twilio', { candidate: { 'twilio.account_sid': SID, 'twilio.auth_token': TOKEN }, deps: f.deps });
    expect(r.outcome).toBe('ok');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(f.calls[0].init.redirect).toBe('manual');
    expect(f.calls[0].init.signal).toBeDefined();
    noLeak(r, TOKEN, SID);
  });
  test('401 and 404 are auth_failed; 500 and a network error are unreachable; a suspended account is misconfigured', async () => {
    const c = { 'twilio.account_sid': SID, 'twilio.auth_token': TOKEN };
    expect((await testProvider('twilio', { candidate: c, deps: fake([[/./, 401, { message: BANNER }]]).deps })).outcome).toBe('auth_failed');
    expect((await testProvider('twilio', { candidate: c, deps: fake([[/./, 404]]).deps })).outcome).toBe('auth_failed');
    expect((await testProvider('twilio', { candidate: c, deps: fake([[/./, 503, { message: BANNER }]]).deps })).outcome).toBe('unreachable');
    expect((await testProvider('twilio', { candidate: c, deps: fake([[/./, () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); }]]).deps })).outcome).toBe('unreachable');
    const susp = await testProvider('twilio', { candidate: c, deps: fake([[/./, 200, { status: 'suspended' }]]).deps });
    expect(susp.outcome).toBe('misconfigured');
    noLeak(susp, TOKEN);
  });
  test('a malformed account sid is misconfigured without a request', async () => {
    const f = fake([[/./, 200]]);
    expect((await testProvider('twilio', { candidate: { 'twilio.account_sid': 'nope', 'twilio.auth_token': TOKEN }, deps: f.deps })).outcome).toBe('misconfigured');
    expect(f.calls).toHaveLength(0);
  });
  test('the Messaging Service is checked too: found ok, not found misconfigured', async () => {
    const c = { 'twilio.account_sid': SID, 'twilio.auth_token': TOKEN, 'twilio.messaging_service_sid': MG };
    const good = await testProvider('twilio', { candidate: c, deps: fake([[/messaging\.twilio\.com\/v1\/Services\/MG/, 200], [/api\.twilio\.com/, 200, { status: 'active' }]]).deps });
    expect(good.outcome).toBe('ok');
    expect(good.checks).toEqual({ account: 'ok', messaging_service: 'ok' });
    const bad = await testProvider('twilio', { candidate: c, deps: fake([[/messaging\.twilio\.com/, 404], [/api\.twilio\.com/, 200, { status: 'active' }]]).deps });
    expect(bad.outcome).toBe('misconfigured');
    expect(bad.checks?.messaging_service).toBe('not_found');
  });
});

describe('elevenlabs, llm, resend, google, turnstile', () => {
  test('elevenlabs GET /v1/user: ok, 401 auth_failed, a scoped key without user_read is misconfigured', async () => {
    const c = { 'elevenlabs.api_key': 'xi_' + 'k'.repeat(30) };
    const f = fake([[/api\.elevenlabs\.io\/v1\/user$/, 200, { subscription: BANNER }]]);
    expect((await testProvider('elevenlabs', { candidate: c, deps: f.deps })).outcome).toBe('ok');
    expect((f.calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe(c['elevenlabs.api_key']);
    expect((await testProvider('elevenlabs', { candidate: c, deps: fake([[/./, 401, { detail: { status: 'invalid_api_key' } }]]).deps })).outcome).toBe('auth_failed');
    expect((await testProvider('elevenlabs', { candidate: c, deps: fake([[/./, 401, { detail: { status: 'missing_permissions' } }]]).deps })).outcome).toBe('misconfigured');
  });
  test('openai models list, then the configured model must exist', async () => {
    const c = { 'llm.openai_api_key': 'sk-' + 'o'.repeat(30), 'llm.openai_model': 'gpt-test-1' };
    const ok = await testProvider('openai', { candidate: c, deps: fake([[/api\.openai\.com\/v1\/models$/, 200, { data: [{ id: 'gpt-test-1' }, { id: 'other' }] }]]).deps });
    expect(ok.outcome).toBe('ok');
    const missing = await testProvider('openai', { candidate: c, deps: fake([[/./, 200, { data: [{ id: 'other' }] }]]).deps });
    expect(missing.outcome).toBe('misconfigured');
    expect(missing.checks?.model).toBe('not_found');
    expect((await testProvider('openai', { candidate: c, deps: fake([[/./, 401]]).deps })).outcome).toBe('auth_failed');
  });
  test('anthropic models list uses x-api-key and the version header', async () => {
    const f = fake([[/api\.anthropic\.com\/v1\/models/, 200, { data: [{ id: 'claude-sonnet-4-5' }] }]]);
    const r = await testProvider('anthropic', { candidate: { 'llm.anthropic_api_key': 'sk-ant-' + 'a'.repeat(30), 'llm.anthropic_model': 'claude-sonnet-4-5' }, deps: f.deps });
    expect(r.outcome).toBe('ok');
    expect((f.calls[0].init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });
  test('resend: domains list; the sender domain must be verified; a send-only key is valid', async () => {
    const c = { 'email.resend_api_key': 're_' + 'r'.repeat(24), 'email.from': 'Console <no-reply@mail.example.test>' };
    const ok = await testProvider('resend', { candidate: c, deps: fake([[/api\.resend\.com\/domains$/, 200, { data: [{ name: 'mail.example.test', status: 'verified' }] }]]).deps });
    expect(ok.outcome).toBe('ok');
    const unverified = await testProvider('resend', { candidate: c, deps: fake([[/./, 200, { data: [{ name: 'mail.example.test', status: 'pending' }] }]]).deps });
    expect(unverified.outcome).toBe('misconfigured');
    expect((await testProvider('resend', { candidate: c, deps: fake([[/./, 401, { name: 'restricted_api_key', message: BANNER }]]).deps })).outcome).toBe('ok');
    expect((await testProvider('resend', { candidate: c, deps: fake([[/./, 401, { name: 'validation_error' }]]).deps })).outcome).toBe('auth_failed');
  });
  test('google: the token endpoint with a garbage code tells a wrong client from a right one', async () => {
    const c = { 'google.client_id': 'id.apps.example.test', 'google.client_secret': 'GOCSPX-' + 's'.repeat(20) };
    const f = fake([[/oauth2\.googleapis\.com\/token$/, 400, { error: 'invalid_grant', error_description: BANNER }]]);
    const ok = await testProvider('google', { candidate: c, deps: f.deps });
    expect(ok.outcome).toBe('ok');
    noLeak(ok, c['google.client_secret']);
    expect((await testProvider('google', { candidate: c, deps: fake([[/./, 401, { error: 'invalid_client' }]]).deps })).outcome).toBe('auth_failed');
  });
  test('turnstile siteverify: invalid-input-secret is auth_failed, invalid-input-response means the secret is right', async () => {
    const c = { 'signup.turnstile_secret_key': '0x4AAAA' + 't'.repeat(20), 'signup.turnstile_site_key': '0x4BBBB' };
    expect((await testProvider('turnstile', { candidate: c, deps: fake([[/./, 200, { success: false, 'error-codes': ['invalid-input-response'] }]]).deps })).outcome).toBe('ok');
    expect((await testProvider('turnstile', { candidate: c, deps: fake([[/./, 200, { success: false, 'error-codes': ['invalid-input-secret'] }]]).deps })).outcome).toBe('auth_failed');
  });
});

describe('stripe', () => {
  const live = 'sk_' + 'live_' + 'L'.repeat(24); const testKey = 'sk_' + 'test_' + 'T'.repeat(24);
  test('balance ok reports the mode of the key; prices must exist, be recurring and match the mode', async () => {
    const f = fake([[/v1\/balance$/, 200, { livemode: false }], [/v1\/prices\/price_m$/, 200, { livemode: false, active: true, recurring: { interval: 'month' } }], [/v1\/prices\/price_a$/, 200, { livemode: true, active: true, recurring: {} }]]);
    const r = await testProvider('stripe', { candidate: { 'stripe.secret_key': testKey, 'stripe.price_id': 'price_m', 'stripe.price_id_annual': 'price_a' }, deps: f.deps });
    expect(r.livemode).toBe(false);
    expect(r.checks).toMatchObject({ balance: 'ok', price_monthly: 'ok', price_annual: 'failed' });
    expect(r.outcome).toBe('misconfigured');
    expect(f.calls.every((c) => c.url.startsWith('https://api.stripe.com/v1/'))).toBe(true);
  });
  test('401 is auth_failed; a restricted key without balance access is misconfigured, not rejected', async () => {
    expect((await testProvider('stripe', { candidate: { 'stripe.secret_key': testKey }, deps: fake([[/./, 401, { error: { message: BANNER } }]]).deps })).outcome).toBe('auth_failed');
    expect((await testProvider('stripe', { candidate: { 'stripe.secret_key': testKey }, deps: fake([[/./, 403]]).deps })).outcome).toBe('misconfigured');
  });
  test('switching test -> live reports the mode change and how many businesses would be orphaned; the same key does not', async () => {
    setEnv('STRIPE_SECRET_KEY', testKey);
    const f = fake([[/v1\/balance$/, 200, { livemode: true }], [/v1\/account$/, 200, { id: 'acct_1' }]]);
    const r = await testProvider('stripe', { candidate: { 'stripe.secret_key': live }, deps: f.deps });
    expect(r).toMatchObject({ outcome: 'ok', livemode: true, mode_changed: true, orphaned_businesses: 3 });
    expect(orphanRisk(r)).toBe(3);
    const same = await testProvider('stripe', { candidate: { 'stripe.secret_key': testKey }, deps: fake([[/./, 200, { livemode: false }]]).deps });
    expect(same).toMatchObject({ mode_changed: false, account_changed: false, orphaned_businesses: 0 });
    expect(orphanRisk(same)).toBe(0);
  });
  test('a new key of the same mode on ANOTHER account counts; on the same account it does not', async () => {
    setEnv('STRIPE_SECRET_KEY', testKey);
    const other = 'sk_' + 'test_' + 'U'.repeat(24);
    const accounts = (a: string, b: string) => fake([[/v1\/balance$/, 200, { livemode: false }], [/v1\/account$/, () => new Response(JSON.stringify({ id: 'acct_x' }), { status: 200 })]]).deps && ((): TestDeps => {
      const calls: string[] = [];
      return { fetch: (async (u: string, init: RequestInit) => {
        const auth = String((init.headers as Record<string, string>).authorization);
        if (/balance/.test(u)) return Response.json({ livemode: false });
        calls.push(auth);
        return Response.json({ id: auth.includes('UUU') ? b : a });
      }) as unknown as typeof fetch, timeoutMs: 500, countCustomers: async () => 5 };
    })();
    const moved = await testProvider('stripe', { candidate: { 'stripe.secret_key': other }, deps: accounts('acct_1', 'acct_2') });
    expect(moved).toMatchObject({ mode_changed: false, account_changed: true, orphaned_businesses: 5 });
    expect(orphanRisk(moved)).toBe(5);
    const same = await testProvider('stripe', { candidate: { 'stripe.secret_key': other }, deps: accounts('acct_1', 'acct_1') });
    expect(same.account_changed).toBe(false);
    expect(orphanRisk(same)).toBe(0);
  });
});

describe('smtp under the SSRF rules', () => {
  const smtp = (extra: Record<string, string> = {}) => ({ 'email.smtp_host': 'smtp.mail.example.test', 'email.smtp_port': '587', 'email.smtp_user': 'u', 'email.smtp_pass': 'p w', ...extra });
  test('a public host is verified at the RESOLVED address, with the name kept for the certificate', async () => {
    const seen: unknown[] = [];
    const r = await testProvider('smtp', { candidate: smtp(), deps: { resolve: async () => ['203.0.113.9'], smtpVerify: async (o) => { seen.push(o); return 'ok'; } } });
    expect(r.outcome).toBe('ok');
    expect(seen[0]).toMatchObject({ ip: '203.0.113.9', host: 'smtp.mail.example.test', port: 587, user: 'u', pass: 'p w' });
    noLeak(r, 'p w');
  });
  test('private, loopback, link-local and metadata addresses and names are refused before any connection', async () => {
    let called = false;
    const deps = (addr: string): TestDeps => ({ resolve: async () => [addr], smtpVerify: async () => { called = true; return 'ok'; } });
    for (const addr of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.9', '::1', 'fd00::1', '100.64.0.1']) {
      const r = await testProvider('smtp', { candidate: smtp(), deps: deps(addr) });
      expect(r.outcome).toBe('misconfigured');
    }
    expect((await testProvider('smtp', { candidate: smtp({ 'email.smtp_host': 'localhost' }), deps: deps('203.0.113.9') })).outcome).toBe('misconfigured');
    expect((await testProvider('smtp', { candidate: smtp({ 'email.smtp_host': '169.254.169.254' }), deps: deps('203.0.113.9') })).outcome).toBe('misconfigured');
    expect((await testProvider('smtp', { candidate: smtp({ 'email.smtp_port': '22' }), deps: deps('203.0.113.9') })).outcome).toBe('misconfigured');
    expect(called).toBe(false);
  });
  test('DNS rebinding between the check and the connect is refused (the second answer is private)', async () => {
    let n = 0; let called = false;
    const r = await testProvider('smtp', { candidate: smtp(), deps: { resolve: async () => (n++ === 0 ? ['203.0.113.9'] : ['10.0.0.1']), smtpVerify: async () => { called = true; return 'ok'; } } });
    expect(r.outcome).toBe('misconfigured');
    expect(called).toBe(false);
  });
  test('an smtp:// URL carries the credentials; a failed login is auth_failed, a dead relay unreachable', async () => {
    const seen: Array<{ user: string | null; pass: string | null; port: number; secure: boolean }> = [];
    const url = { 'email.smtp_url': 'smtps://me%40x:pa%24s@smtp.mail.example.test:465' };
    const r = await testProvider('smtp', { candidate: url, deps: { resolve: async () => ['203.0.113.9'], smtpVerify: async (o) => { seen.push(o); return 'auth_failed'; } } });
    expect(r.outcome).toBe('auth_failed');
    expect(seen[0]).toMatchObject({ user: 'me@x', pass: 'pa$s', port: 465, secure: true });
    expect((await testProvider('smtp', { candidate: smtp(), deps: { resolve: async () => ['203.0.113.9'], smtpVerify: async () => { throw new Error('boom'); } } })).outcome).toBe('unreachable');
  });
});

describe('every request stays on a hard-coded provider host', () => {
  test('no candidate value can redirect a test (hosts, redirect: manual, timeout)', async () => {
    const urls: string[] = [];
    const f = fake([[/./, 200, { data: [], status: 'active', livemode: false }]]);
    const evil = 'https://evil.example.test/';
    const c: Record<string, Record<string, string>> = {
      twilio: { 'twilio.account_sid': SID, 'twilio.auth_token': evil, 'twilio.messaging_service_sid': MG }, elevenlabs: { 'elevenlabs.api_key': 'k'.repeat(20) },
      stripe: { 'stripe.secret_key': 'sk_' + 'test_' + 'x'.repeat(20), 'stripe.price_id': 'price_1' }, openai: { 'llm.openai_api_key': 'sk-' + 'x'.repeat(20) }, anthropic: { 'llm.anthropic_api_key': 'sk-' + 'y'.repeat(20) },
      resend: { 'email.resend_api_key': 're_' + 'x'.repeat(20) }, google: { 'google.client_id': evil, 'google.client_secret': 'x'.repeat(20) }, turnstile: { 'signup.turnstile_secret_key': 'x'.repeat(20) },
    };
    for (const [p, cand] of Object.entries(c)) await testProvider(p as never, { candidate: cand, deps: f.deps });
    for (const call of f.calls) { urls.push(call.url); expect(ALLOWED_HOSTS.has(new URL(call.url).host)).toBe(true); expect(call.init.redirect).toBe('manual'); expect(call.init.signal).toBeDefined(); }
    expect(urls.length).toBeGreaterThan(8);
  });
  test('a hanging provider is cut by the timeout and reported unreachable', async () => {
    const slow = (async (_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(new Error('aborted'))); })) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await testProvider('elevenlabs', { candidate: { 'elevenlabs.api_key': 'k'.repeat(20) }, deps: { fetch: slow, timeoutMs: 80 } });
    expect(r.outcome).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('test-before-save verifier', () => {
  test('is off under bun test unless a transport is injected', () => {
    expect(verificationEnabled()).toBe(false);
    setProviderTestDeps({ fetch: fake([]).deps.fetch });
    expect(verificationEnabled()).toBe(true);
  });
  test('ok saves, a rejected credential does not, an unreachable provider needs the explicit acceptance, format and local-only secrets', async () => {
    const changes = [{ key: 'twilio.auth_token', secret: TOKEN }, { key: 'twilio.account_sid', value: SID }];
    const status = (s: number, body: unknown = { status: 'active' }) => ({ fetch: fake([[/./, s, body]]).deps.fetch, timeoutMs: 300 });
    expect(await secretVerifier({ changes, deps: status(200) })('twilio.auth_token', TOKEN)).toBe(true);
    expect(await secretVerifier({ changes, deps: status(401) })('twilio.auth_token', TOKEN)).toBe(false);
    expect(await secretVerifier({ changes, deps: status(503) })('twilio.auth_token', TOKEN)).toBe(false);
    expect(await secretVerifier({ changes, deps: status(503), acceptUnreachable: true })('twilio.auth_token', TOKEN)).toBe(true);
    expect(await secretVerifier({ changes, deps: status(401), acceptUnreachable: true })('twilio.auth_token', TOKEN)).toBe(false);
    setProviderTestDeps({ fetch: fake([[/./, 200]]).deps.fetch });
    expect(await secretVerifier({ changes: [] })('elevenlabs.webhook_secret', 'wsec_abcdef0123456789')).toBe(true); // no remote check: format only
    expect(await secretVerifier({ changes: [] })('elevenlabs.webhook_secret', 'has space')).toBe(false);
    expect(await secretVerifier({ changes: [] })('elevenlabs.tool_secret', 'line\nbreak')).toBe(false);
  });
  test('candidateOf carries the pair; a removal carries nothing', () => {
    expect(candidateOf([{ key: 'twilio.auth_token', secret: 'a' }, { key: 'twilio.account_sid', value: SID }, { key: 'x.y', remove: true }])).toEqual({ 'twilio.auth_token': 'a', 'twilio.account_sid': SID });
  });
  test('secretFormatOk: an SMTP app password may contain inner spaces, nothing else may', () => {
    expect(secretFormatOk('abcd efgh ijkl', 'email.smtp_pass')).toBe(true);
    expect(secretFormatOk(' abcd', 'email.smtp_pass')).toBe(false);
    expect(secretFormatOk('abcd efgh')).toBe(false);
    expect(secretFormatOk('')).toBe(false);
  });
  test('providerWriteChecks: nothing for a plain change or a dry run; the Stripe orphan guard needs the acknowledgement', async () => {
    const live = 'sk_' + 'live_' + 'L'.repeat(24);
    setEnv('STRIPE_SECRET_KEY', 'sk_' + 'test_' + 'T'.repeat(24));
    const deps: TestDeps = { ...fake([[/v1\/balance$/, 200, { livemode: true }], [/v1\/account$/, 200, { id: 'acct_1' }]]).deps };
    setProviderTestDeps(deps);
    expect(await providerWriteChecks([{ key: 'stripe.price_id', value: 'price_1' }], {}, { deps })).toEqual({});
    expect(await providerWriteChecks([{ key: 'stripe.secret_key', secret: live }], {}, { dryRun: true, deps })).toEqual({});
    expect(await stripeOrphanRisk([{ key: 'stripe.secret_key', secret: live }], deps)).toBe(3);
    await expect(providerWriteChecks([{ key: 'stripe.secret_key', secret: live }], {}, { deps })).rejects.toMatchObject({ status: 409, code: 'orphan_ack_required' });
    const ok = await providerWriteChecks([{ key: 'stripe.secret_key', secret: live }], { acknowledge_orphans: true }, { deps });
    expect(typeof ok.verifySecret).toBe('function');
  });
});

describe('live self-test cache', () => {
  test('configured providers are called once per 5 minutes and credential set, force skips the cache, a non-refreshing role only sees the cache, unset providers are never called', async () => {
    setEnv('ELEVENLABS_API_KEY', 'xi_' + 'k'.repeat(30));
    const f = fake([[/api\.elevenlabs\.io/, 200, { x: 1 }]]);
    const t0 = 1_000_000_000_000;
    const noRefresh = await liveSelftest({ refresh: false, deps: { ...f.deps, now: () => t0 } });
    expect(f.calls).toHaveLength(0);
    expect(noRefresh.providers.find((p) => p.provider === 'elevenlabs')?.test).toBeNull();
    const first = await liveSelftest({ refresh: true, deps: { ...f.deps, now: () => t0 } });
    expect(f.calls).toHaveLength(1);
    const card = first.providers.find((p) => p.provider === 'elevenlabs')!;
    expect(card.tested).toBe(true);
    expect(card.test?.outcome).toBe('ok');
    expect(first.providers.find((p) => p.provider === 'twilio')?.tested).toBe(false); // unset: no call
    await liveSelftest({ refresh: true, deps: { ...f.deps, now: () => t0 + 4 * 60_000 } });
    expect(f.calls).toHaveLength(1);
    expect((await liveSelftest({ refresh: false, deps: { ...f.deps, now: () => t0 + 4 * 60_000 } })).providers.find((p) => p.provider === 'elevenlabs')?.test?.outcome).toBe('ok');
    await liveSelftest({ refresh: true, deps: { ...f.deps, now: () => t0 + 6 * 60_000 } });
    expect(f.calls).toHaveLength(2);
    await liveSelftest({ refresh: true, force: true, deps: { ...f.deps, now: () => t0 + 6 * 60_000 } });
    expect(f.calls).toHaveLength(3);
    setEnv('ELEVENLABS_API_KEY', 'xi_' + 'm'.repeat(30)); // a changed credential invalidates the entry at once
    await liveSelftest({ refresh: true, deps: { ...f.deps, now: () => t0 + 6 * 60_000 } });
    expect(f.calls).toHaveLength(4);
    noLeak(first, 'xi_' + 'k'.repeat(30));
  });
  test('a failing provider makes its card not ready', async () => {
    setEnv('ELEVENLABS_API_KEY', 'xi_' + 'k'.repeat(30));
    const r = await liveSelftest({ refresh: true, deps: fake([[/./, 401]]).deps });
    const card = r.providers.find((p) => p.provider === 'elevenlabs')!;
    expect(card.test?.outcome).toBe('auth_failed');
    expect(card.ready).toBe(false);
  });
});

describe('registry, cards and catalog agree', () => {
  test('every card field is a registry key of the right class; secrets are secrets, ids are provider ids', () => {
    for (const c of CARDS) for (const f of c.fields) {
      const d = settingDef(f.key);
      expect(d).toBeDefined();
      if (f.role === 'secret') expect(d!.kind).toBe('secret');
      if (f.role === 'id') expect(d!.kind).toBe('provider_id');
      if (f.role === 'setting') expect(['secret', 'provider_id']).not.toContain(d!.kind);
    }
  });
  test('every secret and provider id of the provider groups is on a card, nothing is on two cards', () => {
    const onCards = CARDS.flatMap((c) => c.fields.map((f) => f.key));
    expect(new Set(onCards).size).toBe(onCards.length);
    const groups = new Set(['telephony', 'voice', 'payments', 'llm', 'email', 'calendar']);
    for (const d of allSettings()) if ((d.kind === 'secret' || d.kind === 'provider_id') && (groups.has(d.group) || d.key.startsWith('signup.turnstile'))) expect(onCards).toContain(d.key);
  });
  test('PAIRS mirror the registry pairedWith, in both directions', () => {
    for (const [secret, partners] of Object.entries(PAIRS)) for (const p of partners) {
      expect(settingDef(secret)!.pairedWith).toContain(p);
      expect(settingDef(p)!.pairedWith).toContain(secret);
      expect(isPartnerField(p)).toBe(true);
    }
    for (const d of allSettings()) if (d.pairedWith?.length && CARDS.some((c) => c.fields.some((f) => f.key === d.key))) {
      const secretSide = d.kind === 'secret' ? d.key : d.pairedWith.find((k) => settingDef(k)?.kind === 'secret');
      expect(secretSide && PAIRS[secretSide]).toBeDefined();
    }
  });
  test('every secret test maps to a provider test and every webhook to a card', () => {
    for (const t of Object.values(SECRET_TEST)) expect(['twilio', 'elevenlabs', 'stripe', 'openai', 'anthropic', 'resend', 'smtp', 'google', 'turnstile']).toContain(t);
    for (const w of WEBHOOKS) { expect(CARDS.some((c) => c.id === w.card)).toBe(true); expect(w.path.startsWith('/api/')).toBe(true); }
  });
  test('EN and ES have a label for every card field and every card and webhook name', () => {
    for (const c of CARDS) {
      for (const f of c.fields) for (const cat of [en, es] as Array<Record<string, string>>) expect(cat[labelKeyOf(f.key)]).toBeTruthy();
      for (const k of [`ap.card.${c.id}.title`, `ap.card.${c.id}.sub`]) expect((en as Record<string, string>)[k] && (es as Record<string, string>)[k]).toBeTruthy();
    }
    for (const w of WEBHOOKS) expect((es as Record<string, string>)[`ap.wh.name.${w.id}`]).toBeTruthy();
    for (const k of Object.keys(en)) if (k.startsWith('ap.h.')) expect(k.slice(5)).toBe(hintKeyOf(k.slice(5)).slice(5));
  });
  test('the card keys are not on the settings pages of agent A (no field is editable in two places)', async () => {
    const { pageOfKey } = await import('../src/lib/admin-ui/model');
    for (const c of CARDS) for (const f of c.fields) expect(pageOfKey(settingDef(f.key)!)).toBeNull();
  });
});

describe('follow-ups and window', () => {
  const act = (k: string) => (settingDef(k)?.followUp === 'resync_agents' ? 'resync_agents' : settingDef(k)?.followUp === 'repair_numbers' ? 'repair_numbers' : null);
  test('a follow-up is pending only for a change after the last COMPLETE run of that action', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    const revs = [{ key: 'elevenlabs.tool_secret', at: t(10) }, { key: 'elevenlabs.phone_number_id', at: t(20) }, { key: 'stripe.price_id', at: t(30) }];
    const none = pendingFollowUps(revs, { resync_agents: null, repair_numbers: null }, act);
    expect(none.find((f) => f.action === 'resync_agents')).toMatchObject({ pending: true, keys: ['elevenlabs.tool_secret'] });
    expect(none.find((f) => f.action === 'repair_numbers')).toMatchObject({ pending: true, keys: ['elevenlabs.phone_number_id'] });
    const after = pendingFollowUps(revs, { resync_agents: t(15), repair_numbers: t(5) }, act);
    expect(after.find((f) => f.action === 'resync_agents')?.pending).toBe(false);
    expect(after.find((f) => f.action === 'repair_numbers')?.pending).toBe(true);
    expect(after.find((f) => f.action === 'resync_agents')?.since).toBeNull();
  });
  test('the dual-secret window only exists while it is in the future', () => {
    const now = 1_700_000_000_000;
    expect(windowOpenUntil(new Date(now + 60_000).toISOString(), now)?.getTime()).toBe(now + 60_000);
    expect(windowOpenUntil(new Date(now - 1).toISOString(), now)).toBeNull();
    expect(windowOpenUntil(null, now)).toBeNull();
    expect(windowOpenUntil('garbage', now)).toBeNull();
  });
  test('webhook URLs derive from the base URL only', () => {
    expect(webhookUrl('https://app.example.test/', '/api/sms/inbound')).toBe('https://app.example.test/api/sms/inbound');
    expect(webhookUrl(null, '/x')).toBeNull();
  });
});

describe('page model', () => {
  const st = (key: string, source: 'env' | 'console' | 'default' | 'none', set: boolean) => ({ key, source, set });
  test('cardStatus', () => {
    expect(cardStatus('telephony', [st('twilio.account_sid', 'none', false), st('twilio.auth_token', 'none', false)])).toBe('unset');
    expect(cardStatus('telephony', [st('twilio.account_sid', 'env', true), st('twilio.auth_token', 'env', true)])).toBe('locked_env');
    expect(cardStatus('telephony', [st('twilio.account_sid', 'console', true), st('twilio.auth_token', 'console', true)])).toBe('console');
    expect(cardStatus('telephony', [st('twilio.account_sid', 'env', true), st('twilio.auth_token', 'console', true)])).toBe('mixed');
    expect(cardStatus('telephony', [st('twilio.account_sid', 'console', true), st('twilio.auth_token', 'none', false)])).toBe('incomplete');
    expect(cardStatus('ai', [st('llm.openai_model', 'default', true)])).toBe('unset'); // a default is not "set"
  });
  test('testsFor tests only what is configured', () => {
    const ai = CARDS.find((c) => c.id === 'ai')!; const email = CARDS.find((c) => c.id === 'email')!; const tel = CARDS.find((c) => c.id === 'telephony')!;
    expect(testsFor(ai, (k) => k === 'llm.anthropic_api_key', () => null)).toEqual(['anthropic']);
    expect(testsFor(ai, () => true, () => null)).toEqual(['openai', 'anthropic']);
    expect(testsFor(email, () => true, (k) => (k === 'email.provider' ? 'smtp' : null))).toEqual(['smtp']);
    expect(testsFor(email, () => true, () => 'log')).toEqual([]);
    expect(testsFor(tel, () => true, () => null)).toEqual(['twilio']);
  });
  test('canSaveSecret: the test must pass for exactly this value; unreachable needs acceptance; orphans need acknowledgement; the confirmation must be complete', () => {
    const ok = { outcome: 'ok' as const };
    const base = { testRequired: true, result: ok, sameAsTested: true, acceptUnreachable: false, orphans: 0, acknowledged: false, confirmOk: true, previewReady: true };
    expect(canSaveSecret(base)).toBe(true);
    expect(canSaveSecret({ ...base, result: null })).toBe(false);
    expect(canSaveSecret({ ...base, sameAsTested: false })).toBe(false);
    expect(canSaveSecret({ ...base, result: { outcome: 'auth_failed' }, acceptUnreachable: true })).toBe(false);
    expect(canSaveSecret({ ...base, result: { outcome: 'misconfigured' } })).toBe(false);
    expect(canSaveSecret({ ...base, result: { outcome: 'unreachable' } })).toBe(false);
    expect(canSaveSecret({ ...base, result: { outcome: 'unreachable' }, acceptUnreachable: true })).toBe(true);
    expect(canSaveSecret({ ...base, orphans: 4 })).toBe(false);
    expect(canSaveSecret({ ...base, orphans: 4, acknowledged: true })).toBe(true);
    expect(canSaveSecret({ ...base, confirmOk: false })).toBe(false);
    expect(canSaveSecret({ ...base, previewReady: false })).toBe(false);
    expect(canSaveSecret({ ...base, testRequired: false, result: null, sameAsTested: false })).toBe(true); // a secret with no remote endpoint: format only
  });
  const page = (n: number, next: string | null, outcome = 'synced'): BatchPage => ({ items: Array.from({ length: n }, (_, i) => ({ business_id: `b${next ?? 'end'}${i}`, outcome })), next_cursor: next });
  test('runBatches walks next_cursor to the end and counts outcomes and failures', async () => {
    const cursors: Array<string | null> = [];
    const pages = [page(25, 'c1'), page(25, 'c2'), { items: [{ business_id: 'x', outcome: 'failed', detail: 'd' }, { business_id: 'y', outcome: 'synced' }], next_cursor: null }];
    const progress: number[] = [];
    const out = await runBatches(async (c) => { cursors.push(c); return pages[cursors.length - 1]; }, { onProgress: (p) => progress.push(p.processed) });
    expect(cursors).toEqual([null, 'c1', 'c2']);
    expect(out).toMatchObject({ processed: 52, pages: 3, completed: true, stopped: false, error: null });
    expect(out.counts).toEqual({ synced: 51, failed: 1 });
    expect(out.failed.map((f) => f.business_id)).toEqual(['x']);
    expect(progress).toEqual([25, 50, 52]);
  });
  test('runBatches stops on request after the current batch, on an error (progress kept) and on a cursor that does not move', async () => {
    let n = 0;
    const stopped = await runBatches(async () => page(2, `c${++n}`), { shouldStop: () => n >= 2 });
    expect(stopped).toMatchObject({ processed: 4, stopped: true, completed: false });
    const boom = new Error('boom');
    let m = 0;
    const errored = await runBatches(async () => { if (++m === 2) throw boom; return page(3, 'next'); });
    expect(errored.error).toBe(boom);
    expect(errored.processed).toBe(3);
    expect(errored.completed).toBe(false);
    let calls = 0;
    const stuck = await runBatches(async () => { calls++; return page(1, 'same'); });
    expect(calls).toBeLessThanOrEqual(3);
    expect(stuck.completed).toBe(false);
  });
  test('estimatePercent never claims 100 before the run completed', () => {
    expect(estimatePercent(10, 100, false)).toBe(10);
    expect(estimatePercent(150, 100, false)).toBe(99);
    expect(estimatePercent(5, null, false)).toBeNull();
    expect(estimatePercent(5, 100, true)).toBe(100);
  });
});
