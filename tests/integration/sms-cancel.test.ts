/** "Reply C to cancel": a bare C from the booking's own number cancels that sender's single upcoming booking (STOP-class keywords keep precedence). */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq } from '../helpers/fixtures';

integration('sms "Reply C to cancel" (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let inboundRoute: (req: Request) => Promise<Response>;
  let hooks: typeof import('@/lib/booking-hooks');
  const events: { id: string; kind: string }[] = [];
  const DEMO = { DEMO_MODE: 'true' };

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    inboundRoute = (await import('@/app/api/sms/inbound/route')).POST;
    hooks = await import('@/lib/booking-hooks');
    hooks.onBookingChanged('sms-cancel-test', (e) => { events.push({ id: e.bookingId, kind: e.kind }); });
  });
  afterAll(async () => { hooks.clearBookingHandlers(); await cleanup(); });
  beforeEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'sms-cancel:' } } }); });

  type Biz = Awaited<ReturnType<typeof newBusiness>>;
  const text = async (biz: Biz, from: string, body: string, sid = uniq('SM')) => {
    const url = `${SECRETS.publicBase}/api/sms/inbound`;
    const params = { From: from, To: biz.phone!, Body: body, MessageSid: sid };
    return (await inboundRoute(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) }, body: new URLSearchParams(params).toString(),
    }))).text();
  };
  const reply = (xml: string) => /<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1] ?? '';
  let n = 0;
  async function book(biz: Biz, customer: string, daysAhead = 5, over: Record<string, unknown> = {}) {
    const day = futureDateKey(((new Date().getUTCDay() + daysAhead) % 7), 'America/New_York', daysAhead);
    n++;
    return db.createBooking({
      business_id: biz.id, customer_name: 'Maria', customer_phone: customer, service: 'AC repair',
      scheduled_at: new Date(`${day}T${String(8 + (n % 8)).padStart(2, '0')}:00:00-05:00`).toISOString(), duration_minutes: 60, ...over,
    });
  }
  const status = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } }));

  test('cancels the sender\'s single upcoming booking, replies with the refund-policy verdict, audits and emits the hook', async () => {
    await withEnv(DEMO, async () => {
      const biz = await newBusiness();
      const customer = phone();
      const b = await book(biz, customer);
      await prisma.booking.update({ where: { id: b.id }, data: { depositAmount: 5000, depositPaid: true } });
      const xml = await text(biz, customer, ' c. ');
      expect(reply(xml)).toMatch(/was cancelled/);
      expect(reply(xml)).toMatch(/deposit/i); // the verdict (>24h ahead, default policy full_24h: eligible)
      expect(reply(xml)).toMatch(/eligible for a refund/);
      const row = await status(b.id);
      expect(row.status).toBe('cancelled');
      expect(row.cancelReason).toBe('customer_sms_reply');
      expect(row.refundStatus).toBe('none'); // the app never refunds by itself: the owner is offered the refund
      expect(events.filter((e) => e.id === b.id).map((e) => e.kind)).toContain('cancelled');
      const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.cancelled', target: `booking:${b.id}` } });
      expect(audit?.actorKind).toBe('webhook');
      expect(audit?.meta).toMatchObject({ source: 'sms_reply' });
      expect((await db.getUsage(biz.id))!.sms_count).toBeGreaterThan(0); // the reply is metered
      // a second C: nothing left to cancel
      expect(reply(await text(biz, customer, 'C'))).toMatch(/could not find an upcoming booking/);
    });
  });

  test('Spanish business / call language: the reply is in Spanish; a non-refundable deposit says so', async () => {
    await withEnv(DEMO, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { localeDefault: 'es', refundPolicy: 'none' } });
      const customer = phone();
      const b = await book(biz, customer);
      await prisma.booking.update({ where: { id: b.id }, data: { depositAmount: 2500, depositPaid: true } });
      const r = reply(await text(biz, customer, 'C'));
      expect(r).toMatch(/fue cancelada/);
      expect(r).toMatch(/no es reembolsable/);
      const biz2 = await newBusiness();
      await prisma.business.update({ where: { id: biz2.id }, data: { localeDefault: 'es' } });
      expect(reply(await text(biz2, phone(), 'C'))).toMatch(/No encontramos una cita/);
    });
  });

  test('several upcoming bookings: nothing is cancelled, the customer is asked to call; none: told so; another sender cannot cancel it; past / cancelled bookings do not count', async () => {
    await withEnv(DEMO, async () => {
      const biz = await newBusiness();
      const customer = phone();
      const a = await book(biz, customer, 4);
      const b = await book(biz, customer, 6);
      expect(reply(await text(biz, customer, 'C'))).toMatch(/more than one upcoming booking/);
      expect((await status(a.id)).status).not.toBe('cancelled');
      expect((await status(b.id)).status).not.toBe('cancelled');
      expect(reply(await text(biz, phone(), 'C'))).toMatch(/could not find an upcoming booking/); // a stranger's C
      expect((await status(a.id)).status).not.toBe('cancelled');
      // cancel one by the dashboard path, the other becomes the only upcoming one
      await db.transitionBooking(biz.id, a.id, 'cancelled');
      expect(reply(await text(biz, customer, 'C'))).toMatch(/was cancelled/);
      expect((await status(b.id)).status).toBe('cancelled');
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.sms_cancel_refused' } })).toBe(2);
    });
  });

  test('STOP-class keywords keep precedence: CANCEL / END / QUIT opt out and cancel nothing; only bare C cancels; "c" inside a sentence does nothing', async () => {
    await withEnv(DEMO, async () => {
      const biz = await newBusiness();
      const customer = phone();
      const b = await book(biz, customer);
      for (const word of ['CANCEL', 'end', 'QUIT', 'STOP']) {
        await db.recordOptIn(biz.id, customer);
        expect(reply(await text(biz, customer, word))).toMatch(/unsubscribed/);
        expect((await status(b.id)).status).not.toBe('cancelled');
      }
      await db.recordOptIn(biz.id, customer);
      for (const body of ['c please', 'cc', 'Cancel my booking', '1', 'see you']) { await text(biz, customer, body); expect((await status(b.id)).status).not.toBe('cancelled'); }
      expect(reply(await text(biz, customer, 'C'))).toMatch(/was cancelled/);
    });
  });

  test('an opted-out sender still gets their cancellation processed but no reply text; Twilio retries and floods are ignored', async () => {
    await withEnv(DEMO, async () => {
      const biz = await newBusiness();
      const customer = phone();
      const b = await book(biz, customer);
      await db.recordOptOut(biz.id, customer, 'stop_keyword');
      const xml = await text(biz, customer, 'C');
      expect(reply(xml)).toBe('');
      expect((await status(b.id)).status).toBe('cancelled');

      // retry of the very same MessageSid: no second processing, no reply
      const biz2 = await newBusiness();
      const c2 = phone();
      await book(biz2, c2);
      const sid = uniq('SM');
      expect(reply(await text(biz2, c2, 'C', sid))).toMatch(/was cancelled/);
      expect(reply(await text(biz2, c2, 'C', sid))).toBe('');

      // flood from one sender: the 6th message in 10 minutes gets no reply
      const biz3 = await newBusiness();
      const c3 = phone();
      const replies: string[] = [];
      for (let i = 0; i < 7; i++) replies.push(reply(await text(biz3, c3, 'C')));
      expect(replies.slice(0, 5).every((r) => r.length > 0)).toBe(true);
      expect(replies.slice(5)).toEqual(['', '']);
    });
  });

  test('the number belongs to one business: a C sent to business A never touches the same customer\'s booking at business B', async () => {
    await withEnv(DEMO, async () => {
      const a = await newBusiness();
      const b = await newBusiness();
      const customer = phone();
      const atB = await book(b, customer);
      expect(reply(await text(a, customer, 'C'))).toMatch(/could not find/);
      expect((await status(atB.id)).status).not.toBe('cancelled');
      expect(reply(await text(b, customer, 'C'))).toMatch(/was cancelled/);
    });
  });
});
