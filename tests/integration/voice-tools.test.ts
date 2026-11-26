/**
 * POST /api/voice/tools/[tool]: shared-secret auth, tenant binding from the platform agent id,
 * recipient restrictions, verified caller number and the per-call booking cap.
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, toolRequest, uniq, wall,
} from '../helpers/fixtures';

integration('voice tools route (postgres)', () => {
  let POST: (req: Request, ctx: { params: Promise<{ tool: string }> }) => Promise<Response>;
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    POST = (await import('@/app/api/voice/tools/[tool]/route')).POST;
  });
  afterAll(cleanup);

  type ToolBody = { ok: boolean; message: string; data: unknown };
  async function call(tool: string, body: Record<string, unknown>, headers?: Record<string, string>) {
    const res = await POST(toolRequest(tool, body, headers), { params: Promise.resolve({ tool }) });
    return { status: res.status, body: (await res.json()) as ToolBody };
  }
  const TUE = () => futureDateKey(2);
  // Every real tool call carries the platform's conversation id; a booking without any call key is refused.
  const bookingArgs = (extra: Record<string, unknown> = {}) => ({
    customer_name: 'Lucía Gómez', customer_phone: '+13055550999', service: 'AC repair', conversation_id: uniq('conv'), ...extra,
  });
  const GENERIC = /get the owner/i;

  test('the tool secret is required, and the response never leaks row data', async () => {
    const biz = await newBusiness();
    const args = { agent_id: biz.agent_id, date: TUE() };

    const noHeader = await POST(
      new Request('http://localhost/api/voice/tools/check_availability', { method: 'POST', body: JSON.stringify(args) }),
      { params: Promise.resolve({ tool: 'check_availability' }) });
    expect(noHeader.status).toBe(401);
    expect((await call('check_availability', args, { 'x-recepcionista-tool-secret': 'wrong' })).status).toBe(401);
    expect((await call('check_availability', args, { 'x-recepcionista-tool-secret': '' })).status).toBe(401);
    // a server with no secret configured fails closed (outside explicit insecure-dev mode)
    await withEnv({ ELEVENLABS_TOOL_SECRET: undefined }, async () => {
      expect((await call('check_availability', args)).status).toBe(401);
    });

    const ok = await call('check_availability', args);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.message).toMatch(/I have/);
    expect(ok.body.data).toBeNull(); // slots/rows are only returned to unauthenticated dev callers
  });

  test('tenant comes from agent_id: a body-supplied business_id is overridden when it matches and refused when it does not', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const day = TUE();

    // no business_id at all: resolved from the agent
    const viaAgent = await call('create_booking', bookingArgs({ agent_id: a.agent_id, scheduled_at: wall(day, '09:00') }));
    expect(viaAgent.body.ok).toBe(true);
    expect(await prisma.booking.count({ where: { businessId: a.id } })).toBe(1);

    // agent A, but the body claims business B: refused, nothing is written for either tenant
    const forged = await call('create_booking', bookingArgs({ agent_id: a.agent_id, business_id: b.id, scheduled_at: wall(day, '10:00') }));
    expect(forged.body.ok).toBe(false);
    expect(forged.body.message).toMatch(GENERIC);
    expect(await prisma.booking.count({ where: { businessId: b.id } })).toBe(0);
    expect(await prisma.booking.count({ where: { businessId: a.id } })).toBe(1);

    // camelCase alias is treated the same way
    const forged2 = await call('create_booking', bookingArgs({ agent_id: a.agent_id, businessId: b.id, scheduled_at: wall(day, '11:00') }));
    expect(forged2.body.ok).toBe(false);
    expect(await prisma.booking.count({ where: { businessId: b.id } })).toBe(0);

    // agent A + matching business_id: fine
    const matching = await call('create_booking', bookingArgs({ agent_id: a.agent_id, business_id: a.id, scheduled_at: wall(day, '12:00') }));
    expect(matching.body.ok).toBe(true);
    expect(await prisma.booking.count({ where: { businessId: a.id } })).toBe(2);
  });

  test('no agent id or an unknown agent id never selects a tenant', async () => {
    const a = await newBusiness();
    const day = TUE();
    const attempt = (extra: Record<string, unknown>) =>
      call('create_booking', bookingArgs({ scheduled_at: wall(day, '09:00'), ...extra }));

    const bare = await attempt({ business_id: a.id }); // claims a tenant without the platform agent id
    const unknown = await attempt({ agent_id: 'agent_does_not_exist', business_id: a.id });
    for (const r of [bare, unknown]) {
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(r.body.message).toMatch(GENERIC);
    }
    expect(await prisma.booking.count({ where: { businessId: a.id } })).toBe(0);
  });

  test('two businesses can never share an agent id (the tenant mapping cannot become ambiguous)', async () => {
    const a = await newBusiness();
    let failed = false;
    try { await newBusiness({ agent_id: a.agent_id }); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  test('a call_id from another business is dropped, never trusted', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const foreign = await db.createCall({ business_id: b.id, caller_phone: '+13055550177' });
    const r = await call('create_booking', bookingArgs({
      agent_id: a.agent_id, call_id: foreign.id, scheduled_at: wall(TUE(), '09:00'), customer_phone: '+13055550888',
    }));
    expect(r.body.ok).toBe(true);
    const row = (await prisma.booking.findMany({ where: { businessId: a.id } }))[0];
    expect(row.callId).not.toBe(foreign.id); // the foreign call is never attached...
    expect(row.customerPhone).toBe('+13055550888'); // ...nor its number used
  });

  test('create_booking TEXTS the verified caller number from the live call, never the phone the model relays (which is only stored as the contact)', async () => {
    const biz = await newBusiness();
    const caller = '+13055550101';
    const live = await db.createCall({ business_id: biz.id, caller_phone: caller, call_sid: uniq('conv') });
    const r = await call('create_booking', bookingArgs({
      agent_id: biz.agent_id, call_id: live.id, customer_phone: '+13055550666', scheduled_at: wall(TUE(), '09:00'),
    }));
    expect(r.body.ok).toBe(true);
    const row = (await prisma.booking.findMany({ where: { businessId: biz.id } }))[0];
    expect(row.customerPhone).toBe('+13055550666'); // the relayed callback number is stored as the booking contact
    expect(row.callId).toBe(live.id);
    expect(row.followupConsentAt).toBeNull(); // the follow-up notice did not reach the contact number: no consent recorded
    // the confirmation went to the verified number
    const sms = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'confirmation' } });
    expect(sms.map((s) => s.toPhone)).toEqual([caller]);

    // matching by the platform conversation id works too
    const conv = uniq('conv2');
    const live2 = await db.createCall({ business_id: biz.id, caller_phone: '+13055550202', call_sid: conv });
    const r2 = await call('create_booking', bookingArgs({
      agent_id: biz.agent_id, conversation_id: conv, customer_phone: '+13055550666', scheduled_at: wall(TUE(), '11:00'),
    }));
    expect(r2.body.ok).toBe(true);
    expect((await prisma.booking.findFirst({ where: { callId: live2.id } }))?.customerPhone).toBe('+13055550666');
    expect((await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'confirmation' } })).map((x) => x.toPhone).sort())
      .toEqual([caller, '+13055550202'].sort());
  });

  test('call cap: a third booking on the same call is refused', async () => {
    const biz = await newBusiness();
    const live = await db.createCall({ business_id: biz.id, caller_phone: '+13055550303' });
    const day = TUE();
    const book = (hhmm: string) => call('create_booking', bookingArgs({ agent_id: biz.agent_id, call_id: live.id, scheduled_at: wall(day, hhmm) }));
    expect((await book('09:00')).body.ok).toBe(true);
    expect((await book('11:00')).body.ok).toBe(true);
    const third = await book('13:00');
    expect(third.body.ok).toBe(false);
    expect(third.body.message).toMatch(/two appointments/i);
    expect(await prisma.booking.count({ where: { callId: live.id } })).toBe(2);
  });

  test('the booking cap holds under concurrent tool calls on one call', async () => {
    const biz = await newBusiness();
    const live = await db.createCall({ business_id: biz.id, caller_phone: '+13055550404' });
    const day = TUE();
    const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];
    await Promise.all(hours.map((h) => call('create_booking', bookingArgs({ agent_id: biz.agent_id, call_id: live.id, scheduled_at: wall(day, h) }))));
    expect(await prisma.booking.count({ where: { callId: live.id } })).toBeLessThanOrEqual(2);
  });

  test('send_sms: the model cannot choose the recipient (only this caller or the owner)', async () => {
    const owner = '+13055550700';
    const biz = await newBusiness({ owner_phone: owner });
    const caller = '+13055550505';
    const live = await db.createCall({ business_id: biz.id, caller_phone: caller });
    const send = (extra: Record<string, unknown>) => call('send_sms', { agent_id: biz.agent_id, body: 'Hello from the shop', ...extra });
    const sentTo = async () => (await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: { in: ['other', 'owner_alert'] } }, orderBy: { createdAt: 'asc' } })).map((s) => s.toPhone);

    expect((await send({ call_id: live.id, to: '+19995550123' })).body.ok).toBe(true); // arbitrary number
    expect((await send({ call_id: live.id, to: '+13055559999' })).body.ok).toBe(true);
    expect((await send({ call_id: live.id })).body.ok).toBe(true);
    expect(await sentTo()).toEqual([caller, caller, caller]);

    expect((await send({ call_id: live.id, to: 'owner' })).body.ok).toBe(true);
    expect((await send({ call_id: live.id, to: '(305) 555-0700' })).body.ok).toBe(true); // the owner's number in another format
    expect((await sentTo()).slice(3)).toEqual([owner, owner]);

    // without a call and without a platform caller id there is nobody to text, whatever `to` says
    const none = await send({ to: '+19995550123' });
    expect(none.body.ok).toBe(false);
    expect((await sentTo()).length).toBe(5);
    expect(outboundCalls).toEqual([]);
  });

  test('send_sms refuses a destination country outside the allow-list', async () => {
    const biz = await newBusiness();
    const live = await db.createCall({ business_id: biz.id, caller_phone: '+442071838750' });
    const r = await call('send_sms', { agent_id: biz.agent_id, call_id: live.id, body: 'hi' });
    expect(r.body.ok).toBe(false);
    const rows = await prisma.smsLog.findMany({ where: { businessId: biz.id } });
    expect(rows.every((s) => s.status === 'failed')).toBe(true);
  });

  test('create_payment_link: the amount comes from the deposit policy, never from the model; the link texts the caller number only', async () => {
    const biz = await newBusiness();
    const caller = '+13055550606';
    const live = await db.createCall({ business_id: biz.id, caller_phone: caller });
    // No policy: the AI cannot ask for a deposit at all, whatever amount it sends.
    const off = await call('create_payment_link', { agent_id: biz.agent_id, call_id: live.id, amount_cents: 5000 });
    expect(off.body.ok).toBe(false);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'payment_link' } })).toBe(0);

    expect((await db.setDepositPolicy(biz.id, { enabled: true, mode: 'fixed', fixed_cents: 5000 })).ok).toBe(true);
    // review 21 L1: a link is always tied to a booking made on THIS call; without one nothing is created or texted
    const noBooking = await call('create_payment_link', { agent_id: biz.agent_id, call_id: live.id, amount_cents: 99_999 });
    expect(noBooking.body.ok).toBe(false);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'payment_link' } })).toBe(0);
    const made = await call('create_booking', bookingArgs({ agent_id: biz.agent_id, call_id: live.id, scheduled_at: wall(TUE(), '09:00') }));
    expect(made.body.ok).toBe(true);
    const r = await call('create_payment_link', {
      agent_id: biz.agent_id, call_id: live.id, amount_cents: 99_999, to: '+19995550123', caller_phone: '+19995550124',
    });
    expect(r.body.ok).toBe(true);
    expect(r.body.data).toBeNull();
    const sms = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'payment_link' } });
    expect(sms.map((s) => s.toPhone)).toEqual([caller]);
    expect(sms[0].body).toContain('$50'); // the policy's amount, not the model's 99,999
    expect(sms[0].bookingId).toBeTruthy(); // the call's single booking was attached automatically
  });

  test('create_payment_link, percentage policy: the price is the CATALOG price of the service, never the model\'s estimate (review 21 M3)', async () => {
    const biz = await newBusiness();
    await prisma.knowledgeBase.upsert({
      where: { businessId: biz.id },
      create: { businessId: biz.id, services: [{ name: 'AC repair', base_price: 400, duration_minutes: 60 }], faqs: [], pricingNotes: '', callScript: '', systemPrompt: '' },
      update: { services: [{ name: 'AC repair', base_price: 400, duration_minutes: 60 }] },
    });
    expect((await db.setDepositPolicy(biz.id, { enabled: true, mode: 'percent', percent: 25, min_cents: 5000, max_cents: 30_000 })).ok).toBe(true);
    const live = await db.createCall({ business_id: biz.id, caller_phone: '+13055550707' });
    // the model claims the job costs $1: the deposit must still be 25% of the owner's $400, not the owner's minimum chosen by the caller
    const made = await call('create_booking', bookingArgs({ agent_id: biz.agent_id, call_id: live.id, scheduled_at: wall(TUE(), '10:00'), price_estimate: 1 }));
    expect(made.body.ok).toBe(true);
    const r = await call('create_payment_link', { agent_id: biz.agent_id, call_id: live.id });
    expect(r.body.ok).toBe(true);
    const sms = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'payment_link' } });
    expect(sms[0].body).toContain('$100');
    // a service with no catalog price gives no amount (the owner is asked to call)
    const biz2 = await newBusiness();
    expect((await db.setDepositPolicy(biz2.id, { enabled: true, mode: 'percent', percent: 25 })).ok).toBe(true);
    const live2 = await db.createCall({ business_id: biz2.id, caller_phone: '+13055550708' });
    await call('create_booking', bookingArgs({ agent_id: biz2.agent_id, call_id: live2.id, scheduled_at: wall(TUE(), '10:00'), price_estimate: 400 }));
    const none = await call('create_payment_link', { agent_id: biz2.agent_id, call_id: live2.id });
    expect(none.body.ok).toBe(false);
    expect(await prisma.smsLog.count({ where: { businessId: biz2.id, kind: 'payment_link' } })).toBe(0);
  });

  test('unknown tools and tool-name variants', async () => {
    const biz = await newBusiness();
    const unknown = await call('drop_all_tables', { agent_id: biz.agent_id });
    expect(unknown.body.ok).toBe(false);
    const variant = await call('Check-Availability', { agent_id: biz.agent_id, date: TUE() });
    expect(variant.body.ok).toBe(true);
    const nested = await call('check_availability', { agent_id: biz.agent_id, arguments: JSON.stringify({ date: TUE() }) });
    expect(nested.body.ok).toBe(true);
  });

});
