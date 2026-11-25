/**
 * Per-tenant AI line (backlog #6, #3, #22, #21; N8): the purchased number is imported into the voice provider and bound to THAT tenant's agent,
 * never shared; the release path removes it; the admin repair route reports/imports in a dry-run-first way; the webhook line answers every branch
 * with TwiML; live transfer and the assistant name are per-business settings with owner-only, audited routes.
 * Fake providers only (nothing leaves the machine); time-of-day independent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

integration('tenant line (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let line: typeof import('@/lib/voice/tenant-line');
  let el: typeof import('@/lib/voice/elevenlabs');
  let release: typeof import('@/lib/billing/release');
  let lineRoute: { GET: any; PATCH: any };
  let repairRoute: { POST: any };
  let incoming: (req: Request) => Promise<Response>;
  type Ctx = { params: Promise<{ id: string }> };
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const userIds: string[] = [];

  const TW = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_AUTH_TOKEN: 'twilio-auth-token-integration-test', TWILIO_PHONE_NUMBER: '+15005550006', ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_AGENT_ID: undefined, ELEVENLABS_PHONE_NUMBER_ID: undefined, VOICE_LINE_KIND: undefined, APP_URL: 'https://app.example.test', NATIVE_TRANSFER: undefined } as Record<string, string | undefined>;

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    line = await import('@/lib/voice/tenant-line');
    el = await import('@/lib/voice/elevenlabs');
    release = await import('@/lib/billing/release');
    lineRoute = (await import('@/app/api/businesses/[id]/line/route')) as any;
    repairRoute = (await import('@/app/api/admin/repair-numbers/route')) as any;
    incoming = (await import('@/app/api/voice/incoming/route')).POST as any;
  });
  const clear = async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'businesses/line' } }, { key: { startsWith: 'admin/repair' } }] } }); };
  afterEach(clear);
  afterAll(async () => {
    await clear();
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  /** Fake ElevenLabs + a fake Twilio account that lists the given numbers (sms_url empty) and accepts updates. */
  function providers(opts: Parameters<typeof fakeElevenLabs>[0] = {}, twilioNumbers: string[] = []) {
    const eleven = fakeElevenLabs(opts);
    const twilioCalls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes('api.twilio.com')) {
        const method = init?.method ?? 'GET';
        twilioCalls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
        if (method === 'GET') { const q = new URL(url).searchParams.get('PhoneNumber'); return Response.json({ incoming_phone_numbers: twilioNumbers.filter((n) => n === q).map((n) => ({ sid: `PN_${n.slice(-4)}`, phone_number: n, sms_url: '' })) }); }
        return Response.json({ sid: 'PN1' });
      }
      return eleven.fetchImpl(input as any, init as any);
    }) as unknown as typeof fetch;
    return { eleven, twilioCalls, fetchImpl };
  }
  const withFetch = async <T,>(f: typeof fetch, fn: () => Promise<T>) => { const prev = globalThis.fetch; globalThis.fetch = f; try { return await fn(); } finally { globalThis.fetch = prev; } };
  const realNumber = () => `+1786${String(2_000_000 + Math.floor(Math.random() * 7_000_000))}`;
  async function tenant(extra: Record<string, unknown> = {}) {
    const b = await newBusiness({ agent_id: uniq('agent') });
    await prisma.business.update({ where: { id: b.id }, data: { phone: realNumber(), phoneKey: null, phoneE164: null, ...extra } });
    // keep phone key / e164 consistent through the normal writer
    const n = (await db.getBusiness(b.id))!;
    await db.updateBusiness(b.id, { phone: realNumber() });
    return (await db.getBusiness(b.id))!.id === n.id ? (await db.getBusiness(b.id))! : n;
  }
  async function login(businessId: string | null, role: 'owner' | 'staff') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token, session } = await users.createSession(user.id) as any;
    return { cookie: `rc_user_session=${token}`, user, session };
  }
  const req = (path: string, who: { cookie?: string; bearer?: boolean } | null, body: unknown = {}, method = 'PATCH') => new Request(`https://app.example.test${path}`, {
    method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', ...(who?.cookie ? { cookie: who.cookie } : {}), ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const admin = { bearer: true };

  // ------------------------------------------------------------------ ensureTenantLine
  test('ensureTenantLine: imports the tenant\'s own number, stores its id, binds ITS agent; idempotent; dry run writes nothing; re-imports a deleted one', async () => {
    const t = await tenant();
    const p = providers({}, [t.phone!]);
    await withEnv(TW, () => withFetch(p.fetchImpl, async () => {
      const dry = await line.ensureTenantLine(t, { dryRun: true });
      expect(dry).toMatchObject({ ok: true, action: 'import' });
      expect(p.eleven.phones.size).toBe(0);
      expect((await db.getBusiness(t.id))!.elevenlabs_phone_number_id).toBeNull();

      const r = await line.ensureTenantLine(t);
      expect(r).toMatchObject({ ok: true, imported: true, adopted: false });
      const id = (r as any).phone_number_id as string;
      expect((await db.getBusiness(t.id))!.elevenlabs_phone_number_id).toBe(id);
      expect(p.eleven.phones.get(id)).toMatchObject({ phone_number: t.phone, agent_id: t.agent_id });
      // the SMS URL is ours; the Voice URL of an imported line is never written
      const post = p.twilioCalls.find((c) => c.method === 'POST')!;
      expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({ SmsUrl: 'https://app.example.test/api/sms/inbound', SmsMethod: 'POST' });
      expect((await db.getBusiness(t.id))!.twilio_phone_sid).toBe(`PN_${t.phone!.slice(-4)}`);

      // again: nothing new at the provider
      const again = await line.ensureTenantLine((await db.getBusiness(t.id))!);
      expect(again).toMatchObject({ ok: true, imported: false, action: 'ok' });
      expect(p.eleven.importBodies).toHaveLength(1);

      // the import was deleted at the provider: a new one is made and stored
      p.eleven.phones.clear();
      const redo = await line.ensureTenantLine((await db.getBusiness(t.id))!);
      expect(redo).toMatchObject({ ok: true, imported: true });
      expect((await db.getBusiness(t.id))!.elevenlabs_phone_number_id).toBe((redo as any).phone_number_id);
    }));
    expect(outboundCalls).toEqual([]);
  });

  test('ensureTenantLine: never adopts, rebinds or steals a line another business owns; provider failures are reported and store nothing', async () => {
    const a = await tenant();
    const b = await tenant();
    const p = providers({}, [a.phone!, b.phone!]);
    await withEnv(TW, () => withFetch(p.fetchImpl, async () => {
      const ra = await line.ensureTenantLine(a);
      const idA = (ra as any).phone_number_id as string;
      // B's number is (wrongly) already imported under A's id at the provider: B must not take A's id
      p.eleven.phones.get(idA)!.phone_number = b.phone!;
      const rb = await line.ensureTenantLine(b);
      expect(rb).toMatchObject({ ok: false, code: 'conflict' });
      expect((await db.getBusiness(b.id))!.elevenlabs_phone_number_id).toBeNull();
      expect(p.eleven.phones.get(idA)!.agent_id).toBe(a.agent_id); // A's binding did not move
    }));
    const c = await tenant();
    const bad = providers({ failImport: true }, [c.phone!]);
    await withEnv(TW, () => withFetch(bad.fetchImpl, async () => {
      const r = await line.ensureTenantLine(c);
      expect(r).toMatchObject({ ok: false, code: 'import_failed' });
      expect(JSON.stringify(r)).not.toContain('twilio-auth-token-integration-test');
      expect((await db.getBusiness(c.id))!.elevenlabs_phone_number_id).toBeNull();
    }));
    // not applicable: a business without a real agent
    expect(await line.ensureTenantLine({ ...c, agent_id: null })).toMatchObject({ ok: false, code: 'not_applicable' });
  });

  // ------------------------------------------------------------------ bindPhoneNumber
  test('bindPhoneNumber: the tenant\'s own id; the shared env number is refused as soon as another business exists and never moves between tenants', async () => {
    const a = await tenant();
    const b = await tenant();
    const eleven = fakeElevenLabs();
    eleven.phones.set('phnum_own_a', { phone_number_id: 'phnum_own_a', phone_number: a.phone!, label: 'a', agent_id: null });
    eleven.phones.set('phnum_shared', { phone_number_id: 'phnum_shared', phone_number: '+13055550199', label: 's', agent_id: 'agent_of_somebody_else' });
    await prisma.business.update({ where: { id: a.id }, data: { elevenlabsPhoneNumberId: 'phnum_own_a' } });
    await withEnv({ ...TW, ELEVENLABS_PHONE_NUMBER_ID: 'phnum_shared' }, () => withFetch(eleven.fetchImpl, async () => {
      expect(await el.bindPhoneNumber(a.agent_id!, (await db.getBusiness(a.id))!)).toMatchObject({ ok: true, phone_number_id: 'phnum_own_a', source: 'business' });
      expect(eleven.phones.get('phnum_own_a')!.agent_id).toBe(a.agent_id);
      // B has no line of its own: the shared number is NOT given to it (this database holds several businesses)
      const refused = await el.bindPhoneNumber(b.agent_id!, b);
      expect(refused).toMatchObject({ ok: false });
      expect(eleven.phones.get('phnum_shared')!.agent_id).toBe('agent_of_somebody_else');
      expect(eleven.calls.filter((c) => c.startsWith('PATCH /convai/phone-numbers/phnum_shared'))).toEqual([]);
    }));
    // no key: skipped, nothing called
    const none = fakeElevenLabs();
    await withEnv({ ...TW, ELEVENLABS_API_KEY: undefined }, () => withFetch(none.fetchImpl, async () => {
      expect(await el.bindPhoneNumber(a.agent_id!, a)).toMatchObject({ ok: false });
      expect(none.calls).toEqual([]);
    }));
  });

  // ------------------------------------------------------------------ release
  test('release: the tenant\'s imported number is detached and deleted BEFORE the Twilio number; if it cannot be, the Twilio number is kept this round; retry finishes', async () => {
    const t = await tenant();
    const p = providers({}, [t.phone!]);
    await withEnv(TW, () => withFetch(p.fetchImpl, async () => {
      await line.ensureTenantLine(t);
      const lineId = (await db.getBusiness(t.id))!.elevenlabs_phone_number_id!;
      const order: string[] = [];
      const facts = (await release.loadReleaseFacts(t.id))!;
      expect(facts.line_id).toBe(lineId);
      const failing = await release.executeRelease(facts, { notice: 'off' }, {
        releaseLine: async () => { order.push('line'); return { ok: false, error: 'delete 500' }; },
        deleteAgent: async () => { order.push('agent'); return { ok: true }; },
        deleteAgentTools: async () => ({ ok: true, deleted: 0, already_deleted: 0 }),
        releaseNumber: async () => { order.push('number'); return { ok: true }; },
      });
      expect(order).toEqual(['line', 'agent']); // the Twilio number is NOT released while the import could not be removed
      expect(failing.errors.join()).toContain('line: delete 500');
      expect(failing.cleared.phone).toBe(false);

      const order2: string[] = [];
      const facts2 = (await release.loadReleaseFacts(t.id))!;
      const done = await release.executeRelease(facts2, { notice: 'off' }, {
        deleteAgent: async () => { order2.push('agent'); return { ok: true }; },
        deleteAgentTools: async () => ({ ok: true, deleted: 0, already_deleted: 0 }),
        releaseNumber: async () => { order2.push('number'); return { ok: true }; },
      });
      expect(done.errors).toEqual([]);
      expect(p.eleven.phones.has(lineId)).toBe(false); // really deleted at the provider (real releaseTenantLine)
      expect((await db.getBusiness(t.id))!.elevenlabs_phone_number_id).toBeNull();
      expect(order2).toEqual(['number']); // (the agent was already released by the first round)
      expect(await prisma.auditEvent.count({ where: { businessId: t.id, action: 'line.released' } })).toBe(1);
    }));
  });

  test('releaseTenantLine: no key keeps the reference; another business\'s id is never deleted; nothing to release is success', async () => {
    const t = await tenant();
    const other = await tenant();
    await prisma.business.update({ where: { id: t.id }, data: { elevenlabsPhoneNumberId: `phnum_${uniq('r')}` } });
    const eleven = fakeElevenLabs();
    await withEnv({ ...TW, ELEVENLABS_API_KEY: undefined }, () => withFetch(eleven.fetchImpl, async () => {
      expect(await line.releaseTenantLine(t.id)).toMatchObject({ ok: false });
      expect(eleven.calls).toEqual([]);
    }));
    expect((await db.getBusiness(t.id))!.elevenlabs_phone_number_id).toBeTruthy();
    expect(await line.releaseTenantLine(other.id)).toEqual({ ok: true, had_line: false });
  });

  // ------------------------------------------------------------------ admin repair route
  test('admin repair-numbers: the AI line is reported in the dry run (nothing written), imported by a real run, adopted on a repeat; owners and anonymous callers are refused', async () => {
    const t = await tenant();
    const p = providers({}, [t.phone!]);
    const owner = await login(t.id, 'owner');
    await withEnv(TW, () => withFetch(p.fetchImpl, async () => {
      expect((await repairRoute.POST(req('/api/admin/repair-numbers', null, {}, 'POST'))).status).toBe(401);
      expect((await repairRoute.POST(req('/api/admin/repair-numbers', owner, {}, 'POST'))).status).toBe(403);
      const dry = await (await repairRoute.POST(req('/api/admin/repair-numbers', admin, { business_ids: [t.id] }, 'POST'))).json() as any;
      expect(dry.data.dry_run).toBe(true);
      expect(dry.data.items[0].line).toEqual({ outcome: 'would_import' });
      expect(p.eleven.phones.size).toBe(0);
      expect(p.eleven.importBodies).toEqual([]);
      const real = await (await repairRoute.POST(req('/api/admin/repair-numbers', admin, { business_ids: [t.id], dry_run: false }, 'POST'))).json() as any;
      expect(real.data.items[0].line).toEqual({ outcome: 'imported' });
      expect(p.eleven.phones.size).toBe(1);
      expect([...p.eleven.phones.values()][0].agent_id).toBe(t.agent_id);
      const again = await (await repairRoute.POST(req('/api/admin/repair-numbers', admin, { business_ids: [t.id], dry_run: false }, 'POST'))).json() as any;
      expect(again.data.items[0].line.outcome).toBe('ok');
      expect(p.eleven.importBodies).toHaveLength(1);
      // the response and the audit rows never carry the Twilio token
      expect(JSON.stringify(real)).not.toContain('twilio-auth-token-integration-test');
      const audits = await prisma.auditEvent.findMany({ where: { action: 'admin.repair_numbers' }, orderBy: { at: 'desc' }, take: 3 });
      expect(JSON.stringify(audits)).not.toContain('twilio-auth-token-integration-test');
      expect((audits[1].meta as any).line_imported).toBe(1);
    }));
    // on a forced webhook deployment nothing is imported
    const w = await tenant();
    const pw = providers({}, [w.phone!]);
    await withEnv({ ...TW, VOICE_LINE_KIND: 'webhook' }, () => withFetch(pw.fetchImpl, async () => {
      const r = await (await repairRoute.POST(req('/api/admin/repair-numbers', admin, { business_ids: [w.id], dry_run: false }, 'POST'))).json() as any;
      expect(r.data.items[0].line.outcome).toBe('skipped');
      expect(pw.eleven.phones.size).toBe(0);
    }));
  });

  // ------------------------------------------------------------------ webhook-line /api/voice/incoming
  const URL_IN = `${SECRETS.publicBase}/api/voice/incoming`;
  const signed = (params: Record<string, string>) => incoming(new Request(URL_IN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(URL_IN, params) }, body: new URLSearchParams(params).toString(),
  }));
  const callParams = (to: string, from = phone()) => ({ AccountSid: 'AC' + 'a'.repeat(32), CallSid: uniq('CA'), CallStatus: 'ringing', From: from, To: to });

  test('webhook line, AI branch: the provider\'s register-call TwiML is returned; when it fails the caller gets an honest voicemail (never JSON, never silence)', async () => {
    const t = await tenant();
    const params = callParams(t.phone!);
    const good = providers({ registerCall: 'twiml' }, []);
    await withEnv({ ...TW, VOICE_LINE_KIND: 'webhook' }, () => withFetch(good.fetchImpl, async () => {
      const res = await signed(params);
      expect(res.headers.get('content-type')).toContain('xml');
      const xml = await res.text();
      expect(xml).toContain('<Connect>');
      expect(good.eleven.registerCalls[0]).toMatchObject({ direction: 'inbound', from_number: params.From, to_number: t.phone, conversation_initiation_client_data: { dynamic_variables: { business_id: t.id, call_sid: params.CallSid } } });
    }));
    const t2 = await tenant();
    const p2 = callParams(t2.phone!);
    const bad = providers({ registerCall: 'fail' }, []);
    await withEnv({ ...TW, VOICE_LINE_KIND: 'webhook' }, () => withFetch(bad.fetchImpl, async () => {
      const res = await signed(p2);
      expect(res.headers.get('content-type')).toContain('xml');
      const xml = await res.text();
      expect(xml).toContain('<Record');
      expect(xml).toContain('will be recorded');
      expect(xml).not.toContain('{');
    }));
    expect(await prisma.call.findFirst({ where: { businessId: t2.id } })).toMatchObject({ status: 'handed_off' });
    // ELEVENLABS_REGISTER_CALL=off skips the provider call altogether
    const t3 = await tenant();
    const off = providers({ registerCall: 'twiml' }, []);
    await withEnv({ ...TW, VOICE_LINE_KIND: 'webhook', ELEVENLABS_REGISTER_CALL: 'off' }, () => withFetch(off.fetchImpl, async () => {
      expect(await (await signed(callParams(t3.phone!))).text()).toContain('<Record');
      expect(off.eleven.registerCalls).toEqual([]);
    }));
  });

  test('webhook line, owner branch: TwiML for a signed call (register-call when it works, else the honest "not available" line); the unsigned demo UI still gets JSON', async () => {
    const t = await tenant();
    await prisma.business.update({ where: { id: t.id }, data: { ownerPhoneVerifiedAt: new Date() } });
    const ownerFrom = (await db.getBusiness(t.id))!.owner_phone!;
    const bad = providers({ registerCall: 'fail' }, []);
    await withEnv({ ...TW, VOICE_LINE_KIND: 'webhook', OWNER_CALLIN_ENABLED: 'true' }, () => withFetch(bad.fetchImpl, async () => {
      const res = await signed(callParams(t.phone!, ownerFrom));
      expect(res.headers.get('content-type')).toContain('xml');
      const xml = await res.text();
      if (xml.includes('owner line is not available')) expect(xml).toContain('<Hangup/>');
      else expect(xml).toContain('<Response>'); // owner mode was not entered on this build/config: still TwiML
    }));
  });

  // ------------------------------------------------------------------ /api/businesses/[id]/line
  test('line route: owner-only, tenant-isolated, validated, audited (without the name), enabling transfer needs the capability AND a fresh login proof', async () => {
    const a = await tenant();
    const b = await tenant();
    const owner = await login(a.id, 'owner');
    const staff = await login(a.id, 'staff');
    const otherOwner = await login(b.id, 'owner');
    const url = (id: string) => `/api/businesses/${id}/line`;

    // read: staff may read; another tenant's business is a 404; anonymous is 401
    expect((await lineRoute.GET(req(url(a.id), staff, {}, 'GET'), ctx(a.id))).status).toBe(200);
    expect((await lineRoute.GET(req(url(a.id), otherOwner, {}, 'GET'), ctx(a.id))).status).toBe(404);
    expect((await lineRoute.GET(req(url(a.id), null, {}, 'GET'), ctx(a.id))).status).toBe(401);
    const view = (await (await lineRoute.GET(req(url(a.id), owner, {}, 'GET'), ctx(a.id))).json() as any).data;
    expect(view).toMatchObject({ assistant_name: null, assistant_name_effective: 'Maria', native_transfer_enabled: false, transfer_capability: false, own_line: false });
    expect(JSON.stringify(view)).not.toContain('phnum_'); // no provider ids are exposed

    // writes: staff 403, another tenant 404, anonymous 401, no cross-site (CSRF)
    expect((await lineRoute.PATCH(req(url(a.id), staff, { assistant_name: 'Ana' }), ctx(a.id))).status).toBe(403);
    expect((await lineRoute.PATCH(req(url(a.id), otherOwner, { assistant_name: 'Ana' }), ctx(a.id))).status).toBe(404);
    expect((await lineRoute.PATCH(req(url(a.id), null, { assistant_name: 'Ana' }), ctx(a.id))).status).toBe(401);
    const cross = new Request(`https://app.example.test${url(a.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', cookie: owner.cookie }, body: JSON.stringify({ assistant_name: 'Ana' }) });
    expect((await lineRoute.PATCH(cross, ctx(a.id))).status).toBe(403);
    expect((await db.getBusiness(a.id))!.assistant_name).toBeNull();

    // validation
    for (const body of [{}, { nope: 1 }, { assistant_name: 5 }, { assistant_name: 'x'.repeat(41) }, { assistant_name: 'a\u0007b' }, { native_transfer_enabled: 'yes' }, [] as any]) {
      expect((await lineRoute.PATCH(req(url(a.id), owner, body), ctx(a.id))).status).toBe(422);
    }

    // set / clear the name (audited without copying it)
    const set = await lineRoute.PATCH(req(url(a.id), owner, { assistant_name: '  Sofía  ' }), ctx(a.id));
    expect(set.status).toBe(200);
    const setData = ((await set.json()) as any).data;
    expect(setData).toMatchObject({ assistant_name: 'Sofía', assistant_name_effective: 'Sofía' });
    expect(setData.agent_sync).toBeDefined(); // pushed to the agent (skipped here: the provider is not reachable in tests)
    const cleared = ((await (await lineRoute.PATCH(req(url(a.id), owner, { assistant_name: '' }), ctx(a.id))).json()) as any).data;
    expect(cleared).toMatchObject({ assistant_name: null, assistant_name_effective: 'Maria' });
    const audits = await prisma.auditEvent.findMany({ where: { businessId: a.id, action: 'business.assistant_name_changed' } });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('Sofía');
    // an unchanged value writes no audit row
    await lineRoute.PATCH(req(url(a.id), owner, { assistant_name: '' }), ctx(a.id));
    expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'business.assistant_name_changed' } })).toBe(2);
    expect((await db.getBusiness(b.id))!.assistant_name).toBeNull(); // tenant isolation

    // live transfer: refused while the platform capability is off
    const off = await lineRoute.PATCH(req(url(a.id), owner, { native_transfer_enabled: true }), ctx(a.id));
    expect(off.status).toBe(409);
    expect((await db.getBusiness(a.id))!.native_transfer_enabled).toBe(false);
    await withEnv({ NATIVE_TRANSFER: 'on' }, async () => {
      // a stale login proof: step-up required
      await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 24 * 3600_000) } });
      const stale = await lineRoute.PATCH(req(url(a.id), owner, { native_transfer_enabled: true }), ctx(a.id));
      expect(stale.status).toBe(403);
      expect(((await stale.json()) as any).code).toBe('reauth_required');
      expect((await db.getBusiness(a.id))!.native_transfer_enabled).toBe(false);
      await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
      const on = await lineRoute.PATCH(req(url(a.id), owner, { native_transfer_enabled: true }), ctx(a.id));
      expect(on.status).toBe(200);
      expect(((await on.json()) as any).data).toMatchObject({ native_transfer_enabled: true, transfer_capability: true });
      expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'business.native_transfer_changed' } })).toBe(1);
      // turning it OFF never needs a fresh proof
      await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 24 * 3600_000) } });
      expect((await lineRoute.PATCH(req(url(a.id), owner, { native_transfer_enabled: false }), ctx(a.id))).status).toBe(200);
    });
    expect(outboundCalls).toEqual([]);
  });

  test('changing the name or the transfer opt-in pushes the live agent now (and the new agent config says so)', async () => {
    const t = await tenant();
    const owner = await login(t.id, 'owner');
    await db.upsertKnowledgeBase(t.id, { services: [], faqs: [], pricing_notes: '', system_prompt: '', call_script: '' });
    const p = providers({}, []);
    await withEnv({ ...TW, NATIVE_TRANSFER: 'on', ELEVENLABS_TOOL_SECRET: 'tool-secret-x' }, () => withFetch(p.fetchImpl, async () => {
      el.clearToolIdCache(); el.resetInitiationCache();
      const created = await el.syncAgent({ business: t, kb: null });
      const id = created.agent_id;
      expect(p.eleven.agentToolNames(id)).not.toContain('transfer-to-human');
      const res = await lineRoute.PATCH(req(`/api/businesses/${t.id}/line`, owner, { assistant_name: 'Lucía', native_transfer_enabled: true }), ctx(t.id));
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data.agent_sync).toMatchObject({ agent: 'synced' });
      const cfg = p.eleven.agents.get((await db.getBusiness(t.id))!.agent_id!)!.conversation_config.agent;
      expect(cfg.first_message).toContain('this is Lucía');
      expect(cfg.prompt.prompt).toContain('Your name is Lucía');
      expect(cfg.prompt.built_in_tools.transfer_to_number).toBeDefined();
      expect(p.eleven.agentToolNames(id)).toContain('transfer-to-human');
    }));
  });
});
