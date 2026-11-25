/**
 * Call handling mode (ai / paused / forward) on both voice entry paths, the owner API, the forward-number verification and
 * tenant isolation. Providers are in mock mode and every outbound fetch is refused (see helpers/env).
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq } from '../helpers/fixtures';
import { zonedTimeToUtc } from '../../src/lib/time';
import { DEFAULT_DISCLOSURE } from '../../src/lib/kb/disclosure';

integration('call handling mode (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let incoming: (req: Request) => Promise<Response>;
  let voicemail: (req: Request) => Promise<Response>;
  let initiation: { POST: (req: Request) => Promise<Response> };
  type Ctx = { params: Promise<{ id: string }> };
  let modeRoute: { GET: (req: Request, c: Ctx) => Promise<Response>; PATCH: (req: Request, c: Ctx) => Promise<Response> };
  let fwdRoute: { PUT: (req: Request, c: Ctx) => Promise<Response>; DELETE: (req: Request, c: Ctx) => Promise<Response> };
  let fwdStart: (req: Request, c: Ctx) => Promise<Response>;
  let fwdConfirm: (req: Request, c: Ctx) => Promise<Response>;
  let ownerStart: (req: Request, c: Ctx) => Promise<Response>;
  let ownerConfirm: (req: Request, c: Ctx) => Promise<Response>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
    voicemail = (await import('@/app/api/voice/voicemail/route')).POST;
    initiation = await import('@/app/api/voice/initiation/route');
    modeRoute = await import('@/app/api/businesses/[id]/call-mode/route');
    fwdRoute = await import('@/app/api/businesses/[id]/forward-number/route');
    fwdStart = (await import('@/app/api/businesses/[id]/forward-number/verify/start/route')).POST;
    fwdConfirm = (await import('@/app/api/businesses/[id]/forward-number/verify/confirm/route')).POST;
    ownerStart = (await import('@/app/api/businesses/[id]/owner-phone/verify/start/route')).POST;
    ownerConfirm = (await import('@/app/api/businesses/[id]/owner-phone/verify/confirm/route')).POST;
  });
  afterAll(async () => { await clearLimits(); await cleanup(); });
  beforeEach(async () => { await clearLimits(); });
  const clearLimits = () => prisma.rateLimitBucket.deleteMany({
    where: { OR: [{ key: { startsWith: 'owner-phone/' } }, { key: { startsWith: 'forward-number/' } }, { key: { startsWith: 'voice/missed-call' } }] },
  });

  // ------------------------------------------------------------ helpers
  const URL_IN = `${SECRETS.publicBase}/api/voice/incoming`;
  const URL_VM = `${SECRETS.publicBase}/api/voice/voicemail`;
  const form = (url: string, params: Record<string, string>, sig: string | null, handler = incoming) => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (sig) headers['x-twilio-signature'] = sig;
    return handler(new Request(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() }));
  };
  const signed = (url: string, params: Record<string, string>, handler = incoming) => form(url, params, twilioSignature(url, params), handler);
  const callParams = (to: string, from = phone()) => ({ AccountSid: 'AC' + 'a'.repeat(32), CallSid: uniq('CA'), CallStatus: 'ringing', From: from, To: to });

  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const api = (url: string, method: string, body?: unknown, headers: Record<string, string> = admin as Record<string, string>) =>
    new Request(`http://app.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

  const setMode = (id: string, data: Record<string, unknown>) => prisma.business.update({ where: { id }, data });
  const VERIFIED = { callMode: 'forward', forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() };

  const initReq = (body: Record<string, unknown>) =>
    new Request('http://localhost/api/voice/initiation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-recepcionista-tool-secret': SECRETS.toolSecret }, body: JSON.stringify(body),
    });
  type InitBody = { conversation_config_override?: { agent?: { first_message?: string }; conversation?: { max_duration_seconds?: number } } };

  // ------------------------------------------------------------ /api/voice/incoming
  test('ai mode (default) on the webhook line: a signed Twilio call is ALWAYS answered with TwiML (never JSON); with no AI to connect it is an honest voicemail', async () => {
    const biz = await newBusiness();
    const params = callParams(biz.phone!);
    const res = await signed(URL_IN, params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    const xml = await res.text();
    expect(xml).toStartWith('<?xml');
    expect(xml).toContain('<Say');
    expect(xml).toContain('will be recorded'); // the recording notice precedes the <Record>
    expect(xml).toContain('<Record');
    const row = await db.getCallBySid(params.CallSid);
    expect(row?.business_id).toBe(biz.id);
    expect(outboundCalls).toEqual([]);
    // the unsigned demo UI (JSON) still gets JSON
    const demo = await incoming(new Request(URL_IN, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' }, body: JSON.stringify({ To: biz.phone, From: phone(), CallSid: uniq('CA') }) }));
    if (demo.status === 200) expect(demo.headers.get('content-type')).toContain('json');
  });

  test('forward mode: TwiML <Dial> to the verified number, never recorded, the call row says so, no disclosure claimed', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, VERIFIED);
    const params = callParams(biz.phone!);
    const res = await signed(URL_IN, params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('<Dial');
    expect(xml).toMatch(/<Number [^>]*>\+13055550142<\/Number>/);
    expect(xml).toContain(`callerId="${biz.phone_e164}"`);
    expect(xml).toContain('action="/api/voice/voicemail"');
    expect(xml).toContain('statusCallback="/api/voice/dial-status"'); // forwarded minutes are metered from the signed callbacks
    expect(xml).toMatch(/timeLimit="\d+"/); // and a forwarded call can never outlive the allowance
    expect(xml).not.toMatch(/record/i);
    const row = await prisma.call.findFirst({ where: { callSid: params.CallSid } });
    expect(row).toMatchObject({ businessId: biz.id, status: 'completed', recordingDisclosed: false, consentStatus: 'unknown', recordingUrl: null, transcript: null });
    expect(row?.summary).toMatch(/Forwarded to .*0142.*Not recorded/);
    // no agent was created / no text was sent for a forwarded call
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    expect(outboundCalls).toEqual([]);
  });

  test('forward mode with an UNVERIFIED number never dials: the AI answers', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, { ...VERIFIED, forwardNumberVerifiedAt: null });
    const res = await signed(URL_IN, callParams(biz.phone!));
    expect(res.headers.get('content-type')).toContain('xml');
    expect(await res.text()).not.toContain('<Dial');
  });

  test('forward during business hours: forwards while open, the AI answers after hours (business zone)', async () => {
    const biz = await newBusiness({ timezone: 'America/Los_Angeles' });
    await setMode(biz.id, { ...VERIFIED, forwardDuringHours: true });
    const open = (await import('../../src/lib/voice/call-mode')).resolveCallRoute;
    const b = (await db.getBusiness(biz.id))!;
    // 10:00 Pacific on a Tuesday: forward. 20:00 Pacific: AI. (ALL_WEEK fixtures are open 08:00-18:00 every day.)
    expect(open(b, zonedTimeToUtc('2026-11-24', '10:00', 'America/Los_Angeles')).action).toBe('forward');
    expect(open(b, zonedTimeToUtc('2026-11-24', '20:00', 'America/Los_Angeles')).action).toBe('ai');
  });

  test('paused mode: TwiML says the recording notice, records a voicemail; call handed off; owner told once (rate limited); disclosure evidence', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, { callMode: 'paused' });
    const p1 = callParams(biz.phone!);
    const res = await signed(URL_IN, p1);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('<Record');
    expect(xml.indexOf('will be recorded')).toBeLessThan(xml.indexOf('<Record'));
    expect(xml).not.toContain('<Dial');
    const row = await prisma.call.findFirst({ where: { callSid: p1.CallSid } });
    expect(row).toMatchObject({ status: 'handed_off', recordingDisclosed: true, consentStatus: 'disclosed' });
    expect(row?.flaggedReason).toMatch(/Paused/);
    const alerts = () => prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } });
    expect(await alerts()).toBe(1);
    expect((await prisma.smsLog.findFirst({ where: { businessId: biz.id, kind: 'owner_alert' } }))?.body).toContain('MISSED CALL');
    // a second call within 10 minutes: handled the same, but NO second alert text
    await signed(URL_IN, callParams(biz.phone!));
    expect(await alerts()).toBe(1);
    // a Twilio retry of the same CallSid does not duplicate the row or the alert
    await signed(URL_IN, p1);
    expect(await prisma.call.count({ where: { callSid: p1.CallSid } })).toBe(1);
  });

  test('a recorded objection stays sticky: a paused call that was already declined is not re-marked disclosed', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, { callMode: 'paused' });
    const params = callParams(biz.phone!);
    const call = await db.createCall({ business_id: biz.id, call_sid: params.CallSid, caller_phone: params.From, consent_status: 'declined' });
    await signed(URL_IN, params);
    expect((await db.getCall(call.id))?.consent_status).toBe('declined');
  });

  test('JSON (demo UI) callers get a JSON description of the mode, not TwiML', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, { callMode: 'paused' });
    await withEnv({ ALLOW_INSECURE_DEV: 'true', TWILIO_AUTH_TOKEN: undefined, NODE_ENV: 'test' }, async () => {
      const res = await incoming(new Request('http://localhost/api/voice/incoming', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ To: biz.phone, From: phone(), CallSid: uniq('CA') }),
      }));
      expect(res.status).toBe(200);
      const j = (await res.json()) as { data: { call_mode: string; paused: boolean; fallback_script: string } };
      expect(j.data).toMatchObject({ call_mode: 'paused', paused: true });
      expect(j.data.fallback_script).toContain(DEFAULT_DISCLOSURE.split(' ')[0]);
    });
  });

  test('a lapsed plan wins over paused/forward (no service for an inactive account); a used-up FORWARD minutes cap stops FORWARDING but not the voicemail', async () => {
    const lapsed = await newBusiness();
    await setMode(lapsed.id, VERIFIED);
    await db.setBillingState(lapsed.id, { billing_status: 'canceled' });
    await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
      const res = await signed(URL_IN, callParams(lapsed.phone!));
      // the honest out-of-service line, as TwiML (never JSON to a signed Twilio caller)
      expect(res.headers.get('content-type')).toContain('xml');
      const lapsedXml = await res.text();
      expect(lapsedXml).toContain('<Say');
      expect(lapsedXml).toContain('<Hangup/>');
      expect(lapsedXml).not.toContain('<Record');

      const capped = await newBusiness();
      await setMode(capped.id, VERIFIED);
      await db.setBillingState(capped.id, { billing_status: 'active' });
      await db.recordForwardSeconds(capped.id, 60 * 600);
      const res2 = await signed(URL_IN, callParams(capped.phone!));
      const xml2 = await res2.text();
      expect(xml2).not.toContain('<Dial'); // forwarded minutes have their own cap (FORWARD_MINUTES_CAP, 600 by default): it stops the forward ...
      expect(xml2).toContain('<Record'); // ... and the caller is offered the voicemail instead (H2)
    });
  });

  test('Twilio signature is still required in every mode (no row, no TwiML without it)', async () => {
    for (const data of [{ callMode: 'paused' }, VERIFIED]) {
      const biz = await newBusiness();
      await setMode(biz.id, data);
      const params = callParams(biz.phone!);
      const before = await prisma.call.count({ where: { businessId: biz.id } });
      for (const res of [
        await form(URL_IN, params, null),
        await form(URL_IN, params, 'bad-signature'),
        await form(URL_IN, { ...params, To: phone() }, twilioSignature(URL_IN, params)),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.text()).not.toMatch(/<Dial|<Record/);
      }
      expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(before);
    }
  });

  test('tenant isolation: one business paused / forwarding never changes another business\'s calls', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    await setMode(a.id, VERIFIED);
    const bParams = callParams(b.phone!);
    const res = await signed(URL_IN, bParams);
    expect(res.headers.get('content-type')).toContain('xml');
    expect(await res.text()).not.toContain('<Dial');
    expect((await db.getCallBySid(bParams.CallSid))?.business_id).toBe(b.id);
    // and an unknown number with two businesses installed is never routed to "the first one"
    const unknown = await signed(URL_IN, callParams('+13055559999'));
    // (a signed Twilio caller hears the honest unavailable line as TwiML, never a JSON 404)
    expect(unknown.headers.get('content-type')).toContain('xml');
    expect(await unknown.text()).toContain('<Hangup/>');
  });

  // ------------------------------------------------------------ /api/voice/voicemail
  test('forwarded call that nobody answers falls back to the voicemail; an answered one just ends', async () => {
    const biz = await newBusiness();
    await setMode(biz.id, VERIFIED);
    const params = callParams(biz.phone!);
    await signed(URL_IN, params);

    const noAnswer = await signed(URL_VM, { CallSid: params.CallSid, DialCallStatus: 'no-answer' }, voicemail);
    const xml = await noAnswer.text();
    expect(xml).toContain('<Record');
    expect(xml.indexOf('will be recorded')).toBeLessThan(xml.indexOf('<Record'));
    expect(await prisma.call.findFirst({ where: { callSid: params.CallSid } })).toMatchObject({ status: 'handed_off', recordingDisclosed: true });

    const rec = `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'b'.repeat(32)}`;
    const done = await signed(URL_VM, { CallSid: params.CallSid, RecordingUrl: rec, RecordingDuration: '34' }, voicemail);
    expect(await done.text()).toContain('Goodbye');
    expect(await prisma.call.findFirst({ where: { callSid: params.CallSid } })).toMatchObject({ recordingUrl: rec, durationSec: 34 });

    const answered = callParams(biz.phone!);
    await signed(URL_IN, answered);
    const ok = await signed(URL_VM, { CallSid: answered.CallSid, DialCallStatus: 'completed', DialCallDuration: '75' }, voicemail);
    expect(await ok.text()).not.toContain('<Record');
    expect(await prisma.call.findFirst({ where: { callSid: answered.CallSid } })).toMatchObject({ status: 'completed', durationSec: 75 });
  });

  test('voicemail callback: signature required; a foreign recording URL is not stored; unknown calls hang up', async () => {
    const biz = await newBusiness();
    const params = callParams(biz.phone!);
    await db.createCall({ business_id: biz.id, call_sid: params.CallSid, caller_phone: params.From });
    expect((await form(URL_VM, { CallSid: params.CallSid, RecordingUrl: 'https://x/y' }, null, voicemail)).status).toBe(403);
    await signed(URL_VM, { CallSid: params.CallSid, RecordingUrl: 'https://evil.example/steal.mp3', RecordingDuration: '5' }, voicemail);
    expect((await prisma.call.findFirst({ where: { callSid: params.CallSid } }))?.recordingUrl).toBeNull();
    const unknown = await signed(URL_VM, { CallSid: 'CA-unknown', DialCallStatus: 'no-answer' }, voicemail);
    expect(await unknown.text()).toContain('<Hangup/>');
  });

  // ------------------------------------------------------------ native ElevenLabs path
  test('initiation: ai keeps the normal first message; paused and forward use the paused script (disclosure first, 60 s cap); schedule respected', async () => {
    const ai = await newBusiness();
    const r0 = (await (await initiation.POST(initReq({ agent_id: ai.agent_id, called_number: ai.phone, caller_id: phone(), call_sid: uniq('CA'), conversation_id: uniq('conv') }))).json()) as InitBody;
    expect(r0.conversation_config_override?.agent?.first_message).toContain('this is Maria');
    expect(r0.conversation_config_override?.conversation).toBeUndefined();

    for (const data of [{ callMode: 'paused' }, VERIFIED]) {
      const biz = await newBusiness();
      await setMode(biz.id, data);
      const caller = phone();
      const sid = uniq('CA');
      const r = (await (await initiation.POST(initReq({ agent_id: biz.agent_id, called_number: biz.phone, caller_id: caller, call_sid: sid, conversation_id: uniq('conv') }))).json()) as InitBody;
      const msg = r.conversation_config_override!.agent!.first_message!;
      expect(msg.startsWith(DEFAULT_DISCLOSURE.slice(0, 40))).toBe(true); // the recording/AI notice comes first
      expect(msg).toMatch(/not taking bookings by phone/);
      expect(r.conversation_config_override!.conversation!.max_duration_seconds).toBe(60);
      const row = await prisma.call.findFirst({ where: { callSid: sid } });
      expect(row).toMatchObject({ businessId: biz.id, status: 'handed_off', recordingDisclosed: true, consentStatus: 'disclosed' });
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1); // rate-limited missed-call text
    }

    // forward with an unverified number: the AI answers (normal first message)
    const unverified = await newBusiness();
    await setMode(unverified.id, { ...VERIFIED, forwardNumberVerifiedAt: null });
    const r1 = (await (await initiation.POST(initReq({ agent_id: unverified.agent_id, called_number: unverified.phone, caller_id: phone(), call_sid: uniq('CA') }))).json()) as InitBody;
    expect(r1.conversation_config_override?.agent?.first_message).toContain('this is Maria');
  });

  test('initiation: the shared tool secret is still required, and a paused tenant does not affect another tenant', async () => {
    const paused = await newBusiness();
    const other = await newBusiness();
    await setMode(paused.id, { callMode: 'paused' });
    const noSecret = await initiation.POST(new Request('http://localhost/api/voice/initiation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: paused.agent_id }) }));
    expect(noSecret.status).toBe(401);
    const r = (await (await initiation.POST(initReq({ agent_id: other.agent_id, called_number: other.phone, caller_id: phone(), call_sid: uniq('CA') }))).json()) as InitBody;
    expect(r.conversation_config_override?.agent?.first_message).toContain('this is Maria');
  });

  // ------------------------------------------------------------ owner API
  test('PATCH call-mode: owner/admin only, same-origin, validated, audited; staff may read but not change; other tenants get 404', async () => {
    const biz = await newBusiness();
    const other = await newBusiness();
    const patch = (id: string, body: unknown, headers: Record<string, string> = admin) => modeRoute.PATCH(api(`/api/businesses/${id}/call-mode`, 'PATCH', body, headers), ctx(id));

    const p = await patch(biz.id, { mode: 'paused' });
    expect(p.status).toBe(200);
    expect(((await p.json()) as { data: { call_mode: string; route_now: string } }).data).toMatchObject({ call_mode: 'paused', route_now: 'paused' });
    expect((await db.getBusiness(biz.id))?.call_mode).toBe('paused');
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.call_mode_changed' } });
    expect(audit?.meta).toMatchObject({ from: 'ai', to: 'paused' });

    for (const bad of [{ mode: 'on' }, {}, { mode: 'ai', extra: 1 }, { mode: 'ai', forward_during_hours: 'yes' }, []]) {
      expect((await patch(biz.id, bad)).status).toBe(422);
    }
    expect((await patch(biz.id, { mode: 'forward' })).status).toBe(422); // no verified forward number
    expect((await db.getBusiness(biz.id))?.call_mode).toBe('paused');

    // cross-site cookie request refused; no credential refused
    expect((await patch(biz.id, { mode: 'ai' }, { ...admin, 'sec-fetch-site': 'cross-site', cookie: 'rc_admin_session=x', authorization: '' })).status).toBeGreaterThanOrEqual(401);
    expect((await patch(biz.id, { mode: 'ai' }, { 'content-type': 'application/json' })).status).toBe(401);

    const get = await modeRoute.GET(api(`/api/businesses/${biz.id}/call-mode`, 'GET'), ctx(biz.id));
    expect(get.status).toBe(200);
    expect((await modeRoute.GET(api(`/api/businesses/nope/call-mode`, 'GET'), ctx('nope'))).status).toBe(404);
    expect((await db.getBusiness(other.id))?.call_mode).toBe('ai');
  });

  test('forward number: premium / short-code / other-country / own-line numbers are refused before any text is sent', async () => {
    const biz = await newBusiness();
    for (const phoneNumber of ['911', '+19005550142', '+18095550142', '+525512345678', biz.phone, '305 555 0142 ext 4']) {
      const res = await fwdStart(api(`/api/businesses/${biz.id}/forward-number/verify/start`, 'POST', { phone: phoneNumber }), ctx(biz.id));
      expect([phoneNumber, res.status]).toEqual([phoneNumber, 422]);
    }
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    expect((await db.getBusiness(biz.id))?.forward_number_e164).toBeNull();
  });

  /** The code the mock SMS "sent" (the stateless challenge cannot reveal it): capture the console line. */
  async function startFwd(id: string, number: string) {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    let res: Response;
    try { res = await fwdStart(api(`/api/businesses/${id}/forward-number/verify/start`, 'POST', { phone: number }), ctx(id)); } finally { console.log = orig; }
    return { res, json: (await res.json()) as { challenge?: string }, code: lines.join('\n').match(/code: (\d{6})/)?.[1] };
  }

  test('forward number: verified by SMS code (own purpose), then forward mode can be switched on; wrong/foreign codes fail; audited', async () => {
    const biz = await newBusiness();
    const number = phone();
    const { res, json, code } = await startFwd(biz.id, number);
    expect(res.status).toBe(200);
    expect(code).toMatch(/^\d{6}$/);
    // the owner may ALSO get a "forwarding number changed" notice (sent in the daytime, deferred in quiet hours): look for the code row itself
    expect((await prisma.smsLog.findFirst({ where: { businessId: biz.id, body: '[forward number verification code]' } }))?.body).toBe('[forward number verification code]');
    // stored but UNVERIFIED: forward mode refused, and calls are never routed to it
    expect((await db.getBusiness(biz.id))).toMatchObject({ forward_number_e164: number, forward_number_verified_at: null });
    const early = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }), ctx(biz.id));
    expect(early.status).toBe(422);

    const confirm = (body: Record<string, unknown>) => fwdConfirm(api(`/api/businesses/${biz.id}/forward-number/verify/confirm`, 'POST', body), ctx(biz.id));
    expect((await confirm({ phone: number, code: code === '000000' ? '000001' : '000000', challenge: json.challenge })).status).toBe(400);
    expect((await confirm({ phone: phone(), code, challenge: json.challenge })).status).toBe(400);
    const ok = await confirm({ phone: number, code, challenge: json.challenge });
    expect(ok.status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.forward_number_verified' } })).toBe(1);
    expect((await db.getBusiness(biz.id))?.forward_number_verified_at).not.toBeNull();

    const on = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward', forward_during_hours: true }), ctx(biz.id));
    expect(on.status).toBe(200);
    expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'forward', forward_during_hours: true });

    // switching to a NEW number drops the verification and falls back to the AI until it is verified again
    const second = await startFwd(biz.id, phone());
    expect(second.res.status).toBe(200);
    expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'ai', forward_number_verified_at: null });
  });

  test('a code issued for the OWNER phone cannot verify a forward number (and the reverse)', async () => {
    const biz = await newBusiness({ owner_phone: null });
    const number = phone();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    let ownerRes: Response;
    try { ownerRes = await ownerStart(api(`/api/businesses/${biz.id}/owner-phone/verify/start`, 'POST', { phone: number }), ctx(biz.id)); } finally { console.log = orig; }
    const owner = (await ownerRes.json()) as { challenge: string };
    const code = lines.join('\n').match(/code: (\d{6})/)![1];
    const cross = await fwdConfirm(api(`/api/businesses/${biz.id}/forward-number/verify/confirm`, 'POST', { phone: number, code, challenge: owner.challenge }), ctx(biz.id));
    expect(cross.status).toBe(400);
    expect((await db.getBusiness(biz.id))?.forward_number_verified_at).toBeNull();

    const fwd = await startFwd(biz.id, phone());
    const reverse = await ownerConfirm(api(`/api/businesses/${biz.id}/owner-phone/verify/confirm`, 'POST', { phone: fwd.json ? (await db.getBusiness(biz.id))!.forward_number_e164 : '', code: fwd.code, challenge: fwd.json.challenge }), ctx(biz.id));
    expect(reverse.status).toBe(400);
    expect((await db.getBusiness(biz.id))?.owner_phone_verified_at).toBeNull();
  });

  test('PUT forward-number uses the VERIFIED owner phone only; DELETE clears it and returns forward mode to ai', async () => {
    const unverifiedOwner = await newBusiness({ owner_verified: false });
    const no = await fwdRoute.PUT(api(`/api/businesses/${unverifiedOwner.id}/forward-number`, 'PUT', { use_owner_phone: true }), ctx(unverifiedOwner.id));
    expect(no.status).toBe(422);
    expect((await fwdRoute.PUT(api(`/api/businesses/${unverifiedOwner.id}/forward-number`, 'PUT', { use_owner_phone: false }), ctx(unverifiedOwner.id))).status).toBe(422);

    const biz = await newBusiness();
    const yes = await fwdRoute.PUT(api(`/api/businesses/${biz.id}/forward-number`, 'PUT', { use_owner_phone: true }), ctx(biz.id));
    expect(yes.status).toBe(200);
    expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }), ctx(biz.id))).status).toBe(200);
    expect((await fwdRoute.DELETE(api(`/api/businesses/${biz.id}/forward-number`, 'DELETE'), ctx(biz.id))).status).toBe(200);
    expect(await db.getBusiness(biz.id)).toMatchObject({ call_mode: 'ai', forward_number_e164: null, forward_number_verified_at: null });
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: { in: ['business.forward_number_set', 'business.forward_number_removed'] } } })).toBe(2);
  });

  test('database constraints: unknown modes and a verified-without-number row are impossible', async () => {
    const biz = await newBusiness();
    const attempt = async (data: Record<string, unknown>) => { try { await prisma.business.update({ where: { id: biz.id }, data }); return 'accepted'; } catch { return 'rejected'; } };
    expect(await attempt({ callMode: 'sleep' })).toBe('rejected');
    expect(await attempt({ forwardNumberVerifiedAt: new Date() })).toBe('rejected'); // verified without a number
    expect(await attempt({ forwardNumber: '911', forwardNumberE164: '911' })).toBe('rejected');
    expect(await attempt({ callMode: 'paused' })).toBe('accepted');
  });
});
