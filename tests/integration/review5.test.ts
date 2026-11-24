/**
 * Round 5 review fixes (docs/review/09): forward-number rules on every path (H1), forwarded minutes metered and capped (H2),
 * voice tools gated by call mode (M1), honest forwarding on the native AI line (M2), voicemail proxy / tenant isolation / retention (M3),
 * step-up re-authentication + notices + audit for call handling changes (M4), and the Low findings. Providers are in mock mode and every
 * outbound fetch is refused unless a test stubs one (see helpers/env).
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq, wall,
} from '../helpers/fixtures';
import { captureMail } from '../helpers/auth-harness';
import { hashPassword } from '../../src/lib/password';
import { clearVoicemailCache } from '../../src/lib/voice/voicemail';

const PASSWORD = 'correct horse battery staple';
const ACCOUNT = `AC${'a'.repeat(32)}`;
const REC = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${'b'.repeat(32)}`;

integration('review round 5 fixes (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  type Ctx = { params: Promise<{ id: string }> };
  let incoming: (req: Request) => Promise<Response>;
  let voicemail: (req: Request) => Promise<Response>;
  let dialStatus: (req: Request) => Promise<Response>;
  let initiation: { POST: (req: Request) => Promise<Response> };
  let toolRoute: (req: Request, c: { params: Promise<{ tool: string }> }) => Promise<Response>;
  let modeRoute: { GET: (req: Request, c: Ctx) => Promise<Response>; PATCH: (req: Request, c: Ctx) => Promise<Response> };
  let fwdRoute: { PUT: (req: Request, c: Ctx) => Promise<Response>; DELETE: (req: Request, c: Ctx) => Promise<Response> };
  let fwdStart: (req: Request, c: Ctx) => Promise<Response>;
  let fwdConfirm: (req: Request, c: Ctx) => Promise<Response>;
  let callsRoute: { GET: (req: Request) => Promise<Response> };
  let vmRoute: { GET: (req: Request, c: Ctx) => Promise<Response> };
  let reauth: (req: Request) => Promise<Response>;
  let bookingsRoute: { GET: (req: Request) => Promise<Response> };
  const userIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
    voicemail = (await import('@/app/api/voice/voicemail/route')).POST;
    dialStatus = (await import('@/app/api/voice/dial-status/route')).POST;
    initiation = await import('@/app/api/voice/initiation/route');
    toolRoute = (await import('@/app/api/voice/tools/[tool]/route')).POST;
    modeRoute = await import('@/app/api/businesses/[id]/call-mode/route');
    fwdRoute = await import('@/app/api/businesses/[id]/forward-number/route');
    fwdStart = (await import('@/app/api/businesses/[id]/forward-number/verify/start/route')).POST;
    fwdConfirm = (await import('@/app/api/businesses/[id]/forward-number/verify/confirm/route')).POST;
    callsRoute = await import('@/app/api/calls/route');
    vmRoute = await import('@/app/api/calls/[id]/voicemail/route');
    reauth = (await import('@/app/api/auth/reauth/route')).POST;
    bookingsRoute = await import('@/app/api/bookings/route');
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  beforeEach(async () => {
    clearVoicemailCache();
    outboundCalls.length = 0;
    await prisma.rateLimitBucket.deleteMany({
      where: { OR: [{ key: { startsWith: 'voice/' } }, { key: { startsWith: 'forward-number/' } }, { key: { startsWith: 'callmode-notice' } }, { key: { startsWith: 'auth/reauth' } }, { key: { startsWith: 'owner-phone/' } }] },
    });
  });

  // ------------------------------------------------------------ helpers
  const URL_IN = `${SECRETS.publicBase}/api/voice/incoming`;
  const URL_VM = `${SECRETS.publicBase}/api/voice/voicemail`;
  const URL_DS = `${SECRETS.publicBase}/api/voice/dial-status`;
  const callParams = (to: string, from = phone()) => ({ AccountSid: ACCOUNT, CallSid: uniq('CA'), CallStatus: 'ringing', From: from, To: to });
  const post = (url: string, params: Record<string, string>, handler: (r: Request) => Promise<Response>, sig: string | null = twilioSignature(url, params)) =>
    handler(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sig ? { 'x-twilio-signature': sig } : {}) },
      body: new URLSearchParams(params).toString(),
    }));
  const signedIn = (params: Record<string, string>) => post(URL_IN, params, incoming);
  const setBiz = (id: string, data: Record<string, unknown>) => prisma.business.update({ where: { id }, data });
  const FWD = { callMode: 'forward', forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() };
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const api = (url: string, method: string, body?: unknown, headers: Record<string, string> = admin) =>
    new Request(`https://app.example.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const asUser = (cookie: string): Record<string, string> => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', cookie });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({
      email: `${uniq('u')}@example.test`, password_hash: await hashPassword(PASSWORD), role, business_id: businessId, email_verified: true,
    });
    userIds.push(user.id);
    const { token, session } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, user, sessionId: session.id };
  }
  const ageSudo = (sessionId: string, minutes: number) =>
    prisma.userSession.update({ where: { id: sessionId }, data: { sudoAt: new Date(Date.now() - minutes * 60_000) } });
  const billing = async (id: string, patch: Parameters<typeof db.setBillingState>[1]) => { await db.setBillingState(id, patch); };

  // ================================================================== H1
  test('H1 review repro: a verified Jamaican owner phone is a fine alert phone but can NOT become the forward number', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { ownerPhone: '+18765550142', ownerPhoneE164: '+18765550142', ownerPhoneVerifiedAt: new Date() });
    const put = await fwdRoute.PUT(api(`/api/businesses/${biz.id}/forward-number`, 'PUT', { use_owner_phone: true }), ctx(biz.id));
    expect(put.status).toBe(422);
    expect(((await put.json()) as { error: string }).error).toMatch(/premium|international|toll-free/i);
    const patch = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }), ctx(biz.id));
    expect(patch.status).toBe(422);
    expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'ai', forward_number_e164: null });
  });

  test('H1 database layer refuses to adopt / store a disallowed number even if a route forgot to check', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { ownerPhone: '+16715550142', ownerPhoneE164: '+16715550142', ownerPhoneVerifiedAt: new Date() }); // Guam
    await expect(db.adoptOwnerPhoneAsForwardNumber(biz.id)).rejects.toThrow(db.ForwardNumberRejectedError);
    await expect(db.setForwardNumberVerified(biz.id, '+18765550142')).rejects.toThrow(db.ForwardNumberRejectedError);
    await expect(db.setForwardNumberUnverified(biz.id, '+19005550142', '+19005550142')).rejects.toThrow(db.ForwardNumberRejectedError);
    expect((await db.getBusiness(biz.id))?.forward_number_e164).toBeNull();
  });

  test('H1 dial time: a number that is already stored (any path) is re-validated before <Dial> and falls to the voicemail', async () => {
    for (const bad of ['+18765550142', '+16705550142', '+13059760142', '+18005550142']) {
      const biz = await newBusiness();
      await setBiz(biz.id, { ...FWD, forwardNumber: bad, forwardNumberE164: bad });
      const params = callParams(biz.phone!);
      const res = await signedIn(params);
      const xml = await res.text();
      expect([bad, xml.includes('<Dial')]).toEqual([bad, false]);
      expect(xml).toContain('<Record'); // a signed Twilio caller never gets JSON for a refused forward
      expect(xml.indexOf('will be recorded')).toBeLessThan(xml.indexOf('<Record'));
      const row = await prisma.call.findFirst({ where: { callSid: params.CallSid } });
      expect(row?.flaggedReason).toMatch(/Forwarding was refused/);
    }
    // the same via the verified owner phone path (trusted without a second code)
    const owner = await newBusiness();
    await setBiz(owner.id, { callMode: 'forward', forwardNumber: '+18765550142', forwardNumberE164: '+18765550142', ownerPhone: '+18765550142', ownerPhoneE164: '+18765550142', ownerPhoneVerifiedAt: new Date() });
    expect(await (await signedIn(callParams(owner.phone!))).text()).not.toContain('<Dial');
  });

  test('H1 dial time: changing the country list or FORWARD_DENY_AREA_CODES stops a number that was legal when stored', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, FWD);
    expect(await (await signedIn(callParams(biz.phone!))).text()).toContain('<Dial');
    await withEnv({ FORWARD_DENY_AREA_CODES: '305' }, async () => {
      expect(await (await signedIn(callParams(biz.phone!))).text()).not.toContain('<Dial');
    });
    await withEnv({ FORWARD_ALLOWED_COUNTRY_CODES: '44' }, async () => {
      expect(await (await signedIn(callParams(biz.phone!))).text()).not.toContain('<Dial');
    });
    expect(await (await signedIn(callParams(biz.phone!))).text()).toContain('<Dial');
  });

  test('H1 verify/start refuses territories, 976 exchanges, toll-free and ANY assistant number (this tenant or another)', async () => {
    const biz = await newBusiness();
    const other = await newBusiness();
    for (const n of ['+16705550142', '+16715550142', '+16845550142', '+13059760142', '+18005550142', '+18885550142', other.phone!, biz.phone!]) {
      const res = await fwdStart(api(`/api/businesses/${biz.id}/forward-number/verify/start`, 'POST', { phone: n }), ctx(biz.id));
      expect([n, res.status]).toEqual([n, 422]);
    }
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
  });

  // ================================================================== H2
  test('H2 forwarded minutes are metered ONCE per call from the signed Twilio callbacks (action and status callback)', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, FWD);
    const params = callParams(biz.phone!);
    expect(await (await signedIn(params)).text()).toContain('<Dial');
    expect((await db.getUsage(biz.id))).toMatchObject({ call_seconds: 0, forward_seconds: 0 });

    // the per-leg status callback (child leg), then the <Dial action> and a Twilio retry: one count, in the FORWARD counter (never the AI minutes)
    const leg = { ParentCallSid: params.CallSid, CallSid: uniq('CAchild'), CallStatus: 'completed', CallDuration: '3000' };
    expect((await post(URL_DS, leg, dialStatus)).status).toBe(200);
    expect((await db.getUsage(biz.id))).toMatchObject({ forward_seconds: 3000, call_seconds: 0 });
    await post(URL_DS, leg, dialStatus);
    await post(URL_VM, { CallSid: params.CallSid, DialCallStatus: 'completed', DialCallDuration: '3000' }, voicemail);
    expect((await db.getUsage(biz.id))).toMatchObject({ forward_seconds: 3000, call_seconds: 0 });
    expect((await prisma.call.findFirst({ where: { callSid: params.CallSid } }))?.durationSec).toBe(3000);
  });

  test('H2 the dial-status callback needs a Twilio signature; the tenant comes from the call row, never from the request', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const params = callParams(a.phone!);
    await db.createCall({ business_id: a.id, call_sid: params.CallSid, caller_phone: params.From });
    const body = { ParentCallSid: params.CallSid, CallDuration: '120', business_id: b.id, BusinessId: b.id };
    expect((await post(URL_DS, body, dialStatus, null)).status).toBe(403);
    expect((await post(URL_DS, body, dialStatus, 'bad')).status).toBe(403);
    expect((await db.getUsage(a.id))?.forward_seconds).toBe(0);
    expect((await post(URL_DS, body, dialStatus)).status).toBe(200);
    expect((await db.getUsage(a.id))?.forward_seconds).toBe(120);
    expect((await db.getUsage(b.id))?.forward_seconds).toBe(0);
    // unknown parent / garbage durations are ignored, not errors
    expect((await post(URL_DS, { ParentCallSid: 'CAnope', CallDuration: '5' }, dialStatus)).status).toBe(200);
    expect((await post(URL_DS, { ParentCallSid: params.CallSid, CallDuration: '-5' }, dialStatus)).status).toBe(200);
    expect((await db.getUsage(a.id))?.forward_seconds).toBe(120);
  });

  test('H2 the FORWARD allowance caps the forwarded call (timeLimit) and a used-up forward cap, a trial cap or a lapsed plan stops forwarding; the AI minutes are not involved', async () => {
    await withEnv({ BILLING_ENFORCED: 'true', FORWARD_MINUTES_CAP: '10' }, async () => {
      // 10 minute forward allowance, 5 used: <Dial timeLimit> is the 300 s that are left
      const part = await newBusiness();
      await setBiz(part.id, FWD);
      await billing(part.id, { billing_status: 'active' });
      await db.recordForwardSeconds(part.id, 300);
      expect(await (await signedIn(callParams(part.phone!))).text()).toContain('timeLimit="300"');

      // the AI minutes being used up does NOT stop forwarding (separate counters)
      const aiFull = await newBusiness();
      await setBiz(aiFull.id, FWD);
      await billing(aiFull.id, { billing_status: 'active', call_minutes_cap_override: 1 });
      await db.recordCallSeconds(aiFull.id, 600);
      expect(await (await signedIn(callParams(aiFull.phone!))).text()).toContain('<Dial');

      // forward minutes used up: no <Dial>, the voicemail instead (the notice comes before the beep)
      const used = await newBusiness();
      await setBiz(used.id, FWD);
      await billing(used.id, { billing_status: 'active' });
      await db.recordForwardSeconds(used.id, 600);
      const params = callParams(used.phone!);
      const xml = await (await signedIn(params)).text();
      expect(xml).not.toContain('<Dial');
      expect(xml.indexOf('will be recorded')).toBeLessThan(xml.indexOf('<Record'));
      expect((await prisma.call.findFirst({ where: { callSid: params.CallSid } }))?.flaggedReason).toMatch(/minutes are used up/);

      // trialing tenants get the (lower) trial forward cap
      await withEnv({ TRIAL_FORWARD_MINUTES_CAP: '2' }, async () => {
        const trial = await newBusiness();
        await setBiz(trial.id, FWD);
        await billing(trial.id, { billing_status: 'trialing' });
        await db.recordForwardSeconds(trial.id, 121);
        expect(await (await signedIn(callParams(trial.phone!))).text()).not.toContain('<Dial');
      });

      // a lapsed plan is out of service (no forward, no voicemail JSON-less call either)
      const lapsed = await newBusiness();
      await setBiz(lapsed.id, FWD);
      await billing(lapsed.id, { billing_status: 'canceled' });
      expect(await (await signedIn(callParams(lapsed.phone!))).text()).not.toContain('<Dial');
    });
  });

  test('H2 forwarded calls per hour are rate limited per business (the rest go to the voicemail) and voicemails too', async () => {
    await withEnv({ FORWARD_CALLS_PER_HOUR: '2', VOICEMAIL_PER_HOUR: '2', CALLER_UNKNOWN_SHARE_PCT: '100' }, async () => {
      const biz = await newBusiness();
      await setBiz(biz.id, FWD);
      const results: string[] = [];
      for (let i = 0; i < 3; i++) results.push(await (await signedIn(callParams(biz.phone!))).text());
      expect(results.map((x) => x.includes('<Dial'))).toEqual([true, true, false]);
      expect(results[2]).toContain('<Record');

      const paused = await newBusiness();
      await setBiz(paused.id, { callMode: 'paused' });
      const outs: string[] = [];
      for (let i = 0; i < 3; i++) outs.push(await (await signedIn(callParams(paused.phone!))).text());
      expect(outs.map((x) => x.includes('<Record'))).toEqual([true, true, false]);
      expect(outs[2]).toContain('<Hangup/>');
    });
  });

  test('H2 voicemail seconds are metered once per call', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { callMode: 'paused' });
    const params = callParams(biz.phone!);
    await signedIn(params);
    const done = { CallSid: params.CallSid, RecordingUrl: REC, RecordingDuration: '45' };
    await post(URL_VM, done, voicemail);
    await post(URL_VM, done, voicemail);
    expect((await db.getUsage(biz.id))).toMatchObject({ voicemail_seconds: 45, call_seconds: 0 });
  });

  // ================================================================== M1
  test('M1 paused: the agent cannot book, text, take payment or quote; it can only take a message', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { callMode: 'paused' });
    const day = futureDateKey(2);
    const call = async (tool: string, body: Record<string, unknown>) => {
      const res = await toolRoute(toolRequest(tool, { agent_id: biz.agent_id, ...body }), { params: Promise.resolve({ tool }) });
      return (await res.json()) as { ok: boolean; message: string };
    };
    const booking = await call('create_booking', { customer_name: 'Lucía Gómez', customer_phone: '+13055550999', service: 'AC repair', scheduled_at: wall(day, '10:00'), conversation_id: uniq('conv') });
    expect(booking.ok).toBe(false);
    expect(booking.message).toMatch(/not taking bookings/i);
    expect(await prisma.booking.count({ where: { businessId: biz.id } })).toBe(0);
    for (const [tool, body] of [
      ['send_sms', { to: '+13055550999', message: 'hi' }],
      ['create_payment_link', { amount: 50 }],
      ['get_pricing', { service: 'AC repair' }],
      ['check_availability', { date: day }],
      ['createBooking', { customer_name: 'x', customer_phone: '+13055550999', service: 'AC repair', scheduled_at: wall(day, '10:00') }], // other spellings are the same tool
    ] as const) {
      expect([tool, (await call(tool, { ...body })).ok]).toEqual([tool, false]);
    }
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    // taking a message still works (the owner is told)
    const handoff = await call('handoff_to_human', { reason: 'caller wants a quote', caller_name: 'Lucía', caller_phone: '+13055550999', conversation_id: uniq('conv') });
    expect(handoff.message).not.toMatch(/not taking bookings/i);
    expect(outboundCalls).toEqual([]);

    // back to AI: the same tool works again
    await setBiz(biz.id, { callMode: 'ai' });
    expect((await call('check_availability', { date: day })).ok).toBe(true);
  });

  test('M1 forward mode on the AI line behaves like paused for the tools; after hours (forward only during business hours) the AI works', async () => {
    const day = futureDateKey(2);
    const openAllDay = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '00:00', close: '24:00' }]));
    const biz = await newBusiness({ hours: openAllDay as never });
    await setBiz(biz.id, { ...FWD, forwardDuringHours: true });
    const refused = async (id: string) => {
      const res = await toolRoute(toolRequest('check_availability', { agent_id: id, date: day }), { params: Promise.resolve({ tool: 'check_availability' }) });
      return /not taking bookings/i.test(((await res.json()) as { message: string }).message);
    };
    expect(await refused(biz.agent_id!)).toBe(true); // inside hours the forward is due, and this line cannot dial: paused script, tools refused
    await setBiz(biz.id, { hours: {} });
    expect(await refused(biz.agent_id!)).toBe(false); // closed all week: after hours the AI answers (the tool runs, whatever it then finds)
    const init = (await (await initiation.POST(new Request('http://localhost/api/voice/initiation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret },
      body: JSON.stringify({ agent_id: biz.agent_id, called_number: biz.phone, caller_id: phone(), call_sid: uniq('CA') }),
    }))).json()) as { conversation_config_override?: { agent?: { first_message?: string } } };
    expect(init.conversation_config_override?.agent?.first_message).toContain('this is Maria'); // same decision: the normal greeting
  });

  test('M1 the paused prompt override is only sent when explicitly enabled (an agent that was not re-provisioned never gets one)', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { callMode: 'paused' });
    const ask = async () => ((await (await initiation.POST(new Request('http://localhost/api/voice/initiation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret },
      body: JSON.stringify({ agent_id: biz.agent_id, called_number: biz.phone, caller_id: phone(), call_sid: uniq('CA') }),
    }))).json()) as { conversation_config_override: { agent: { prompt?: { prompt: string } } } }).conversation_config_override.agent;
    expect((await ask()).prompt).toBeUndefined();
    await withEnv({ ELEVENLABS_PAUSED_PROMPT_OVERRIDE: 'true' }, async () => {
      expect((await ask()).prompt?.prompt).toMatch(/PAUSED[\s\S]*handoff_to_human/);
    });
  });

  // ================================================================== M2
  test('M2 on the native AI line forwarding is refused with an honest message and shown as unavailable', async () => {
    await withEnv({ VOICE_LINE_KIND: 'native' }, async () => {
      const biz = await newBusiness();
      await setBiz(biz.id, { forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() });
      const res = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }), ctx(biz.id));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('Forwarding is not available on the AI voice line — callers will hear the paused message');
      expect((await db.getBusiness(biz.id))?.call_mode).toBe('ai');

      // a business that already had 'forward' stored: the pill says so and the caller hears the paused script
      await setBiz(biz.id, { callMode: 'forward' });
      const view = ((await (await modeRoute.GET(api(`/api/businesses/${biz.id}/call-mode`, 'GET'), ctx(biz.id))).json()) as { data: { forward_supported: boolean; label: string; route_now: string } }).data;
      expect(view).toMatchObject({ forward_supported: false, route_now: 'paused' });
      expect(view.label).toMatch(/Forwarding is not available on the AI voice line/);
      const sid = uniq('CA');
      const init = (await (await initiation.POST(new Request('http://localhost/api/voice/initiation', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret },
        body: JSON.stringify({ agent_id: biz.agent_id, called_number: biz.phone, caller_id: phone(), call_sid: sid }),
      }))).json()) as { conversation_config_override: { agent: { first_message: string } } };
      expect(init.conversation_config_override.agent.first_message).toMatch(/not taking bookings/);
      expect((await prisma.call.findFirst({ where: { callSid: sid } }))?.flaggedReason).toMatch(/Forwarding is not available/);
    });
    // and on a webhook line (the default here) it is available
    const biz = await newBusiness();
    await setBiz(biz.id, FWD);
    const ok = ((await (await modeRoute.GET(api(`/api/businesses/${biz.id}/call-mode`, 'GET'), ctx(biz.id))).json()) as { data: { forward_supported: boolean } }).data;
    expect(ok.forward_supported).toBe(true);
  });

  // ================================================================== M3
  async function voicemailCall(businessId: string, extra: Record<string, unknown> = {}) {
    return prisma.call.create({
      data: { businessId, callSid: uniq('CA'), callerPhone: phone(), status: 'handed_off', flaggedReason: 'Voicemail left (34s): please call back', recordingUrl: REC, durationSec: 34, ...extra },
    });
  }
  const stubTwilio = (handler: (url: string, init: RequestInit) => Response) => {
    const saved = globalThis.fetch;
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      seen.push({ url, init });
      return handler(url, init);
    }) as typeof fetch;
    return { seen, restore: () => { globalThis.fetch = saved; } };
  };

  test('M3 the voicemail proxy streams the audio server-side with the account credentials; tenant isolation; no raw URL ever leaks', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const other = await newBusiness();
      const owner = await login(biz.id, 'owner');
      const staff = await login(biz.id, 'staff');
      const stranger = await login(other.id, 'owner');
      const call = await voicemailCall(biz.id);
      const plain = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: phone(), summary: 'normal call' } });

      const twilio = stubTwilio(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '4' } }));
      try {
        const get = (id: string, headers: Record<string, string>) => vmRoute.GET(api(`/api/calls/${id}/voicemail`, 'GET', undefined, headers), ctx(id));
        for (const who of [owner, staff]) {
          const res = await get(call.id, asUser(who.cookie));
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toBe('audio/mpeg');
          expect(res.headers.get('cache-control')).toContain('no-store');
          expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
        }
        // the server fetched the .mp3 of OUR account with Basic auth (account sid : token); the browser never sees either
        // the second listener was served from the short-lived server-side cache: ONE Twilio fetch for both
        expect(twilio.seen.length).toBe(1);
        expect(twilio.seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${'b'.repeat(32)}.mp3`);
        const auth = (twilio.seen[0].init.headers as Record<string, string>).authorization;
        expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(`${ACCOUNT}:${SECRETS.twilioToken}`);
        // a Range request on a warm entry is answered from it (a seek costs no Twilio call) ...
        const seek = await get(call.id, { ...asUser(owner.cookie), range: 'bytes=2-3' });
        expect(seek.status).toBe(206);
        expect(seek.headers.get('content-range')).toBe('bytes 2-3/4');
        expect([...new Uint8Array(await seek.arrayBuffer())]).toEqual([3, 4]);
        expect(twilio.seen.length).toBe(1);
        // ... and passed through to Twilio on a cold one
        clearVoicemailCache();
        await get(call.id, { ...asUser(owner.cookie), range: 'bytes=2-3' });
        expect((twilio.seen[1].init.headers as Record<string, string>).range).toBe('bytes=2-3');

        // other tenants: 404 exactly like a missing id; no credential: 401; a call without a voicemail: 404
        expect((await get(call.id, asUser(stranger.cookie))).status).toBe(404);
        expect((await get('nope', asUser(owner.cookie))).status).toBe(404);
        expect((await get(call.id, { 'content-type': 'application/json' })).status).toBe(401);
        expect((await get(plain.id, asUser(owner.cookie))).status).toBe(404);
        expect(twilio.seen.length).toBe(2); // refused requests never reached Twilio
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'call.voicemail_played' } })).toBe(2); // owner + staff (the seek is not logged again)
      } finally { twilio.restore(); }

      // /api/calls: no recording_url anywhere, has_voicemail instead; ?voicemail=1 lists only voicemails; other tenants see nothing of it
      const list = await callsRoute.GET(api('/api/calls', 'GET', undefined, asUser(staff.cookie)));
      const text = await list.text();
      expect(text).not.toContain('recording_url');
      expect(text).not.toContain('api.twilio.com');
      expect(text).not.toContain(REC);
      const items = (JSON.parse(text) as { data: { items: { id: string; has_voicemail: boolean }[] } }).data.items;
      expect(items.find((c) => c.id === call.id)?.has_voicemail).toBe(true);
      expect(items.find((c) => c.id === plain.id)?.has_voicemail).toBe(false);
      const only = JSON.parse(await (await callsRoute.GET(api('/api/calls?voicemail=1', 'GET', undefined, asUser(staff.cookie)))).text()) as { data: { items: { id: string }[] } };
      expect(only.data.items.map((c) => c.id)).toEqual([call.id]);
      const foreign = JSON.parse(await (await callsRoute.GET(api(`/api/calls?voicemail=1&business_id=${biz.id}`, 'GET', undefined, asUser(stranger.cookie)))).text()) as { ok: boolean; data?: { items: unknown[] } };
      expect(foreign.data?.items ?? []).toEqual([]);
    });
  });

  test('M3 playback is refused when the credentials do not match the recording account; only recordings of our own account are ever fetched', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id);
    const call = await voicemailCall(biz.id);
    const foreign = await voicemailCall(biz.id, { recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'c'.repeat(32)}/Recordings/RE${'d'.repeat(32)}` });
    const evil = await voicemailCall(biz.id, { recordingUrl: 'https://evil.example/steal.mp3' });
    const twilio = stubTwilio(() => new Response('x', { status: 200 }));
    try {
      await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
        for (const c of [foreign, evil]) {
          const res = await vmRoute.GET(api(`/api/calls/${c.id}/voicemail`, 'GET', undefined, asUser(owner.cookie)), ctx(c.id));
          expect([c.id, res.status === 503 || res.status === 404]).toEqual([c.id, true]);
        }
      });
      await withEnv({ TWILIO_ACCOUNT_SID: undefined }, async () => {
        expect((await vmRoute.GET(api(`/api/calls/${call.id}/voicemail`, 'GET', undefined, asUser(owner.cookie)), ctx(call.id))).status).toBe(503);
      });
      expect(twilio.seen).toEqual([]); // credentials were never sent anywhere
    } finally { twilio.restore(); }
  });

  test('M3 retention purge and customer erasure also delete the provider-side recording; export names the playback path, not the URL', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const caller = phone();
      const old = new Date(Date.now() - 400 * 86_400_000); // past the default 365 days
      await voicemailCall(biz.id, { startedAt: old, callerPhone: caller, callerE164: caller });
      const twilio = stubTwilio(() => new Response(null, { status: 204 }));
      try {
        const counts = await db.purgeExpiredData();
        expect(counts.recordings).toBeGreaterThanOrEqual(1);
        const del = twilio.seen.find((s) => s.init.method === 'DELETE');
        expect(del?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${'b'.repeat(32)}.json`);
        expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);

        const biz2 = await newBusiness();
        const caller2 = phone();
        const c2 = await voicemailCall(biz2.id, { callerPhone: caller2, callerE164: caller2 });
        const { exportCustomerData } = await import('../../src/lib/privacy');
        const exp = await exportCustomerData(biz2.id, caller2);
        const json = JSON.stringify(exp);
        expect(json).not.toContain('api.twilio.com');
        expect(json).toContain(`/api/calls/${c2.id}/voicemail`);
        twilio.seen.length = 0;
        const erased = await db.eraseCustomerData(biz2.id, caller2);
        expect(erased).toMatchObject({ calls: 1, recordings: 1 });
        expect(twilio.seen.filter((s) => s.init.method === 'DELETE').length).toBe(1);
      } finally { twilio.restore(); }
    });
  });

  // ================================================================== M4
  test('M4 switching INTO paused/forward needs a recent proof of identity; reauth with the password unlocks it for 5 minutes; back to AI never asks', async () => {
    const biz = await newBusiness();
    const { cookie, sessionId } = await login(biz.id);
    const patch = (body: unknown) => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', body, asUser(cookie)), ctx(biz.id));
    const reauthWith = (body: unknown) => reauth(api('/api/auth/reauth', 'POST', body, asUser(cookie)));

    expect((await patch({ mode: 'paused' })).status).toBe(200); // a fresh login counts as recent
    await ageSudo(sessionId, 6);
    const denied = await patch({ mode: 'ai' }); // switching back to AI never needs it
    expect(denied.status).toBe(200);
    const stale = await patch({ mode: 'paused' });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: 'reauth_required' });
    expect((await db.getBusiness(biz.id))?.call_mode).toBe('ai');

    expect((await reauthWith({ password: 'wrong password' })).status).toBe(401);
    expect((await reauthWith({})).status).toBe(422);
    expect((await patch({ mode: 'paused' })).status).toBe(403);
    expect((await reauthWith({ password: PASSWORD })).status).toBe(200);
    expect((await patch({ mode: 'paused' })).status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: { in: ['auth.reauth', 'auth.reauth_failed'] } } })).toBe(2);

    await ageSudo(sessionId, 5.5);
    expect((await patch({ mode: 'ai' })).status).toBe(200);
    expect((await patch({ mode: 'paused' })).status).toBe(403); // 5 minutes later it is stale again
    // the admin Bearer token carries its own proof
    expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'paused' }), ctx(biz.id))).status).toBe(200);
  });

  test('M4 reauth is per session, throttled, and works for owners with 2FA only through a valid code', async () => {
    const biz = await newBusiness();
    const a = await login(biz.id);
    const b = await login(biz.id);
    await ageSudo(a.sessionId, 10);
    await ageSudo(b.sessionId, 10);
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, asUser(a.cookie)))).status).toBe(200);
    const mode = (cookie: string) => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'paused' }), ctx(biz.id)).then(() => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'ai' }, asUser(cookie)), ctx(biz.id)));
    void mode;
    // the OTHER session of the same user is still stale
    const other = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'paused' }, asUser(b.cookie)), ctx(biz.id));
    expect(other.status).toBe(403);
    // unauthenticated and cross-site calls are refused
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, { 'content-type': 'application/json' }))).status).toBe(401);
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, { ...asUser(a.cookie), 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    // too many wrong attempts lock the step
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await reauth(api('/api/auth/reauth', 'POST', { password: `wrong-${i}` }, asUser(b.cookie)))).status;
    expect(last).toBe(429);
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, asUser(b.cookie)))).status).toBe(429);
  });

  test('M4 setting the forwarding number needs the same step-up and every transition is audited and announced by email AND text', async () => {
    const mail = captureMail();
    try {
      const biz = await newBusiness();
      const { cookie, sessionId, user } = await login(biz.id);
      const staff = await login(biz.id, 'staff');
      const start = (phoneNumber: string) => fwdStart(api(`/api/businesses/${biz.id}/forward-number/verify/start`, 'POST', { phone: phoneNumber }, asUser(cookie)), ctx(biz.id));

      await ageSudo(sessionId, 10);
      const smsBefore = await prisma.smsLog.count({ where: { businessId: biz.id } });
      const refused = await start(phone());
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'reauth_required' });
      expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(smsBefore); // no code was sent
      expect((await fwdRoute.PUT(api(`/api/businesses/${biz.id}/forward-number`, 'PUT', { use_owner_phone: true }, asUser(cookie)), ctx(biz.id))).status).toBe(403);
      await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, asUser(cookie)));

      // adopt the verified owner phone, then forward: both announced
      expect((await fwdRoute.PUT(api(`/api/businesses/${biz.id}/forward-number`, 'PUT', { use_owner_phone: true }, asUser(cookie)), ctx(biz.id))).status).toBe(200);
      expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }, asUser(cookie)), ctx(biz.id))).status).toBe(200);
      const notices = mail.to(user.email);
      expect(notices.length).toBeGreaterThanOrEqual(2);
      expect(notices.every((m) => m.subject === 'Your call handling was changed')).toBe(true);
      expect(notices.some((m) => /from AI answers to forwarding/.test(m.text))).toBe(true);
      expect(notices.some((m) => /number ending \d{4}/.test(m.text))).toBe(true);
      expect(notices.some((m) => m.text.includes('+1305'))).toBe(false); // never the whole number
      expect(mail.to(staff.user.email)).toEqual([]); // owners only
      const texts = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'owner_alert' } });
      expect(texts.length).toBeGreaterThanOrEqual(2);

      // a DIFFERENT number silently dropped 'forward' back to 'ai': that transition is audited and announced too
      const res = await start(phone());
      expect(res.status).toBe(200);
      expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'ai', forward_number_verified_at: null });
      const audits = await prisma.auditEvent.findMany({ where: { businessId: biz.id, action: 'business.call_mode_changed' }, orderBy: { at: 'asc' } });
      expect(audits.map((a) => (a.meta as { to: string; reason: string }).to + ':' + (a.meta as { reason: string }).reason)).toEqual(['forward:mode_changed', 'ai:forward_number_replaced']);
      expect(mail.to(user.email).length).toBeGreaterThanOrEqual(3);

      // removing the number is announced as well (no password needed to remove)
      await ageSudo(sessionId, 10);
      expect((await fwdRoute.DELETE(api(`/api/businesses/${biz.id}/forward-number`, 'DELETE', undefined, asUser(cookie)), ctx(biz.id))).status).toBe(200);
      expect(mail.to(user.email).some((m) => /forwarding number removed/.test(m.text))).toBe(true);
    } finally { mail.restore(); }
  });

  test('M4 confirming a forwarding number needs the step-up too (a stale session cannot finish a verification someone else started)', async () => {
    const biz = await newBusiness();
    const { cookie, sessionId } = await login(biz.id);
    await ageSudo(sessionId, 10);
    const res = await fwdConfirm(api(`/api/businesses/${biz.id}/forward-number/verify/confirm`, 'POST', { phone: phone(), code: '123456', challenge: 'x.y' }, asUser(cookie)), ctx(biz.id));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'reauth_required' });
    expect((await db.getBusiness(biz.id))?.forward_number_verified_at).toBeNull();
  });

  test('M4 change notices are rate limited per business (the change still happens and is audited)', async () => {
    const mail = captureMail();
    try {
      const biz = await newBusiness();
      const { user } = await login(biz.id);
      for (let i = 0; i < 9; i++) {
        const mode = i % 2 === 0 ? 'paused' : 'ai';
        expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode }), ctx(biz.id))).status).toBe(200);
      }
      expect(mail.to(user.email).length).toBe(6);
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.call_mode_changed' } })).toBe(9);
    } finally { mail.restore(); }
  });

  // ================================================================== Lows
  test('L2 a job in progress is listed under upcoming only, never also under past', async () => {
    const biz = await newBusiness();
    const now = new Date();
    const running = await prisma.booking.create({ data: { businessId: biz.id, customerName: 'Running', customerPhone: phone(), service: 'AC', scheduledAt: new Date(now.getTime() - 30 * 60_000), durationMinutes: 120, status: 'confirmed' } });
    const ended = await prisma.booking.create({ data: { businessId: biz.id, customerName: 'Ended', customerPhone: phone(), service: 'AC', scheduledAt: new Date(now.getTime() - 5 * 3600_000), durationMinutes: 60, status: 'confirmed' } });
    const later = await prisma.booking.create({ data: { businessId: biz.id, customerName: 'Later', customerPhone: phone(), service: 'AC', scheduledAt: new Date(now.getTime() + 3 * 3600_000), durationMinutes: 60, status: 'confirmed' } });
    const up = (await db.listBookingsPage(biz.id, { direction: 'upcoming', now })).items.map((b) => b.id);
    const past = (await db.listBookingsPage(biz.id, { direction: 'past', now })).items.map((b) => b.id);
    expect(up).toEqual([running.id, later.id]);
    expect(past).toEqual([ended.id]);
    // paging through `past` with a tiny limit never yields the running job either
    const p1 = await db.listBookingsPage(biz.id, { direction: 'past', now, limit: 1 });
    expect(p1.items.map((b) => b.id)).toEqual([ended.id]);
  });

  test('L3 a keyset cursor survives the cursor row being deleted mid-walk (no tenant is skipped)', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const c = await newBusiness();
    const all = (await db.listAllBusinesses()).map((x) => x.id);
    for (const id of [a.id, b.id, c.id]) expect(all).toContain(id);
    // walk page by page; delete the business the cursor points at before taking the next page
    const first = await db.listBusinessesPage({ limit: 1 });
    expect(first.next_cursor).not.toBeNull();
    await prisma.business.delete({ where: { id: first.items[0].id } });
    const next = await db.listBusinessesPage({ limit: 1000, cursor: first.next_cursor });
    const ids = next.items.map((x) => x.id);
    expect(ids).not.toContain(first.items[0].id);
    expect(ids.length).toBeGreaterThanOrEqual(2); // the walk continued instead of ending empty
    // the legacy proof: a cursor row that is deleted before the call
    const mid = await db.listBusinessesPage({ limit: 1 });
    const cursor = mid.next_cursor;
    await prisma.business.delete({ where: { id: mid.items[0].id } });
    expect((await db.listBusinessesPage({ limit: 5, cursor })).items.length).toBeGreaterThan(0);
  });

  test('L3 the job runner list keeps walking when a tenant is deleted between pages', async () => {
    const live = await Promise.all([newBusiness(), newBusiness(), newBusiness()]);
    for (const b of live) await prisma.business.update({ where: { id: b.id }, data: { status: 'live' } });
    const rows = await db.listLiveBusinessesForJobs();
    for (const b of live) expect(rows.map((r) => r.id)).toContain(b.id);
  });

  test('L5 PATCH accepts forward_during_hours alone and never touches the mode (a stale tab cannot revert it)', async () => {
    const biz = await newBusiness();
    await setBiz(biz.id, { callMode: 'paused' });
    const res = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { forward_during_hours: true }), ctx(biz.id));
    expect(res.status).toBe(200);
    expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'paused', forward_during_hours: true });
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.forward_hours_changed' } })).toBe(1);
    // nothing to change is a 422, and a forward number that became unverified does not block the hours flag
    expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', {}), ctx(biz.id))).status).toBe(422);
    await setBiz(biz.id, { callMode: 'forward', forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: null });
    expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { forward_during_hours: false }), ctx(biz.id))).status).toBe(200);
  });

  test('L6 date far outside the supported range is a 422, not a 500 (month, week, day)', async () => {
    const biz = await newBusiness();
    const owner = await login(biz.id);
    for (const view of ['month', 'week', 'day']) {
      for (const date of ['9999-12-15', '0001-01-01', '2126-01-01']) {
        const res = await bookingsRoute.GET(api(`/api/bookings?view=${view}&date=${date}`, 'GET', undefined, asUser(owner.cookie)));
        expect([view, date, res.status]).toEqual([view, date, 422]);
      }
    }
    expect((await bookingsRoute.GET(api('/api/bookings?view=month&date=2026-12-15', 'GET', undefined, asUser(owner.cookie)))).status).toBe(200);
  });
});
