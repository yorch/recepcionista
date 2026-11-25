/**
 * Phase 2 telephony (postgres, fake providers): live transcript poller + SSE + polling fallback, native transfer, call screening,
 * STIR/SHAKEN buckets, metering reconciliation, cap warnings, language detection config.
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq } from '../helpers/fixtures';
import { hashPassword } from '../../src/lib/password';

const ACCOUNT = `AC${'b'.repeat(32)}`;

integration('telephony phase 2 (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let live: typeof import('@/lib/voice/live-transcript');
  let reconcile: typeof import('@/lib/voice/reconcile');
  let warnings: typeof import('@/lib/billing/warnings');
  let postcall: typeof import('@/lib/voice/postcall');
  let el: typeof import('@/lib/voice/elevenlabs');
  type Ctx = { params: Promise<{ id: string }> };
  let liveRoute: { GET: (r: Request, c: Ctx) => Promise<Response> };
  let transcriptRoute: { GET: (r: Request, c: Ctx) => Promise<Response> };
  let pushRoute: { POST: (r: Request) => Promise<Response> };
  let incoming: (r: Request) => Promise<Response>;
  let screen: (r: Request) => Promise<Response>;
  let voicemail: (r: Request) => Promise<Response>;
  let initiation: (r: Request) => Promise<Response>;
  let toolsRoute: { POST: (r: Request, c: { params: Promise<{ tool: string }> }) => Promise<Response> };
  const userIds: string[] = [];
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    live = await import('@/lib/voice/live-transcript');
    reconcile = await import('@/lib/voice/reconcile');
    warnings = await import('@/lib/billing/warnings');
    postcall = await import('@/lib/voice/postcall');
    el = await import('@/lib/voice/elevenlabs');
    liveRoute = await import('@/app/api/calls/[id]/live/route');
    transcriptRoute = await import('@/app/api/calls/[id]/transcript/route');
    pushRoute = await import('@/app/api/voice/transcript-event/route');
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
    screen = (await import('@/app/api/voice/screen/route')).POST;
    voicemail = (await import('@/app/api/voice/voicemail/route')).POST;
    initiation = (await import('@/app/api/voice/initiation/route')).POST;
    toolsRoute = await import('@/app/api/voice/tools/[tool]/route');
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  beforeEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'voice/' } } });
  });

  async function login(businessId: string, role: 'owner' | 'staff' = 'staff') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: await hashPassword('correct horse battery staple'), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id, { mfaVerified: false });
    return { cookie: `rc_user_session=${token}`, userId: user.id };
  }
  const get = (url: string, headers: Record<string, string> = {}) => new Request(`https://app.example.test${url}`, { method: 'GET', headers });
  async function newCall(biz: { id: string }, patch: Record<string, unknown> = {}) {
    return prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), conversationId: uniq('conv'), callerPhone: phone(), status: 'in_progress', consentStatus: 'disclosed', recordingDisclosed: true, ...patch } });
  }
  const turns = (...t: [string, string][]) => t.map(([role, message], i) => ({ role, message, time_in_call_secs: i * 3 }));
  function fakeSource(getTurns: () => { role: string; message: string; time_in_call_secs: number }[], opts: { ended?: () => boolean } = {}) {
    let calls = 0;
    const source: import('@/lib/voice/live-transcript').LiveTranscriptSource = {
      async snapshot(call) {
        calls++;
        await new Promise((r) => setTimeout(r, 15));
        const { parseConversation } = await import('@/lib/voice/conversations');
        const snap = parseConversation({ status: opts.ended?.() ? 'done' : 'in-progress', transcript: getTurns(), metadata: { call_duration_secs: 30 } });
        return { events: (await import('@/lib/voice/live-transcript')).snapshotToEvents(snap, call.started_at), ended: snap.status === 'done' };
      },
    };
    return { source, calls: () => calls };
  }

  // ============================================================ 1. live transcript
  test('poller: ten concurrent viewers cause ONE upstream poll per window and no duplicate rows', async () => {
    const biz = await newBusiness(); const call = await newCall(biz);
    const fake = fakeSource(() => turns(['agent', 'Hello'], ['user', 'My AC broke']));
    const out = await Promise.all(Array.from({ length: 10 }, () => live.requestPoll(call.id, { source: fake.source, leaseMs: 5000 })));
    expect(fake.calls()).toBe(1);
    expect(out.filter((o) => o === 'polled').length).toBe(1);
    expect(out.filter((o) => o === 'shared').length).toBe(9);
    const rows = await prisma.callTranscriptEvent.findMany({ where: { callId: call.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.seq, r.role, r.text])).toEqual([[0, 'agent', 'Hello'], [1, 'caller', 'My AC broke']]);
    // the next window picks up only the new line; the same text is never stored twice
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call.id}` } });
    const more = fakeSource(() => turns(['agent', 'Hello'], ['user', 'My AC broke'], ['agent', 'Can I get your address?']));
    await live.requestPoll(call.id, { source: more.source, leaseMs: 5000 });
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(3);
  });

  test('declined or undisclosed consent: nothing is ever stored', async () => {
    const biz = await newBusiness();
    const fake = fakeSource(() => turns(['agent', 'Hello'], ['user', 'Hi']));
    for (const consent of ['declined', 'unknown']) {
      const call = await newCall(biz, { consentStatus: consent });
      const o = await live.requestPoll(call.id, { source: fake.source, leaseMs: 1 });
      expect(['declined', 'not_consented']).toContain(o);
      expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
    }
    expect(fake.calls()).toBe(0);
    // the helper itself refuses too
    const d = await newCall(biz, { consentStatus: 'declined' });
    expect(await db.appendTranscriptEvents(d.id, [{ seq: 0, role: 'caller', text: 'x', at: new Date() }])).toEqual({ ok: false, reason: 'consent_declined' });
  });

  test('a caller who objects mid-call: sticky decline, stored lines purged, nothing new stored', async () => {
    const biz = await newBusiness(); const call = await newCall(biz);
    const ok = fakeSource(() => turns(['agent', 'This call may be recorded'], ['user', 'ok']));
    await live.requestPoll(call.id, { source: ok.source, leaseMs: 1 });
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(2);
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call.id}` } });
    const bad = fakeSource(() => turns(['agent', 'This call may be recorded'], ['user', 'ok'], ['user', "I don't want to be recorded"]));
    expect(await live.requestPoll(call.id, { source: bad.source, leaseMs: 1 })).toBe('declined');
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.consentStatus).toBe('declined');
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call.id}` } });
    expect(await live.requestPoll(call.id, { source: ok.source, leaseMs: 1 })).toBe('declined');
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
  });

  test('post-call transcript replaces the interim rows (source of truth)', async () => {
    const biz = await newBusiness({ agent_id: uniq('agent') }); const call = await newCall(biz);
    await db.appendTranscriptEvents(call.id, [{ seq: 0, role: 'agent', text: 'interim guess', at: new Date() }, { seq: 1, role: 'caller', text: 'stale', at: new Date() }, { seq: 2, role: 'agent', text: 'extra', at: new Date() }]);
    await live.reconcileFinalTranscript(call.id, turns(['agent', 'Final one'], ['user', 'Final two']), new Date().toISOString());
    const rows = await prisma.callTranscriptEvent.findMany({ where: { callId: call.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.text)).toEqual(['Final one', 'Final two']);
  });

  test('SSE: auth required, tenant isolation (404), staff allowed, limits (429), Last-Event-ID resume, no buffering headers', async () => {
    const a = await newBusiness(); const b = await newBusiness();
    const call = await newCall(a, { consentStatus: 'unknown' });
    await prisma.call.update({ where: { id: call.id }, data: { consentStatus: 'disclosed' } });
    await db.appendTranscriptEvents(call.id, [0, 1, 2, 3].map((i) => ({ seq: i, role: i % 2 ? 'caller' as const : 'agent' as const, text: `line ${i}`, at: new Date() })));
    const staffA = await login(a.id, 'staff'); const staffB = await login(b.id, 'staff'); const staffA2 = await login(a.id, 'staff');

    expect((await liveRoute.GET(get(`/api/calls/${call.id}/live`), ctx(call.id))).status).toBe(401);
    expect((await liveRoute.GET(get(`/api/calls/${call.id}/live`, { cookie: staffB.cookie }), ctx(call.id))).status).toBe(404);
    expect((await transcriptRoute.GET(get(`/api/calls/${call.id}/transcript`, { cookie: staffB.cookie }), ctx(call.id))).status).toBe(404);

    await withEnv({ LIVE_MAX_PER_USER: '1' }, async () => {
      const ac = new AbortController();
      const res = await liveRoute.GET(new Request(`https://app.example.test/api/calls/${call.id}/live`, { headers: { cookie: staffA.cookie, 'last-event-id': '1' }, signal: ac.signal }), ctx(call.id));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      expect(res.headers.get('cache-control')).toContain('no-transform');
      // second stream of the same user: over the limit
      const second = await liveRoute.GET(get(`/api/calls/${call.id}/live`, { cookie: staffA.cookie }), ctx(call.id));
      expect(second.status).toBe(429);
      // another user of the same business is not affected by that user's limit
      const other = await liveRoute.GET(new Request(`https://app.example.test/api/calls/${call.id}/live`, { headers: { cookie: staffA2.cookie } }), ctx(call.id));
      expect(other.status).toBe(200);
      await other.body!.cancel();
      const reader = res.body!.getReader(); let text = '';
      const end = Date.now() + 5000;
      while (Date.now() < end && !text.includes('id: 3')) { const r = await reader.read(); if (r.value) text += new TextDecoder().decode(r.value); if (r.done) break; }
      expect(text).toContain('id: 2\nevent: transcript');
      expect(text).toContain('id: 3\nevent: transcript');
      expect(text).not.toContain('id: 1\n');
      ac.abort(); await reader.cancel().catch(() => undefined);
    });
    // the slot is free again after the stream closed
    await new Promise((r) => setTimeout(r, 50));
    const again = await liveRoute.GET(get(`/api/calls/${call.id}/live`, { cookie: staffA.cookie }), ctx(call.id));
    expect(again.status).toBe(200); await again.body!.cancel();
  });

  test('polling fallback: ?after= returns only newer events; consent not disclosed returns none', async () => {
    const a = await newBusiness(); const call = await newCall(a);
    await db.appendTranscriptEvents(call.id, [0, 1, 2].map((i) => ({ seq: i, role: 'agent' as const, text: `t${i}`, at: new Date() })));
    const u = await login(a.id);
    const res = await transcriptRoute.GET(get(`/api/calls/${call.id}/transcript?after=0`, { cookie: u.cookie }), ctx(call.id));
    const j = await res.json() as { data: { events: { seq: number }[]; next_after: number; consent: string } };
    expect(j.data.events.map((e) => e.seq)).toEqual([1, 2]); expect(j.data.next_after).toBe(2);
    const quiet = await newCall(a, { consentStatus: 'unknown' });
    const j2 = await (await transcriptRoute.GET(get(`/api/calls/${quiet.id}/transcript`, { cookie: u.cookie }), ctx(quiet.id))).json() as { data: { events: unknown[] } };
    expect(j2.data.events).toEqual([]);
  });

  test('POST /api/voice/transcript-event: secret required, idempotent by seq, consent gated, objection declines', async () => {
    const biz = await newBusiness(); const call = await newCall(biz);
    const send = (body: unknown, headers: Record<string, string> = { 'x-recepcionista-tool-secret': SECRETS.toolSecret }) =>
      pushRoute.POST(new Request('https://app.example.test/api/voice/transcript-event', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
    const evs = [{ seq: 0, role: 'agent', text: 'hi' }, { seq: 1, role: 'caller', text: 'hello' }];
    expect((await send({ call_sid: call.callSid, events: evs }, {})).status).toBe(401);
    expect(((await (await send({ call_sid: call.callSid, events: evs })).json()) as { stored: number }).stored).toBe(2);
    expect(((await (await send({ call_sid: call.callSid, events: evs })).json()) as { stored: number }).stored).toBe(0); // retry: nothing new
    expect((await send({ call_sid: 'nope', events: evs })).status).toBe(404);
    const unknown = await newCall(biz, { consentStatus: 'unknown' });
    expect(((await (await send({ call_sid: unknown.callSid, events: evs })).json()) as { ignored: string }).ignored).toBe('consent_not_disclosed');
    expect(await prisma.callTranscriptEvent.count({ where: { callId: unknown.id } })).toBe(0);
    const r = await (await send({ call_sid: call.callSid, events: [{ seq: 2, role: 'caller', text: "please don't record me" }] })).json() as { declined?: boolean };
    expect(r.declined).toBe(true);
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
  });

  // ============================================================ 4. STIR trust
  const URL_IN = `${SECRETS.publicBase}/api/voice/incoming`;
  const formPost = (url: string, params: Record<string, string>, h: (r: Request) => Promise<Response>) => h(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString(),
  }));
  const FWD = { callMode: 'forward', forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() };
  const ring = (biz: { phone?: string | null }, from: string, stir?: string, sid: string = uniq('CA')) =>
    formPost(URL_IN, { AccountSid: ACCOUNT, CallSid: sid, CallStatus: 'ringing', From: from, To: biz.phone!, ...(stir ? { StirVerstat: stir } : {}) }, incoming);
  const kindOf = (xml: string) => (xml.includes('<Dial') ? 'dial' : xml.includes('<Record') ? 'record' : 'hangup');

  test('STIR: the verstat is stored on the call; only attestation A has a per-caller identity (spoofed known-number flooding)', () => withEnv({ FORWARD_MAX_CONCURRENT: '50' }, async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const known = phone();
    await prisma.booking.create({ data: { businessId: biz.id, customerName: 'Known', customerPhone: known, phoneE164: known, service: 'AC', scheduledAt: new Date(Date.now() + 86_400_000) } });

    // an attacker spoofs the known customer's number, with no attestation: 12 calls
    const spoof: string[] = [];
    for (let i = 0; i < 12; i++) spoof.push(kindOf(await (await ring(biz, known)).text()));
    expect(spoof.filter((k) => k === 'dial').length).toBe(5); // the shared stranger bucket (FORWARD_WITHHELD_PER_HOUR=5), not the known customer's own
    // a FAILED attestation lands in a stricter bucket of its own
    const failed: string[] = [];
    for (let i = 0; i < 6; i++) failed.push(kindOf(await (await ring(biz, known, 'TN-Validation-Failed-A')).text()));
    expect(failed.filter((k) => k === 'dial').length).toBe(2);
    // the real, verified customer still gets through, and their own bucket is untouched by the attacker
    const real = await ring(biz, known, 'TN-Validation-Passed-A', 'CA-real-' + uniq('x'));
    expect(kindOf(await real.text())).toBe('dial');
    const own = await prisma.rateLimitBucket.findMany({ where: { key: { startsWith: `voice/forward:caller:${biz.id}:` } } });
    expect(own.filter((r) => !/:(unverified|failed|withheld)$/.test(r.key)).reduce((n, r) => n + r.count, 0)).toBe(1);
    const stored = await prisma.call.findMany({ where: { businessId: biz.id, callerPhone: known }, orderBy: { startedAt: 'asc' } });
    expect(stored.some((c) => c.stirStatus === 'TN-Validation-Passed-A' && c.callerVerified === true)).toBe(true);
    expect(stored.some((c) => c.stirStatus === 'TN-Validation-Failed-A' && c.callerVerified === false)).toBe(true);
    expect(stored[0].stirStatus).toBeNull();
  }));

  // ============================================================ 3. screening
  test('screening: the forward leg carries the whisper, accept bridges, decline/no input fall to voicemail with NOTHING metered', async () => {
    const biz = await newBusiness({ name: 'Cool Air Co' });
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const from = phone(); const sid = uniq('CA');
    const dial = await (await ring(biz, from, 'TN-Validation-Passed-A', sid)).text();
    expect(dial).toContain('<Number url="/api/voice/screen" method="POST"');
    const URL_SCREEN = `${SECRETS.publicBase}/api/voice/screen`;
    const child = { AccountSid: ACCOUNT, CallSid: uniq('CAchild'), ParentCallSid: sid };
    const prompt = await (await formPost(URL_SCREEN, child, screen)).text();
    expect(prompt).toContain('Cool Air Co call from');
    expect(prompt).toContain(from.replace('+', '').split('').join(' '));
    expect(prompt).toContain('Press 1 to accept');
    // 1 = decline path first (this call): press 2
    const declined = await (await formPost(URL_SCREEN, { ...child, Digits: '2' }, screen)).text();
    expect(declined).toContain('<Hangup/>');
    const URL_VM = `${SECRETS.publicBase}/api/voice/voicemail`;
    const vm = await (await formPost(URL_VM, { AccountSid: ACCOUNT, CallSid: sid, DialCallStatus: 'completed', DialCallDuration: '25' }, voicemail)).text();
    expect(vm).toContain('<Record'); // treated as unanswered: the caller gets the voicemail
    const usage = await db.getUsage(biz.id);
    expect(usage!.forward_seconds).toBe(0);

    // accepted: bridged seconds are metered
    const sid2 = uniq('CA');
    await ring(biz, phone(), 'TN-Validation-Passed-A', sid2);
    const child2 = { AccountSid: ACCOUNT, CallSid: uniq('CAchild'), ParentCallSid: sid2 };
    await formPost(URL_SCREEN, child2, screen);
    expect(await (await formPost(URL_SCREEN, { ...child2, Digits: '1' }, screen)).text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const done = await (await formPost(URL_VM, { AccountSid: ACCOUNT, CallSid: sid2, DialCallStatus: 'completed', DialCallDuration: '120' }, voicemail)).text();
    expect(done).toContain('<Hangup/>');
    expect((await db.getUsage(biz.id))!.forward_seconds).toBe(120);

    // carrier voicemail answered (no input at all): started but never accepted -> unanswered, nothing metered
    const sid3 = uniq('CA');
    await ring(biz, phone(), 'TN-Validation-Passed-A', sid3);
    await formPost(URL_SCREEN, { AccountSid: ACCOUNT, CallSid: uniq('CAchild'), ParentCallSid: sid3 }, screen);
    const vm3 = await (await formPost(URL_VM, { AccountSid: ACCOUNT, CallSid: sid3, DialCallStatus: 'completed', DialCallDuration: '40' }, voicemail)).text();
    expect(vm3).toContain('<Record');
    expect((await db.getUsage(biz.id))!.forward_seconds).toBe(120);
    // an unsigned request is refused
    expect((await screen(new Request(URL_SCREEN, { method: 'POST', body: new URLSearchParams(child).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).status).toBe(403);
  });

  // ============================================================ 2. native transfer
  const init = (agentId: string, calledNumber: string, callSid: string, callerId = phone()) => initiation(new Request('https://app.example.test/api/voice/initiation', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret },
    body: JSON.stringify({ agent_id: agentId, called_number: calledNumber, caller_id: callerId, call_sid: callSid, conversation_id: uniq('conv') }),
  }));
  type InitBody = { dynamic_variables: Record<string, string>; conversation_config_override: { agent: { first_message: string } } };

  test('transfer: flag off keeps the honest paused script and never gives a destination', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const body = await (await init(biz.agent_id!, biz.phone!, uniq('CA'))).json() as InitBody;
    expect(body.dynamic_variables.transfer_destination).toBe('');
    expect(body.dynamic_variables.transfer_mode).toBe('off');
    expect(body.conversation_config_override.agent.first_message).toContain('not taking bookings by phone');
  });

  test('transfer: flag on, forward mode -> verified number per call, disclosure first, caps charged, status attempted', () => withEnv({ NATIVE_TRANSFER: 'on', FORWARD_MAX_CONCURRENT: '1', FORWARD_WITHHELD_PER_HOUR: '50' }, async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const sid = uniq('CA');
    const body = await (await init(biz.agent_id!, biz.phone!, sid)).json() as InitBody;
    expect(body.dynamic_variables.transfer_mode).toBe('forward');
    expect(body.dynamic_variables.transfer_destination).toBe('+13055550142');
    const first = body.conversation_config_override.agent.first_message;
    expect(first.toLowerCase()).toContain('recorded'); // the disclosure comes first
    expect(first).toContain('connecting you');
    expect((await prisma.call.findUnique({ where: { callSid: sid } }))!.transferStatus).toBe('attempted');
    // concurrency 1: a second simultaneous transfer is refused -> paused script, no destination
    const second = await (await init(biz.agent_id!, biz.phone!, uniq('CA'))).json() as InitBody;
    expect(second.dynamic_variables.transfer_destination).toBe('');
    expect(second.conversation_config_override.agent.first_message).toContain('not taking bookings by phone');
  }));

  test('transfer: unverified, premium or loop numbers are refused at transfer time', () => withEnv({ NATIVE_TRANSFER: 'on', FORWARD_MAX_CONCURRENT: '50' }, async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['unverified', { forwardNumberVerifiedAt: null }],
      ['premium', { forwardNumber: '+19005550123', forwardNumberE164: '+19005550123' }],
    ];
    for (const [, patch] of cases) {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { ...FWD, ...patch } });
      const body = await (await init(biz.agent_id!, biz.phone!, uniq('CA'))).json() as InitBody;
      expect(body.dynamic_variables.transfer_destination).toBe('');
      expect(body.dynamic_variables.transfer_mode).toBe('off');
    }
    const other = await newBusiness();
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { ...FWD, forwardNumber: other.phone, forwardNumberE164: other.phone } });
    expect(((await (await init(biz.agent_id!, biz.phone!, uniq('CA'))).json()) as InitBody).dynamic_variables.transfer_destination).toBe('');
  }));

  test('transfer: per-caller limit (no verstat on the native path = stranger bucket) and the AI-mode mid-call destination', () => withEnv({ NATIVE_TRANSFER: 'on', FORWARD_MAX_CONCURRENT: '50', FORWARD_WITHHELD_PER_HOUR: '2' }, async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const res: string[] = [];
    for (let i = 0; i < 4; i++) res.push(((await (await init(biz.agent_id!, biz.phone!, uniq('CA'), '+13055550199')).json()) as InitBody).dynamic_variables.transfer_mode);
    expect(res).toEqual(['forward', 'forward', 'off', 'off']);
    // AI mode with a trusted number: mid-call transfer is "available" (the tool re-checks and charges)
    const ai = await newBusiness();
    await prisma.business.update({ where: { id: ai.id }, data: { ...FWD, callMode: 'ai' } });
    const b = await (await init(ai.agent_id!, ai.phone!, uniq('CA'))).json() as InitBody;
    expect(b.dynamic_variables.transfer_mode).toBe('available');
    expect(b.dynamic_variables.transfer_destination).toBe('+13055550142');
  }));

  test('transfer_to_human tool: flag off -> honest refusal + callback; flag on -> approved once, status attempted; outside hours -> callback', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { ...FWD, callMode: 'ai' } });
    const call = (sid: string) => toolsRoute.POST(toolRequest('transfer_to_human', { agent_id: biz.agent_id, call_sid: sid, conversation_id: uniq('conv'), caller_phone: phone(), reason: 'wants the owner' }), { params: Promise.resolve({ tool: 'transfer_to_human' }) });
    const offSid = uniq('CA');
    const off = await (await call(offSid)).json() as { ok: boolean; message: string };
    expect(off.ok).toBe(false);
    expect(off.message).toMatch(/cannot transfer|dueño/i);
    await withEnv({ NATIVE_TRANSFER: 'on', FORWARD_MAX_CONCURRENT: '50' }, async () => {
      const sid = uniq('CA');
      const on = await (await call(sid)).json() as { ok: boolean; message: string };
      expect(on.ok).toBe(true);
      expect(on.message).toMatch(/approved/i);
      expect((await prisma.call.findUnique({ where: { callSid: sid } }))!.transferStatus).toBe('attempted');
      // the owner only works 00:00-00:01: always closed now -> refused with a callback instead of a transfer
      await prisma.business.update({ where: { id: biz.id }, data: { forwardDuringHours: true, hours: { monday: { open: '00:00', close: '00:01' }, tuesday: { open: '00:00', close: '00:01' }, wednesday: { open: '00:00', close: '00:01' }, thursday: { open: '00:00', close: '00:01' }, friday: { open: '00:00', close: '00:01' }, saturday: { open: '00:00', close: '00:01' }, sunday: { open: '00:00', close: '00:01' } } } });
      const closedSid = uniq('CA');
      const closed = await (await call(closedSid)).json() as { ok: boolean; message: string };
      expect(closed.ok).toBe(false);
      expect(closed.message).toMatch(/not available|dueño|owner/i);
      expect((await prisma.call.findUnique({ where: { callSid: closedSid } }))!.transferStatus).toBe('failed');
    });
  });

  // ============================================================ 7. language detection + agent config
  function fakeAgentApi(rejectLanguage = false) {
    type AgentBody = { conversation_config: { language_presets?: { es: { overrides: { agent: { first_message: string } } } }; agent: { prompt: { prompt: string; built_in_tools: Record<string, { type?: string; params: Record<string, unknown> & { transfer_rules?: { provider_configs: { config: { transfer_destination: { destination: string } } }[] }[] } } | undefined> }; dynamic_variables: { dynamic_variable_placeholders: Record<string, string> } } } };
    const bodies: AgentBody[] = [];
    const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = String(input).replace('https://api.elevenlabs.io/v1', ''); const method = init?.method ?? 'GET';
      if (path === '/convai/tools' && method === 'GET') return Response.json({ tools: [] });
      if (path === '/convai/tools' && method === 'POST') return Response.json({ id: `tool_${Math.random().toString(36).slice(2)}` });
      if (path === '/convai/agents/create' || path.startsWith('/convai/agents/')) {
        if (method === 'POST' || method === 'PATCH') {
          const b = JSON.parse(String(init?.body)); bodies.push(b);
          if (rejectLanguage && b.conversation_config.language_presets) return new Response(JSON.stringify({ detail: 'language_presets invalid' }), { status: 422 });
          return Response.json({ agent_id: 'agent_x' });
        }
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  }
  async function provision(env: Record<string, string | undefined>, api = fakeAgentApi()) {
    const prev = globalThis.fetch; globalThis.fetch = api.fetchImpl;
    try {
      return await withEnv({ ELEVENLABS_API_KEY: 'xi-test', APP_URL: 'https://app.example.test', ...env }, async () => {
        el.clearToolIdCache();
        const biz = await newBusiness({ agent_id: null });
        const r = await el.createOrUpdateAgent({ business: biz, kb: null });
        return { r, api };
      });
    } finally { globalThis.fetch = prev; }
  }
  test('agent config: language detection on by default; transfer tool only with NATIVE_TRANSFER=on', async () => {
    const def = await provision({});
    const cfg = def.api.bodies[0].conversation_config;
    expect(cfg.agent.prompt.built_in_tools.language_detection).toMatchObject({ type: 'system', params: { system_tool_type: 'language_detection' } });
    expect(cfg.agent.prompt.built_in_tools.transfer_to_number).toBeUndefined();
    expect(cfg.language_presets!.es.overrides.agent.first_message.toLowerCase()).toContain('record'); // disclosure present in the es preset as well
    expect(cfg.agent.dynamic_variables.dynamic_variable_placeholders.transfer_destination).toBe('');
    const off = await provision({ LANGUAGE_DETECTION: 'off' });
    expect(off.api.bodies[0].conversation_config.agent.prompt.built_in_tools.language_detection).toBeUndefined();
    expect(off.api.bodies[0].conversation_config.language_presets).toBeUndefined();
    const on = await provision({ NATIVE_TRANSFER: 'on' });
    const t = on.api.bodies[0].conversation_config.agent.prompt.built_in_tools.transfer_to_number!;
    expect(t.params.transfer_rules![0].provider_configs[0].config.transfer_destination.destination).toBe('{{transfer_destination}}');
    expect(on.api.bodies[0].conversation_config.agent.prompt.prompt).toContain('# Live transfer');
  });
  test('agent config: a provider that rejects the language fields is retried once without them (provisioning never breaks)', async () => {
    const { r, api } = await provision({}, fakeAgentApi(true));
    expect(r.mock).toBe(false);
    expect(api.bodies.length).toBe(2);
    expect(api.bodies[1].conversation_config.language_presets).toBeUndefined();
    expect(api.bodies[1].conversation_config.agent.prompt.built_in_tools.language_detection).toBeUndefined();
  });
  test('post-call sets calls.language from the metadata', async () => {
    const biz = await newBusiness({ agent_id: uniq('agent') }); const call = await newCall(biz, { consentStatus: 'disclosed' });
    const out = await postcall.processPostCall({ type: 'post_call_transcription', data: {
      conversation_id: call.conversationId!, agent_id: biz.agent_id!, call_sid: call.callSid!, transcript: turns(['agent', 'Hola'], ['user', 'Necesito aire']),
      metadata: { call_duration_secs: 33, main_language: 'es' }, analysis: { transcript_summary: 'Spanish call' },
    } } as never);
    expect(out.status).toBe(200);
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.language).toBe('es');
  });

  // ============================================================ 5. reconcile
  const conversation = (secs: number, status = 'done') => ({ ok: true as const, snapshot: { status: status as 'done', durationSecs: secs, startUnixSecs: null, language: null, turns: [] } });
  test('reconcile: meters an unmetered call once (idempotent), AI seconds only; owner-line calls are metered too', async () => {
    const biz = await newBusiness();
    const old = new Date(Date.now() - 3 * 3600_000);
    const call = await newCall(biz, { startedAt: old });
    const owner = await newCall(biz, { startedAt: old, kind: 'owner' });
    const fresh = await newCall(biz, { startedAt: new Date() });
    let fetches = 0;
    const deps = { fetchConversation: async () => { fetches++; return conversation(120); } };
    const r1 = await reconcile.reconcileUnmeteredCalls(deps);
    expect(r1.items.filter((i) => i.call_id === call.id)[0].outcome).toBe('metered');
    const r2 = await reconcile.reconcileUnmeteredCalls(deps);
    expect(r2.items.filter((i) => i.call_id === call.id).length).toBe(0); // already metered: no longer listed
    // owner-line calls use AI minutes like any other call (owner decision): metered, never blocked by the caps
    expect(r1.items.filter((i) => i.call_id === owner.id)[0].outcome).toBe('metered');
    expect((await prisma.call.findUnique({ where: { id: owner.id } }))!.meteredAt).not.toBeNull();
    expect((await db.getUsage(biz.id))!.call_seconds).toBe(240); // customer 120 + owner 120
    expect((await prisma.call.findUnique({ where: { id: fresh.id } }))!.meteredAt).toBeNull();
    expect(fetches).toBeGreaterThanOrEqual(1);
  });

  test('owner-line calls: post-call webhook and reconcile race -> the minutes are added exactly once, and the owner call stays out of stats/lists', async () => {
    for (let round = 0; round < 3; round++) {
      const biz = await newBusiness({ agent_id: uniq('agent') });
      const call = await newCall(biz, { startedAt: new Date(Date.now() - 2 * 3600_000), kind: 'owner' });
      const envelope = { type: 'post_call_transcription', data: {
        conversation_id: call.conversationId!, agent_id: biz.agent_id!, call_sid: call.callSid!, transcript: turns(['agent', 'Hi'], ['user', 'Change my hours']),
        metadata: { call_duration_secs: 75 }, analysis: { transcript_summary: 's' },
      } };
      await Promise.all([
        reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => conversation(75) }),
        postcall.processPostCall(envelope as never),
        reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => conversation(75) }),
      ]);
      expect((await db.getUsage(biz.id))!.call_seconds).toBe(75);
      const row = (await prisma.call.findUnique({ where: { id: call.id } }))!;
      expect(row.meteredAt).not.toBeNull();
      expect(row.transcript).toBeNull(); // nothing kept
      expect((await db.listCallsPage(biz.id, { limit: 10 })).items.some((c: { id: string }) => c.id === call.id)).toBe(false); // lists exclude owner calls
    }
  });

  test('reconcile: an owner call whose provider conversation was already deleted is settled (0 s), not retried and "given up" noisily', async () => {
    const biz = await newBusiness();
    const call = await newCall(biz, { startedAt: new Date(Date.now() - 5 * 3600_000), kind: 'owner' });
    const gone = { fetchConversation: async () => ({ ok: false as const, status: 404, notFound: true, error: 'not found' }) };
    const r = await reconcile.reconcileUnmeteredCalls(gone);
    expect(r.items.find((i) => i.call_id === call.id)?.outcome).toBe('already_metered');
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.meteredAt).not.toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: 'voice.reconcile_gave_up', target: `call:${call.id}` } })).toBe(0);
  });

  test('reconcile vs a late post-call webhook: the minutes are added exactly once, whichever wins', async () => {
    for (let round = 0; round < 3; round++) {
      const biz = await newBusiness({ agent_id: uniq('agent') });
      const call = await newCall(biz, { startedAt: new Date(Date.now() - 2 * 3600_000) });
      const envelope = { type: 'post_call_transcription', data: {
        conversation_id: call.conversationId!, agent_id: biz.agent_id!, call_sid: call.callSid!, transcript: turns(['agent', 'Hi'], ['user', 'Hello']),
        metadata: { call_duration_secs: 90 }, analysis: { transcript_summary: 's' },
      } };
      await Promise.all([
        reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => conversation(90) }),
        postcall.processPostCall(envelope as never),
        reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => conversation(90) }),
      ]);
      expect((await db.getUsage(biz.id))!.call_seconds).toBe(90);
      expect((await prisma.call.findUnique({ where: { id: call.id } }))!.meteredAt).not.toBeNull();
    }
  });

  test('reconcile: backs off, then gives up with an audit row and an error after the max attempts', async () => {
    const biz = await newBusiness();
    const call = await newCall(biz, { startedAt: new Date(Date.now() - 100 * 3600_000) });
    const deps = { fetchConversation: async () => ({ ok: false as const, status: 500, notFound: false, error: 'http 500' }), now: new Date() };
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await reconcile.reconcileUnmeteredCalls({ ...deps, env: { RECONCILE_MAX_ATTEMPTS: '3', ELEVENLABS_API_KEY: 'x' } });
      outcomes.push(...r.items.filter((x) => x.call_id === call.id).map((x) => x.outcome));
    }
    expect(outcomes.filter((o) => o === 'fetch_failed').length).toBe(3);
    expect(outcomes).toContain('gave_up');
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.reconcileAttempts).toBe(3);
    expect(await prisma.auditEvent.count({ where: { action: 'voice.reconcile_gave_up', target: `call:${call.id}` } })).toBe(1);
    expect((await db.getUsage(biz.id))?.call_seconds ?? 0).toBe(0);
  });

  // ============================================================ 6. warnings
  function fakeMail() {
    const sent = { email: [] as string[], sms: [] as string[] }; let failEmail = false; let failSms = false;
    return {
      sent, fail(v: boolean) { failEmail = v; failSms = v; },
      deps: {
        now: () => noonNy(),
        ownerEmails: async () => ['owner@example.test'],
        sendEmail: async (_to: string, subject: string) => { if (failEmail) throw new Error('smtp'); sent.email.push(subject); },
        sendSms: async (_b: unknown, body: string) => { if (failSms) return false; sent.sms.push(body); return true; },
      },
    };
  }
  const noonNy = () => { const d = new Date(); d.setUTCHours(17, 0, 0, 0); return d; }; // 12:00-13:00 in New York: not quiet hours
  test('warnings: 80% then 100% each send exactly one email and one text, even with 12 concurrent checks', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { smsCapOverride: 100 } });
    const m = fakeMail();
    await db.recordSms(biz.id, 79, noonNy());
    expect(await warnings.checkUsageWarnings(biz.id, m.deps, { force: true })).toEqual([]);
    await db.recordSms(biz.id, 1, noonNy());
    await Promise.all(Array.from({ length: 12 }, () => warnings.checkUsageWarnings(biz.id, m.deps, { force: true })));
    expect(m.sent.email.length).toBe(1); expect(m.sent.sms.length).toBe(1);
    expect(m.sent.sms[0]).toContain('80%');
    await warnings.checkUsageWarnings(biz.id, m.deps, { force: true });
    expect(m.sent.email.length).toBe(1);
    await db.recordSms(biz.id, 20, noonNy());
    await Promise.all(Array.from({ length: 12 }, () => warnings.checkUsageWarnings(biz.id, m.deps, { force: true })));
    expect(m.sent.email.length).toBe(2); expect(m.sent.sms.length).toBe(2);
    expect(m.sent.sms[1]).toContain('all of your');
    const view = await warnings.usageWarningsFor(biz.id, noonNy());
    expect(view.find((w) => w.kind === 'sms')).toMatchObject({ level: 100, percent: 100 });
    expect((await db.getUsageWarnings(biz.id, noonNy()))!.sms_100).not.toBeNull();
  });

  test('warnings: a jump straight to 100% sends one warning (not two); failure gives the claim back; quiet hours defer', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { smsCapOverride: 10 } });
    const m = fakeMail();
    await db.recordSms(biz.id, 10, noonNy());
    m.fail(true);
    const failed = await warnings.checkUsageWarnings(biz.id, m.deps, { force: true });
    expect(failed[0].outcome).toBe('failed');
    expect((await db.getUsageWarnings(biz.id, noonNy()))!.sms_100).toBeNull(); // given back
    m.fail(false);
    const night = new Date(noonNy()); night.setUTCHours(5, 0, 0, 0); // 00:00 in New York
    const deferred = await warnings.checkUsageWarnings(biz.id, { ...m.deps, now: () => night }, { force: true });
    expect(deferred.map((d) => d.outcome)).toEqual(['deferred_quiet_hours']);
    expect(m.sent.email.length).toBe(0);
    await warnings.checkUsageWarnings(biz.id, m.deps, { force: true });
    await warnings.checkUsageWarnings(biz.id, m.deps, { force: true });
    expect(m.sent.email.length).toBe(1); expect(m.sent.sms.length).toBe(1);
    expect(m.sent.sms[0]).not.toContain('80%'); // the 80% warning was folded into the 100% one
  });

  test('warnings: no verified owner phone -> email only; unverified phone never gets a text', async () => {
    const biz = await newBusiness({ owner_verified: false });
    await prisma.business.update({ where: { id: biz.id }, data: { smsCapOverride: 10 } });
    const m = fakeMail();
    await db.recordSms(biz.id, 9, noonNy());
    await warnings.checkUsageWarnings(biz.id, m.deps, { force: true });
    expect(m.sent.email.length).toBe(1); expect(m.sent.sms.length).toBe(0);
  });

  // ============================================================ review 14 (report 12)
  test('R14 M1: a member removed from this business but still in ANOTHER one loses the open live stream at the next re-check', async () => {
    const { mayStillViewCall } = await import('@/lib/voice/live-access');
    const { addMembership, removeMembership } = await import('@/lib/db/memberships');
    const a = await newBusiness(); const b = await newBusiness();
    const staff = await login(a.id, 'staff');
    await addMembership({ user_id: staff.userId, business_id: b.id, role: 'staff' });
    const h = new Headers({ cookie: staff.cookie });
    expect(await mayStillViewCall(h, a.id)).toBe(true);
    expect(await mayStillViewCall(h, b.id)).toBe(false); // the session works in A: B's calls are a 404 for it
    expect((await removeMembership(staff.userId, a.id)).ok).toBe(true); // the user keeps a valid session: it now resolves to B
    expect(await mayStillViewCall(h, a.id)).toBe(false);
    expect(await mayStillViewCall(new Headers({ cookie: 'rc_user_session=nope' }), a.id)).toBe(false);
  });

  test('R14 voice L1: every successful playback (any Range) is audited once per person, call and 10 minutes', async () => {
    const { clearRecordingCache } = await import('@/lib/voice/recording-audio');
    clearRecordingCache();
    const audioRoute = (await import('@/app/api/calls/[id]/audio/route')).GET;
    const biz = await newBusiness(); const other = await newBusiness();
    const owner = await login(biz.id, 'owner'); const other2 = await login(biz.id, 'staff');
    const call = await newCall(biz, { conversationId: `conv${uniq('a').replace(/[^A-Za-z0-9]/g, '')}`, status: 'completed' });
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(500).fill(3), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch;
    const plays = () => prisma.auditEvent.count({ where: { businessId: biz.id, action: 'call.recording_played', target: `call:${call.id}` } });
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi_test_key' }, async () => {
        const go = (who: { cookie: string }, range?: string) => audioRoute(new Request(`https://app.example.test/api/calls/${call.id}/audio`, { headers: { cookie: who.cookie, ...(range ? { range } : {}) } }), ctx(call.id));
        const r = await go(owner, 'bytes=-999999999'); // a suffix range pulled the whole file with no trace before
        expect(r.status).toBe(206);
        expect(await plays()).toBe(1);
        expect((await go(owner, 'bytes=1-')).status).toBe(206);
        expect((await go(owner, 'bytes=0-0')).status).toBe(206);
        expect((await go(owner)).status).toBe(200);
        expect(await plays()).toBe(1); // the same person, call and window: not logged again
        expect((await go(other2, 'bytes=5-9')).status).toBe(206);
        expect(await plays()).toBe(2); // another person is a separate row
        expect(other.id).not.toBe(biz.id);
      });
    } finally { globalThis.fetch = saved; clearRecordingCache(); }
  });

  test('R14 voice M3: erasure and the retention purge queue the ElevenLabs conversation; the drain deletes it (404 = gone, failures retry, alert)', async () => {
    const { eraseCustomerData, purgeExpiredData } = await import('@/lib/db/compliance');
    const { drainRecordingDeletions, RECORDING_DELETE_ALERT_ATTEMPTS } = await import('@/lib/voice/recording-deletion');
    const { fetchConversationAudio, clearRecordingCache, recordingCacheStats } = await import('@/lib/voice/recording-audio');
    await withEnv({ ELEVENLABS_API_KEY: 'xi_test_key' }, async () => {
      const biz = await newBusiness();
      const caller = phone();
      const conv = `conv${uniq('e').replace(/[^A-Za-z0-9]/g, '')}`;
      await newCall(biz, { conversationId: conv, callerPhone: caller, callerE164: caller, status: 'completed' });
      // the audio proxy cache holds this recording; erasure must drop it from memory too
      clearRecordingCache();
      await fetchConversationAudio(conv, null, (async () => new Response(new Uint8Array(100), { headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch);
      expect(recordingCacheStats().entries).toBe(1);
      const res = await eraseCustomerData(biz.id, caller);
      expect(res.calls).toBe(1);
      expect(recordingCacheStats().entries).toBe(0);
      const queued = await prisma.pendingRecordingDeletion.findFirst({ where: { recordingSid: conv } });
      expect(queued).toMatchObject({ provider: 'elevenlabs', accountSid: 'elevenlabs', businessId: biz.id });
      // the erase request already tried once (no network in tests: it failed and stays queued, never lost)
      const seen: { url: string; method: string; key: string | null }[] = [];
      const respond = (status: number) => (async (url: string, init?: RequestInit) => { seen.push({ url: String(url), method: init?.method ?? 'GET', key: new Headers(init?.headers).get('xi-api-key') }); return new Response('{}', { status }); }) as unknown as typeof fetch;
      await prisma.pendingRecordingDeletion.update({ where: { id: queued!.id }, data: { nextAttemptAt: new Date(0) } });
      const fail = await drainRecordingDeletions({ ids: [queued!.id], fetchImpl: respond(503) });
      expect(fail).toMatchObject({ attempted: 1, deleted: 0, failed: 1 });
      expect(seen[0]).toEqual({ url: `https://api.elevenlabs.io/v1/convai/conversations/${conv}`, method: 'DELETE', key: 'xi_test_key' });
      expect((await prisma.pendingRecordingDeletion.findUnique({ where: { id: queued!.id } }))!.lastError).toBe('http_503');
      await prisma.pendingRecordingDeletion.update({ where: { id: queued!.id }, data: { nextAttemptAt: new Date(0), attempts: RECORDING_DELETE_ALERT_ATTEMPTS - 1 } });
      const stuck = await drainRecordingDeletions({ ids: [queued!.id], fetchImpl: respond(500) });
      expect(stuck.alerted).toBe(1);
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'recordings.deletion_stuck' } })).toBe(1);
      await prisma.pendingRecordingDeletion.update({ where: { id: queued!.id }, data: { nextAttemptAt: new Date(0) } });
      const gone = await drainRecordingDeletions({ ids: [queued!.id], fetchImpl: respond(404) });
      expect(gone.deleted).toBe(1);
      expect(await prisma.pendingRecordingDeletion.count({ where: { recordingSid: conv } })).toBe(0);

      // retention purge: a call past the retention window
      const old = `conv${uniq('p').replace(/[^A-Za-z0-9]/g, '')}`;
      await prisma.business.update({ where: { id: biz.id }, data: { retentionDays: 30 } });
      await newCall(biz, { conversationId: old, status: 'completed', startedAt: new Date(Date.now() - 90 * 86_400_000) });
      await purgeExpiredData(new Date());
      expect(await prisma.pendingRecordingDeletion.count({ where: { recordingSid: old, provider: 'elevenlabs' } })).toBe(1);
      await prisma.pendingRecordingDeletion.deleteMany({ where: { recordingSid: old } });
      // the erase and the purge each tried the inline provider delete on the (blocked) global fetch: this test owns those two
      // attempts, so assert them and take them out of the shared outboundCalls list instead of leaking them into later files
      const mine = [`https://api.elevenlabs.io/v1/convai/conversations/${conv}`, `https://api.elevenlabs.io/v1/convai/conversations/${old}`];
      for (const url of mine) expect(outboundCalls).toContain(url);
      for (let i = outboundCalls.length - 1; i >= 0; i--) if (mine.includes(outboundCalls[i])) outboundCalls.splice(i, 1);
    });
    // without a provider key there is nothing at the provider to delete: nothing is queued (and nothing can alert forever)
    await withEnv({ ELEVENLABS_API_KEY: undefined }, async () => {
      const biz = await newBusiness();
      const caller = phone();
      const conv = `conv${uniq('n').replace(/[^A-Za-z0-9]/g, '')}`;
      await newCall(biz, { conversationId: conv, callerPhone: caller, callerE164: caller, status: 'completed' });
      await eraseCustomerData(biz.id, caller);
      expect(await prisma.pendingRecordingDeletion.count({ where: { recordingSid: conv } })).toBe(0);
    });
  });

  test('R14 voice M3b: a declined call whose inline provider delete fails is queued, not forgotten', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi_test_key' }, async () => {
        const biz = await newBusiness({ agent_id: uniq('agent') });
        const call = await newCall(biz, { consentStatus: 'declined' });
        const out = await postcall.processPostCall({ type: 'post_call_transcription', data: {
          conversation_id: call.conversationId!, agent_id: biz.agent_id!, call_sid: call.callSid!, transcript: turns(['agent', 'Recorded.'], ['user', 'I do not want to be recorded']),
          metadata: { call_duration_secs: 10 },
        } } as never);
        expect(out.status).toBe(200);
        expect(await prisma.pendingRecordingDeletion.count({ where: { recordingSid: call.conversationId!, provider: 'elevenlabs', businessId: biz.id } })).toBe(1);
      });
    } finally { globalThis.fetch = saved; }
  });

  test('R14 voice L2/L3: a transferred call is split into AI and forward seconds; a forward-metering failure gives the claim back', async () => {
    const transferred = (conv: string, sid: string, biz: { agent_id?: string | null }, atSecs: number | null) => ({ type: 'post_call_transcription', data: {
      conversation_id: conv, agent_id: biz.agent_id!, call_sid: sid,
      transcript: [
        { role: 'agent', message: 'Hello', time_in_call_secs: 0 }, { role: 'user', message: 'Connect me', time_in_call_secs: 5 },
        { role: 'agent', message: 'Connecting', time_in_call_secs: atSecs ?? undefined, tool_calls: [{ tool_name: 'transfer_to_number' }], tool_results: [{ tool_name: 'transfer_to_number', result_value: 'ok' }] },
      ],
      metadata: { call_duration_secs: 100 }, analysis: { transcript_summary: 's' },
    } });
    // (a) the transfer turn time is known: 40 s of AI, 60 s of forward
    const biz = await newBusiness({ agent_id: uniq('agent') });
    const call = await newCall(biz, { transferStatus: 'attempted' });
    expect((await postcall.processPostCall(transferred(call.conversationId!, call.callSid!, biz, 40) as never)).status).toBe(200);
    const u = (await db.getUsage(biz.id))!;
    expect([u.call_seconds, u.forward_seconds]).toEqual([40, 60]);
    // (b) no readable result at all: unknown, so the whole call is AI time (never "connected" by default)
    const biz2 = await newBusiness({ agent_id: uniq('agent') });
    const call2 = await newCall(biz2, { transferStatus: 'attempted' });
    const unreadable = transferred(call2.conversationId!, call2.callSid!, biz2, null);
    (unreadable.data.transcript[2] as Record<string, unknown>).tool_results = undefined;
    await postcall.processPostCall(unreadable as never);
    const u2 = (await db.getUsage(biz2.id))!;
    expect([u2.call_seconds, u2.forward_seconds]).toEqual([100, 0]);
    expect((await prisma.call.findUnique({ where: { id: call2.id } }))!.transferStatus).toBe('attempted');
    // (c) R15 L3: the AI part is written FIRST. When the forward write then fails (twice: it is retried once), the AI seconds are already
    // recorded, so the claim is KEPT: giving it back would let the reconcile job bill the whole call as AI on top (a double count).
    const biz3 = await newBusiness({ agent_id: uniq('agent') });
    const call3 = await newCall(biz3, { transferStatus: 'attempted' });
    await db.recordForwardSeconds(biz3.id, 1); // the usage row exists
    await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters ADD CONSTRAINT r14_tmp_fail CHECK (forward_seconds < 30) NOT VALID`);
    try {
      await postcall.processPostCall(transferred(call3.conversationId!, call3.callSid!, biz3, 40) as never);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters DROP CONSTRAINT r14_tmp_fail`); }
    expect((await prisma.call.findUnique({ where: { id: call3.id } }))!.meteredAt).not.toBeNull();
    const u3 = (await db.getUsage(biz3.id))!;
    expect([u3.call_seconds, u3.forward_seconds]).toEqual([40, 1]); // AI part recorded once, forward part lost (logged), nothing billed twice
    // (d) the AI write itself fails: nothing was written, so the claim IS given back and the retry meters both parts
    const biz4 = await newBusiness({ agent_id: uniq('agent') });
    const call4 = await newCall(biz4, { transferStatus: 'attempted' });
    await db.recordForwardSeconds(biz4.id, 1);
    await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters ADD CONSTRAINT r14_tmp_fail CHECK (call_seconds < 30) NOT VALID`);
    try {
      await postcall.processPostCall(transferred(call4.conversationId!, call4.callSid!, biz4, 40) as never);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters DROP CONSTRAINT r14_tmp_fail`); }
    expect((await prisma.call.findUnique({ where: { id: call4.id } }))!.meteredAt).toBeNull();
    await prisma.processedEvent.deleteMany({ where: { id: call4.conversationId! } });
    await postcall.processPostCall(transferred(call4.conversationId!, call4.callSid!, biz4, 40) as never);
    expect((await prisma.call.findUnique({ where: { id: call4.id } }))!.meteredAt).not.toBeNull();
    const u4 = (await db.getUsage(biz4.id))!;
    expect([u4.call_seconds, u4.forward_seconds]).toEqual([40, 61]);
  });

  test('R14 voice L4: a provider conversation with no duration is retried, never closed with 0 seconds', async () => {
    const biz = await newBusiness();
    const call = await newCall(biz, { startedAt: new Date(Date.now() - 3 * 3600_000) });
    const noDuration = { ok: true as const, snapshot: { status: 'processing' as const, durationSecs: null, startUnixSecs: null, language: null, turns: [] } };
    const r = await reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => noDuration });
    expect(r.items.find((i) => i.call_id === call.id)!.outcome).toBe('not_ready');
    const row = await prisma.call.findUnique({ where: { id: call.id } });
    expect(row!.meteredAt).toBeNull();
    expect(row!.reconcileAttempts).toBe(1);
    const done = { ok: true as const, snapshot: { status: 'done' as const, durationSecs: 90, startUnixSecs: null, language: null, turns: [] } };
    await prisma.call.update({ where: { id: call.id }, data: { startedAt: new Date(Date.now() - 9 * 3600_000) } });
    const r2 = await reconcile.reconcileUnmeteredCalls({ fetchConversation: async () => done });
    expect(r2.items.find((i) => i.call_id === call.id)!.outcome).toBe('metered');
    expect((await db.getUsage(biz.id))!.call_seconds).toBe(90);
  });

  test('R14 voice L5: the turn still being spoken is stored as interim and replaced; an objection in its later text is caught', async () => {
    const biz = await newBusiness(); const call = await newCall(biz);
    let message = "I don't";
    const source = new live.ElevenLabsPollingSource(async () => ({
      ok: true as const, snapshot: { status: 'in-progress' as const, durationSecs: null, startUnixSecs: null, language: null, turns: [
        { role: 'agent' as const, message: 'This call may be recorded', timeInCallSecs: 0 }, { role: 'user' as const, message, timeInCallSecs: 4 },
      ] },
    }));
    expect(await live.requestPoll(call.id, { source, leaseMs: 1 })).toBe('polled');
    let rows = await prisma.callTranscriptEvent.findMany({ where: { callId: call.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.text, r.isFinal])).toEqual([['This call may be recorded', true], ["I don't", false]]);
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call.id}` } });
    message = "I don't want to be recorded";
    expect(await live.requestPoll(call.id, { source, leaseMs: 1 })).toBe('declined');
    expect(await prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.consentStatus).toBe('declined');
    // an ordinary growing turn is updated in place, and finalised when the call ends
    const call2 = await newCall(biz);
    let text = 'My AC';
    let status: 'in-progress' | 'done' = 'in-progress';
    const src2 = new live.ElevenLabsPollingSource(async () => ({ ok: true as const, snapshot: { status, durationSecs: 20, startUnixSecs: null, language: null, turns: [{ role: 'user' as const, message: text, timeInCallSecs: 1 }] } }));
    await live.requestPoll(call2.id, { source: src2, leaseMs: 1 });
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call2.id}` } });
    text = 'My AC stopped working'; 
    await live.requestPoll(call2.id, { source: src2, leaseMs: 1 });
    rows = await prisma.callTranscriptEvent.findMany({ where: { callId: call2.id } });
    expect(rows.map((r) => [r.text, r.isFinal])).toEqual([['My AC stopped working', false]]);
    await prisma.provisionLock.deleteMany({ where: { key: `live-transcript:${call2.id}` } });
    status = 'done';
    await live.requestPoll(call2.id, { source: src2, leaseMs: 1 });
    rows = await prisma.callTranscriptEvent.findMany({ where: { callId: call2.id } });
    expect(rows.map((r) => [r.text, r.isFinal])).toEqual([['My AC stopped working', true]]);
  });

  test('R14 voice L7: the /transcript polling fallback is rate limited per person', async () => {
    const biz = await newBusiness(); const staff = await login(biz.id, 'staff');
    const call = await newCall(biz, { consentStatus: 'unknown' });
    const { LIVE_POLL_PER_MINUTE } = await import('@/app/api/calls/[id]/transcript/route');
    const hit = () => transcriptRoute.GET(get(`/api/calls/${call.id}/transcript`, { cookie: staff.cookie }), ctx(call.id));
    let last = 200;
    for (let i = 0; i < LIVE_POLL_PER_MINUTE; i++) last = (await hit()).status;
    expect(last).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `live-poll:user:${staff.userId}` } } });
  });
  // ------------------------------------------------------------------ residual gaps (reports 12 L2, 15 L3)

  const xfer = (conv: string, sid: string, biz: { agent_id?: string | null }, o: { duration?: number; transferAt?: number; lead?: boolean } = {}) => ({ type: 'post_call_transcription', data: {
    conversation_id: conv, agent_id: biz.agent_id!, call_sid: sid,
    transcript: [
      { role: 'agent', message: 'Hello', ...(o.lead === false ? {} : { time_in_call_secs: 0 }) }, { role: 'user', message: 'Connect me', ...(o.lead === false ? {} : { time_in_call_secs: 25 }) },
      { role: 'agent', message: 'Connecting', ...(o.transferAt !== undefined ? { time_in_call_secs: o.transferAt } : {}), tool_calls: [{ tool_name: 'transfer_to_number' }], tool_results: [{ tool_name: 'transfer_to_number', result_value: 'ok' }] },
    ],
    metadata: { call_duration_secs: o.duration ?? 100 }, analysis: { transcript_summary: 's' },
  } });
  const usageOf = async (id: string) => { const u = (await db.getUsage(id))!; return [u.call_seconds, u.forward_seconds]; };

  test('residual L2: a transferred call whose transfer turn has no time is split by the Twilio dial duration, else the last timed turn, else it stays forward time; AI + forward always equal the duration', async () => {
    // (a) the dial-status callback reported 70 bridged seconds BEFORE the post-call report: forward = 70 (metered once, by the callback), AI = 30
    const a = await newBusiness({ agent_id: uniq('agent') });
    const callA = await newCall(a, { transferStatus: 'attempted' });
    const dialStatus = (await import('@/app/api/voice/dial-status/route')).POST;
    const url = `${SECRETS.publicBase}/api/voice/dial-status`;
    const params = { ParentCallSid: callA.callSid!, CallSid: uniq('CAchild'), CallDuration: '70', DialCallStatus: 'completed' };
    expect((await dialStatus(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString() }))).status).toBe(200);
    expect((await prisma.call.findUnique({ where: { id: callA.id } }))!.dialSeconds).toBe(70);
    expect(await usageOf(a.id)).toEqual([0, 70]);
    await postcall.processPostCall(xfer(callA.conversationId!, callA.callSid!, a) as never);
    expect(await usageOf(a.id)).toEqual([30, 70]); // never 100 forward (double bill) and never AI 100
    expect((await prisma.call.findUnique({ where: { id: callA.id } }))!.forwardPendingSecs).toBeNull();

    // (b) the dial duration arrives AFTER the post-call report: the whole-call fallback was already billed as forward, the callback is a duplicate
    const b = await newBusiness({ agent_id: uniq('agent') });
    const callB = await newCall(b, { transferStatus: 'attempted' });
    await postcall.processPostCall(xfer(callB.conversationId!, callB.callSid!, b, { lead: false }) as never);
    expect(await usageOf(b.id)).toEqual([0, 100]); // nothing readable: the documented fallback
    const late = { ParentCallSid: callB.callSid!, CallSid: uniq('CAchild'), CallDuration: '70' };
    await dialStatus(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, late) }, body: new URLSearchParams(late).toString() }));
    expect(await usageOf(b.id)).toEqual([0, 100]);

    // (c) no dial duration, but the turns before the transfer carry times: the AI part ends at the last of them (25 s)
    const c = await newBusiness({ agent_id: uniq('agent') });
    const callC = await newCall(c, { transferStatus: 'attempted' });
    await postcall.processPostCall(xfer(callC.conversationId!, callC.callSid!, c) as never);
    expect(await usageOf(c.id)).toEqual([25, 75]);

    // (d) a dial duration larger than the call is clamped to it (no negative AI seconds, no extra forward seconds)
    const d = await newBusiness({ agent_id: uniq('agent') });
    const callD = await newCall(d, { transferStatus: 'attempted' });
    await db.recordDialSeconds(callD.callSid!, 500);
    await postcall.processPostCall(xfer(callD.conversationId!, callD.callSid!, d, { lead: false }) as never);
    expect(await usageOf(d.id)).toEqual([0, 100]);
    // (e) the transfer turn's own time still wins over everything else
    const e = await newBusiness({ agent_id: uniq('agent') });
    const callE = await newCall(e, { transferStatus: 'attempted' });
    await db.recordDialSeconds(callE.callSid!, 90);
    await postcall.processPostCall(xfer(callE.conversationId!, callE.callSid!, e, { transferAt: 40 }) as never);
    expect(await usageOf(e.id)).toEqual([40, 60]);
  });

  test('residual L3: a forward write that failed after the AI part was recorded is marked and finished by the reconcile job (never lost, never twice)', async () => {
    const biz = await newBusiness({ agent_id: uniq('agent') });
    const call = await newCall(biz, { transferStatus: 'attempted' });
    await db.recordForwardSeconds(biz.id, 1); // the usage row exists
    await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters ADD CONSTRAINT resid_tmp_fail CHECK (forward_seconds < 30) NOT VALID`);
    try {
      await postcall.processPostCall(xfer(call.conversationId!, call.callSid!, biz, { transferAt: 40 }) as never);
      const row = (await prisma.call.findUnique({ where: { id: call.id } }))!;
      expect(row.meteredAt).not.toBeNull(); // the claim is kept: the AI part is in
      expect(row.forwardPendingSecs).toBe(60); // ... and the forward part is remembered
      expect(await usageOf(biz.id)).toEqual([40, 1]);
      // still failing: the job reports it and keeps the marker
      const stuck = await reconcile.settlePendingForwards({ now: new Date(Date.now() + 5000), afterMinutes: 0 });
      expect(stuck.failed).toBeGreaterThanOrEqual(1);
      expect((await prisma.call.findUnique({ where: { id: call.id } }))!.forwardPendingSecs).toBe(60);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters DROP CONSTRAINT resid_tmp_fail`); }
    const done = await reconcile.settlePendingForwards({ now: new Date(Date.now() + 5000), afterMinutes: 0 });
    expect(done.settled).toBeGreaterThanOrEqual(1);
    expect(await usageOf(biz.id)).toEqual([40, 61]);
    expect((await prisma.call.findUnique({ where: { id: call.id } }))!.forwardPendingSecs).toBeNull();
    // idempotent: running again (or the dial-status callback arriving now) adds nothing
    await reconcile.settlePendingForwards({ now: new Date(Date.now() + 5000), afterMinutes: 0 });
    expect(await usageOf(biz.id)).toEqual([40, 61]);
    // the same through the job wrapper
    const { runReconcileJob } = await import('@/lib/jobs/reconcile');
    const report = await runReconcileJob({ now: new Date(Date.now() + 5000), env: { ...process.env } as NodeJS.ProcessEnv });
    expect(report.counts).toHaveProperty('forwards_pending');
    expect(await usageOf(biz.id)).toEqual([40, 61]);

    // a callback that metered the leg first makes the reconcile pass a no-op that just clears the marker
    const biz2 = await newBusiness({ agent_id: uniq('agent') });
    const call2 = await newCall(biz2, { transferStatus: 'attempted', meteredAt: new Date(Date.now() - 600_000), forwardPendingSecs: 60 });
    await db.recordForwardSeconds(biz2.id, 60);
    const { meterForwardedCall } = await import('@/lib/voice/forward-metering');
    expect(await meterForwardedCall(call2.callSid!, biz2.id, 60)).toBe('metered'); // what the dial-status callback does
    await reconcile.settlePendingForwards({ now: new Date(), afterMinutes: 1 });
    expect(await usageOf(biz2.id)).toEqual([0, 120]); // 60 recorded directly above + 60 by the callback; the job added none
    expect((await prisma.call.findUnique({ where: { id: call2.id } }))!.forwardPendingSecs).toBeNull();
  });

  test('residual L3: when the AI write itself fails nothing is pending and the claim is given back', async () => {
    const biz = await newBusiness({ agent_id: uniq('agent') });
    const call = await newCall(biz, { transferStatus: 'attempted' });
    await db.recordForwardSeconds(biz.id, 1);
    await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters ADD CONSTRAINT resid_tmp_fail2 CHECK (call_seconds < 30) NOT VALID`);
    try { await postcall.processPostCall(xfer(call.conversationId!, call.callSid!, biz, { transferAt: 40 }) as never); }
    finally { await prisma.$executeRawUnsafe(`ALTER TABLE usage_counters DROP CONSTRAINT resid_tmp_fail2`); }
    const row = (await prisma.call.findUnique({ where: { id: call.id } }))!;
    expect(row.meteredAt).toBeNull();
    expect(row.forwardPendingSecs).toBeNull();
  });
});
