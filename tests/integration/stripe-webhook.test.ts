/**
 * POST /api/payments/webhook with realistic, correctly signed Stripe events against a real database.
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  cleanup, eventId, futureDateKey, loadDb, loadPrisma, newBusiness, phone, stripeSignature, uniq,
} from '../helpers/fixtures';

integration('stripe webhook (postgres)', () => {
  let POST: (req: Request) => Promise<Response>;
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    POST = (await import('@/app/api/payments/webhook/route')).POST;
  });
  afterAll(cleanup);

  let hour = 8;
  async function pendingBooking(businessId: string) {
    const day = futureDateKey(2);
    hour = hour >= 16 ? 8 : hour + 1;
    return db.createBooking({
      business_id: businessId, customer_name: 'Dana Ruiz', customer_phone: phone(), service: 'AC repair',
      scheduled_at: new Date(`${day}T${String(hour + 5).padStart(2, '0')}:00:00Z`).toISOString(),
      status: 'pending', price_estimate: 18900,
    });
  }

  function checkoutCompleted(opts: {
    id?: string; booking?: string; business?: string; amount?: number; payment_status?: string; type?: string;
  }) {
    const id = opts.id ?? eventId();
    return {
      id,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: opts.type ?? 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_${id}`,
          object: 'checkout.session',
          amount_total: opts.amount ?? 5000,
          currency: 'usd',
          payment_status: opts.payment_status ?? 'paid',
          status: 'complete',
          metadata: {
            ...(opts.booking ? { booking_id: opts.booking } : {}),
            ...(opts.business ? { business_id: opts.business } : {}),
          },
        },
      },
    };
  }

  function send(event: unknown, opts: { sig?: string | null; t?: number; secret?: string; body?: string } = {}) {
    const body = opts.body ?? JSON.stringify(event);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const sig = opts.sig === undefined ? stripeSignature(body, { t: opts.t, secret: opts.secret }) : opts.sig;
    if (sig) headers['stripe-signature'] = sig;
    return POST(new Request('https://app.example.test/api/payments/webhook', { method: 'POST', headers, body }));
  }
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  const booking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });

  test('valid checkout.session.completed records the deposit in cents and confirms the booking once', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    expect(bk.status).toBe('pending');

    const res = await send(checkoutCompleted({ booking: bk.id, business: biz.id, amount: 5000 }));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ received: true, booking_id: bk.id, deposit_paid: true });

    const row = await booking(bk.id);
    expect(row).toMatchObject({ depositPaid: true, depositAmount: 5000, status: 'confirmed' });
    // the owner is told exactly once
    const alerts = await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'owner_alert' } });
    expect(alerts.length).toBe(1);
    expect(alerts[0].body).toContain('$50');
    expect(outboundCalls).toEqual([]);
  });

  test('replaying the same event id is ignored as a duplicate', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const event = checkoutCompleted({ booking: bk.id, business: biz.id, amount: 7500 });

    expect((await json(await send(event))).data).toMatchObject({ deposit_paid: true });
    const again = await json(await send(event));
    expect(again.data).toEqual({ received: true, duplicate: true });
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1);
    expect((await booking(bk.id)).depositAmount).toBe(7500);

    // a *different* event for the same payment is processed but changes nothing and does not re-alert
    const second = await json(await send(checkoutCompleted({ booking: bk.id, business: biz.id, amount: 7500 })));
    expect(second.data).toMatchObject({ received: true, deposit_paid: false });
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1);
  });

  test('concurrent deliveries of one event id process it exactly once', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const event = checkoutCompleted({ booking: bk.id, business: biz.id, amount: 2500 });
    const results = await Promise.all(Array.from({ length: 6 }, () => send(event).then(json)));
    const processed = results.filter((r) => r.data?.deposit_paid === true);
    const dupes = results.filter((r) => r.data?.duplicate === true);
    expect(processed.length).toBe(1);
    expect(dupes.length).toBe(5);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(1);
  });

  test('bad signatures are rejected with 400 and nothing is recorded', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const event = checkoutCompleted({ booking: bk.id, business: biz.id });
    const body = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);

    const cases: Record<string, Response> = {
      'no header': await send(event, { sig: null }),
      'garbage header': await send(event, { sig: 'nope' }),
      'wrong secret': await send(event, { secret: 'whsec_other' }),
      'v1 not hex of the body': await send(event, { sig: `t=${now},v1=${'0'.repeat(64)}` }),
      'tampered body': await send(event, { sig: stripeSignature(body), body: body.replace('5000', '500000') }),
      'stale timestamp': await send(event, { t: now - 3600 }),
      'future timestamp': await send(event, { t: now + 3600 }),
      'only a v0 scheme': await send(event, { sig: stripeSignature(body).replace('v1=', 'v0=') }),
    };
    for (const [name, res] of Object.entries(cases)) expect([name, res.status]).toEqual([name, 400]);
    const row = await booking(bk.id);
    expect(row).toMatchObject({ depositPaid: false, depositAmount: null, status: 'pending' });
    expect(await prisma.processedEvent.count({ where: { id: event.id } })).toBe(0);
  });

  test('any one valid v1 among several is accepted (secret rotation)', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const event = checkoutCompleted({ booking: bk.id, business: biz.id });
    const body = JSON.stringify(event);
    const good = stripeSignature(body);
    const header = `${good.replace(/v1=/, 'v1=' + 'a'.repeat(64) + ',v1=')}`;
    expect((await send(event, { sig: header, body })).status).toBe(200);
    expect((await booking(bk.id)).depositPaid).toBe(true);
  });

  test('missing STRIPE_WEBHOOK_SECRET refuses with 503, even with a signature and the unsigned flag', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const event = checkoutCompleted({ booking: bk.id, business: biz.id });
    await withEnv({ STRIPE_WEBHOOK_SECRET: undefined }, async () => {
      expect((await send(event)).status).toBe(503);
      // STRIPE_ALLOW_UNSIGNED alone must not open the door: it also needs ALLOW_INSECURE_DEV outside production.
      await withEnv({ STRIPE_ALLOW_UNSIGNED: 'true' }, async () => {
        expect((await send(event, { sig: null })).status).toBe(503);
      });
      await withEnv({ STRIPE_ALLOW_UNSIGNED: 'true', ALLOW_INSECURE_DEV: 'true', NODE_ENV: 'production' }, async () => {
        expect((await send(event, { sig: null })).status).toBe(503);
      });
    });
    expect((await booking(bk.id)).depositPaid).toBe(false);
  });

  test('a cancelled booking is not resurrected by a late payment', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    await db.updateBooking(bk.id, { status: 'cancelled' });
    const res = await send(checkoutCompleted({ booking: bk.id, business: biz.id, amount: 5000 }));
    expect(res.status).toBe(200);
    const row = await booking(bk.id);
    expect(row.status).toBe('cancelled');
    // and the cancelled slot is still free for somebody else
    const free = await db.createBooking({
      business_id: biz.id, customer_name: 'Next', customer_phone: phone(), service: 'AC repair',
      scheduled_at: row.scheduledAt.toISOString(),
    });
    expect(free.status).toBe('confirmed');
  });

  test('metadata naming a different business is rejected; the owner is alerted instead', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const bk = await pendingBooking(a.id);
    const res = await json(await send(checkoutCompleted({ booking: bk.id, business: b.id, amount: 5000 })));
    expect(res.data).toMatchObject({ received: true, unmatched: true });
    expect(await booking(bk.id)).toMatchObject({ depositPaid: false, depositAmount: null, status: 'pending' });
    const alerts = await prisma.smsLog.findMany({ where: { kind: 'owner_alert', businessId: { in: [a.id, b.id] } } });
    expect(alerts.map((x) => x.businessId)).toEqual([b.id]);
    expect(alerts[0].body).toContain('without a booking match');
  });

  test('unknown booking, zero amount and unpaid sessions never mark anything paid', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const missing = await json(await send(checkoutCompleted({ booking: '00000000-0000-0000-0000-000000000001', business: biz.id })));
    expect(missing.data).toMatchObject({ unmatched: true });
    const zero = await json(await send(checkoutCompleted({ booking: bk.id, business: biz.id, amount: 0 })));
    expect(zero.data).toMatchObject({ unmatched: true });
    const unpaid = await json(await send(checkoutCompleted({ booking: bk.id, business: biz.id, payment_status: 'unpaid' })));
    expect(unpaid.data).toMatchObject({ ignored: 'not paid yet' });
    expect(await booking(bk.id)).toMatchObject({ depositPaid: false, depositAmount: null, status: 'pending' });
  });

  test('payment_intent.succeeded (amount_received) and irrelevant event types', async () => {
    const biz = await newBusiness();
    const bk = await pendingBooking(biz.id);
    const intent = {
      id: eventId(), object: 'event', type: 'payment_intent.succeeded',
      data: { object: { id: uniq('pi'), object: 'payment_intent', amount: 18900, amount_received: 9450, metadata: { booking_id: bk.id, business_id: biz.id } } },
    };
    expect((await json(await send(intent))).data).toMatchObject({ deposit_paid: true });
    expect((await booking(bk.id)).depositAmount).toBe(9450);

    const other = { id: eventId(), type: 'customer.created', data: { object: {} } };
    expect((await json(await send(other))).data).toMatchObject({ ignored: 'customer.created' });
    // ignored types are not claimed, so a later relevant event with the same id is still processed
    expect(await prisma.processedEvent.count({ where: { id: other.id } })).toBe(0);
  });

  test('a signed but unparseable body answers 200 so Stripe does not disable the endpoint', async () => {
    const res = await send(null, { body: '{not json' });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ ignored: 'unparseable body' });
  });
});
