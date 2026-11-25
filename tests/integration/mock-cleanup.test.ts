/**
 * docs/review/18f section 4 (mock cleanup): production never treats a mock SMS as delivered (verify-start 503, no plan quota burned, no follow-up
 * consent, no "I texted you"), dashboard knowledge/business edits reach the live agent (and are queued for retry on failure), syncAgent loads the KB
 * itself, the gratitude sweep texts in the call's language, consent is not claimed when nothing speaks a disclosure, DEMO_MODE is inert in
 * production, and the number-webhook repair route is a dry run by default.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { awakeTimezone, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq, wall } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

integration('mock cleanup (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let el: typeof import('@/lib/voice/elevenlabs');
  type Ctx = { params: Promise<{ id: string }> };
  // production also needs the 32-byte app key (challenge signing) and an active plan (billing is enforced there)
  const PROD = { NODE_ENV: 'production', APP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') };
  const activate = (id: string) => prisma.business.update({ where: { id }, data: { billingStatus: 'active' } });
  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const req = (url: string, body: unknown, method = 'POST') => new Request(`http://app.test${url}`, { method, headers: admin, body: JSON.stringify(body) });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const clear = async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'owner-phone/' } }, { key: { startsWith: 'forward-number/' } }, { key: { startsWith: 'admin/repair-numbers' } }, { key: { startsWith: 'sms/send' } }] } }); };

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    el = await import('@/lib/voice/elevenlabs');
  });
  afterEach(clear);
  afterAll(async () => { await clear(); await cleanup(); });

  const booking = (biz: { id: string }, over: Record<string, unknown> = {}) => db.createBooking({
    business_id: biz.id, customer_name: 'Ana', customer_phone: phone(), service: 'AC repair',
    scheduled_at: new Date(Date.now() + (2 + Math.floor(Math.random() * 300)) * 86400_000).toISOString(), duration_minutes: 30, ...over,
  }, { enforce: false });

  // ------------------------------------------------------------------ #1 / #2: a mock is never delivered in production

  test('verify-start routes answer an honest 503 sms_provider_not_configured in production (no code "sent"), and 200 outside production', async () => {
    const start = (await import('@/app/api/businesses/[id]/owner-phone/verify/start/route')).POST;
    const fwd = (await import('@/app/api/businesses/[id]/forward-number/verify/start/route')).POST;
    const biz = await newBusiness({ owner_phone: null });
    await activate(biz.id);
    await withEnv(PROD, async () => {
      const r = await start(req(`/api/businesses/${biz.id}/owner-phone/verify/start`, { phone: phone() }), ctx(biz.id));
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, error: 'sms_provider_not_configured' });
      const f = await fwd(req(`/api/businesses/${biz.id}/forward-number/verify/start`, { phone: phone() }), ctx(biz.id));
      expect(f.status).toBe(503);
      expect(((await f.json()) as { error: string }).error).toBe('sms_provider_not_configured');
    });
    const rows = await prisma.smsLog.findMany({ where: { businessId: biz.id } });
    expect(rows.length).toBe(2);
    expect(rows.every((s) => s.status === 'failed')).toBe(true);
    expect((await db.getUsage(biz.id))?.sms_count ?? 0).toBe(0); // no quota burned
    await clear();
    const lines: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { expect((await start(req(`/api/businesses/${biz.id}/owner-phone/verify/start`, { phone: phone() }), ctx(biz.id))).status).toBe(200); } finally { console.log = orig; }
    expect(outboundCalls).toEqual([]);
  });

  test('POST /api/sms/send answers 503 sms_provider_not_configured in production instead of returning a "mock" success', async () => {
    const send = (await import('@/app/api/sms/send/route')).POST as any;
    const biz = await newBusiness({ timezone: awakeTimezone() });
    await activate(biz.id);
    const b = await booking(biz);
    const r: Response = await withEnv(PROD, async () => send(req('/api/sms/send', { business_id: biz.id, to: b.customer_phone, body: 'Running late' })));
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toBe('sms_provider_not_configured');
    const ok = await send(req('/api/sms/send', { business_id: biz.id, to: b.customer_phone, body: 'Running late' }));
    expect(ok.status).toBe(200); // outside production the demo mock stays a delivered mock
  });

  test('production without Twilio: an undelivered text is a failure everywhere: no plan quota, no follow-up consent, no "I texted you", no gratitude count', async () => {
    const messaging = await import('@/lib/messaging');
    const actions = await import('@/lib/messaging/actions');
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { timezone: awakeTimezone(), billingStatus: 'active' } });
    const b = await booking(biz);
    await withEnv(PROD, async () => {
      const sent = await messaging.sendAndLog({ business_id: biz.id, to: phone(), body: 'Hello there', kind: 'confirmation' });
      expect(sent.sms.status).toBe('failed');
      expect(sent.result.error).toBe('sms_provider_not_configured');
      const conf = await actions.sendConfirmation(b.id, 'en');
      expect(conf.sms.status).toBe('failed');
      expect((await db.getBooking(b.id))!.followup_consent_at).toBeNull(); // consent is only recorded for a text that was delivered
      // the voice tool tells the caller the truth
      const biz2 = await newBusiness();
      await activate(biz2.id);
      const live = await db.createCall({ business_id: biz2.id, caller_phone: phone() });
      const tool = (await import('@/app/api/voice/tools/[tool]/route')).POST;
      const r = await tool(toolRequest('send_sms', { agent_id: biz2.agent_id, call_id: live.id, body: 'hi there' }), { params: Promise.resolve({ tool: 'send_sms' }) });
      const body = (await r.json()) as { ok: boolean; message: string };
      expect(body.ok).toBe(false);
      expect(body.message).not.toMatch(/just sent/i);
      // booking creation does not promise a confirmation text
      const day = futureDateKey(2);
      const made = await tool(toolRequest('create_booking', {
        agent_id: biz2.agent_id, call_id: live.id, customer_name: 'Lucia', customer_phone: live.caller_phone, service: 'AC repair', scheduled_at: wall(day, '10:00'), conversation_id: uniq('conv'),
      }), { params: Promise.resolve({ tool: 'create_booking' }) });
      const mb = (await made.json()) as { ok: boolean; message: string; data: { sms_sent?: boolean } | null };
      if (mb.ok) expect(mb.message).not.toMatch(/sending your confirmation text/i);
    });
    expect((await db.getUsage(biz.id))?.sms_count ?? 0).toBe(0);
    // outside production the same send IS a delivered mock (dev / demo) and records the consent
    const b2 = await booking(biz);
    const dev = await actions.sendConfirmation(b2.id, 'en');
    expect(dev.sms.status).toBe('mock');
    expect((await db.getBooking(b2.id))!.followup_consent_at).not.toBeNull();
  });

  test('gratitude sweep: in production an undelivered text is an error, not "sent"; it texts in the call\'s language, else the business default', async () => {
    const sweep = (await import('@/lib/gratitude')).runGratitudeSweep;
    const mk = async (opts: { callLang?: 'es' | 'en' | null; locale?: 'en' | 'es' }) => {
      const biz = await newBusiness({ timezone: awakeTimezone() });
      await prisma.business.update({ where: { id: biz.id }, data: { localeDefault: opts.locale ?? 'en', billingStatus: 'active' } });
      const b = await booking(biz, { scheduled_at: new Date(Date.now() - 30 * 3600_000).toISOString() });
      await db.updateBooking(b.id, { status: 'completed', followup_consent_at: new Date().toISOString(), followup_consent_source: 'confirmation_sms_notice' });
      if (opts.callLang !== null && opts.callLang !== undefined) {
        const call = await db.createCall({ business_id: biz.id, caller_phone: b.customer_phone, language: opts.callLang });
        await prisma.booking.update({ where: { id: b.id }, data: { callId: call.id } });
      }
      return { biz, b };
    };
    const es = await mk({ callLang: 'es' });
    const r = await sweep(es.biz.id);
    expect(r.sent).toBe(1);
    const row = await prisma.smsLog.findFirstOrThrow({ where: { businessId: es.biz.id, kind: 'gratitude' } });
    expect(row.body).toMatch(/Responda 1-5/); // Spanish template
    const fallbackEs = await mk({ callLang: null, locale: 'es' });
    await sweep(fallbackEs.biz.id);
    const fb = await prisma.smsLog.findFirstOrThrow({ where: { businessId: fallbackEs.biz.id, kind: 'gratitude' } });
    expect(fb.body).toMatch(/Responda 1-5/);
    const en = await mk({ callLang: 'en', locale: 'es' }); // the call's language wins over the business default
    await sweep(en.biz.id);
    const enRow = await prisma.smsLog.findFirstOrThrow({ where: { businessId: en.biz.id, kind: 'gratitude' } });
    expect(enRow.body).toMatch(/Reply 1-5/);
    // production without Twilio: nothing is delivered, so nothing is "sent"
    const prod = await mk({ callLang: 'es' });
    const pr = await withEnv(PROD, () => sweep(prod.biz.id));
    expect(pr.sent).toBe(0);
    expect(pr.skipped_error).toBe(1);
  });

  // ------------------------------------------------------------------ #4 / #10: edits reach the live agent; syncAgent loads the KB

  async function withFake<T>(fn: (f: ReturnType<typeof fakeElevenLabs>) => Promise<T>): Promise<T> {
    const fake = fakeElevenLabs();
    fake.install();
    try {
      return await withEnv({ ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ELEVENLABS_TOOL_SECRET: 'tool-secret-x', ELEVENLABS_AGENT_ID: undefined }, async () => { el.clearToolIdCache(); el.resetInitiationCache(); return fn(fake); });
    } finally { fake.restore(); }
  }
  const promptOf = (f: ReturnType<typeof fakeElevenLabs>, agentId: string) => f.agents.get(agentId)!.conversation_config.agent.prompt.prompt as string;
  const dirty = (id: string) => prisma.processedEvent.count({ where: { id, source: { startsWith: 'agent-dirty:' } } });

  test('syncAgent with kb:null loads the stored knowledge base (the incoming-route repair no longer pushes a price-less prompt)', async () => {
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      const system_prompt = (await import('@/lib/kb')).buildSystemPrompt(biz, { services: [{ name: 'Zeppelin Tune-Up', base_price: 4321 }], faqs: [], pricing_notes: 'Notes here' });
      await db.upsertKnowledgeBase(biz.id, { services: [{ name: 'Zeppelin Tune-Up', base_price: 4321 }], faqs: [], pricing_notes: 'Notes here', call_script: 'x', system_prompt });
      const r = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      expect(r.mock).toBe(false);
      expect(promptOf(fake, r.agent_id)).toContain('Zeppelin Tune-Up');
    });
  });

  test('a dashboard knowledge edit is pushed to the live agent and the response says so; a provider failure is queued for retry and reported', async () => {
    const put = (await import('@/app/api/businesses/[id]/onboarding-status/knowledge/route')).PUT as any;
    const put2 = (await import('@/app/api/businesses/[id]/knowledge/route')).PUT as any;
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      const first = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      expect(first.mock).toBe(false);
      const r = await put(req(`/api/businesses/${biz.id}/onboarding-status/knowledge`, { services: [{ name: 'Quantum Flush', base_price: 99 }], faqs: [], pricing_notes: '' }, 'PUT'), ctx(biz.id));
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data.agent_sync).toEqual({ agent: 'synced', retry_queued: false });
      expect(promptOf(fake, first.agent_id)).toContain('Quantum Flush');
      const r2 = await put2(req(`/api/businesses/${biz.id}/knowledge`, { pricing_notes: 'Weekend surcharge applies' }, 'PUT'), ctx(biz.id));
      expect(((await r2.json()) as any).data.agent_sync.agent).toBe('synced');
      expect(promptOf(fake, first.agent_id)).toContain('Weekend surcharge applies');
      expect(await dirty(biz.id)).toBe(0);
      // the provider is down: the edit is saved, the response is honest, and the business is queued for the reconcile job
      const real = globalThis.fetch;
      globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
      try {
        const bad = await put(req(`/api/businesses/${biz.id}/onboarding-status/knowledge`, { services: [{ name: 'Quantum Flush', base_price: 120 }], faqs: [], pricing_notes: '' }, 'PUT'), ctx(biz.id));
        expect(bad.status).toBe(200);
        expect(((await bad.json()) as any).data.agent_sync).toEqual({ agent: 'failed', retry_queued: true });
      } finally { globalThis.fetch = real; }
      expect((await db.getKnowledgeBase(biz.id))!.services[0].base_price).toBe(120);
      expect(await dirty(biz.id)).toBe(1);
      expect(promptOf(fake, first.agent_id)).not.toContain('$120'); // the live agent still has the old prompt: the UI must not say "next call"
    });
  });

  test('a business PATCH of a prompt field (hours, name, area) is pushed too; owner_phone alone does not trigger a push', async () => {
    const patch = (await import('@/app/api/businesses/[id]/route')).PATCH as any;
    await withFake(async (fake) => {
      const biz = await newBusiness({ agent_id: null });
      const first = await el.syncAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
      await db.upsertKnowledgeBase(biz.id, { services: [], faqs: [], pricing_notes: '', call_script: 'x', system_prompt: 'placeholder' });
      const before = fake.calls.filter((c) => c.startsWith('PATCH /convai/agents/')).length;
      const r = await patch(req(`/api/businesses/${biz.id}`, { name: 'Renamed Cooling Co', service_area: ['Hialeah'] }, 'PATCH'), ctx(biz.id));
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data.agent_sync).toEqual({ agent: 'synced', retry_queued: false });
      expect(promptOf(fake, first.agent_id)).toContain('Renamed Cooling Co');
      expect(promptOf(fake, first.agent_id)).toContain('Hialeah');
      expect(fake.calls.filter((c) => c.startsWith('PATCH /convai/agents/')).length).toBeGreaterThan(before);
      const other = await patch(req(`/api/businesses/${biz.id}`, { owner_name: 'Rosa' }, 'PATCH'), ctx(biz.id));
      expect(((await other.json()) as any).data.agent_sync.agent).toBe('synced');
      const quiet = await patch(req(`/api/businesses/${biz.id}`, { owner_phone: phone() }, 'PATCH'), ctx(biz.id));
      expect(((await quiet.json()) as any).data.agent_sync).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------ #7: no consent claim when nothing speaks a disclosure

  test('incoming call with no ElevenLabs key: "disclosed" is claimed only outside production (the scripted demo speaks it)', async () => {
    const incoming = (await import('@/app/api/voice/incoming/route')).POST;
    const call = async () => {
      const biz = await newBusiness();
      await activate(biz.id);
      const params = { CallSid: uniq('CA'), From: phone(), To: biz.phone!, AccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
      const url = `${SECRETS.publicBase}/api/voice/incoming`;
      const res = await incoming(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString(),
      }));
      expect(res.status).toBe(200);
      return prisma.call.findFirstOrThrow({ where: { businessId: biz.id } });
    };
    expect(await call()).toMatchObject({ consentStatus: 'disclosed', recordingDisclosed: true });
    const prod = await withEnv({ ...PROD, ALLOW_INSECURE_DEV: undefined }, call);
    expect(prod).toMatchObject({ consentStatus: 'unknown', recordingDisclosed: false });
  });

  // ------------------------------------------------------------------ #19: DEMO_MODE is inert in production

  test('DEMO_MODE=true in production: reset, simulate-call and mock-complete are 404', async () => {
    const reset = (await import('@/app/api/demo/reset/route')).POST as any;
    const sim = (await import('@/app/api/demo/simulate-call/route')).POST as any;
    const complete = (await import('@/app/api/pay/mock-complete/route')).POST as any;
    const biz = await newBusiness();
    await withEnv({ DEMO_MODE: 'true', ...PROD }, async () => {
      expect((await reset(req('/api/demo/reset', {}))).status).toBe(404);
      expect((await sim(req('/api/demo/simulate-call', { business_id: biz.id }))).status).toBe(404);
      expect((await complete(req('/api/pay/mock-complete', { booking_id: 'x' }))).status).toBe(404);
    });
    expect(await prisma.business.count({ where: { id: biz.id } })).toBe(1);
  });

  // ------------------------------------------------------------------ #5: number webhook repair route

  test('repair-numbers: admin only, a dry run by default, 503 when Twilio or the public URL is not configured', async () => {
    const repair = (await import('@/app/api/admin/repair-numbers/route')).POST as any;
    const noAuth = new Request('http://app.test/api/admin/repair-numbers', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
    expect((await repair(noAuth)).status).toBe(401);
    expect((await repair(req('/api/admin/repair-numbers', {}))).status).toBe(503); // Twilio is not configured in tests
    const biz = await newBusiness();
    const calls: { method: string; url: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return Response.json({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: biz.phone, sms_url: '', sms_method: 'POST' }] });
    }) as unknown as typeof fetch;
    try {
      await withEnv({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_PHONE_NUMBER: '+13055550100', VOICE_LINE_KIND: 'native' }, async () => {
        const dry = await repair(req('/api/admin/repair-numbers', { business_ids: [biz.id] }));
        expect(dry.status).toBe(200);
        const body = ((await dry.json()) as any).data;
        expect(body.dry_run).toBe(true);
        expect(body.items).toEqual([{ business_id: biz.id, phone: biz.phone, outcome: 'would_update', changed: ['SmsUrl'] }]);
        expect(calls.every((c) => c.method === 'GET')).toBe(true);
        expect((await repair(req('/api/admin/repair-numbers', { business_ids: [biz.id], dry_run: false }))).status).toBe(200);
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/IncomingPhoneNumbers/PN1.json'))).toBe(true);
        expect((await repair(req('/api/admin/repair-numbers', { dry_run: 'no' }))).status).toBe(422);
      });
    } finally { globalThis.fetch = real; }
    expect(await prisma.auditEvent.count({ where: { action: 'admin.repair_numbers' } })).toBeGreaterThanOrEqual(2);
  });

  // ------------------------------------------------------------------ #36: a failed verification email is visible

  test('a failed deferred verification email leaves an audit row and never throws', async () => {
    const flows = await import('@/lib/account-flows');
    const users = await import('@/lib/db/users');
    const email = `fail-${uniq('u')}@example.test`;
    const owned = await newBusiness();
    const u = await users.createUser({ email, password_hash: 'x', role: 'owner', business_id: owned.id });
    try {
      // production without an email provider: EmailConfigError
      const sent = await withEnv({ ...PROD, EMAIL_PROVIDER: undefined, RESEND_API_KEY: undefined, EMAIL_FROM: undefined }, () => flows.sendVerificationEmailReported(u, 'signup'));
      expect(sent).toBe(false);
      const audit = await prisma.auditEvent.findFirst({ where: { action: 'auth.verification_email_failed', target: `user:${u.id}` } });
      expect(audit?.meta).toMatchObject({ source: 'signup', kind: 'email_not_configured' });
      expect(JSON.stringify(audit?.meta)).not.toContain('example.test');
    } finally { await prisma.user.deleteMany({ where: { id: u.id } }); }
  });
});
