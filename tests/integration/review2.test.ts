/**
 * Regression tests for adversarial review round 2 (docs/review/06-adversarial-review-round-2.md):
 * H1 declined-consent leak, H2 platform caller id + per-call cap, M1/M2 SMS abuse, M3 erasure coverage,
 * M4 retention default-off, M5 inbound keywords, M6 mandatory disclosure.
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanup, elevenLabsSignature, futureDateKey, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq, wall,
} from '../helpers/fixtures';
import { DEFAULT_DISCLOSURE } from '../../src/lib/kb/disclosure';

integration('review round 2 regressions (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let toolsRoute: (req: Request, ctx: { params: Promise<{ tool: string }> }) => Promise<Response>;
  let postCallRoute: (req: Request) => Promise<Response>;
  let incomingRoute: (req: Request) => Promise<Response>;
  let smsInbound: (req: Request) => Promise<Response>;
  let gratReply: (req: Request) => Promise<Response>;
  let smsSend: (req: Request) => Promise<Response>;
  let payLink: (req: Request) => Promise<Response>;
  let settingsRoute: any;
  let bizRoute: any;
  let privacyErase: (req: Request) => Promise<Response>;
  let privacyExport: (req: Request) => Promise<Response>;
  let retentionRoute: (req: Request) => Promise<Response>;
  const audioFiles: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    toolsRoute = (await import('@/app/api/voice/tools/[tool]/route')).POST;
    postCallRoute = (await import('@/app/api/voice/post-call/route')).POST;
    incomingRoute = (await import('@/app/api/voice/incoming/route')).POST;
    smsInbound = (await import('@/app/api/sms/inbound/route')).POST;
    gratReply = (await import('@/app/api/sms/gratitude-reply/route')).POST;
    smsSend = (await import('@/app/api/sms/send/route')).POST;
    payLink = (await import('@/app/api/sms/payment-link/route')).POST;
    settingsRoute = await import('@/app/api/businesses/[id]/settings/route');
    bizRoute = await import('@/app/api/businesses/[id]/route');
    privacyErase = (await import('@/app/api/privacy/erase/route')).POST;
    privacyExport = (await import('@/app/api/privacy/export/route')).GET;
    retentionRoute = (await import('@/app/api/admin/retention/route')).POST;
  });
  afterAll(async () => {
    for (const f of audioFiles) fs.rmSync(f, { force: true });
    await cleanup();
  });

  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const adminReq = (url: string, body?: unknown, method = 'POST') => new Request(`http://app.test${url}`, {
    method, headers: admin, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const clearRates = () => prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'sms/' } }, { key: { startsWith: 'admin/' } }] } });

  async function tool(name: string, body: Record<string, unknown>) {
    const res = await toolsRoute(toolRequest(name, body), { params: Promise.resolve({ tool: name }) });
    return (await res.json()) as { ok: boolean; message: string };
  }

  // ------------------------------------------------------------------ post-call helpers
  const AGENT_OPENING = `${DEFAULT_DISCLOSURE} — Thanks for calling, how can I help?`;
  function postCall(agentId: string, conv: string | null, turns: { role: string; message: string }[], data: Record<string, unknown> = {}) {
    const raw = JSON.stringify({
      type: 'post_call_transcription',
      data: {
        agent_id: agentId, ...(conv ? { conversation_id: conv } : {}), transcript: turns,
        metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 60, call_duration_secs: 42, main_language: 'en' },
        analysis: { transcript_summary: 'Caller wants a repair.' }, ...data,
      },
    });
    return postCallRoute(new Request(`${SECRETS.publicBase}/api/voice/post-call`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'elevenlabs-signature': elevenLabsSignature(raw) }, body: raw,
    }));
  }
  const normal = [
    { role: 'agent', message: AGENT_OPENING },
    { role: 'user', message: 'My AC is leaking, my address is 12 Elm St.' },
  ];
  const callsOf = (businessId: string) => prisma.call.findMany({ where: { businessId }, orderBy: { startedAt: 'asc' } });

  // ====================================================================== H1

  test('H1: declined through /api/voice/incoming + handoff + post-call is ONE row, declined, no transcript', async () => {
    const biz = await newBusiness();
    const from = phone();
    const sid = uniq('CA');
    const conv = uniq('conv');
    const params = { CallSid: sid, From: from, To: biz.phone!, AccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const url = `${SECRETS.publicBase}/api/voice/incoming`;
    const inc = await incomingRoute(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) },
      body: new URLSearchParams(params).toString(),
    }));
    expect(inc.status).toBe(200);
    const incRow = (await callsOf(biz.id))[0];
    expect(incRow.callSid).toBe(sid); // keyed by the Twilio SID the agent platform will hand the tools
    // the tool call carries system__call_sid + system__conversation_id + system__caller_id
    const h = await tool('handoff_to_human', {
      agent_id: biz.agent_id, call_sid: sid, conversation_id: conv, caller_phone: from, reason: 'caller declined recording/AI', consent_declined: true,
    });
    expect(h.message).not.toMatch(/best number/i); // L10: the declined reply no longer asks for personal data
    const afterTool = await callsOf(biz.id);
    expect(afterTool.length).toBe(1);
    expect(afterTool[0]).toMatchObject({ id: incRow.id, consentStatus: 'declined', conversationId: conv });

    const res = await postCall(biz.agent_id!, conv, [
      { role: 'agent', message: AGENT_OPENING },
      { role: 'user', message: "I don't want to be recorded. My name is Ana, I live at 12 Elm St." },
    ]);
    expect(res.status).toBe(200);
    const rows = await callsOf(biz.id);
    expect(rows.length).toBe(1); // no phantom duplicate
    expect(rows[0]).toMatchObject({ id: incRow.id, consentStatus: 'declined', transcript: null, recordingUrl: null });
    expect(rows[0].summary).toMatch(/declined/i);
    expect(outboundCalls).toEqual([]);
  });

  test('H1: native path, tool keyed by call_sid only; post-call correlates by metadata.phone_call.call_sid', async () => {
    const biz = await newBusiness();
    const sid = uniq('CA');
    await tool('handoff_to_human', { agent_id: biz.agent_id, call_sid: sid, reason: 'declined', consent_declined: true });
    const res = await postCall(biz.agent_id!, uniq('conv'), normal, { metadata: { phone_call: { call_sid: sid }, start_time_unix_secs: Math.floor(Date.now() / 1000) - 30 } });
    expect(res.status).toBe(200);
    const rows = await callsOf(biz.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ callSid: sid, consentStatus: 'declined', transcript: null });
  });

  test('H1: declined is sticky at the data layer (no later write can move it to disclosed)', async () => {
    const biz = await newBusiness();
    const c = await db.createCall({ business_id: biz.id, consent_status: 'declined' });
    await db.updateCall(c.id, { consent_status: 'disclosed', recording_disclosed: true });
    expect(await db.getCall(c.id)).toMatchObject({ consent_status: 'declined', recording_disclosed: false });
    await db.updateCall(c.id, { consent_status: 'unknown' });
    expect((await db.getCall(c.id))?.consent_status).toBe('declined');
  });

  test('H1: a caller who objects in the transcript is treated as declined even if no tool ran; nothing is stored', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    const res = await postCall(biz.agent_id!, conv, [
      { role: 'agent', message: AGENT_OPENING },
      { role: 'user', message: 'No quiero que me graben, adiós.' },
    ]);
    expect(res.status).toBe(200);
    const rows = await callsOf(biz.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ consentStatus: 'declined', transcript: null });
    const objection = await postCall(biz.agent_id!, uniq('conv'), [
      { role: 'agent', message: AGENT_OPENING },
      { role: 'user', message: "I do not consent to this call being recorded or transcribed." },
    ]);
    expect(objection.status).toBe(200);
    expect((await callsOf(biz.id)).every((r) => r.transcript === null)).toBe(true);
  });

  test('H1: only SERVER-SIDE evidence sets disclosed: a caller saying "recorded" proves nothing; the agent opening does', async () => {
    const biz = await newBusiness();
    // no disclosure in the agent's turns; the caller's own words mention "recorded"
    const conv1 = uniq('conv');
    await postCall(biz.agent_id!, conv1, [
      { role: 'agent', message: 'Hello, how can I help?' },
      { role: 'user', message: 'Is this call recorded? This is recorded right?' },
    ]);
    const first = (await callsOf(biz.id)).find((r) => r.conversationId === conv1)!;
    expect(first.consentStatus).toBe('unknown');
    expect(first.transcript).toBeNull(); // consent not established: fail privacy-safe
    // the agent's own first message carries the disclosure: stored and marked disclosed
    const conv2 = uniq('conv');
    await postCall(biz.agent_id!, conv2, normal);
    const rows = await callsOf(biz.id);
    expect(rows.length).toBe(2);
    const second = rows.find((r) => r.conversationId === conv2)!;
    expect(second).toMatchObject({ consentStatus: 'disclosed', recordingDisclosed: true });
    expect(second.transcript).toContain('My AC is leaking');
  });

  test('H1: a call that cannot be tied to a conversation (no keys at all) stores metadata only', async () => {
    const biz = await newBusiness();
    const res = await postCall(biz.agent_id!, null, normal);
    expect(res.status).toBe(200);
    const row = (await callsOf(biz.id))[0];
    expect(row).toMatchObject({ transcript: null, consentStatus: 'unknown' });
    expect(row.summary).toMatch(/not stored/i);
    // an unkeyed declined call in the window also forces metadata-only for an unmatched conversation
    const biz2 = await newBusiness();
    await tool('handoff_to_human', { agent_id: biz2.agent_id, reason: 'declined', consent_declined: true }); // no call keys
    await postCall(biz2.agent_id!, uniq('conv'), normal);
    expect((await callsOf(biz2.id)).every((r) => r.transcript === null)).toBe(true);
  });

  // ====================================================================== H2

  const TUE = () => futureDateKey(2);
  const book = (biz: { agent_id?: string | null }, extra: Record<string, unknown>, hhmm: string) => tool('create_booking', {
    agent_id: biz.agent_id, customer_name: 'Ana Pérez', service: 'AC repair', scheduled_at: wall(TUE(), hhmm), ...extra,
  });

  test('H2: texts go to the platform caller id, never to the number the model relays; the relayed number is only the contact', async () => {
    const biz = await newBusiness();
    const caller = '+13055550142';
    const conv = uniq('conv');
    const r = await book(biz, { conversation_id: conv, caller_phone: caller, customer_phone: '+13055559999' }, '09:00');
    expect(r.ok).toBe(true);
    const booking = (await prisma.booking.findMany({ where: { businessId: biz.id } }))[0];
    expect(booking.customerPhone).toBe('+13055559999');
    expect(booking.followupConsentAt).toBeNull(); // the notice did not reach that number
    expect((await prisma.smsLog.findMany({ where: { businessId: biz.id } })).map((s) => [s.kind, s.toPhone])).toEqual([['confirmation', caller]]);
    const row = (await callsOf(biz.id))[0];
    expect(row).toMatchObject({ conversationId: conv, callerPhone: caller }); // the first tool call created the row

    const s = await tool('send_sms', { agent_id: biz.agent_id, conversation_id: conv, caller_phone: caller, to: '+19995550123', body: 'Our address is 1 Main St' });
    expect(s.ok).toBe(true);
    const pay = await tool('create_payment_link', { agent_id: biz.agent_id, conversation_id: conv, caller_phone: caller, amount_cents: 5000, booking_id: booking.id });
    expect(pay.ok).toBe(true);
    const tos = (await prisma.smsLog.findMany({ where: { businessId: biz.id } })).map((x) => x.toPhone);
    expect(new Set(tos)).toEqual(new Set([caller]));
    expect(tos.length).toBe(3);
  });

  test('H2: when the relayed number IS the caller, the follow-up consent is recorded and gratitude can use it', async () => {
    const biz = await newBusiness();
    const caller = phone();
    await book(biz, { conversation_id: uniq('conv'), caller_phone: caller, customer_phone: caller }, '09:00');
    const booking = (await prisma.booking.findMany({ where: { businessId: biz.id } }))[0];
    expect(booking.followupConsentAt).not.toBeNull();
    expect(booking.followupConsentSource).toBe('confirmation_sms_notice');
    const conf = await prisma.smsLog.findFirst({ where: { businessId: biz.id, kind: 'confirmation' } });
    expect(conf?.body).toMatch(/may text you after your visit/i);
  });

  test('H2: the per-call cap holds with NO prior call row (keyed by conversation id), sequentially and concurrently', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    const base = { conversation_id: conv, caller_phone: '+13055550142', customer_phone: '+13055550142' };
    const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];
    const results = [];
    for (const h of hours) results.push(await book(biz, base, h));
    expect(results.filter((r) => r.ok).length).toBe(2);
    expect(await prisma.booking.count({ where: { businessId: biz.id } })).toBe(2);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'confirmation' } })).toBe(2);

    const conv2 = uniq('conv');
    await Promise.all(hours.map((h) => book(biz, { ...base, conversation_id: conv2 }, `${h.slice(0, 2)}:30`)));
    const rows = await callsOf(biz.id);
    expect(rows.filter((c) => c.conversationId === conv2).length).toBe(1); // concurrent first calls share ONE row
    expect(await prisma.booking.count({ where: { callId: rows.find((c) => c.conversationId === conv2)!.id } })).toBeLessThanOrEqual(2);
  });

  test('H2: a booking with no call key at all is refused (nothing for the cap to hang on)', async () => {
    const biz = await newBusiness();
    const r = await book(biz, { caller_phone: '+13055550142', customer_phone: '+13055550142' }, '09:00');
    expect(r.ok).toBe(false);
    expect(await prisma.booking.count({ where: { businessId: biz.id } })).toBe(0);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    expect(await db.createBooking({ business_id: biz.id, customer_name: 'x', customer_phone: '+13055550101', service: 's', scheduled_at: new Date(Date.now() + 3 * 86400_000).toISOString() }, { enforce: false, max_per_call: 2 }).catch((e) => e.reason)).toBe('no_call');
  });

  test('H2: with no verified caller id the relayed phone is stored but NOT texted, unless policy allows it', async () => {
    const biz = await newBusiness();
    const r = await book(biz, { conversation_id: uniq('conv'), customer_phone: '+13055550177' }, '09:00');
    expect(r.ok).toBe(true);
    expect((await prisma.booking.findMany({ where: { businessId: biz.id } }))[0].customerPhone).toBe('+13055550177');
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    await withEnv({ ALLOW_UNVERIFIED_BOOKING_SMS: 'true' }, async () => {
      expect((await book(biz, { conversation_id: uniq('conv'), customer_phone: '+13055550178' }, '11:00')).ok).toBe(true);
    });
    expect((await prisma.smsLog.findMany({ where: { businessId: biz.id } })).map((s) => s.toPhone)).toEqual(['+13055550178']);
  });

  test('H2: flag_emergency never turns a relayed number into the call\'s trusted caller number', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    await tool('flag_emergency', { agent_id: biz.agent_id, conversation_id: conv, reason: 'leak', customer_phone: '+19995550123' });
    expect((await callsOf(biz.id))[0].callerPhone).toBeNull();
    const s = await tool('send_sms', { agent_id: biz.agent_id, conversation_id: conv, body: 'hi' });
    expect(s.ok).toBe(false); // nobody verified to text
  });

  // ====================================================================== M1 / M2

  test('M1: kind and consent_basis cannot be set over HTTP; free text is `manual` and honours opt-outs and quiet hours', async () => {
    await clearRates();
    const biz = await newBusiness();
    const cust = phone();
    await db.createCall({ business_id: biz.id, caller_phone: cust });
    const send = (extra: Record<string, unknown> = {}) => smsSend(adminReq('/api/sms/send', { business_id: biz.id, to: cust, body: 'Spring promo!', ...extra }));
    expect((await send({ kind: 'owner_alert' })).status).toBe(422);
    expect((await send({ kind: 'review_request', consent_basis: 'express_opt_in' })).status).toBe(422);
    expect((await send({ consent_basis: 'express_opt_in' })).status).toBe(422);
    await db.recordOptOut(biz.id, cust, 'stop_keyword');
    const blocked = (await (await send()).json()) as { data: { kind: string; status: string } };
    expect(blocked.data).toMatchObject({ kind: 'manual', status: 'blocked_opt_out' });
    // re-pointing owner_phone at the opted-out customer is refused, so owner_alert exemption cannot be abused
    const patch = await bizRoute.PATCH(adminReq(`/api/businesses/${biz.id}`, { owner_phone: cust }, 'PATCH'), { params: Promise.resolve({ id: biz.id }) });
    expect(patch.status).toBe(422);
    expect((await db.getBusiness(biz.id))?.owner_phone).not.toBe(cust);
    // quiet hours apply to manual free text
    await db.recordOptIn(biz.id, cust);
    const night = await (await import('@/lib/messaging')).sendAndLog({ business_id: biz.id, to: cust, body: 'x', kind: 'manual', now: new Date('2026-07-01T03:00:00-04:00') });
    expect(night.blocked).toBe('blocked_quiet_hours');
  });

  test('M1: gratitude consent is DERIVED from a recorded basis: none => blocked_no_consent; recorded => allowed (quiet hours aside)', async () => {
    const biz = await newBusiness();
    const actions = await import('@/lib/messaging/actions');
    const mk = (customer_phone: string) => db.createBooking({
      business_id: biz.id, customer_name: 'Ana', customer_phone, service: 'AC repair',
      scheduled_at: new Date(Date.now() + (2 + Math.random() * 20) * 86400_000).toISOString(), duration_minutes: 30,
    }, { enforce: false });
    const noConsent = await mk(phone());
    const r1 = await actions.sendGratitude(noConsent.id);
    expect(r1.sms.status).toBe('blocked_no_consent');
    const withConsent = await mk(phone());
    await db.updateBooking(withConsent.id, { followup_consent_at: new Date().toISOString(), followup_consent_source: 'confirmation_sms_notice' });
    const r2 = await actions.sendGratitude(withConsent.id);
    expect(['mock', 'sent', 'blocked_quiet_hours']).toContain(r2.sms.status); // allowed by consent; only the clock may still defer it
    expect(r2.sms.consent_basis ?? 'booking_followup').toBe('booking_followup');
  });

  test('M2: payment-link texts only the booking\'s own number with a server-built body', async () => {
    await clearRates();
    const biz = await newBusiness();
    const other = await newBusiness();
    const bookingPhone = phone();
    const booking = await db.createBooking({
      business_id: biz.id, customer_name: 'Ana', customer_phone: bookingPhone, service: 'AC repair',
      scheduled_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    }, { enforce: false });
    const foreign = await db.createBooking({
      business_id: other.id, customer_name: 'Zed', customer_phone: phone(), service: 'AC repair',
      scheduled_at: new Date(Date.now() + 6 * 86400_000).toISOString(),
    }, { enforce: false });
    const post = (body: Record<string, unknown>) => payLink(adminReq('/api/sms/payment-link', { business_id: biz.id, amount_cents: 5000, ...body }));
    expect((await post({ booking_id: booking.id, to: '+19995550123' })).status).toBe(422);
    expect((await post({ booking_id: booking.id, description: 'Your account is locked, pay at evil.example' })).status).toBe(422);
    expect((await post({ to: '+19995550123' })).status).toBe(422); // booking_id is mandatory
    expect((await post({ booking_id: foreign.id })).status).toBe(404);
    const ok = await post({ booking_id: booking.id });
    expect(ok.status).toBe(200);
    const sms = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'payment_link' } });
    expect(sms.map((s) => s.toPhone)).toEqual([bookingPhone]);
    expect(sms[0].body).toContain('AC repair');
  });

  // ====================================================================== M3

  test('M3: erasure and export cover owner alerts, briefings and the audio files; other customers are untouched', async () => {
    const biz = await newBusiness();
    const target = '+13055550142';
    const day = '2026-06-15';
    const call = await db.createCall({
      business_id: biz.id, caller_phone: target, caller_name: 'Ana Gómez', started_at: `${day}T15:00:00.000Z`, transcript: 'hi',
    });
    const booking = await db.createBooking({
      business_id: biz.id, call_id: call.id, customer_name: 'Ana Gómez', customer_phone: target, service: 'AC repair',
      scheduled_at: `${day}T16:00:00.000Z`, duration_minutes: 30,
    }, { enforce: false });
    const otherCall = await db.createCall({ business_id: biz.id, caller_phone: '+13055550188', caller_name: 'Pedro', started_at: '2026-06-20T15:00:00.000Z' });
    await db.logSms({ business_id: biz.id, to_phone: biz.owner_phone!, body: `New booking: Ana Gómez ${target} AC repair`, kind: 'owner_alert', status: 'sent' });
    await db.logSms({ business_id: biz.id, to_phone: biz.owner_phone!, body: 'Cliente no contento', kind: 'owner_alert', status: 'sent', booking_id: booking.id });
    await db.logSms({ business_id: biz.id, to_phone: biz.owner_phone!, body: 'EMERGENCY Caller: Ana Gómez leak', kind: 'owner_alert', status: 'sent' });
    const keepSms = await db.logSms({ business_id: biz.id, to_phone: biz.owner_phone!, body: 'New booking: Pedro +13055550188', kind: 'owner_alert', status: 'sent' });
    const audioDir = path.join(process.cwd(), 'public', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const mk = async (date: string, transcript: string) => {
      const file = path.join(audioDir, `briefing-${biz.id}-${date}.mp3`);
      fs.writeFileSync(file, 'x'.repeat(2000));
      audioFiles.push(file);
      return db.createBriefing({ business_id: biz.id, date, transcript, audio_url: `/audio/briefing-${biz.id}-${date}.mp3` });
    };
    await mk(day, 'Today ana called about AC'); // the customer's day
    const keepBriefing = await mk('2026-06-20', 'Pedro called about heating'); // someone else's day

    const exp = (await (await privacyExport(adminReq(`/api/privacy/export?business_id=${biz.id}&phone=${encodeURIComponent(target)}`, undefined, 'GET'))).json()) as any;
    expect(exp.data.calls.length).toBe(1);
    expect(exp.data.sms.length).toBe(3); // two alerts quoting her + the booking-linked one
    expect(exp.data.briefings.length).toBe(1);

    const res = await privacyErase(adminReq('/api/privacy/erase', { business_id: biz.id, phone: target }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ calls: 1, transcript_events: 0, sms_logs: 3, bookings_anonymized: 1, briefings: 1, audio_files: 1, recordings: 0, recordings_pending: 0, recording_deletion: 'complete' });
    expect(await prisma.smsLog.findMany({ where: { businessId: biz.id } }).then((r) => r.map((x) => x.id))).toEqual([keepSms.id]);
    expect(await prisma.briefing.findMany({ where: { businessId: biz.id } }).then((r) => r.map((x) => x.id))).toEqual([keepBriefing.id]);
    expect(fs.existsSync(path.join(audioDir, `briefing-${biz.id}-${day}.mp3`))).toBe(false);
    expect(fs.existsSync(path.join(audioDir, `briefing-${biz.id}-2026-06-20.mp3`))).toBe(true);
    expect(await db.getCall(otherCall.id)).not.toBeNull();
    expect((await db.getBooking(booking.id))?.customer_name).toBe('[redacted]');
  });

  // ====================================================================== M4

  test('M4: the automatic retention job is OFF by default; a dry run reports without deleting; the admin endpoint defaults to dry run', async () => {
    const rj = await import('@/lib/retention-job');
    expect(rj.retentionJobEnabled(undefined)).toBe(false);
    expect(rj.retentionJobEnabled('')).toBe(false);
    expect(rj.retentionJobEnabled('true')).toBe(false); // only the exact value `on`
    expect(rj.retentionJobEnabled('on')).toBe(true);

    const biz = await newBusiness();
    const old = await db.createCall({ business_id: biz.id, caller_phone: phone(), started_at: new Date(Date.now() - 400 * 86400_000).toISOString() });
    const dry = await db.purgeExpiredData(new Date(), { dryRun: true });
    expect(dry.calls).toBeGreaterThanOrEqual(1);
    expect(await db.getCall(old.id)).not.toBeNull();

    const forbidden = await retentionRoute(new Request('http://app.test/api/admin/retention', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(forbidden.status).toBe(401);
    const viaApi = (await (await retentionRoute(adminReq('/api/admin/retention', {}))).json()) as any;
    expect(viaApi.data).toMatchObject({ dry_run: true, automatic_job: 'off' });
    expect(await db.getCall(old.id)).not.toBeNull();
    expect((await retentionRoute(adminReq('/api/admin/retention', { dry_run: 'yes' }))).status).toBe(422);
  });

  test('M4: a real purge also deletes the briefing audio files', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { retentionDays: 30 } });
    const date = '2026-01-10';
    const audioDir = path.join(process.cwd(), 'public', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const file = path.join(audioDir, `briefing-${biz.id}-${date}.m4a`);
    fs.writeFileSync(file, 'x'.repeat(2000));
    audioFiles.push(file);
    const b = await db.createBriefing({ business_id: biz.id, date, transcript: 'old', audio_url: `/audio/briefing-${biz.id}-${date}.m4a` });
    await prisma.briefing.update({ where: { id: b.id }, data: { createdAt: new Date(Date.now() - 60 * 86400_000) } });
    const counts = await db.purgeExpiredData();
    expect(counts.briefings).toBeGreaterThanOrEqual(1);
    expect(counts.audio_files).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(file)).toBe(false);
    // a tampered audio_url can never delete anything outside the generated names
    const { removeBriefingAudio } = await import('@/lib/briefing/audio-files');
    expect(removeBriefingAudio(['/audio/../../package.json', '/etc/passwd', '/audio/briefing-x/../../package.json'])).toBe(0);
    expect(fs.existsSync(path.join(process.cwd(), 'package.json'))).toBe(true);
  });

  // ====================================================================== M5

  function twilioForm(url: string, params: Record<string, string>) {
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) },
      body: new URLSearchParams(params).toString(),
    });
  }

  test('M5: /api/sms/inbound opts out on every revocation keyword form, and ignores near-misses', async () => {
    const biz = await newBusiness();
    const url = `${SECRETS.publicBase}/api/sms/inbound`;
    const text = async (body: string, from: string) => {
      const res = await smsInbound(twilioForm(url, { From: from, To: biz.phone!, Body: body, MessageSid: uniq('SM') }));
      return { status: res.status, xml: await res.text() };
    };
    for (const word of ['STOP', 'stop texting me', 'ＳＴＯＰ', '"Opt out"', 'REVOKE', 'Quit.', 'Parar']) {
      const from = phone();
      const r = await text(word, from);
      expect([word, r.status]).toEqual([word, 200]);
      expect(r.xml).toContain('unsubscribed');
      expect([word, await db.isOptedOut(biz.id, from)]).toEqual([word, true]);
    }
    for (const word of ['stop by tomorrow at 5', 'nonstop', 'Yes', '5 stars']) {
      const from = phone();
      await text(word, from);
      expect([word, await db.isOptedOut(biz.id, from)]).toEqual([word, false]);
    }
    const from = phone();
    await text('STOP', from);
    expect(await db.isOptedOut(biz.id, from)).toBe(true);
    expect((await text('YES', from)).xml).not.toContain('resubscribed'); // bare YES is not a re-subscribe
    expect(await db.isOptedOut(biz.id, from)).toBe(true);
    expect((await text('START', from)).xml).toContain('resubscribed');
    expect(await db.isOptedOut(biz.id, from)).toBe(false);
  });

  test('M5: the legacy /api/sms/gratitude-reply URL also honours STOP, and a 1-5 reply on /api/sms/inbound reaches the gratitude logic', async () => {
    const biz = await newBusiness();
    const cust = phone();
    const booking = await db.createBooking({
      business_id: biz.id, customer_name: 'Ana', customer_phone: cust, service: 'AC repair',
      scheduled_at: new Date(Date.now() + 4 * 86400_000).toISOString(),
    }, { enforce: false });
    const grUrl = `${SECRETS.publicBase}/api/sms/gratitude-reply`;
    const res = await gratReply(twilioForm(grUrl, { From: cust, To: biz.phone!, Body: 'STOP' }));
    expect(res.status).toBe(200); // not a 422 "rating must be a number"
    expect(await db.isOptedOut(biz.id, cust)).toBe(true);
    await db.recordOptIn(biz.id, cust);

    await db.logSms({ business_id: biz.id, to_phone: cust, body: 'How did it go? Reply 1-5', kind: 'gratitude', status: 'sent', booking_id: booking.id });
    const inUrl = `${SECRETS.publicBase}/api/sms/inbound`;
    const rated = await smsInbound(twilioForm(inUrl, { From: cust, To: biz.phone!, Body: '5' }));
    expect(rated.status).toBe(200);
    const review = await prisma.smsLog.findFirst({ where: { businessId: biz.id, kind: 'review_request' } });
    expect(review).not.toBeNull();
    expect(review?.bookingId).toBe(booking.id);
    // a 2 goes to the owner as an owner alert, never a review ask
    await smsInbound(twilioForm(inUrl, { From: cust, To: biz.phone!, Body: '2' }));
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1);
  });

  // ====================================================================== M6

  test('M6: a custom disclosure always carries the AI + recording notice, and disclosed needs server-side evidence', async () => {
    await clearRates();
    const biz = await newBusiness();
    const save = await settingsRoute.PATCH(adminReq(`/api/businesses/${biz.id}/settings`, { recording_disclosure_text: 'Hi!' }, 'PATCH'), { params: Promise.resolve({ id: biz.id }) });
    expect(save.status).toBe(200);
    const stored = (await db.getBusiness(biz.id))!;
    const { firstMessageFor } = await import('@/lib/voice/elevenlabs');
    expect(firstMessageFor(stored)).toContain(DEFAULT_DISCLOSURE);
    expect(firstMessageFor(stored).startsWith('Hi! ')).toBe(true);

    // incoming (no ElevenLabs key => the scripted demo speaks firstMessageFor) records the evidence-based state
    const params = { CallSid: uniq('CA'), From: phone(), To: biz.phone! };
    const url = `${SECRETS.publicBase}/api/voice/incoming`;
    expect((await incomingRoute(twilioForm(url, params))).status).toBe(200);
    expect((await callsOf(biz.id))[0]).toMatchObject({ consentStatus: 'disclosed', recordingDisclosed: true });
    // a Twilio retry of the same CallSid reuses the row
    expect((await incomingRoute(twilioForm(url, params))).status).toBe(200);
    expect((await callsOf(biz.id)).length).toBe(1);
    // with an ElevenLabs key whose agent refresh FAILED, the old first message stands: not marked disclosed
    const params2 = { CallSid: uniq('CA'), From: phone(), To: biz.phone! };
    await withEnv({ ELEVENLABS_API_KEY: 'k' }, async () => {
      expect((await incomingRoute(twilioForm(url, params2))).status).toBe(200); // fetch is blocked in tests => agent setup fails
    });
    expect(outboundCalls.length).toBeGreaterThan(0); // the (blocked) provider calls this test provoked on purpose
    outboundCalls.length = 0; // outboundCalls is shared by every integration test: leave it clean
    const failed = (await callsOf(biz.id)).find((c) => c.callSid === params2.CallSid)!;
    expect(failed.consentStatus).toBe('unknown');
  });

  test('M6: an unknown To number only routes to a single-tenant install, and GET /incoming reveals no tenant count', async () => {
    const biz = await newBusiness();
    const params = { CallSid: uniq('CA'), From: phone(), To: '+19995550001' };
    const url = `${SECRETS.publicBase}/api/voice/incoming`;
    const res = await incomingRoute(twilioForm(url, params));
    // other businesses exist in this database, so there is no "first business" fallback
    expect(res.status).toBe(404);
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);
    const get = (await import('@/app/api/voice/incoming/route')).GET;
    expect(await (await get()).json()).toEqual({ ok: true, data: { ready: true } });
  });

  // ====================================================================== L3

  test('L3: a claim carries status + timestamp; a crashed worker\'s stale claim is taken over, a live or finished one is not', async () => {
    const source = `lease-${uniq('s')}`;
    const id = uniq('evt');
    expect(await db.claimEvent(source, id, 60_000)).toBe(true);
    expect(await db.claimEvent(source, id, 60_000)).toBe(false); // still being processed under a live lease
    // the worker died: its claim ages past the lease
    await prisma.processedEvent.update({ where: { source_id: { source, id } }, data: { claimedAt: new Date(Date.now() - 120_000) } });
    const takeovers = await Promise.all(Array.from({ length: 5 }, () => db.claimEvent(source, id, 60_000)));
    expect(takeovers.filter(Boolean).length).toBe(1); // exactly one retry wins the takeover
    await db.completeEvent(source, id);
    expect((await prisma.processedEvent.findUnique({ where: { source_id: { source, id } } }))?.status).toBe('done');
    await prisma.processedEvent.update({ where: { source_id: { source, id } }, data: { claimedAt: new Date(Date.now() - 999_000) } });
    expect(await db.claimEvent(source, id, 60_000)).toBe(false); // done is final, however old
    await prisma.processedEvent.deleteMany({ where: { source } });
  });

  test('L3: a post-call whose first attempt crashed after claiming is processed on the sender\'s retry', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    expect(await db.claimEvent('elevenlabs-postcall', conv)).toBe(true); // attempt 1 claims, then the process dies
    expect(((await (await postCall(biz.agent_id!, conv, normal)).json()) as any).data).toEqual({ ignored: 'duplicate' }); // lease still live
    await prisma.processedEvent.update({ where: { source_id: { source: 'elevenlabs-postcall', id: conv } }, data: { claimedAt: new Date(Date.now() - 10 * 60_000) } });
    const retry = await postCall(biz.agent_id!, conv, normal);
    expect(retry.status).toBe(200);
    expect((await callsOf(biz.id))[0].transcript).toContain('My AC is leaking');
    expect((await prisma.processedEvent.findUnique({ where: { source_id: { source: 'elevenlabs-postcall', id: conv } } }))?.status).toBe('done');
  });

  // ====================================================================== L7 / L4

  test('L7: staff do not receive the stored system prompt; owners do', async () => {
    const biz = await newBusiness();
    await db.upsertKnowledgeBase(biz.id, { system_prompt: 'You are Maria. Secret playbook.', call_script: 'script' });
    const pw = await import('@/lib/password');
    const email = (r: string) => `l7-${r}-${uniq('u')}@example.test`;
    const staff = await db.createUser({ email: email('staff'), password_hash: await pw.hashPassword('correct horse battery'), role: 'staff', business_id: biz.id });
    const owner = await db.createUser({ email: email('owner'), password_hash: await pw.hashPassword('correct horse battery'), role: 'owner', business_id: biz.id });
    const get = async (userId: string) => {
      const { token } = await db.createSession(userId);
      const res = await bizRoute.GET(new Request(`http://app.test/api/businesses/${biz.id}`, { headers: { cookie: `rc_user_session=${token}` } }), { params: Promise.resolve({ id: biz.id }) });
      return (await res.json()) as any;
    };
    expect((await get(staff.id)).data.knowledge_base).toMatchObject({ system_prompt: '', call_script: '' });
    expect((await get(owner.id)).data.knowledge_base.system_prompt).toContain('Secret playbook');
    await prisma.user.deleteMany({ where: { id: { in: [staff.id, owner.id] } } });
  });

  test('L4: withLease aborts its signal when the lease is lost', async () => {
    const key = `lease-lost-${uniq('k')}`;
    let aborted = false;
    const res = await db.withLease(key, 900, async (lease, signal) => {
      expect(signal.aborted).toBe(false);
      await prisma.provisionLock.update({ where: { key: lease.key }, data: { holder: 'someone-else' } }); // a successor took it
      await new Promise((r) => setTimeout(r, 700));
      aborted = signal.aborted;
      return 'done';
    });
    expect(res).toMatchObject({ acquired: true, value: 'done' });
    expect(aborted).toBe(true);
    await prisma.provisionLock.deleteMany({ where: { key } });
  });

  test('M4/L8: briefing audio is served by an authenticated, tenant-scoped route (the /audio/ URL is rewritten to it)', async () => {
    const biz = await newBusiness();
    const other = await newBusiness();
    const audioDir = path.join(process.cwd(), 'public', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const name = `briefing-${biz.id}-2026-06-01.mp3`;
    audioFiles.push(path.join(audioDir, name));
    fs.writeFileSync(path.join(audioDir, name), Buffer.from('0123456789'.repeat(300)));
    const audioRoute = await import('@/app/api/briefings/audio/[name]/route');
    const pw = await import('@/lib/password');
    const user = async (businessId: string) => {
      const u = await db.createUser({ email: `aud-${uniq('u')}@example.test`, password_hash: await pw.hashPassword('correct horse battery'), role: 'staff', business_id: businessId });
      return { id: u.id, cookie: `rc_user_session=${(await db.createSession(u.id)).token}` };
    };
    const mine = await user(biz.id);
    const theirs = await user(other.id);
    const get = (n: string, headers: Record<string, string>) => audioRoute.GET(new Request(`http://app.test/api/briefings/audio/${n}`, { headers }), { params: Promise.resolve({ name: n }) });
    expect((await get(name, {})).status).toBe(401);
    expect((await get(name, { cookie: theirs.cookie })).status).toBe(404); // another tenant
    const ok = await get(name, { cookie: mine.cookie });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/mpeg');
    expect((await ok.arrayBuffer()).byteLength).toBe(3000);
    const part = await get(name, { cookie: mine.cookie, range: 'bytes=0-9' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-9/3000');
    expect((await get('../../package.json', { cookie: mine.cookie })).status).toBe(404);
    expect((await get(`briefing-${biz.id}-2026-06-02.mp3`, { cookie: mine.cookie })).status).toBe(404); // not generated
    expect((await get(name, admin)).status).toBe(200);
    await prisma.user.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
  });
});
