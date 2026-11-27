/**
 * Admin console providers and secrets against a real database: the test route (roles, candidate validation, rate limit, coarse results, no leak), test-before-save on the
 * secret and apply routes (a rejected credential saves nothing, a pair is saved atomically, the dual-secret window), the Stripe orphan guard, GET /providers (webhook
 * addresses derived from the base URL, usage, follow-ups pending / done), the live self-test, and provisioning that stores the ElevenLabs webhook secret in the console.
 * Every provider request goes to an injected transport: nothing leaves the machine.
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { captureMail } from '../helpers/auth-harness';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';
import { confirmGoLive } from '../helpers/golive';
import crypto from 'node:crypto';

type Who = { cookie: string; user: { id: string; email: string } } | 'bearer' | null;
const ORIGIN = 'https://app.example.test';

integration('admin console: providers, connection tests and secrets (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let loader: typeof import('@/lib/admin/loader');
  let pt: typeof import('@/lib/admin/provider-tests');
  let prov: typeof import('@/lib/admin/provider-provision');
  let store: typeof import('@/lib/admin/settings-store');
  let R: Record<string, any> = {};
  let restoreMail: (() => void) | null = null;
  const userIds: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const MASTER = crypto.randomBytes(32).toString('base64');
  const startedAt = new Date(Date.now() - 1000);
  const SID = `AC${'c'.repeat(32)}`;
  const TOKEN = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const BANNER = 'REMOTE-BANNER-MUST-NOT-LEAK';
  let adminToken = '';

  /** A scripted provider transport: [url pattern, status, body] first match wins; every call is recorded. */
  let script: Array<[RegExp, number, unknown]> = [];
  let fetched: Array<{ url: string; auth: string }> = [];
  const transport = (async (url: string | URL, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    fetched.push({ url: String(url), auth: h.authorization ?? h['x-api-key'] ?? h['xi-api-key'] ?? '' });
    for (const [re, status, body] of script) if (re.test(String(url))) return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 599 });
  }) as unknown as typeof fetch;

  const mk = async (role: 'owner' | 'ops' | 'support' | 'read_only') => {
    const user = await users.createUser({ email: `${uniq('prov')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, platform_role: role });
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    await users.markSessionMfaVerified(session.id);
    return { user: { id: user.id, email: user.email }, cookie: `rc_user_session=${token}` };
  };
  const reqOf = (method: string, path: string, who: Who, body?: unknown): Request => new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...(who === 'bearer' ? { authorization: `Bearer ${adminToken}` } : who ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (handler: (req: Request, ctx?: any) => Promise<Response>, method: string, path: string, who: Who, body?: unknown, params?: Record<string, string>) => {
    const res = await handler(reqOf(method, path, who, body), params ? { params: Promise.resolve(params) } : undefined);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, data: json?.data, code: json?.code };
  };
  const resetRates = () => prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'admin/' } }, { key: { startsWith: 'business/' } }] } });

  beforeAll(async () => {
    for (const k of ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'TRUSTED_PROXY', 'APP_URL']) setEnv(k, process.env[k]);
    setEnv('APP_SECRET_KEY', MASTER);
    for (const k of ['SETTINGS_FREEZE', 'ADMIN_TOKEN_ALLOW_SETTINGS', 'ALERT_EMAIL', 'STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'ELEVENLABS_API_KEY', 'ELEVENLABS_WEBHOOK_SECRET', 'ELEVENLABS_PHONE_NUMBER_ID', 'TWILIO_MESSAGING_SERVICE_SID']) setEnv(k, undefined);
    adminToken = process.env.ADMIN_TOKEN ?? '';
    await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users'); loader = await import('@/lib/admin/loader'); pt = await import('@/lib/admin/provider-tests'); prov = await import('@/lib/admin/provider-provision'); store = await import('@/lib/admin/settings-store');
    const m = async (p: string) => await import(p);
    R = {
      test: (await m('@/app/api/admin/providers/[provider]/test/route')).POST, providers: (await m('@/app/api/admin/providers/route')).GET, selftest: (await m('@/app/api/admin/selftest/route')).GET,
      secret: await m('@/app/api/admin/secrets/[key]/route'), apply: (await m('@/app/api/admin/settings/apply/route')).POST, settings: (await m('@/app/api/admin/settings/route')).GET,
    };
    restoreMail = captureMail().restore ?? null;
    loader.startSettingsPoll(3_600_000);
    await resetRates();
  });
  beforeEach(async () => { await resetRates(); script = []; fetched = []; pt.clearLiveCache(); pt.setProviderTestDeps({ fetch: transport, timeoutMs: 1000 }); });
  afterEach(() => { setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', undefined); setEnv('SETTINGS_FREEZE', undefined); pt.setProviderTestDeps(null); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    pt.setProviderTestDeps(null);
    loader.stopSettingsLoader();
    await prisma.platformSetting.deleteMany({}); await prisma.settingChangeSet.deleteMany({});
    await prisma.settingsState.update({ where: { id: 1 }, data: { frozenAt: null, frozenBy: null, frozenReason: null, globalVersion: { increment: 1 } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { at: { gte: startedAt }, action: { in: ['admin.bearer_use', 'admin.repair_numbers', 'admin.resync_agents', 'admin.notify_failed'] } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    restoreMail?.();
    await cleanup();
  });

  test('the test route: roles, candidate validation, coarse results, no leak, rate limit', async () => {
    script = [[/api\.elevenlabs\.io\/v1\/user$/, 200, { note: BANNER }]];
    const owner = await mk('owner'); const ops = await mk('ops'); const ro = await mk('read_only'); const support = await mk('support');
    setEnv('ELEVENLABS_API_KEY', 'xi_' + 'k'.repeat(30));
    const cand = { candidate: { 'elevenlabs.api_key': 'xi_' + 'n'.repeat(30) } };
    // roles: the stored configuration may be tested by ops and owner, a CANDIDATE only by an owner
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', null, {}, { provider: 'elevenlabs' })).status).toBe(401);
    for (const who of [ro, support]) expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', who, {}, { provider: 'elevenlabs' })).status).toBe(403);
    const stored = await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', ops, {}, { provider: 'elevenlabs' });
    expect(stored.status).toBe(200);
    expect(stored.data).toMatchObject({ provider: 'elevenlabs', outcome: 'ok', scope: 'remote' });
    expect(fetched[0]).toMatchObject({ url: 'https://api.elevenlabs.io/v1/user', auth: 'xi_' + 'k'.repeat(30) });
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', ops, cand, { provider: 'elevenlabs' })).status).toBe(403);
    const withCand = await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, cand, { provider: 'elevenlabs' });
    expect(withCand.status).toBe(200);
    expect(fetched[1].auth).toBe('xi_' + 'n'.repeat(30)); // the CANDIDATE was tested, not the stored value
    expect(withCand.text).not.toContain('n'.repeat(30));
    expect(withCand.text).not.toContain(BANNER);
    // the break-glass token may test what is stored, never a candidate
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', 'bearer', {}, { provider: 'elevenlabs' })).status).toBe(200);
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', 'bearer', cand, { provider: 'elevenlabs' })).status).toBe(403);
    // validation
    await resetRates();
    expect((await call(R.test, 'POST', '/api/admin/providers/nope/test', owner, {}, { provider: 'nope' })).status).toBe(404);
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, { candidate: { 'jobs.briefing_hour': '5' } }, { provider: 'elevenlabs' })).status).toBe(422);
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, { candidate: { 'elevenlabs.api_key': 12 } }, { provider: 'elevenlabs' })).status).toBe(422);
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, { candidate: { 'elevenlabs.api_key': 'has space' } }, { provider: 'elevenlabs' })).status).toBe(422);
    expect((await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, { candidate: 'x' }, { provider: 'elevenlabs' })).status).toBe(422);
    // a rejected credential and a dead provider are coarse results, never remote text
    script = [[/./, 401, { message: BANNER }]];
    const bad = await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, cand, { provider: 'elevenlabs' });
    expect(bad.data.outcome).toBe('auth_failed');
    expect(bad.text).not.toContain(BANNER);
    // 6 per minute
    await resetRates();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call(R.test, 'POST', '/api/admin/providers/elevenlabs/test', owner, {}, { provider: 'elevenlabs' })).status;
    expect(last).toBe(429);
  });

  test('test-before-save: a rejected pair saves nothing, a good pair is saved atomically, the previous secret stays accepted for the window, nothing leaks', async () => {
    const owner = await mk('owner');
    const put = (token: string, extra: Record<string, unknown> = {}) => call(R.secret.PUT, 'PUT', '/api/admin/secrets/twilio.auth_token', owner, {
      value: token, paired: { 'twilio.account_sid': SID }, reason: 'rotate the Twilio credentials', confirm: 'apply 2 critical settings', ...extra,
    }, { key: 'twilio.auth_token' });
    script = [[/api\.twilio\.com/, 401, { message: BANNER }]];
    const rejected = await put(TOKEN);
    expect(rejected.status).toBe(422);
    expect(rejected.json.problems[0]).toMatchObject({ key: 'twilio.auth_token', code: 'verification_failed' });
    expect(rejected.text).not.toContain(BANNER);
    expect(await prisma.platformSetting.count({ where: { key: { startsWith: 'twilio.' } } })).toBe(0);
    expect(fetched[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    expect(fetched[0].auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`); // the candidate PAIR was tested
    // unreachable: refused unless the operator accepts it
    script = [[/api\.twilio\.com/, 503, {}]];
    expect((await put(TOKEN)).status).toBe(422);
    expect(await prisma.platformSetting.count({ where: { key: { startsWith: 'twilio.' } } })).toBe(0);
    // good: both rows in ONE change set
    script = [[/api\.twilio\.com/, 200, { status: 'active' }]];
    const saved = await put(TOKEN);
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(TOKEN);
    expect(await prisma.platformSetting.count({ where: { key: { in: ['twilio.account_sid', 'twilio.auth_token'] } } })).toBe(2);
    expect(await prisma.settingChangeSet.count({ where: { id: saved.data.change_set_id } })).toBe(1);
    const info = await call(R.secret.GET, 'GET', '/api/admin/secrets/twilio.auth_token', owner, undefined, { key: 'twilio.auth_token' });
    expect(info.data).toMatchObject({ set: true, source: 'console', fingerprint: crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 8), last4: TOKEN.slice(-4) });
    // rotate: the previous one is accepted for the window and the listing says until when
    const next = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const second = await put(next, { confirm: 'twilio.auth_token' }); // the unchanged account sid is a no-op: one live key, so the phrase is the key itself
    expect([second.status, second.json?.error, JSON.stringify(second.json?.problems)]).toEqual([200, undefined, undefined]);
    const listing = await call(R.settings, 'GET', '/api/admin/settings', owner);
    const view = listing.data.settings.find((s: any) => s.key === 'twilio.auth_token');
    expect(new Date(view.secret.previous_accepted_until).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(view.secret.previous_accepted_until).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
    expect(listing.text).not.toContain(TOKEN);
    expect(listing.text).not.toContain(next);
    const audits = await prisma.auditEvent.findMany({ where: { action: 'settings.change', at: { gte: startedAt } } });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain(next);
    // the apply route verifies too
    script = [[/api\.twilio\.com/, 401, {}]];
    const viaApply = await call(R.apply, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'twilio.account_sid', value: SID }, { key: 'twilio.auth_token', secret: 'tok_' + 'q'.repeat(20) }], reason: 'try the apply route', confirm: 'apply 2 critical settings' });
    expect([viaApply.status, viaApply.json.problems?.[0]?.code]).toEqual([422, 'verification_failed']);
  });

  test('switching the Stripe key between test and live needs the orphan acknowledgement; the count is shown', async () => {
    const owner = await mk('owner');
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { stripeCustomerId: `cus_${uniq('x')}` } });
    const customers = await prisma.business.count({ where: { stripeCustomerId: { not: null } } });
    const testKey = 'sk_' + 'test_' + 'T'.repeat(24); const liveKey = 'sk_' + 'live_' + 'L'.repeat(24);
    const put = (value: string, extra: Record<string, unknown> = {}) => call(R.secret.PUT, 'PUT', '/api/admin/secrets/stripe.secret_key', owner, { value, reason: 'change the Stripe key', confirm: 'stripe.secret_key', ...extra }, { key: 'stripe.secret_key' });
    script = [[/v1\/balance$/, 200, { livemode: false }]];
    expect((await put(testKey)).status).toBe(200); // first key: nothing to orphan
    script = [[/v1\/balance$/, 200, { livemode: true }], [/v1\/account$/, 200, { id: 'acct_1' }]];
    const refused = await put(liveKey);
    expect([refused.status, refused.code]).toEqual([409, 'orphan_ack_required']);
    expect(refused.json.error).toContain(String(customers));
    expect((await prisma.platformSetting.findUnique({ where: { key: 'stripe.secret_key' } }))?.secretLast4).toBe(testKey.slice(-4)); // unchanged
    const test = await call(R.test, 'POST', '/api/admin/providers/stripe/test', owner, { candidate: { 'stripe.secret_key': liveKey } }, { provider: 'stripe' });
    expect(test.data).toMatchObject({ outcome: 'ok', livemode: true, mode_changed: true, orphaned_businesses: customers });
    expect(test.text).not.toContain(liveKey);
    const acked = await put(liveKey, { acknowledge_orphans: true });
    expect(acked.status).toBe(200);
    expect((await prisma.platformSetting.findUnique({ where: { key: 'stripe.secret_key' } }))?.secretLast4).toBe(liveKey.slice(-4));
    await prisma.business.update({ where: { id: biz.id }, data: { stripeCustomerId: null } });
  });

  test('GET /providers: webhook addresses from the base URL, usage, follow-ups pending until a complete run', async () => {
    const owner = await mk('owner'); const ro = await mk('read_only');
    expect((await call(R.providers, 'GET', '/api/admin/providers', null)).status).toBe(401);
    const first = await call(R.providers, 'GET', '/api/admin/providers', ro);
    expect(first.status).toBe(200);
    expect(first.data.base_url).toBe(process.env.APP_URL);
    const sms = first.data.webhooks.find((w: any) => w.id === 'twilio_sms');
    expect(sms.url).toBe(`${process.env.APP_URL}/api/sms/inbound`);
    expect(first.data.webhooks.find((w: any) => w.id === 'stripe_billing')).toMatchObject({ path: '/api/billing/webhook', verifier_configured: false });
    expect(first.data.google_redirect.url).toBe(`${process.env.APP_URL}/api/integrations/google/callback`);
    expect(first.data.follow_ups.find((f: any) => f.action === 'repair_numbers').pending).toBe(false);
    // a key that needs "repair numbers" changes -> pending; a complete real run afterwards -> done
    const set = await call(R.apply, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'elevenlabs.phone_number_id', value: 'phnum_abc123' }], reason: 'point at the shared number' });
    expect(set.status).toBe(200);
    const pending = await call(R.providers, 'GET', '/api/admin/providers', owner);
    expect(pending.data.follow_ups.find((f: any) => f.action === 'repair_numbers')).toMatchObject({ pending: true, keys: ['elevenlabs.phone_number_id'] });
    await prisma.auditEvent.create({ data: { actorKind: 'admin_token', action: 'admin.repair_numbers', target: 'numbers', meta: { dry_run: false, has_more: true } } });
    expect((await call(R.providers, 'GET', '/api/admin/providers', owner)).data.follow_ups.find((f: any) => f.action === 'repair_numbers').pending).toBe(true); // an unfinished run does not count
    await prisma.auditEvent.create({ data: { actorKind: 'admin_token', action: 'admin.repair_numbers', target: 'numbers', meta: { dry_run: false, has_more: false } } });
    expect((await call(R.providers, 'GET', '/api/admin/providers', owner)).data.follow_ups.find((f: any) => f.action === 'repair_numbers').pending).toBe(false);
    await prisma.platformSetting.deleteMany({ where: { key: 'elevenlabs.phone_number_id' } }); // keep the shared-number fallback out of the later tests
    await loader.refreshNow();
  });

  test('selftest: default is offline; ?live=1 tests configured providers once per 5 minutes; a read-only role only sees the cache', async () => {
    const owner = await mk('owner'); const ro = await mk('read_only');
    setEnv('ELEVENLABS_API_KEY', 'xi_' + 'k'.repeat(30));
    script = [[/api\.elevenlabs\.io\/v1\/user$/, 200, {}]];
    const offline = await call(R.selftest, 'GET', '/api/admin/selftest', owner);
    expect([offline.data.tested, fetched.length]).toEqual([false, 0]);
    const el = () => fetched.filter((f) => f.url.includes('api.elevenlabs.io')).length; // other providers configured by the earlier tests are tested too: count only this one
    const roFirst = await call(R.selftest, 'GET', '/api/admin/selftest?live=1', ro);
    expect(roFirst.data.providers.find((p: any) => p.provider === 'elevenlabs').test).toBeNull();
    expect(fetched).toHaveLength(0);
    const live = await call(R.selftest, 'GET', '/api/admin/selftest?live=1', owner);
    expect(live.data.tested).toBe(true);
    expect(live.data.providers.find((p: any) => p.provider === 'elevenlabs')).toMatchObject({ tested: true, test: { outcome: 'ok' } });
    expect(live.data.providers.find((p: any) => p.provider === 'google').tested).toBe(false); // nothing configured: never called
    expect(el()).toBe(1);
    await call(R.selftest, 'GET', '/api/admin/selftest?live=1', owner);
    expect(el()).toBe(1); // cached
    expect((await call(R.selftest, 'GET', '/api/admin/selftest?live=1', ro)).data.providers.find((p: any) => p.provider === 'elevenlabs').test.outcome).toBe('ok');
    await call(R.selftest, 'GET', '/api/admin/selftest?live=1&force=1', owner);
    expect(el()).toBe(2);
    expect(live.text).not.toContain('k'.repeat(30));
  });

  test('provisioning stores the ElevenLabs webhook secret in the encrypted console store (critical, audited); every other case keeps the one-time display', async () => {
    const owner = await mk('owner');
    const principal = (u: { id: string }, via: 'user' | 'token' = 'user') => ({ kind: 'admin', via, user: via === 'user' ? { id: u.id, platform_role: 'owner' } : null }) as any;
    const SECRET = `wsec_${crypto.randomBytes(12).toString('hex')}`;
    // the break-glass token cannot write secrets: falls back to show-once
    expect(await prov.storeProvisionedWebhookSecret(principal(owner.user, 'token'), SECRET)).toBe(false);
    expect(await prisma.platformSetting.count({ where: { key: 'elevenlabs.webhook_secret' } })).toBe(0);
    // pinned by the environment: nothing is stored
    setEnv('ELEVENLABS_WEBHOOK_SECRET', 'pinned-by-env-0123456789');
    expect(await prov.storeProvisionedWebhookSecret(principal(owner.user), SECRET)).toBe(false);
    setEnv('ELEVENLABS_WEBHOOK_SECRET', undefined);
    // frozen console: nothing is stored
    setEnv('SETTINGS_FREEZE', 'true');
    expect(await prov.storeProvisionedWebhookSecret(principal(owner.user), SECRET)).toBe(false);
    setEnv('SETTINGS_FREEZE', undefined);
    // an owner: stored, critical, audited with a fingerprint only
    expect(await prov.storeProvisionedWebhookSecret(principal(owner.user), SECRET, '203.0.113.5')).toBe(true);
    const info = await store.secretInfo('elevenlabs.webhook_secret');
    expect(info).toMatchObject({ set: true, source: 'console', fingerprint: crypto.createHash('sha256').update(SECRET).digest('hex').slice(0, 8) });
    const row = await prisma.auditEvent.findFirst({ where: { action: 'settings.change', actorUserId: owner.user.id }, orderBy: { at: 'desc' } });
    expect((row?.meta as any).tier).toBe('critical');
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(await prov.storeProvisionedWebhookSecret({ kind: 'user' } as any, SECRET)).toBe(false); // a tenant principal is never a console actor
  });

  test('the provision route: an owner admin gets webhook_secret_stored (no secret in the response); an environment pin or the Bearer token keeps the one-time display', async () => {
    const provision = (await import('@/app/api/businesses/[id]/provision/route')).POST as any;
    const owner = await mk('owner');
    const WSEC = 'wsec_PLATFORM_WIDE_' + crypto.randomBytes(6).toString('hex');
    const elevenCalls: string[] = [];
    const run_id = crypto.randomBytes(3).toString('hex'); let agentSeq = 0;
    const stub = (async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (!url.startsWith('https://api.elevenlabs.io')) return Response.json({ id: 'mail_1' });
      elevenCalls.push(`${method} ${url.replace(/^https:\/\/api\.elevenlabs\.io\/v1/, '')}`);
      if (url.endsWith('/workspace/webhooks') && method === 'GET') return Response.json({ webhooks: [] });
      if (url.endsWith('/workspace/webhooks') && method === 'POST') return Response.json({ webhook_id: 'wh_new', webhook_secret: WSEC });
      if (url.endsWith('/convai/agents/create')) return Response.json({ agent_id: `agent_prov_${run_id}_${++agentSeq}` });
      if (url.endsWith('/convai/tools') && method === 'GET') return Response.json({ tools: [] });
      if (url.endsWith('/convai/tools') && method === 'POST') return Response.json({ id: 'tool_prov' });
      return Response.json({});
    }) as unknown as typeof fetch;
    const real = globalThis.fetch;
    const run = async (who: Who, id: string) => {
      await prisma.rateLimitBucket.deleteMany({});
      const res = await provision(reqOf('POST', `/api/businesses/${id}/provision`, who, { force: true }), { params: Promise.resolve({ id }) });
      return { status: res.status, text: await res.text() };
    };
    try {
      globalThis.fetch = stub;
      await withEnv({ ELEVENLABS_API_KEY: 'xi-test', BILLING_ENFORCED: 'true', ELEVENLABS_WEBHOOK_SECRET: undefined }, async () => {
        const mkBiz = async () => { const b = await newBusiness({ agent_id: null }); await prisma.business.update({ where: { id: b.id }, data: { billingStatus: 'active' } }); await run(owner, b.id); await confirmGoLive(b.id); return b; };
        const b1 = await mkBiz();
        const stored = await run(owner, b1.id);
        expect(stored.status).toBe(200);
        const data = JSON.parse(stored.text).data;
        expect(data.webhook_secret_stored).toBe(true);
        expect(stored.text).not.toContain(WSEC);
        expect(stored.text).not.toContain('webhook_secret"');
        expect(await store.secretInfo('elevenlabs.webhook_secret')).toMatchObject({ set: true, source: 'console', fingerprint: crypto.createHash('sha256').update(WSEC).digest('hex').slice(0, 8) });
        const audit = await prisma.auditEvent.findFirst({ where: { action: 'settings.change', actorUserId: owner.user.id }, orderBy: { at: 'desc' } });
        expect((audit?.meta as any).tier).toBe('critical');
        expect(JSON.stringify(audit)).not.toContain(WSEC);
        // the Bearer token cannot write secrets: the one-time display is kept (behaviour of before the console)
        const b2 = await mkBiz();
        await prisma.platformSetting.deleteMany({ where: { key: 'elevenlabs.webhook_secret' } });
        await loader.refreshNow();
        const shown = await run('bearer', b2.id);
        expect(JSON.parse(shown.text).data.webhook_secret).toBe(WSEC);
        expect(JSON.parse(shown.text).data.webhook_secret_stored).toBeUndefined();
        expect(await prisma.platformSetting.count({ where: { key: 'elevenlabs.webhook_secret' } })).toBe(0);
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});
