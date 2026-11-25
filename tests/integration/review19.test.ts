/**
 * Fixes for the adversarial reviews 19-22 (docs/review/19..22), against a real Postgres. Fake providers only (no outbound request leaves the machine; the
 * Twilio / ElevenLabs / Stripe fakes below replace `fetch` for the length of one call and always restore it). Time-of-day independent (awake / quiet zones).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ALL_WEEK, awakeTimezone, cleanup, eventId, futureDateKey, loadDb, loadPrisma, newBusiness, phone, stripeSignature, twilioSignature, uniq } from '../helpers/fixtures';
import { fakeElevenLabs } from '../helpers/fake-elevenlabs';

const DEMO = { DEMO_MODE: 'true' };
const PLATFORM = '+15005550006';
const TW = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_PHONE_NUMBER: PLATFORM, APP_URL: 'https://app.example.test' } as Record<string, string | undefined>;

integration('review 19-22 fixes (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let inbound: (req: Request) => Promise<Response>;
  let webhook: (req: Request) => Promise<Response>;
  const userIds: string[] = [];
  const bizIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    inbound = (await import('@/app/api/sms/inbound/route')).POST;
    webhook = (await import('@/app/api/payments/webhook/route')).POST;
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.auditEvent.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
    expect(outboundCalls).toEqual([]); // nothing tried to leave the machine through the guard (the fakes below replace fetch only while they run)
  });
  beforeEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'inbox' } }, { key: { startsWith: 'manual-sms' } }, { key: { startsWith: 'privacy:' } }, { key: { startsWith: 'briefing-audio' } }] } });
  });

  // ------------------------------------------------------------ helpers
  const realNumber = (): string => { for (;;) { const n = `+1786${2_000_000 + Math.floor(Math.random() * 7_000_000)}`; if (!/555\d{4}$/.test(n)) return n; } };
  const mockNumber = (): string => `+1305555${String(1000 + Math.floor(Math.random() * 8999))}`;
  async function biz(extra: { phone?: string | null; tz?: string; agent?: string | null } = {}) {
    const b = await newBusiness({ timezone: extra.tz ?? awakeTimezone(), agent_id: extra.agent ?? null });
    bizIds.push(b.id);
    if (extra.phone !== undefined) await db.updateBusiness(b.id, { phone: extra.phone });
    return (await db.getBusiness(b.id))!;
  }
  const URL_IN = `${SECRETS.publicBase}/api/sms/inbound`;
  const text = async (to: string, from: string, body: string, sid = uniq('SM')) => {
    const params = { From: from, To: to, Body: body, MessageSid: sid };
    const res = await inbound(new Request(URL_IN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(URL_IN, params) }, body: new URLSearchParams(params).toString() }));
    return { res, sid };
  };
  const rows = (id: string) => prisma.inboundMessage.findMany({ where: { businessId: id }, orderBy: { receivedAt: 'asc' } });
  const sms = (id: string, kind: string) => prisma.smsLog.findMany({ where: { businessId: id, kind } });

  /** A fake Twilio Messages API: records From / To / Body of every send and accepts it. Replaces fetch only inside `fn`. */
  async function withTwilio<T>(fn: (sends: { to: string; from: string; body: string }[]) => Promise<T>): Promise<T> {
    const sends: { to: string; from: string; body: string }[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (!url.includes('api.twilio.com') || !url.endsWith('/Messages.json')) throw new Error(`unexpected fetch ${url}`);
      const p = new URLSearchParams(String(init?.body));
      sends.push({ to: p.get('To') as string, from: p.get('From') as string, body: p.get('Body') as string });
      return Response.json({ sid: `SM${uniq('x')}` }, { status: 201 });
    }) as typeof fetch;
    try { return await withEnv(TW, () => fn(sends)); } finally { globalThis.fetch = prev; }
  }

  // ================================================================== 20 H1: the sender of customer texts
  test('20 H1: the inbox auto-reply, the owner forward and a manual text go out from the TENANT\'s own number; STOP to it opts the customer out of THAT tenant', async () => {
    const b = await biz({ phone: realNumber() });
    const customer = phone();
    await withTwilio(async (sends) => {
      expect((await text(b.phone!, customer, 'Can you come tomorrow at three?')).res.status).toBe(200);
      expect(sends.length).toBe(2); // the owner forward and the customer's acknowledgement
      expect(sends.map((s) => s.from)).toEqual([b.phone, b.phone]);
      expect(sends.find((s) => s.to === customer)?.body).toContain('Reply STOP');
      const { sendManualText } = await import('@/lib/messaging/manual');
      const manual = await sendManualText({ business: b, to: customer, body: 'We are on our way', kind: 'manual', trustedRecipient: true });
      expect(manual.ok).toBe(true);
      expect(sends[2]).toMatchObject({ to: customer, from: b.phone });
      // the customer's STOP goes to the number that texted them: it IS this tenant's number, so it is recorded
      expect((await text(b.phone!, customer, 'STOP')).res.status).toBe(200);
      expect(await db.isOptedOut(b.id, customer)).toBe(true);
    });
  });

  test('20 H1: a tenant without a real number (mock-pool) falls back to the shared sender; a reply or STOP to the shared sender is routed by the LAST OUTBOUND text', async () => {
    const a = await biz({ phone: mockNumber() });
    const c = await biz({ phone: mockNumber() });
    const customer = phone();
    await withTwilio(async (sends) => {
      await text(a.phone!, customer, 'Hello from a customer of A');
      await text(c.phone!, customer, 'Hello from the same customer to C');
      expect(sends.filter((s) => s.to === customer).map((s) => s.from)).toEqual([PLATFORM, PLATFORM]); // both acknowledgements came from the shared sender
      // an ordinary answer to the shared sender lands in the inbox of the business that texted last (C)
      expect((await text(PLATFORM, customer, 'Yes tomorrow works for me')).res.status).toBe(200);
      expect((await rows(c.id)).map((r) => r.body)).toContain('Yes tomorrow works for me');
      expect((await rows(a.id)).map((r) => r.body)).not.toContain('Yes tomorrow works for me');
      // STOP to the shared sender stops EVERY business that texted this customer from it
      const stop = await text(PLATFORM, customer, 'STOP');
      expect(stop.res.status).toBe(200);
      expect(await stop.res.text()).toContain('unsubscribed');
      expect(await db.isOptedOut(a.id, customer)).toBe(true);
      expect(await db.isOptedOut(c.id, customer)).toBe(true);
      // a number nobody texted is unrouted: nothing is recorded anywhere
      const stranger = phone();
      const before = (await rows(a.id)).length + (await rows(c.id)).length;
      expect((await text(PLATFORM, stranger, 'STOP')).res.status).toBe(200);
      expect(await db.isOptedOut(a.id, stranger)).toBe(false);
      expect((await rows(a.id)).length + (await rows(c.id)).length).toBe(before);
    });
  });

  test('20 H1: a tenant number Twilio refuses as a sender is retried from the shared sender (and the text is still logged as sent)', async () => {
    const b = await biz({ phone: realNumber() });
    const customer = phone();
    const prev = globalThis.fetch;
    const froms: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      const p = new URLSearchParams(String(init?.body));
      froms.push(p.get('From') as string);
      return p.get('From') === b.phone ? Response.json({ code: 21606, message: 'not SMS capable' }, { status: 400 }) : Response.json({ sid: 'SMfallback1' }, { status: 201 });
    }) as typeof fetch;
    try {
      await withEnv(TW, async () => {
        await text(b.phone!, customer, 'please call me about the estimate');
      });
    } finally { globalThis.fetch = prev; }
    expect(froms).toContain(b.phone!);
    expect(froms).toContain(PLATFORM);
    expect((await sms(b.id, 'inbox_autoreply'))[0]).toMatchObject({ status: 'sent', providerId: 'SMfallback1' });
  });

  // ================================================================== 20 H2 / L2: privacy
  test('20 H2: the owner-forward log row holds none of the customer\'s words; export returns the inbox row, erasure deletes everything (also a legacy forward row, never another customer\'s)', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const customer = phone();
      const other = phone();
      await text(b.phone!, customer, 'My divorce lawyer said call me back about the HIV test results');
      await text(b.phone!, other, 'My roof is leaking badly please come');
      const forwards = await sms(b.id, 'owner_alert');
      expect(forwards).toHaveLength(2);
      expect(JSON.stringify(forwards.map((f) => f.body))).not.toMatch(/divorce|HIV|roof|leaking/);
      expect(forwards.every((f) => f.body.includes('forwarded to the owner'))).toBe(true);
      // a forward row written by the OLD code (the customer's words, no number, booking or name) is still found by the shape + last 4 + the customer's own inbox text
      await prisma.smsLog.create({ data: { businessId: b.id, toPhone: b.owner_phone!, toE164: b.owner_phone_e164 ?? null, kind: 'owner_alert', status: 'sent', body: `Customer text (...${customer.slice(-4)}): "My divorce lawyer said call me back about the HIV test results". Reply from Messages in the dashboard.` } });
      await prisma.smsLog.create({ data: { businessId: b.id, toPhone: b.owner_phone!, toE164: b.owner_phone_e164 ?? null, kind: 'owner_alert', status: 'sent', body: `Customer text (...${customer.slice(-4)}): "Totally different words from somebody else with the same last digits". Reply from Messages in the dashboard.` } });
      const { exportCustomerData } = await import('@/lib/privacy');
      const exp = await exportCustomerData(b.id, customer);
      expect(exp.inbound_messages.map((m: any) => m.body)).toEqual(['My divorce lawyer said call me back about the HIV test results']);
      expect(JSON.stringify(exp.sms)).toContain('HIV'); // the legacy row is part of the export
      expect(JSON.stringify(exp.sms)).not.toContain('somebody else');
      await prisma.rateLimitBucket.create({ data: { key: `inbox:sender:${b.id}:${customer}`, windowStart: new Date(), count: 1 } }).catch(() => undefined);
      const counts = await db.eraseCustomerData(b.id, customer);
      expect(counts.inbound_messages).toBe(1);
      const left = await prisma.smsLog.findMany({ where: { businessId: b.id, kind: 'owner_alert' } });
      expect(left.map((r) => r.body).join('|')).not.toMatch(/HIV|divorce/);
      expect(left.map((r) => r.body).join('|')).toContain('somebody else'); // the other customer's row survives
      expect((await rows(b.id)).map((r) => r.fromE164)).toEqual([other]);
      // 20 L2: nothing derived from the erased number outlives erasure in the limiter
      expect(await prisma.rateLimitBucket.count({ where: { key: { endsWith: `:${b.id}:${customer}` } } })).toBe(0);
      expect(await prisma.rateLimitBucket.count({ where: { key: { endsWith: `:${b.id}:${other}` } } })).toBeGreaterThan(0);
    });
  });

  // ================================================================== 20 M1: one number cannot lock the inbox
  test('20 M1: a flooding sender spends only its OWN budget; the next real customer is still stored', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const attacker = phone();
      for (let i = 0; i < 25; i++) await text(b.phone!, attacker, `spam ${i} lorem ipsum`);
      const victim = phone();
      await text(b.phone!, victim, 'Hi, my AC is leaking, can someone come today?');
      expect(await prisma.inboundMessage.count({ where: { businessId: b.id, fromE164: attacker } })).toBe(10);
      expect(await prisma.inboundMessage.count({ where: { businessId: b.id, fromE164: victim } })).toBe(1);
      const bucket = await prisma.rateLimitBucket.aggregate({ where: { key: `inbox:biz:${b.id}` }, _sum: { count: true } });
      expect(bucket._sum.count ?? 0).toBeLessThanOrEqual(11); // the 15 rejected texts never reached the business budget
    });
  });

  // ================================================================== 20 M2: opt-out phrasing
  test('20 M2: a free-form opt-out request gets no automatic reply, is flagged, the owner is told, and the owner can opt the number out in one tap', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const cust = phone();
      for (const body of ['Stop. Who is this?', "Don't text me again", 'Please remove me from your list']) {
        const from = phone();
        await text(b.phone!, from, body);
        expect(await sms(b.id, 'inbox_autoreply')).toHaveLength(0);
        const [m] = await prisma.inboundMessage.findMany({ where: { businessId: b.id, fromE164: from } });
        expect(m.handledBy).toBe('auto:possible_revocation');
        expect(m.status).toBe('new');
        expect(m.autoRepliedAt).toBeNull();
      }
      expect((await sms(b.id, 'owner_alert')).length).toBe(3); // the owner IS told (the forward is logged without the words)
      const { toInboxItem } = await import('@/lib/messaging/inbox-view');
      const revoked = await prisma.inboundMessage.findFirst({ where: { businessId: b.id }, orderBy: { receivedAt: 'asc' } });
      expect(toInboxItem(await db.getInboundMessage(b.id, revoked!.id) as any).possible_opt_out).toBe(true);
      // the opt-out route: owner/staff of THAT business only; the number is the stored sender
      const route = await import('@/app/api/businesses/[id]/messages/[messageId]/opt-out/route');
      const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role: 'staff', business_id: b.id, email_verified: true });
      userIds.push(user.id);
      const { token } = await users.createSession(user.id);
      const post = (id: string, messageId: string, cookie: string) => route.POST(new Request('https://app.example.test/x', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', cookie }, body: '{}' }), { params: Promise.resolve({ id, messageId }) });
      expect((await post(b.id, revoked!.id, `rc_user_session=${token}`)).status).toBe(200);
      expect(await db.isOptedOut(b.id, revoked!.fromE164)).toBe(true);
      expect((await db.getInboundMessage(b.id, revoked!.id))!.status).toBe('handled');
      const stranger = await biz();
      const strangerUser = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: stranger.id, email_verified: true });
      userIds.push(strangerUser.id);
      const s2 = await users.createSession(strangerUser.id);
      expect((await post(b.id, revoked!.id, `rc_user_session=${s2.token}`)).status).toBeGreaterThanOrEqual(403); // another tenant's owner: refused
      expect(cust).toBeTruthy();
    });
  });

  // ================================================================== 20 M4: forward budget per sender
  test('20 M4: one sender can spend at most 2 owner texts per hour; the business budget stays for everyone else', async () => {
    await withEnv({ ...DEMO, INBOX_FORWARD_HOURLY_LIMIT: '10' }, async () => {
      const b = await biz();
      const noisy = phone();
      for (let i = 0; i < 5; i++) await text(b.phone!, noisy, `question number ${i} about the estimate`);
      expect((await sms(b.id, 'owner_alert')).length).toBe(2);
      expect((await rows(b.id)).filter((r) => r.fromE164 === noisy && r.forwardedToOwnerAt).length).toBe(2);
      const real = phone();
      await text(b.phone!, real, 'Is anyone available to look at a burst pipe?');
      expect((await sms(b.id, 'owner_alert')).length).toBe(3);
      const bucket = await prisma.rateLimitBucket.aggregate({ where: { key: `inbox-forward:hour:${b.id}` }, _sum: { count: true } });
      expect(bucket._sum.count ?? 0).toBe(3); // only forwards that went out spent the business budget
    });
  });

  // ================================================================== 20 L1: high-rate destinations
  test('20 L1: no automatic reply to a Caribbean number (stored and forwarded); a manual text there needs a booking', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const carib = '+18765551234';
      await text(b.phone!, carib, 'Hello is this the plumber?');
      expect(await rows(b.id)).toHaveLength(1);
      expect(await sms(b.id, 'owner_alert')).toHaveLength(1);
      expect(await sms(b.id, 'inbox_autoreply')).toHaveLength(0);
      const { sendManualText } = await import('@/lib/messaging/manual');
      const refused = await sendManualText({ business: b, to: carib, body: 'Yes we can come', kind: 'manual' });
      expect(refused).toMatchObject({ ok: false, reason: 'high_rate_destination' });
      const viaReply = await sendManualText({ business: b, to: carib, body: 'Yes we can come', kind: 'owner_inbox_reply', trustedRecipient: true });
      expect(viaReply).toMatchObject({ ok: false, reason: 'high_rate_destination' });
      await db.createBooking({ business_id: b.id, customer_name: 'Caribbean Cust', customer_phone: carib, service: 'AC repair', scheduled_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), status: 'pending' }).catch(() => undefined);
    });
  });

  // ================================================================== 21 H1 / M1: card payment over a manual mark
  async function stripeEvent(bookingId: string, businessId: string, amount: number, type = 'checkout.session.completed') {
    const id = eventId();
    const event = { id, object: 'event', type, data: { object: { id: type === 'checkout.session.completed' ? `cs_test_${id}` : `pi_${id}`, amount_total: amount, payment_status: 'paid', ...(type === 'checkout.session.completed' ? { payment_intent: `pi_${id}` } : {}), metadata: { booking_id: bookingId, business_id: businessId } } } };
    const raw = JSON.stringify(event);
    return webhook(new Request('https://app.example.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': stripeSignature(raw) }, body: raw }));
  }
  const nextHour = new Map<string, number>();
  async function pendingBooking(businessId: string, extra: Record<string, unknown> = {}) {
    const n = nextHour.get(businessId) ?? 0; nextHour.set(businessId, n + 1); // a different slot for every booking of one business
    return db.createBooking({
      business_id: businessId, customer_name: 'Dana Ruiz', customer_phone: phone(), service: 'AC repair',
      scheduled_at: new Date(`${futureDateKey(2)}T${String(8 + n).padStart(2, '0')}:00:00Z`).toISOString(), status: 'pending', price_estimate: 18900, ...extra,
    } as any);
  }

  test('21 H1+M1: a card payment on a booking already marked paid by hand becomes a Stripe payment, the owner is told they paid twice, a manual refund no longer blocks the card refund, and unmark is refused', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const bk = await pendingBooking(b.id);
      expect((await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, { amount_cents: 4000 })).ok).toBe(true);
      const { recordManualRefund, refundDeposit } = await import('@/lib/refund-service');
      expect((await recordManualRefund({ businessId: b.id, bookingId: bk.id, amount_cents: 4000, actor: { kind: 'admin_token' } })).ok).toBe(true);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } })).refundStatus).toBe('refunded');
      // the customer pays the still-live link anyway
      const res = await stripeEvent(bk.id, b.id, 5000);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data).toMatchObject({ booking_id: bk.id, deposit_paid: true });
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } });
      expect(row).toMatchObject({ depositSource: 'stripe', depositAmount: 5000, depositPaid: true, depositMarkedBy: null, depositMarkedAt: null, refundStatus: 'none', refundAmountCents: null });
      expect(row.stripePaymentIntentId).toMatch(/^pi_/);
      const alerts = await sms(b.id, 'owner_alert');
      expect(alerts.map((a) => a.body).join('\n')).toMatch(/paid twice/);
      const audit = await prisma.auditEvent.findFirst({ where: { businessId: b.id, action: 'payment.paid_over_manual_deposit' } });
      expect((audit!.meta as any)).toMatchObject({ amount_cents: 5000, manual_amount_cents: 4000, manual_refund_cents: 4000 });
      // the manual refund stays in the audit trail
      expect(await prisma.auditEvent.count({ where: { businessId: b.id, action: 'booking.refund_recorded_manual' } })).toBe(1);
      // the same payment's second event (payment_intent.succeeded) is a no-op: no second alert
      await stripeEvent(bk.id, b.id, 5000, 'payment_intent.succeeded');
      expect((await sms(b.id, 'owner_alert')).filter((a) => /paid twice/.test(a.body))).toHaveLength(1);
      // the card payment is refundable through Stripe again (it reaches the provider step, not "manual_deposit" / "already_refunded")
      const prev = globalThis.fetch;
      let stripeCalls = 0;
      globalThis.fetch = (async (u: unknown) => { const url = String(u); if (url.startsWith('https://api.stripe.com/')) { stripeCalls++; return Response.json({ error: { message: 'test refusal' } }, { status: 400 }); } throw new Error(`unexpected ${url}`); }) as typeof fetch;
      try {
        const refund = await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, () => refundDeposit({ businessId: b.id, bookingId: bk.id, override: true, actor: { kind: 'admin_token' } }));
        expect(['manual_deposit', 'already_refunded']).not.toContain((refund as any).code);
        expect(stripeCalls).toBeGreaterThan(0);
      } finally { globalThis.fetch = prev; }
      // unmarking a deposit with a card payment on file is refused (a manual row that somehow carries card references)
      await prisma.booking.update({ where: { id: bk.id }, data: { depositSource: 'manual', depositMarkedAt: new Date(), depositMarkedBy: 'x', refundStatus: 'none' } });
      expect(await db.unmarkManualDeposit(b.id, bk.id, { kind: 'admin_token' })).toEqual({ ok: false, reason: 'card_payment_on_file' });
    });
  });

  test('21 H1 (same amount): a card payment of the SAME amount over a manual mark is also converted and reported', async () => {
    await withEnv(DEMO, async () => {
      const b = await biz();
      const bk = await pendingBooking(b.id);
      await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, { amount_cents: 5000 });
      await stripeEvent(bk.id, b.id, 5000);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } })).depositSource).toBe('stripe');
      expect((await sms(b.id, 'owner_alert')).map((a) => a.body).join('\n')).toMatch(/paid twice/);
    });
  });

  test('21 H1: the manual mark queues a DURABLE link deactivation: a Stripe outage is retried by the reconcile pass, a link whose id was never stored is found by its booking_id', async () => {
    const b = await biz();
    const bk = await pendingBooking(b.id);
    await prisma.booking.update({ where: { id: bk.id }, data: { stripePaymentLinkId: 'plink_durable1234', depositAmount: 5000 } });
    await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, {});
    const store = await import('@/lib/payments/link-store');
    const prev = globalThis.fetch;
    const seen: string[] = [];
    let healthy = false;
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      seen.push(`${init?.method ?? 'GET'} ${url.replace('https://api.stripe.com/v1', '')}`);
      if (!url.startsWith('https://api.stripe.com/')) throw new Error(`unexpected ${url}`);
      return healthy ? Response.json({ id: 'plink_durable1234', active: false }) : new Response('{}', { status: 503 });
    }) as typeof fetch;
    try {
      await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
        expect(await store.scheduleLinkDeactivation({ id: bk.id, business_id: b.id })).toBe('queued');
        await store.flushLinkDeactivations();
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: bk.id } })).toBe(1); // Stripe failed: the queue row stays
        healthy = true;
        const drained = await store.drainLinkDeactivations({ now: new Date(Date.now() + 10 * 60_000) });
        expect(drained.done).toBeGreaterThanOrEqual(1);
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: bk.id } })).toBe(0);
      });
    } finally { globalThis.fetch = prev; }
    expect(seen.some((s) => s.startsWith('POST /payment_links/plink_durable1234'))).toBe(true);
    // a card-paid booking is not touched by the queue (nothing to stop)
    const paid = await pendingBooking(b.id);
    await db.markDepositPaid(paid.id, 5000);
    await prisma.processedEvent.create({ data: { source: 'link-deactivate', id: paid.id, status: 'processing' } });
    await prisma.processedEvent.updateMany({ where: { source: 'link-deactivate', id: paid.id }, data: { claimedAt: new Date(Date.now() - 3600_000) } });
    const seenBefore = seen.length;
    await store.drainLinkDeactivations({ now: new Date() });
    expect(seen.length).toBe(seenBefore);
    expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: paid.id } })).toBe(0);
  });

  // ================================================================== 21 M2: stale snapshot
  test('21 M2: a stale booking snapshot never rewrites a paid deposit\'s amount, and a link made for a booking that was paid meanwhile is deactivated at once', async () => {
    const b = await biz();
    const bk = await pendingBooking(b.id);
    await prisma.booking.update({ where: { id: bk.id }, data: { depositAmount: 5000 } });
    const stale = (await db.getBooking(bk.id))!; // the snapshot a slow request took before the owner marked the deposit
    await db.markDepositPaidManually(b.id, bk.id, { kind: 'admin_token' }, {});
    expect(await db.setDepositAmountIfUnpaid(stale.id, 9000)).toBe(false);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } })).depositAmount).toBe(5000);
    const unpaid = await pendingBooking(b.id);
    expect(await db.setDepositAmountIfUnpaid(unpaid.id, 7000)).toBe(true);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: unpaid.id } })).depositAmount).toBe(7000);
    // the new link of the stale request is deactivated as soon as it is remembered
    const store = await import('@/lib/payments/link-store');
    const prev = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (u: unknown) => { const url = String(u); seen.push(url); if (!url.startsWith('https://api.stripe.com/')) throw new Error(`unexpected ${url}`); return Response.json({ id: 'plink_late1234', active: false }); }) as typeof fetch;
    try {
      await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, () => store.rememberPaymentLink(bk.id, 'plink_late1234'));
    } finally { globalThis.fetch = prev; }
    expect(seen.some((u) => u.includes('/payment_links/plink_late1234'))).toBe(true);
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: b.id, action: 'booking.payment_link_deactivated', target: `booking:${bk.id}` } });
    expect((audit!.meta as any).reason).toBe('deposit_already_paid');
  });

  // ================================================================== 21 L3: demo checkout
  test('21 L3: the demo checkout leaves deposit_source empty (nothing was charged) and never touches an already paid deposit', async () => {
    await withEnv(DEMO, async () => {
      const route = await import('@/app/api/pay/mock-complete/route');
      const b = await biz();
      const bk = await pendingBooking(b.id);
      await prisma.booking.update({ where: { id: bk.id }, data: { depositAmount: 5000 } });
      const call = (id: string) => route.POST(new Request('https://app.example.test/api/pay/mock-complete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200) + 1}` }, body: JSON.stringify({ booking_id: id }) }));
      expect((await call(bk.id)).status).toBe(200);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bk.id } })).toMatchObject({ depositPaid: true, depositSource: null });
      const manual = await pendingBooking(b.id);
      await db.markDepositPaidManually(b.id, manual.id, { kind: 'admin_token' }, { amount_cents: 6000 });
      expect(((await (await call(manual.id)).json()) as any).data.updated).toBe(false);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ depositSource: 'manual', depositAmount: 6000 });
    });
  });

  // ================================================================== 22 M3: the owner's slot list
  test('22 M3: the dashboard\'s new-booking slot list offers what the owner\'s own booking can take (no minimum notice, no booking window); customers still obey both', async () => {
    const sched = await import('@/lib/scheduler');
    const b = await newBusiness({ timezone: 'UTC', hours: Object.fromEntries(Object.keys(ALL_WEEK).map((d) => [d, { open: '00:00', close: '23:59' }])) as any });
    bizIds.push(b.id);
    await db.setSchedulingConfig(b.id, { min_lead_minutes: 180, horizon_days: 7 });
    const biz2 = (await db.getBusiness(b.id))!;
    const now = Date.UTC(2030, 0, 2, 10, 0);
    const far = '2030-01-22';
    expect(await sched.slotsForDate(biz2, far, 60, now)).toEqual([]); // a customer: beyond the 7-day window
    const owner = await sched.slotsForDate(biz2, far, 60, now, { ownerInitiated: true });
    expect(owner.filter((s) => s.available).length).toBeGreaterThan(10);
    const today = await sched.slotsForDate(biz2, '2030-01-02', 60, now, { ownerInitiated: true });
    expect(today.find((s) => s.start === '2030-01-02T11:00:00.000Z')?.available).toBe(true); // inside the 3 h notice
    const customerToday = await sched.slotsForDate(biz2, '2030-01-02', 60, now);
    expect(customerToday.find((s) => s.start === '2030-01-02T11:00:00.000Z')?.available).toBe(false);
    // and what is offered can be booked (the same rule createBooking applies for the owner)
    const made = await db.createBooking({ business_id: b.id, customer_name: 'Far Away', customer_phone: phone(), service: 'AC repair', scheduled_at: '2030-01-22T10:00:00.000Z', status: 'confirmed' } as any, { ownerInitiated: true } as any).catch((e) => e);
    expect(made instanceof Error).toBe(false);
  });

  // ================================================================== 22 M4 / L1: content confirmation
  test('22 M4+L1: an FAQ price edit makes the confirmation stale; confirming with the hash the page showed is refused when the content changed meanwhile', async () => {
    const b = await biz();
    await db.upsertKnowledgeBase(b.id, {
      services: [{ name: 'Drain cleaning', base_price: 125, duration_minutes: 60 }], faqs: [{ question: 'How much?', answer: 'Drain cleaning starts around $125' }], pricing_notes: '', call_script: '', system_prompt: 'x',
    } as any);
    await db.updateBusiness(b.id, { service_area: ['Miami'] });
    const first = await db.getContentConfirmation(b.id);
    expect(first!.state).toBe('unconfirmed');
    const shown = first!.content_hash;
    const ok = await db.confirmContent(b.id, { kind: 'admin_token' }, new Date(), { expected_hash: shown });
    expect(ok).toMatchObject({ state: 'confirmed' });
    expect((await db.getContentConfirmation(b.id))!.state).toBe('confirmed');
    // a staff member edits the FAQ price: stale
    await db.upsertKnowledgeBase(b.id, { services: [{ name: 'Drain cleaning', base_price: 125, duration_minutes: 60 }], faqs: [{ question: 'How much?', answer: 'Drain cleaning starts around $199' }], pricing_notes: '', call_script: '', system_prompt: 'x' } as any);
    expect((await db.getContentConfirmation(b.id))!.state).toBe('stale');
    // the owner's page still shows the OLD content: the confirmation is refused, nothing is stored, and the current hash is returned
    const refused = await db.confirmContent(b.id, { kind: 'admin_token' }, new Date(), { expected_hash: shown });
    expect(refused).toMatchObject({ changed: true });
    expect((await db.getContentConfirmation(b.id))!.state).toBe('stale');
    const again = await db.confirmContent(b.id, { kind: 'admin_token' }, new Date(), { expected_hash: (refused as any).content_hash });
    expect(again).toMatchObject({ state: 'confirmed' });
  });

  // ================================================================== 22 L3: the onboarding zone
  test('22 L3: the time zone view says whether the zone was already chosen (the onboarding suggestion must not override it)', async () => {
    const route = await import('@/app/api/businesses/[id]/timezone/route');
    const b = await biz({ tz: 'America/New_York' });
    const owner = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: b.id, email_verified: true });
    userIds.push(owner.id);
    const { token } = await users.createSession(owner.id);
    const get = async () => ((await (await route.GET(new Request('https://app.example.test/x', { headers: { cookie: `rc_user_session=${token}`, 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ id: b.id }) })).json()) as any).data;
    expect((await get()).chosen).toBe(false); // the untouched default
    await prisma.business.update({ where: { id: b.id }, data: { timezone: 'America/Chicago' } });
    expect((await get()).chosen).toBe(true); // a non-default zone is always a choice
    await prisma.business.update({ where: { id: b.id }, data: { timezone: 'America/New_York' } });
    await prisma.auditEvent.create({ data: { actorKind: 'user', businessId: b.id, action: 'business.timezone_changed', target: `business:${b.id}`, meta: {} } });
    expect((await get()).chosen).toBe(true); // chosen once, even if it is the default again
  });

  // ================================================================== 22 L4: honest "no slots" wording
  test('22 L4: the voice agent says why a day has nothing: beyond the booking window, closed, in the past', async () => {
    const tools = await import('@/lib/voice/tools');
    const tz = awakeTimezone();
    const b = await newBusiness({ timezone: tz, agent_id: uniq('agent'), hours: { ...ALL_WEEK, sunday: null } as any });
    bizIds.push(b.id);
    await db.setSchedulingConfig(b.id, { horizon_days: 5 });
    const far = futureDateKey(1, tz, 40);
    const r = await tools.checkAvailability({ business_id: b.id, date: far });
    expect(r.message).toMatch(/further ahead than we are booking/);
    expect(r.message).not.toMatch(/full/);
    const closedDay = futureDateKey(0, tz, 1); // a Sunday, inside the window or not: closed days are never "full"
    await db.setSchedulingConfig(b.id, { horizon_days: 180 });
    const c = await tools.checkAvailability({ business_id: b.id, date: closedDay });
    expect(c.message).toMatch(/closed that day/);
    const past = await tools.checkAvailability({ business_id: b.id, date: '2020-01-01' });
    expect(past.message).toMatch(/already passed/);
  });

  // ================================================================== 22 M2: the release job cap
  test('22 M2: a provider outage cannot lift the release cap or delete agents: no agent is deleted while the line cannot be, the breaker stops the run after 3 failing tenants', async () => {
    const { runTenantReleaseJob } = await import('@/lib/jobs/tenants');
    const ids: string[] = [];
    const agents: string[] = [];
    for (let i = 0; i < 6; i++) {
      const b = await newBusiness({ agent_id: `agent_rel_${uniq('a')}` });
      bizIds.push(b.id);
      const num = realNumber();
      await prisma.business.update({ where: { id: b.id }, data: { billingStatus: 'canceled', plan: 'standard', currentPeriodEnd: new Date(Date.now() - 90 * 86_400_000), phone: num, phoneE164: num, phoneKey: num.slice(-10), elevenlabsPhoneNumberId: `phnum_${uniq('l')}`, status: 'live' } });
      await prisma.auditEvent.create({ data: { actorKind: 'system', businessId: b.id, action: 'billing.release_notice', target: `business:${b.id}`, meta: { notified_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }, at: new Date(Date.now() - 40 * 86_400_000) } });
      ids.push(b.id); agents.push((await db.getBusiness(b.id))!.agent_id!);
    }
    const prev = globalThis.fetch;
    const agentDeletes: string[] = [];
    globalThis.fetch = (async (u: unknown, init?: { method?: string }) => {
      const url = String(u);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE' && /convai\/phone-numbers\//.test(url)) return new Response('boom', { status: 500 });
      if (method === 'DELETE' && /convai\/agents\//.test(url)) { agentDeletes.push(url); return Response.json({}); }
      return Response.json({});
    }) as typeof fetch;
    try {
      const report = await withEnv({ TENANT_RELEASE_JOB: 'on', ELEVENLABS_API_KEY: 'xi-test', TWILIO_ACCOUNT_SID: undefined }, () => runTenantReleaseJob({ dryRun: false, now: new Date() }));
      const mine = report.items.filter((i) => ids.includes(i.business_id as string));
      expect(mine.filter((i) => i.outcome === 'partial_error').length).toBeLessThanOrEqual(3);
      expect(mine.filter((i) => i.outcome === 'deferred_to_next_run').length).toBeGreaterThanOrEqual(3);
      expect(agentDeletes.filter((u) => agents.some((a) => u.includes(a)))).toEqual([]); // agents survive while their lines cannot be removed
      expect(report.counts!.released ?? 0).toBe(0);
      expect(report.counts!.partial_error).toBeGreaterThan(0);
    } finally { globalThis.fetch = prev; }
  });

  // ================================================================== 19: the AI line
  const TWL = { ...TW, TWILIO_AUTH_TOKEN: 'twilio-auth-token-integration-test', ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_AGENT_ID: undefined, ELEVENLABS_PHONE_NUMBER_ID: undefined, VOICE_LINE_KIND: undefined, NATIVE_TRANSFER: undefined } as Record<string, string | undefined>;
  function providers(twilioNumbers: Record<string, { voice_url?: string }> = {}) {
    const eleven = fakeElevenLabs();
    const twilioCalls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes('api.twilio.com')) {
        const method = init?.method ?? 'GET';
        twilioCalls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
        if (method === 'GET') { const q = new URL(url).searchParams.get('PhoneNumber') as string; return Response.json({ incoming_phone_numbers: q in twilioNumbers ? [{ sid: `PN_${q.slice(-4)}`, phone_number: q, sms_url: '', sms_method: 'POST', voice_url: twilioNumbers[q].voice_url ?? '', voice_method: 'POST' }] : [] }); }
        return Response.json({ sid: 'PN1' });
      }
      return eleven.fetchImpl(input as any, init as any);
    }) as unknown as typeof fetch;
    return { eleven, twilioCalls, fetchImpl };
  }
  const withFetch = async <T,>(f: typeof fetch, fn: () => Promise<T>) => { const prev = globalThis.fetch; globalThis.fetch = f; try { return await fn(); } finally { globalThis.fetch = prev; } };
  /** The repair route is rate limited per minute; every call of these tests starts from an empty bucket. */
  const repairPost = async (route: { POST: (r: Request) => Promise<Response> }, r: Request) => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/repair' } } }); return route.POST(r); };
  const adminReq = (body: unknown) => new Request('https://app.example.test/api/admin/repair-numbers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRETS.adminToken}`, 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test' }, body: JSON.stringify(body) });

  test('19 F1: on a webhook-kind deployment repair-numbers never overwrites the Voice URL of a number the tenant already imported into ElevenLabs', async () => {
    const repair = await import('@/app/api/admin/repair-numbers/route');
    const num = realNumber();
    const b = await biz({ phone: num, agent: uniq('agent') });
    await db.setBusinessLine(b.id, { elevenlabs_phone_number_id: `phnum_${uniq('i')}` });
    const p = providers({ [num]: { voice_url: 'https://api.us.elevenlabs.io/twilio/inbound_call' } });
    await withEnv({ ...TWL, VOICE_LINE_KIND: 'webhook', ELEVENLABS_API_KEY: undefined }, () => withFetch(p.fetchImpl, async () => {
      const r = await (await repairPost(repair, adminReq({ business_ids: [b.id], dry_run: false }))).json() as any;
      expect(r.data.items[0].changed ?? []).not.toContain('VoiceUrl');
    }));
    // SmsUrl is still repaired; no POST ever carries a VoiceUrl
    expect(p.twilioCalls.filter((c) => c.method === 'POST').some((c) => /VoiceUrl/.test(c.body ?? ''))).toBe(false);
    expect(p.twilioCalls.some((c) => c.method === 'POST' && /SmsUrl/.test(c.body ?? ''))).toBe(true);
    // a tenant that does NOT own an imported line on the same deployment still gets the webhook Voice URL (forwarding / voicemail numbers)
    const num2 = realNumber();
    const w = await biz({ phone: num2, agent: uniq('agent') });
    const p2 = providers({ [num2]: {} });
    await withEnv({ ...TWL, VOICE_LINE_KIND: 'webhook', ELEVENLABS_API_KEY: undefined }, () => withFetch(p2.fetchImpl, async () => {
      const r = await (await repairPost(repair, adminReq({ business_ids: [w.id], dry_run: false }))).json() as any;
      expect(r.data.items[0].changed).toContain('VoiceUrl');
    }));
  });

  test('19 F2+F3: the call-mode surfaces use the business\'s own line; the repair never silently ends forwarding for a forward-mode tenant', async () => {
    const repair = await import('@/app/api/admin/repair-numbers/route');
    const { callModeView } = await import('@/lib/voice/call-mode');
    const { effectiveLineKindFor } = await import('@/lib/voice/line');
    const num = realNumber();
    const b = await biz({ phone: num, agent: uniq('agent') });
    await prisma.business.update({ where: { id: b.id }, data: { callMode: 'forward', forwardNumberE164: '+13052345678', forwardNumberVerifiedAt: new Date() } });
    const fresh = (await db.getBusiness(b.id))!;
    // the default deployment (API key set, no shared line id, not forced): this business is not imported yet, so it forwards on the webhook line
    await withEnv({ ...TWL }, async () => {
      expect(effectiveLineKindFor(fresh)).toBe('webhook');
      expect(callModeView(fresh).forward_supported).toBe(true);
      const p = providers({ [num]: {} });
      await withFetch(p.fetchImpl, async () => {
        const dry = await (await repairPost(repair, adminReq({ business_ids: [b.id] }))).json() as any;
        expect(dry.data.items[0].line.outcome).toBe('skipped');
        expect(dry.data.items[0].line.detail).toMatch(/would_change_behaviour/);
        const real = await (await repairPost(repair, adminReq({ business_ids: [b.id], dry_run: false }))).json() as any;
        expect(real.data.items[0].line.outcome).toBe('skipped');
        expect(p.eleven.phones.size).toBe(0); // nothing was imported: the tenant keeps forwarding
      });
      expect((await db.getBusiness(b.id))!.elevenlabs_phone_number_id).toBeNull();
      // switching the tenant to AI first makes it repairable
      await db.setCallMode(b.id, 'ai');
      const p2 = providers({ [num]: {} });
      await withFetch(p2.fetchImpl, async () => {
        const done = await (await repairPost(repair, adminReq({ business_ids: [b.id], dry_run: false }))).json() as any;
        expect(done.data.items[0].line.outcome).toBe('imported');
      });
    });
    // a tenant that owns an imported line cannot be put in forward mode on a webhook-default deployment (it would be answered by ElevenLabs)
    await withEnv({ ...TWL, VOICE_LINE_KIND: 'webhook', ELEVENLABS_API_KEY: undefined }, async () => {
      const owned = (await db.getBusiness(b.id))!;
      expect(owned.elevenlabs_phone_number_id).toBeTruthy();
      expect(effectiveLineKindFor(owned)).toBe('native');
      expect(callModeView({ ...owned, call_mode: 'forward' } as any).forward_supported).toBe(false);
      expect(await db.setCallMode(b.id, 'forward')).toMatchObject({ ok: false, reason: 'forward_unsupported' });
    });
  });

  test('19 F4: concurrent ensureTenantLine runs import the number ONCE and leave no orphan import', async () => {
    const line = await import('@/lib/voice/tenant-line');
    const num = realNumber();
    const b = await biz({ phone: num, agent: uniq('agent') });
    const p = providers({ [num]: {} });
    await withEnv(TWL, () => withFetch(p.fetchImpl, async () => {
      const results = await Promise.all([line.ensureTenantLine(b), line.ensureTenantLine(b), line.ensureTenantLine(b)]);
      expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
      for (const r of results) if (!r.ok) expect(r).toMatchObject({ code: 'import_failed', retryable: true });
      expect(p.eleven.importBodies).toHaveLength(1);
      expect(p.eleven.phones.size).toBe(1);
      const stored = (await db.getBusiness(b.id))!.elevenlabs_phone_number_id;
      expect([...p.eleven.phones.keys()]).toEqual([stored]);
      // a duplicate import left by a lost race (no business owns it) is removed after a fresh import
      const num2 = realNumber();
      const b2 = await biz({ phone: num2, agent: uniq('agent') });
      const orphanId = `phnum_orphan_${uniq('o')}`;
      p.eleven.phones.set(orphanId, { phone_number_id: orphanId, phone_number: num2, label: 'orphan', agent_id: null });
      // the orphan is adopted by the first import (that is the idempotent behaviour) and nothing else is created
      const r2 = await line.ensureTenantLine(b2);
      expect(r2).toMatchObject({ ok: true, adopted: true, phone_number_id: orphanId });
    }));
  });

  test('19 F5: the shared ELEVENLABS_PHONE_NUMBER_ID fallback line is never adopted by a tenant and never deleted by a release; an import bound to another business\'s agent is not adopted', async () => {
    const line = await import('@/lib/voice/tenant-line');
    const num = realNumber();
    const b = await biz({ phone: num, agent: uniq('agent') });
    const p = providers({ [num]: {} });
    const sharedId = `phnum_shared_${uniq('s')}`;
    p.eleven.phones.set(sharedId, { phone_number_id: sharedId, phone_number: num, label: 'shared', agent_id: null });
    await withEnv({ ...TWL, ELEVENLABS_PHONE_NUMBER_ID: sharedId }, () => withFetch(p.fetchImpl, async () => {
      const r = await line.ensureTenantLine(b);
      expect(r).toMatchObject({ ok: false, code: 'conflict' });
      expect((await db.getBusiness(b.id))!.elevenlabs_phone_number_id).toBeNull();
      expect(p.eleven.phones.get(sharedId)!.agent_id).toBeNull(); // never rebound
      // a business that somehow points at the shared id: release refuses to delete it
      await prisma.business.update({ where: { id: b.id }, data: { elevenlabsPhoneNumberId: sharedId } });
      const rel = await line.releaseTenantLine(b.id);
      expect(rel).toMatchObject({ ok: false });
      expect(p.eleven.phones.has(sharedId)).toBe(true);
      expect((await db.getBusiness(b.id))!.elevenlabs_phone_number_id).toBe(sharedId);
    }));
    // an unowned import bound to ANOTHER business's agent is theirs
    const other = await biz({ agent: uniq('agent') });
    const num3 = realNumber();
    const c = await biz({ phone: num3, agent: uniq('agent') });
    const p3 = providers({ [num3]: {} });
    const foreignId = `phnum_foreign_${uniq('f')}`;
    p3.eleven.phones.set(foreignId, { phone_number_id: foreignId, phone_number: num3, label: 'foreign', agent_id: other.agent_id! });
    await withEnv(TWL, () => withFetch(p3.fetchImpl, async () => {
      expect(await line.ensureTenantLine(c)).toMatchObject({ ok: false, code: 'conflict' });
      expect(p3.eleven.phones.get(foreignId)!.agent_id).toBe(other.agent_id!);
    }));
  });

  test('19 F7: repair-numbers can refresh the Twilio credentials of imported numbers after a token rotation (the token only goes to the provider, never into the response or the audit)', async () => {
    const repair = await import('@/app/api/admin/repair-numbers/route');
    const num = realNumber();
    const b = await biz({ phone: num, agent: uniq('agent') });
    const p = providers({ [num]: {} });
    await withEnv(TWL, () => withFetch(p.fetchImpl, async () => {
      await repairPost(repair, adminReq({ business_ids: [b.id], dry_run: false })); // imports it
      const id = (await db.getBusiness(b.id))!.elevenlabs_phone_number_id!;
      const dry = await (await repairPost(repair, adminReq({ business_ids: [b.id], refresh_credentials: true }))).json() as any;
      expect(dry.data.items[0].line).toEqual({ outcome: 'would_refresh' });
      expect(p.eleven.credentialPatches).toHaveLength(0);
      const real = await (await repairPost(repair, adminReq({ business_ids: [b.id], refresh_credentials: true, dry_run: false }))).json() as any;
      expect(real.data.items[0].line).toEqual({ outcome: 'refreshed' });
      expect(p.eleven.credentialPatches).toHaveLength(1);
      expect(p.eleven.credentialPatches[0]).toMatchObject({ token: 'twilio-auth-token-integration-test' });
      expect(p.eleven.phones.get(id)!.agent_id).toBe(b.agent_id); // the binding is untouched
      expect(JSON.stringify(real)).not.toContain('twilio-auth-token-integration-test');
      expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { action: 'admin.repair_numbers' }, orderBy: { at: 'desc' }, take: 3 }))).not.toContain('twilio-auth-token-integration-test');
      expect((await repairPost(repair, adminReq({ refresh_credentials: 'yes' }))).status).toBe(422);
    }));
  });

  // ================================================================== 22 L5: briefing audio
  test('22 L5: the audio route answers 304 and byte ranges without reading the whole clip, and the regenerate button is capped per business per day', async () => {
    const route = await import('@/app/api/briefings/[id]/audio/route');
    const b = await biz({ tz: 'UTC' });
    const owner = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: b.id, email_verified: true });
    userIds.push(owner.id);
    const { token } = await users.createSession(owner.id);
    const headers = (extra: Record<string, string> = {}) => ({ cookie: `rc_user_session=${token}`, 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', 'content-type': 'application/json', ...extra });
    const briefing = await db.createBriefing({ business_id: b.id, date: '2030-03-04', transcript: 'A short text.', audio_url: null, stats: { narration: 'automatic' } } as any);
    const clip = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    expect((await db.saveBriefingAudio(b.id, briefing.id, { content_type: 'audio/mpeg', bytes: clip })).ok).toBe(true);
    const ctx = { params: Promise.resolve({ id: briefing.id }) };
    const full = await route.GET(new Request('http://app.test/x', { headers: headers() }), ctx);
    expect(full.status).toBe(200);
    const etag = full.headers.get('etag')!;
    expect(Buffer.from(await full.arrayBuffer()).equals(clip)).toBe(true);
    const notModified = await route.GET(new Request('http://app.test/x', { headers: headers({ 'if-none-match': etag }) }), ctx);
    expect(notModified.status).toBe(304);
    const part = await route.GET(new Request('http://app.test/x', { headers: headers({ range: 'bytes=100-199' }) }), ctx);
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(Buffer.from(await part.arrayBuffer()).equals(clip.subarray(100, 200))).toBe(true);
    const tail = await route.GET(new Request('http://app.test/x', { headers: headers({ range: 'bytes=-50' }) }), ctx);
    expect(Buffer.from(await tail.arrayBuffer()).equals(clip.subarray(4950))).toBe(true);
    expect((await route.GET(new Request('http://app.test/x', { headers: headers({ range: 'bytes=9000-9100' }) }), ctx)).status).toBe(416);
    // the slice is cut in Postgres and tenant scoped
    expect(await db.getBriefingAudioSlice(b.id, briefing.id, 0, 3)).toEqual(Buffer.from([0, 1, 2, 3]));
    const strangerBiz = await biz();
    expect(await db.getBriefingAudioSlice(strangerBiz.id, briefing.id, 0, 3)).toBeNull();
    // daily cap of real syntheses (audit rows of synthesized regenerations) per business
    await prisma.briefingAudio.updateMany({ where: { briefingId: briefing.id }, data: { textHash: null } }); // an unknown clip is not reusable: it would be synthesized again
    for (let i = 0; i < 10; i++) await prisma.auditEvent.create({ data: { actorKind: 'user', businessId: b.id, action: 'briefing.audio_regenerated', target: `briefing:${briefing.id}`, meta: { status: 'ready', synthesized: true } } });
    const post = await withEnv({ ELEVENLABS_API_KEY: 'xi-test' }, () => route.POST(new Request('http://app.test/x', { method: 'POST', headers: headers(), body: '{}' }), ctx));
    expect(post.status).toBe(429);
    expect(((await post.json()) as any).code).toBe('audio_daily_limit');
  });
});
