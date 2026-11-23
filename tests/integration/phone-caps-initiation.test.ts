/**
 * Usage caps (SMS + call minutes), the ElevenLabs conversation-initiation webhook, post-call metering and the
 * customer-initiated follow-up consent path (YES / START) with its gratitude-sweep summary.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, elevenLabsSignature, loadDb, loadPrisma, newBusiness, phone, toolRequest, twilioSignature, uniq } from '../helpers/fixtures';
import { DEFAULT_DISCLOSURE } from '../../src/lib/kb/disclosure';

integration('caps, initiation webhook and follow-up consent (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let msg: typeof import('../../src/lib/messaging');
  let initiation: { POST: (req: Request) => Promise<Response> };
  let postCall: (req: Request) => Promise<Response>;
  let tools: (req: Request, ctx: { params: Promise<{ tool: string }> }) => Promise<Response>;
  let smsInbound: (req: Request) => Promise<Response>;
  let incoming: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    msg = await import('../../src/lib/messaging');
    initiation = await import('@/app/api/voice/initiation/route');
    postCall = (await import('@/app/api/voice/post-call/route')).POST;
    tools = (await import('@/app/api/voice/tools/[tool]/route')).POST;
    smsInbound = (await import('@/app/api/sms/inbound/route')).POST;
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
  });
  afterAll(cleanup);

  const ENFORCED = { BILLING_ENFORCED: 'true' };
  const initReq = (body: Record<string, unknown>, headers: Record<string, string> = { 'x-recepcionista-tool-secret': SECRETS.toolSecret }) =>
    new Request('http://localhost/api/voice/initiation', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // ------------------------------------------------------------------ SMS caps

  test('SMS cap: customer texts stop at the cap (blocked_cap, logged); owner alerts and verification codes are not blocked but ARE counted', async () => {
    const biz = await newBusiness();
    await db.setBillingState(biz.id, { billing_status: 'active', sms_cap_override: 2 });
    await withEnv(ENFORCED, async () => {
      const a = await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'one', kind: 'other' });
      const b = await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'two', kind: 'other' });
      expect([a.sms.status, b.sms.status]).toEqual(['mock', 'mock']);
      const c = await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'three', kind: 'other' });
      expect(c.blocked).toBe('blocked_cap');
      expect(c.sms.status).toBe('blocked_cap');
      expect((await db.getUsage(biz.id))?.sms_count).toBe(2); // a blocked text is not counted

      const alert = await msg.sendAndLog({ business_id: biz.id, to: biz.owner_phone!, body: 'EMERGENCY', kind: 'owner_alert' });
      expect(alert.blocked).toBeUndefined();
      const code = await msg.sendOwnerVerificationCode(biz.id, phone(), 'code 123456');
      expect(code.blocked).toBeUndefined();
      expect((await db.getUsage(biz.id))?.sms_count).toBe(4);
      // gratitude (marketing class) is capped too
      const g = await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'how was it', kind: 'gratitude', consent_basis: 'booking_followup', now: new Date('2026-07-01T12:00:00-04:00') });
      expect(g.blocked).toBe('blocked_cap');
    });
  });

  test('no plan while BILLING_ENFORCED=true blocks customer texts; without enforcement nothing is blocked but texts are still counted', async () => {
    const biz = await newBusiness(); // billing_status 'none'
    await withEnv(ENFORCED, async () => {
      expect((await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'x', kind: 'other' })).blocked).toBe('blocked_cap');
    });
    expect((await msg.sendAndLog({ business_id: biz.id, to: phone(), body: 'x', kind: 'other' })).blocked).toBeUndefined();
    expect((await db.getUsage(biz.id))?.sms_count).toBe(1);
  });

  // ------------------------------------------------------------------ initiation webhook

  test('initiation: needs the tool secret (fails closed without one configured), returns the documented shape and records server-side disclosure evidence', async () => {
    const biz = await newBusiness();
    const body = { caller_id: '+13055550188', agent_id: biz.agent_id, called_number: biz.phone, call_sid: uniq('CA'), conversation_id: uniq('conv') };
    expect((await initiation.POST(initReq(body, {}))).status).toBe(401);
    expect((await initiation.POST(initReq(body, { 'x-recepcionista-tool-secret': 'nope' }))).status).toBe(401);
    await withEnv({ ELEVENLABS_TOOL_SECRET: undefined }, async () => {
      expect((await initiation.POST(initReq(body))).status).toBe(401);
    });
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);

    const res = await initiation.POST(initReq(body));
    expect(res.status).toBe(200);
    const json = await res.json() as {
      type: string; dynamic_variables: Record<string, string>; conversation_config_override: { agent: { first_message: string } };
    };
    expect(json.type).toBe('conversation_initiation_client_data');
    expect(json.dynamic_variables).toMatchObject({ business_id: biz.id, caller_phone: '+13055550188', call_sid: body.call_sid, timezone: 'America/New_York' });
    for (const k of ['current_date', 'current_time', 'current_weekday', 'current_datetime']) expect(k in json.dynamic_variables).toBe(true);
    expect(json.conversation_config_override.agent.first_message).toContain(DEFAULT_DISCLOSURE);

    const calls = await prisma.call.findMany({ where: { businessId: biz.id } });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      callSid: body.call_sid, conversationId: body.conversation_id, callerPhone: '+13055550188', callerE164: '+13055550188',
      recordingDisclosed: true, consentStatus: 'disclosed',
    });
    // a retry (and a later tool call) reuses the same row
    await initiation.POST(initReq(body));
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
  });

  test('initiation: a recorded objection stays declined; an unknown agent/number gets no tenant data and creates no call', async () => {
    const biz = await newBusiness();
    const body = { caller_id: phone(), agent_id: biz.agent_id, call_sid: uniq('CA'), conversation_id: uniq('conv') };
    await initiation.POST(initReq(body));
    const call = (await prisma.call.findFirst({ where: { businessId: biz.id } }))!;
    await db.updateCall(call.id, { consent_status: 'declined' });
    await initiation.POST(initReq(body));
    expect((await prisma.call.findUnique({ where: { id: call.id } }))?.consentStatus).toBe('declined');

    const before = await prisma.call.count();
    const res = await initiation.POST(initReq({ caller_id: phone(), agent_id: 'agent-unknown', called_number: '+19999999999', call_sid: uniq('CA') }));
    const json = await res.json() as { dynamic_variables: Record<string, string>; conversation_config_override?: unknown };
    expect(json.dynamic_variables.business_id).toBe('');
    expect(json.conversation_config_override).toBeUndefined();
    expect(await prisma.call.count()).toBe(before);
  });

  test('call cap: over the minutes cap the agent opens with the out-of-service line, the call is handed off honestly, tools refuse (except the owner alerts)', async () => {
    const biz = await newBusiness();
    await db.setBillingState(biz.id, { billing_status: 'active', call_minutes_cap_override: 1 });
    await db.recordCallSeconds(biz.id, 60);
    await withEnv(ENFORCED, async () => {
      const body = { caller_id: phone(), agent_id: biz.agent_id, call_sid: uniq('CA'), conversation_id: uniq('conv') };
      const json = await (await initiation.POST(initReq(body))).json() as { conversation_config_override: { agent: { first_message: string } } };
      const first = json.conversation_config_override.agent.first_message;
      expect(first).toContain(DEFAULT_DISCLOSURE); // the recording/AI notice always comes first
      expect(first).toMatch(/cannot take bookings right now/);
      const call = (await prisma.call.findFirst({ where: { businessId: biz.id } }))!;
      expect(call.status).toBe('handed_off');
      expect(call.flaggedReason).toBe('out_of_service:cap_reached');
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1); // owner told (mock)

      const run = async (name: string, args: Record<string, unknown>) =>
        (await (await tools(toolRequest(name, { agent_id: biz.agent_id, conversation_id: body.conversation_id, ...args }), { params: Promise.resolve({ tool: name }) })).json()) as { ok: boolean; message: string };
      const booking = await run('create_booking', { customer_name: 'A', customer_phone: phone(), service: 'AC', scheduled_at: '2030-01-01T10:00:00' });
      expect(booking.ok).toBe(false);
      expect(booking.message).toMatch(/pass your message to the owner/i);
      expect(await prisma.booking.count({ where: { businessId: biz.id } })).toBe(0);
      const handoff = await run('handoff_to_human', { reason: 'wants a callback' });
      expect(handoff.message).not.toMatch(/pass your message/i);
    });
    // not enforced: same business, same usage, service continues
    const body2 = { caller_id: phone(), agent_id: biz.agent_id, call_sid: uniq('CA'), conversation_id: uniq('conv') };
    const ok = await (await initiation.POST(initReq(body2))).json() as { conversation_config_override: { agent: { first_message: string } } };
    expect(ok.conversation_config_override.agent.first_message).not.toMatch(/cannot take bookings/);
  });

  test('/api/voice/incoming applies the same call gate and keeps one row per CallSid', async () => {
    const biz = await newBusiness();
    await db.setBillingState(biz.id, { billing_status: 'active', call_minutes_cap_override: 0 });
    const url = `${SECRETS.publicBase}/api/voice/incoming`;
    const params = { CallSid: uniq('CA'), From: phone(), To: biz.phone! };
    const form = () => new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) },
      body: new URLSearchParams(params).toString(),
    });
    await withEnv(ENFORCED, async () => {
      const res = await incoming(form());
      const json = await res.json() as { data: { out_of_service?: boolean; agent_id: string } };
      expect(json.data.out_of_service).toBe(true);
      expect(json.data.agent_id).toBe('');
    });
    const calls = await prisma.call.findMany({ where: { businessId: biz.id } });
    expect(calls.length).toBe(1);
    expect(calls[0].status).toBe('handed_off');
    expect(calls[0].callerE164).toBe(params.From);
    expect((await (await incoming(form())).json() as { data: { out_of_service?: boolean } }).data.out_of_service).toBeUndefined(); // billing not enforced
    expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(1);
  });

  // ------------------------------------------------------------------ post-call metering

  test('post-call records the call duration ONCE per conversation (duplicate deliveries and retries do not double count)', async () => {
    const biz = await newBusiness();
    const conv = uniq('conv');
    const raw = JSON.stringify({
      type: 'post_call_transcription',
      data: {
        agent_id: biz.agent_id, conversation_id: conv, status: 'done',
        transcript: [{ role: 'agent', message: `${DEFAULT_DISCLOSURE} — Thanks for calling` }, { role: 'user', message: 'hi' }],
        metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 100, call_duration_secs: 95 },
        analysis: { transcript_summary: 'x' },
      },
    });
    const send = () => postCall(new Request('http://localhost/api/voice/post-call', {
      method: 'POST', headers: { 'content-type': 'application/json', 'elevenlabs-signature': elevenLabsSignature(raw) }, body: raw,
    }));
    expect((await send()).status).toBe(200);
    expect((await db.getUsage(biz.id))?.call_seconds).toBe(95);
    expect((await send()).status).toBe(200); // duplicate delivery
    expect((await db.getUsage(biz.id))?.call_seconds).toBe(95);
  });

  // ------------------------------------------------------------------ follow-up consent from a customer's own YES

  let slot = 0; // distinct 2h slots: bookings of one business may not overlap
  async function seedBooking(businessId: string, customerPhone: string, opts: { daysAgo?: number; consent?: boolean; status?: string } = {}) {
    return prisma.booking.create({
      data: {
        businessId, customerName: 'Cust', customerPhone, phoneE164: customerPhone, service: 'AC repair',
        scheduledAt: new Date(Date.now() - (opts.daysAgo ?? 1) * 86400_000 - (++slot) * 2 * 3600_000), durationMinutes: 60, status: opts.status ?? 'completed',
        followupConsentAt: opts.consent ? new Date() : null,
      },
    });
  }
  const inbound = async (biz: { phone?: string | null }, from: string, body: string) => {
    const url = `${SECRETS.publicBase}/api/sms/inbound`;
    const params = { From: from, To: biz.phone!, Body: body, MessageSid: uniq('SM') };
    const res = await smsInbound(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) },
      body: new URLSearchParams(params).toString(),
    }));
    return res.text();
  };

  test('a customer texting YES / Y / SI / START records follow-up consent on their MOST RECENT booking only; STOP always wins', async () => {
    const biz = await newBusiness();
    const cust = phone();
    const old = await seedBooking(biz.id, cust, { daysAgo: 30 });
    const latest = await seedBooking(biz.id, cust, { daysAgo: 1 });
    const reply = await inbound(biz, cust, 'yes');
    expect(reply).toContain('may text you after your visit');
    expect((await prisma.booking.findUnique({ where: { id: latest.id } }))?.followupConsentAt).not.toBeNull();
    expect((await prisma.booking.findUnique({ where: { id: latest.id } }))?.followupConsentSource).toBe('inbound_keyword:yes');
    expect((await prisma.booking.findUnique({ where: { id: old.id } }))?.followupConsentAt).toBeNull();
    expect(await inbound(biz, cust, 'yes')).not.toContain('<Message>'); // already consented: nothing more to do
    expect((await db.getUsage(biz.id))?.sms_count).toBe(1); // the confirmation reply is counted

    for (const word of ['Y', 'SÍ', 'Si!', 'START']) {
      const c = phone();
      const b = await seedBooking(biz.id, c);
      await inbound(biz, c, word);
      expect([word, (await prisma.booking.findUnique({ where: { id: b.id } }))?.followupConsentAt !== null]).toEqual([word, true]);
    }

    // not a bare keyword / unrelated numbers / opted-out numbers / other countries: nothing recorded
    const c2 = phone();
    const b2 = await seedBooking(biz.id, c2);
    await inbound(biz, c2, 'yes please call me');
    await inbound(biz, phone(), 'yes');
    await inbound(biz, '+442079460958', 'yes');
    expect((await prisma.booking.findUnique({ where: { id: b2.id } }))?.followupConsentAt).toBeNull();
    await db.recordOptOut(biz.id, c2);
    await inbound(biz, c2, 'yes');
    expect((await prisma.booking.findUnique({ where: { id: b2.id } }))?.followupConsentAt).toBeNull();
  });

  test('gratitude sweep reports skipped_no_consent (legacy bookings are excluded by design, nothing is texted or logged for them)', async () => {
    const { runGratitudeSweep } = await import('../../src/lib/gratitude');
    const biz = await newBusiness();
    const legacy = await seedBooking(biz.id, phone(), { daysAgo: 1 });
    const consented = await seedBooking(biz.id, phone(), { daysAgo: 1, consent: true });
    void legacy;
    const sweep = await runGratitudeSweep(biz.id);
    // bookings are 24h old by the clock: inside the 20-48h window
    expect(sweep.skipped_no_consent).toBe(1);
    expect(sweep.sent + sweep.skipped_quiet_hours).toBe(1); // 9pm-8am local: held for the next sweep, otherwise sent
    expect(sweep.skipped).toBe(sweep.skipped_no_consent + sweep.skipped_quiet_hours + sweep.skipped_cap + sweep.skipped_opt_out + sweep.skipped_error);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, status: 'blocked_no_consent' } })).toBe(0);
    if (sweep.sent === 1) expect(sweep.ids).toEqual([consented.id]);
  });
});
