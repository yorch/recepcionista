/**
 * Dashboard bookings (create / edit / no-show), deposits (policy-bound request and resend, manual "paid", manual refund) and the deposit policy API,
 * against a real Postgres. Adversarial: roles, tenant isolation, CSRF, step-up, hours / closed days / overlap per crew, quiet hours, manual deposits
 * never reaching Stripe. Time-of-day independent (quiet / awake zones); no outbound request may leave (outboundCalls must stay empty).
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ALL_WEEK, awakeTimezone, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, quietTimezone, uniq, wall } from '../helpers/fixtures';
import { zonedTimeToUtc } from '../../src/lib/time';

const NY = 'America/New_York';
type Ctx = { params: Promise<{ id: string }> };
type Route<T = Response> = (req: Request, c: Ctx) => Promise<T>;

integration('dashboard bookings and deposits (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let listRoute: { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
  let oneRoute: { PATCH: Route };
  let slotsRoute: { GET: (r: Request) => Promise<Response> };
  let depositRoute: { POST: Route };
  let markRoute: { POST: Route };
  let unmarkRoute: { POST: Route };
  let refundRoute: { POST: Route };
  let manualRefundRoute: { POST: Route };
  let policyRoute: { GET: Route; PUT: Route };
  let createLinkRoute: { POST: (r: Request) => Promise<Response> };
  let hooks: typeof import('@/lib/booking-hooks');
  const userIds: string[] = [];
  let ipSeq = 0;

  let savedProxy: string | undefined;
  beforeAll(async () => {
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.TRUSTED_PROXY = 'true'; // every request below carries its own x-forwarded-for, so each gets its own rate-limit bucket
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    listRoute = await import('@/app/api/bookings/route');
    oneRoute = await import('@/app/api/bookings/[id]/route');
    slotsRoute = await import('@/app/api/bookings/slots/route');
    depositRoute = await import('@/app/api/bookings/[id]/deposit/route');
    markRoute = await import('@/app/api/bookings/[id]/deposit/mark-paid/route');
    unmarkRoute = await import('@/app/api/bookings/[id]/deposit/unmark/route');
    refundRoute = await import('@/app/api/bookings/[id]/refund/route');
    manualRefundRoute = await import('@/app/api/bookings/[id]/refund/manual/route');
    policyRoute = await import('@/app/api/businesses/[id]/deposit-policy/route');
    createLinkRoute = await import('@/app/api/payments/create-link/route');
    hooks = await import('@/lib/booking-hooks');
  });
  afterAll(async () => {
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY; else process.env.TRUSTED_PROXY = savedProxy;
    hooks.clearBookingHandlers();
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  const events: { bookingId: string; kind: string }[] = [];
  beforeEach(() => { events.length = 0; hooks.onBookingChanged('test', (e) => { events.push({ bookingId: e.bookingId, kind: e.kind }); }); });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, user };
  }
  type Who = { cookie?: string; site?: string } | null;
  const req = (path: string, who: Who, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'x-forwarded-for': `198.52.${(ipSeq = (ipSeq + 1) % 250)}.${Math.floor(ipSeq / 3) + 1}`, 'sec-fetch-site': who?.site ?? 'same-origin',
        origin: who?.site === 'cross-site' ? 'https://evil.example' : 'https://app.example.test', ...(who?.cookie ? { cookie: who.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const json = async <T = unknown>(r: Response) => (await r.json()) as { ok: boolean; data?: T; error?: string; code?: string };

  const day = futureDateKey(2, NY, 10);
  const create = (who: Who, body: Record<string, unknown>) => listRoute.POST(req('/api/bookings', who, body));
  const base = (extra: Record<string, unknown> = {}) => ({ customer_name: 'Ana Pérez', customer_phone: phone(), service: 'AC repair', scheduled_at: wall(day, '10:00'), ...extra });
  type B = { booking: { id: string; status: string; crew?: number; created_via?: string; scheduled_at: string; duration_minutes: number; customer_phone: string; deposit_amount?: number | null; deposit_paid: boolean; deposit_source?: string | null; refund_status?: string; price_estimate?: number | null; followup_consent_at?: string | null; cancel_reason?: string | null }; notice?: { status: string; delivered: boolean } | null };

  async function setup() {
    const biz = await newBusiness();
    return { biz, owner: await login(biz.id), staff: await login(biz.id, 'staff') };
  }
  const leaked = () => expect(outboundCalls).toEqual([]);

  // ---------------------------------------------------------------- create

  test('create: owner books like the AI: confirmed, created_via dashboard, audited, Google/booking hook fired, nobody texted unless asked', async () => {
    const { biz, owner } = await setup();
    const r = await create(owner, base({ price_estimate: 15_000, address: '1 Main St' }));
    expect(r.status).toBe(201);
    const d = (await json<B>(r)).data!;
    expect(d.booking).toMatchObject({ status: 'confirmed', created_via: 'dashboard', crew: 1, duration_minutes: 60, price_estimate: 15_000 });
    expect(d.booking.scheduled_at).toBe(zonedTimeToUtc(day, '10:00', NY).toISOString()); // offset-less = the business zone
    expect(d.notice).toBeNull();
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    expect(events).toEqual([{ bookingId: d.booking.id, kind: 'created' }]);
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.created_dashboard', target: `booking:${d.booking.id}` } });
    expect(audit).toMatchObject({ actorKind: 'user', actorUserId: owner.user.id });
    expect(await prisma.booking.findUnique({ where: { id: d.booking.id } })).toMatchObject({ createdVia: 'dashboard', phoneE164: d.booking.customer_phone });
    leaked();
  });

  test('create: a walk-in without a phone number is allowed (nothing can be texted)', async () => {
    const { owner } = await setup();
    const r = await create(owner, base({ customer_phone: '', notify: true, scheduled_at: wall(day, '11:00') }));
    expect(r.status).toBe(201);
    const d = (await json<B>(r)).data!;
    expect(d.booking.customer_phone).toBe('');
    expect(d.notice).toMatchObject({ status: 'skipped', delivered: false });
  });

  test('create: roles, tenant isolation, CSRF, unknown fields and bad input', async () => {
    const a = await setup(); const b = await setup();
    expect((await create(a.staff, base())).status).toBe(403); // staff are read-only
    expect((await create(null, base())).status).toBe(401);
    expect((await create({ ...a.owner, site: 'cross-site' }, base())).status).toBe(403); // CSRF
    expect([403, 404]).toContain((await create(a.owner, base({ business_id: b.biz.id }))).status); // another tenant: refused without revealing it exists
    expect(await prisma.booking.count({ where: { businessId: { in: [a.biz.id, b.biz.id] } } })).toBe(0);
    for (const bad of [{ crew_x: 1 }, { status: 'completed' }, { deposit_paid: true }, { created_via: 'ai' }, { call_id: 'x' }]) expect((await create(a.owner, base(bad))).status).toBe(422);
    for (const bad of [{ customer_name: '' }, { service: '' }, { customer_phone: 'abc' }, { price_estimate: 1.5 }, { price_estimate: -5 }, { duration_minutes: 0 }, { duration_minutes: 'x' }, { notify: 'yes' },
      { scheduled_at: 'tomorrow' }, { scheduled_at: day }, { crew: 0 }, { crew: 1.5 }]) {
      expect([JSON.stringify(bad), (await create(a.owner, base(bad))).status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect(await prisma.booking.count({ where: { businessId: a.biz.id } })).toBe(0);
  });

  test('create: hours, closed day, past, overlap (back-to-back is fine) and crews, all enforced by the same engine as the AI', async () => {
    const hours = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, { open: '08:00', close: '18:00' }])) as unknown as typeof ALL_WEEK;
    const biz = await newBusiness({ hours });
    const owner = await login(biz.id);
    const status = async (o: Record<string, unknown>) => (await create(owner, base(o))).status;
    const sunday = futureDateKey(0, NY, 10);
    expect(await status({ scheduled_at: wall(sunday, '10:00') })).toBe(422);          // closed day
    expect(await status({ scheduled_at: wall(day, '07:00') })).toBe(422);              // before opening
    expect(await status({ scheduled_at: wall(day, '17:30') })).toBe(422);              // would run past closing
    expect(await status({ scheduled_at: '2020-01-06T10:00:00' })).toBe(422);           // past
    expect(await status({ scheduled_at: wall(day, '10:00'), duration_minutes: 120 })).toBe(201); // 10:00-12:00
    expect(await status({ scheduled_at: wall(day, '11:00') })).toBe(409);               // overlaps -> slot_taken
    expect(await status({ scheduled_at: wall(day, '09:30') })).toBe(409);               // 09:30-10:30 overlaps
    expect(await status({ scheduled_at: wall(day, '12:00') })).toBe(201);               // back to back
    expect(await status({ scheduled_at: wall(day, '09:00') })).toBe(201);               // ends exactly at 10:00
    // two crews: a second job at the same time takes crew 2, a third is refused; an explicit crew beyond the count is refused
    await prisma.business.update({ where: { id: biz.id }, data: { crews: 2 } });
    const second = await create(owner, base({ scheduled_at: wall(day, '10:00') }));
    expect(second.status).toBe(201);
    expect((await json<B>(second)).data!.booking.crew).toBe(2);
    expect(await status({ scheduled_at: wall(day, '10:30') })).toBe(409);
    expect(await status({ scheduled_at: wall(day, '15:00'), crew: 3 })).toBe(422);
    expect(await status({ scheduled_at: wall(day, '15:00'), crew: 2 })).toBe(201);
    expect(await status({ scheduled_at: wall(day, '15:00'), crew: 2 })).toBe(409);
    leaked();
  });

  test('create: parallel requests for one slot book exactly one', async () => {
    const { biz, owner } = await setup();
    const rs = await Promise.all(Array.from({ length: 6 }, () => create(owner, base({ scheduled_at: wall(day, '14:00') }))));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await prisma.booking.count({ where: { businessId: biz.id } })).toBe(1);
  });

  test('create with notify: quiet hours defer the text; awake hours send exactly one confirmation', async () => {
    const quiet = await newBusiness({ timezone: quietTimezone() });
    const qOwner = await login(quiet.id);
    const qDay = futureDateKey(2, quietTimezone(), 10);
    const q = await create(qOwner, base({ scheduled_at: wall(qDay, '10:00'), notify: true }));
    expect(q.status).toBe(201);
    expect((await json<B>(q)).data!.notice).toMatchObject({ status: 'blocked_quiet_hours', delivered: false });
    expect(await prisma.smsLog.count({ where: { businessId: quiet.id, kind: 'confirmation' } })).toBe(0);

    const awake = await newBusiness({ timezone: awakeTimezone() });
    const aOwner = await login(awake.id);
    const aDay = futureDateKey(2, awakeTimezone(), 10);
    const phoneNumber = phone();
    const a = await create(aOwner, base({ scheduled_at: wall(aDay, '10:00'), notify: true, customer_phone: phoneNumber }));
    expect(a.status).toBe(201);
    const d = (await json<B>(a)).data!;
    expect(d.notice?.delivered).toBe(true);
    const sms = await prisma.smsLog.findMany({ where: { businessId: awake.id } });
    expect(sms.map((s) => [s.kind, s.toPhone, s.bookingId])).toEqual([['confirmation', phoneNumber, d.booking.id]]);
    leaked();
  });

  test('new-booking slots: owner only, same availability, validated input', async () => {
    const { biz, owner, staff } = await setup();
    expect((await slotsRoute.GET(req(`/api/bookings/slots?date=${day}`, staff))).status).toBe(403);
    expect((await slotsRoute.GET(req(`/api/bookings/slots?date=${day}`, null))).status).toBe(401);
    expect((await slotsRoute.GET(req('/api/bookings/slots?date=nope', owner))).status).toBe(422);
    expect((await slotsRoute.GET(req(`/api/bookings/slots?date=${day}&duration=5`, owner))).status).toBe(422);
    const other = await newBusiness();
    expect([403, 404]).toContain((await slotsRoute.GET(req(`/api/bookings/slots?date=${day}&business_id=${other.id}`, owner))).status);
    await create(owner, base({ scheduled_at: wall(day, '10:00') }));
    const r = await slotsRoute.GET(req(`/api/bookings/slots?date=${day}&duration=60`, owner));
    const d = (await json<{ slots: { start: string; available: boolean }[]; timezone: string }>(r)).data!;
    expect(d.timezone).toBe(NY);
    expect(d.slots.find((s) => s.start === zonedTimeToUtc(day, '10:00', NY).toISOString())!.available).toBe(false);
    expect(d.slots.find((s) => s.start === zonedTimeToUtc(day, '11:00', NY).toISOString())!.available).toBe(true);
    expect(biz.id).toBeTruthy();
  });

  // ---------------------------------------------------------------- edit and no-show

  async function makeBooking(who: Who, o: Record<string, unknown> = {}) {
    const r = await create(who, base(o));
    expect(r.status).toBe(201);
    return (await json<B>(r)).data!.booking;
  }

  test('edit: plain fields, audited with the changed field names; a new number drops the follow-up consent; closed bookings and other tenants are refused', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    await prisma.booking.update({ where: { id: b.id }, data: { followupConsentAt: new Date(), followupConsentSource: 'confirmation_sms_notice' } });
    const patch = (who: Who, id: string, body: unknown) => oneRoute.PATCH(req(`/api/bookings/${id}`, who, body, 'PATCH'), ctx(id));
    const r = await patch(owner, b.id, { customer_name: 'Ana María Pérez', service: 'Heater repair', address: '2 Oak Ave', price_estimate: 20_000 });
    expect(r.status).toBe(200);
    const d = (await json<B & { changed: boolean; moved: boolean }>(r)).data!;
    expect(d).toMatchObject({ changed: true, moved: false });
    expect(d.booking).toMatchObject({ service: 'Heater repair', price_estimate: 20_000 });
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.edited', target: `booking:${b.id}` } });
    expect((audit!.meta as { fields: string[] }).fields.sort()).toEqual(['address', 'customer_name', 'price_estimate', 'service']);
    expect(events.filter((e) => e.kind === 'updated').length).toBe(1);
    // the same values again: nothing changes, no audit row
    const again = await patch(owner, b.id, { service: 'Heater repair' });
    expect((await json<{ changed: boolean }>(again)).data!.changed).toBe(false);
    expect(await prisma.auditEvent.count({ where: { action: 'booking.edited', target: `booking:${b.id}` } })).toBe(1);
    // a different number: consent no longer applies
    const np = phone();
    await patch(owner, b.id, { customer_phone: np });
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ customerPhone: np, followupConsentAt: null, followupConsentSource: null });
    // clearing the price and address
    await patch(owner, b.id, { price_estimate: null, address: null });
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ priceEstimate: null, address: null });
    // guards
    expect((await patch(staff, b.id, { service: 'x' })).status).toBe(403);
    expect([403, 404]).toContain((await patch(other.owner, b.id, { service: 'x' })).status);
    expect((await patch({ ...owner, site: 'cross-site' }, b.id, { service: 'x' })).status).toBe(403);
    expect((await patch(owner, b.id, {})).status).toBe(422);
    expect((await patch(owner, b.id, { service: '' })).status).toBe(422);
    expect((await patch(owner, b.id, { depositPaid: true })).status).toBe(422);
    expect((await patch(owner, b.id, { deposit_amount: 5 })).status).toBe(422);
    expect((await patch(owner, b.id, { status: 'cancelled', service: 'x' })).status).toBe(422); // a status change stands alone
    expect((await patch(owner, b.id, { service: 'x', reason: 'why' })).status).toBe(422);
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'completed' } });
    expect((await patch(owner, b.id, { service: 'Late edit' })).status).toBe(409);
    expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.service).toBe('Heater repair');
  });

  test('edit: a new time or length goes through the reschedule engine (overlap, hours) and the customer text is optional', async () => {
    const { biz, owner } = await setup();
    const a = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    const c = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
    const patch = (id: string, body: unknown) => oneRoute.PATCH(req(`/api/bookings/${id}`, owner, body, 'PATCH'), ctx(id));
    expect((await patch(a.id, { duration_minutes: 180 })).status).toBe(409); // 09:00-12:00 runs into the 11:00 job
    expect((await patch(a.id, { scheduled_at: wall(day, '20:00') })).status).toBe(422);
    expect((await patch(a.id, { scheduled_at: '2020-01-06T10:00:00' })).status).toBe(422);
    expect((await prisma.booking.findUnique({ where: { id: a.id } }))!.durationMinutes).toBe(60);
    const ok = await patch(a.id, { duration_minutes: 120, notify: false });
    expect(ok.status).toBe(200);
    expect((await json<{ moved: boolean; notice: { status: string } }>(ok)).data).toMatchObject({ moved: true, notice: { status: 'skipped' } });
    const moved = await patch(c.id, { scheduled_at: wall(day, '15:00'), notify: false });
    expect((await json<{ booking: { scheduled_at: string } }>(moved)).data!.booking.scheduled_at).toBe(zonedTimeToUtc(day, '15:00', NY).toISOString());
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.rescheduled' } })).toBe(2);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(0);
    expect(events.map((e) => e.kind)).toContain('rescheduled');
    leaked();
  });

  test('no-show: only after the start; closes the booking like a cancellation without texting the customer; a paid deposit is kept', async () => {
    const { biz, owner } = await setup();
    const future = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    const patch = (id: string, body: unknown) => oneRoute.PATCH(req(`/api/bookings/${id}`, owner, body, 'PATCH'), ctx(id));
    expect((await patch(future.id, { status: 'cancelled', reason: 'no_show', notify: false })).status).toBe(409);
    expect((await prisma.booking.findUnique({ where: { id: future.id } }))!.status).toBe('confirmed');
    const past = await prisma.booking.create({
      data: { businessId: biz.id, customerName: 'Walk In', customerPhone: phone(), service: 'AC repair', scheduledAt: new Date(Date.now() - 2 * 3_600_000), durationMinutes: 60, status: 'confirmed', depositAmount: 5000, depositPaid: true, depositSource: 'manual', depositMarkedAt: new Date() },
    });
    const r = await patch(past.id, { status: 'cancelled', reason: 'no_show', notify: false });
    expect(r.status).toBe(200);
    const d = (await json<B & { notice: { status: string } | null }>(r)).data!;
    expect(d.booking).toMatchObject({ status: 'cancelled', cancel_reason: 'no_show', deposit_paid: true });
    expect(d.notice).toMatchObject({ status: 'skipped', delivered: false });
    expect(await prisma.smsLog.count({ where: { bookingId: past.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.cancelled', target: `booking:${past.id}` } })).toBe(1);
    leaked();
  });

  // ---------------------------------------------------------------- deposit policy API

  test('deposit policy API: owner saves a validated, audited policy; staff read only; other tenants and CSRF refused; the whole policy is validated', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const put = (who: Who, id: string, body: unknown) => policyRoute.PUT(req(`/api/businesses/${id}/deposit-policy`, who, body, 'PUT'), ctx(id));
    const get = (who: Who, id: string) => policyRoute.GET(req(`/api/businesses/${id}/deposit-policy`, who), ctx(id));
    expect((await json<{ policy: { enabled: boolean }; limits: { max_cents: number; ai_cap_cents: number } }>(await get(staff, biz.id))).data).toMatchObject({ policy: { enabled: false }, limits: { max_cents: 100_000, ai_cap_cents: 50_000 } });
    const good = { enabled: true, mode: 'percent', fixed_cents: null, percent: 30, min_cents: 2000, max_cents: 20_000 };
    const r = await put(owner, biz.id, good);
    expect(r.status).toBe(200);
    expect((await json<{ policy: unknown }>(r)).data!.policy).toEqual(good);
    expect(await db.getDepositPolicy(biz.id)).toEqual(good);
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.deposit_policy_changed' } });
    expect(audit).toMatchObject({ actorUserId: owner.user.id });
    expect((await put(staff, biz.id, good)).status).toBe(403);
    expect([403, 404]).toContain((await put(other.owner, biz.id, good)).status);
    expect([403, 404]).toContain((await get(other.owner, biz.id)).status);
    expect((await put({ ...owner, site: 'cross-site' }, biz.id, good)).status).toBe(403);
    for (const bad of [null, [], 'x', { enabled: 'yes' }, { enabled: true, mode: 'weekly' }, { enabled: true, mode: 'percent', percent: 0 }, { enabled: true, mode: 'percent', percent: 101 }, { enabled: true, mode: 'percent', percent: 1.5 },
      { enabled: true, mode: 'fixed' }, { enabled: true, mode: 'fixed', fixed_cents: 99 }, { enabled: true, mode: 'fixed', fixed_cents: 100_001 }, { enabled: true, mode: 'fixed', fixed_cents: 5000, min_cents: 6000 },
      { enabled: true, mode: 'fixed', fixed_cents: 5000, min_cents: 9000, max_cents: 8000 }, { enabled: true, mode: 'percent', percent: 10, max_cents: 1e9 }]) {
      expect([JSON.stringify(bad), (await put(owner, biz.id, bad)).status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect(await db.getDepositPolicy(biz.id)).toEqual(good); // untouched by the refused ones
    expect([403, 404]).toContain((await put(owner, other.biz.id, good)).status);
  });

  // ---------------------------------------------------------------- deposit requests

  test('deposit request: policy-bound amount, stored on the booking, texted once, resend keeps it, a typed amount must fit the policy', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00'), price_estimate: 40_000 });
    const dep = (who: Who, id: string, body: unknown = {}) => depositRoute.POST(req(`/api/bookings/${id}/deposit`, who, body), ctx(id));
    type D = { amount_cents: number; source: string; resent: boolean; link: { url: string; mock: boolean }; sms: { status: string; delivered: boolean } | null };
    // no policy and no amount: the owner must type one
    expect((await dep(owner, b.id)).status).toBe(422);
    // out-of-range / bad amounts
    for (const bad of [99, 100_001, 12.5, '5000', -1, null]) {
      const r = await dep(owner, b.id, { amount_cents: bad });
      expect([String(bad), r.status]).toEqual([String(bad), bad === null ? 422 : 422]);
    }
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'payment_link' } })).toBe(0);
    // an explicit amount without a policy: allowed within the platform limits
    const first = await dep(owner, b.id, { amount_cents: 6000 });
    expect(first.status).toBe(200);
    const f = (await json<D>(first)).data!;
    expect(f).toMatchObject({ amount_cents: 6000, source: 'owner', resent: false, sms: { delivered: true } });
    expect(f.link.url).toContain('/pay/'); // the demo link outside production
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ depositAmount: 6000, depositPaid: false });
    // a resend keeps the amount agreed
    const re = await json<D>(await dep(owner, b.id));
    expect(re.data).toMatchObject({ amount_cents: 6000, source: 'stored', resent: true });
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'payment_link', bookingId: b.id } })).toBe(2);
    // a policy: 25% of $400 = $100, clamped to [$20, $60]; an explicit amount must lie inside the range
    await db.setDepositPolicy(biz.id, { enabled: true, mode: 'percent', percent: 25, min_cents: 2000, max_cents: 6000 });
    const c = await makeBooking(owner, { scheduled_at: wall(day, '12:00'), price_estimate: 40_000 });
    expect((await json<D>(await dep(owner, c.id))).data).toMatchObject({ amount_cents: 6000, source: 'policy' });
    const c2 = await makeBooking(owner, { scheduled_at: wall(day, '14:00'), price_estimate: 10_000 });
    expect((await json<D>(await dep(owner, c2.id, { amount_cents: 2500, send: false }))).data).toMatchObject({ amount_cents: 2500, source: 'owner', sms: null });
    expect((await dep(owner, c2.id, { amount_cents: 1999 })).status).toBe(422);
    expect((await dep(owner, c2.id, { amount_cents: 6001 })).status).toBe(422);
    // percent without an estimate: nothing to compute, the owner types one
    const noEstimate = await makeBooking(owner, { scheduled_at: wall(day, '16:00') });
    expect((await dep(owner, noEstimate.id)).status).toBe(422);
    // guards
    expect((await dep(staff, c.id)).status).toBe(403);
    expect([403, 404]).toContain((await dep(other.owner, c.id)).status);
    expect((await dep({ ...owner, site: 'cross-site' }, c.id)).status).toBe(403);
    expect((await dep(owner, c.id, { send: 'yes' })).status).toBe(422);
    expect((await dep(owner, c.id, { to: '+19995550123' })).status).toBe(422); // the recipient is never caller-supplied
    expect((await dep(owner, 'no-such-booking')).status).toBe(404);
    // the texts only ever went to the booking's own number
    const tos = (await prisma.smsLog.findMany({ where: { businessId: biz.id, kind: 'payment_link', bookingId: b.id } })).map((s) => s.toPhone);
    expect(new Set(tos)).toEqual(new Set([b.customer_phone]));
    leaked();
  });

  test('deposit request: refused for a cancelled booking or a paid deposit, for a booking without a number (send), and fails closed in production without Stripe', async () => {
    const { biz, owner } = await setup();
    const dep = (id: string, body: unknown = { amount_cents: 5000 }) => depositRoute.POST(req(`/api/bookings/${id}/deposit`, owner, body), ctx(id));
    const walkIn = await makeBooking(owner, { customer_phone: '', scheduled_at: wall(day, '09:00') });
    expect((await dep(walkIn.id)).status).toBe(422);                                  // cannot text
    const noText = await dep(walkIn.id, { amount_cents: 5000, send: false });
    expect(noText.status).toBe(200);                                                  // but the link can be made and copied
    const cancelled = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
    await prisma.booking.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });
    expect((await dep(cancelled.id)).status).toBe(409);
    const paid = await makeBooking(owner, { scheduled_at: wall(day, '13:00') });
    await prisma.booking.update({ where: { id: paid.id }, data: { depositAmount: 5000, depositPaid: true, depositSource: 'stripe' } });
    expect((await dep(paid.id)).status).toBe(409);
    expect((await prisma.booking.findUnique({ where: { id: paid.id } }))!.depositAmount).toBe(5000);
    const live = await makeBooking(owner, { scheduled_at: wall(day, '15:00') });
    const before = await prisma.smsLog.count({ where: { businessId: biz.id } });
    await withEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: undefined }, async () => {
      const r = await dep(live.id);
      expect(r.status).toBe(503);
      expect((await json(r)).error).toBe('payments_not_configured');
    });
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(before);
    expect((await prisma.booking.findUnique({ where: { id: live.id } }))!.depositAmount).toBeNull();
    leaked();
  });

  test('payments/create-link and the AI path are policy-bound too', async () => {
    const { biz, owner } = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00'), price_estimate: 20_000 });
    await db.setDepositPolicy(biz.id, { enabled: true, mode: 'fixed', fixed_cents: 5000, min_cents: 3000, max_cents: 8000 });
    const link = (body: unknown) => createLinkRoute.POST(req('/api/payments/create-link', owner, body));
    expect((await link({ business_id: biz.id, booking_id: b.id, amount_cents: 9000 })).status).toBe(422);
    expect((await link({ business_id: biz.id, booking_id: b.id, amount_cents: 2000 })).status).toBe(422);
    const r = await link({ business_id: biz.id, booking_id: b.id });
    expect(r.status).toBe(200);
    expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.depositAmount).toBe(5000);
    const tools = await import('@/lib/voice/tools');
    const call = await db.createCall({ business_id: biz.id, caller_phone: b.customer_phone });
    await prisma.booking.update({ where: { id: b.id }, data: { callId: call.id } });
    // the model's amount is ignored; the policy's is used; another call's booking is not touched
    const viaAi = await tools.createPaymentLink({ business_id: biz.id, call_id: call.id, booking_id: b.id, amount_cents: 99_999 });
    expect(viaAi.ok).toBe(true);
    expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.depositAmount).toBe(5000);
    const stranger = await makeBooking(owner, { scheduled_at: wall(day, '12:00') });
    const call2 = await db.createCall({ business_id: biz.id, caller_phone: phone() });
    await tools.createPaymentLink({ business_id: biz.id, call_id: call2.id, booking_id: stranger.id, amount_cents: 7000 });
    expect((await prisma.booking.findUnique({ where: { id: stranger.id } }))!.depositAmount).toBeNull();
    await db.setDepositPolicy(biz.id, { enabled: false });
    const off = await tools.createPaymentLink({ business_id: biz.id, call_id: call.id, booking_id: b.id });
    expect(off.ok).toBe(false);
    leaked();
  });

  // ---------------------------------------------------------------- manual deposits

  test('mark paid manually: owner + step-up, audited with who, stored as manual, confirms a pending booking, idempotent, never over a Stripe payment', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'pending' } });
    const mark = (who: Who, id: string, body: unknown = { amount_cents: 5000 }) => markRoute.POST(req(`/api/bookings/${id}/deposit/mark-paid`, who, body), ctx(id));
    // step-up: a stale session is asked to re-enter its password and nothing changes
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 3_600_000) } });
    const denied = await mark(owner, b.id);
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe('reauth_required');
    expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.depositPaid).toBe(false);
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
    // guards
    expect((await mark(staff, b.id)).status).toBe(403);
    expect([403, 404]).toContain((await mark(other.owner, b.id)).status);
    expect((await mark({ ...owner, site: 'cross-site' }, b.id)).status).toBe(403);
    for (const bad of [0, 99, -5, 1.5, '5000', null, 1e12]) expect([String(bad), (await mark(owner, b.id, { amount_cents: bad })).status]).toEqual([String(bad), 422]);
    expect((await mark(owner, b.id, { amount_cents: 5000, extra: 1 })).status).toBe(422);
    expect((await mark(owner, b.id, {})).status).toBe(422); // no amount and none requested yet
    const r = await mark(owner, b.id);
    expect(r.status).toBe(200);
    expect((await json<{ changed: boolean }>(r)).data!.changed).toBe(true);
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ depositPaid: true, depositAmount: 5000, depositSource: 'manual', depositMarkedBy: owner.user.id, status: 'confirmed' });
    expect(await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.deposit_marked_manual', target: `booking:${b.id}` } })).toMatchObject({ actorUserId: owner.user.id });
    expect(events.some((e) => e.bookingId === b.id && e.kind === 'updated')).toBe(true);
    expect((await json<{ changed: boolean }>(await mark(owner, b.id))).data!.changed).toBe(false); // same mark again
    expect((await mark(owner, b.id, { amount_cents: 7000 })).status).toBe(409);                      // a different amount over a paid deposit
    // a deposit paid through Stripe is never overridden
    const card = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
    await prisma.booking.update({ where: { id: card.id }, data: { depositAmount: 5000, depositPaid: true, depositSource: 'stripe', stripePaymentIntentId: 'pi_x1' } });
    expect((await mark(owner, card.id)).status).toBe(409);
    expect(await prisma.booking.findUnique({ where: { id: card.id } })).toMatchObject({ depositSource: 'stripe' });
    // a cancelled booking cannot be marked
    const gone = await makeBooking(owner, { scheduled_at: wall(day, '13:00') });
    await prisma.booking.update({ where: { id: gone.id }, data: { status: 'cancelled' } });
    expect((await mark(owner, gone.id)).status).toBe(409);
    leaked();
  });

  test('a manual deposit never reaches Stripe: the Stripe refund is refused (no outbound call), the manual refund is recorded without a text', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    const mark = (id: string, body: unknown) => markRoute.POST(req(`/api/bookings/${id}/deposit/mark-paid`, owner, body), ctx(id));
    expect((await mark(b.id, { amount_cents: 6000 })).status).toBe(200);
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date(), stripePaymentIntentId: 'pi_should_not_be_used' } });
    const before = outboundCalls.length;
    await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
      const r = await refundRoute.POST(req(`/api/bookings/${b.id}/refund`, owner, { override: true }), ctx(b.id));
      expect(r.status).toBe(409);
      expect((await json(r)).code).toBe('manual_deposit');
    });
    expect(outboundCalls.length).toBe(before);                       // Stripe was never called
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ refundStatus: 'none', depositPaid: true });
    // the manual refund
    const rec = (who: Who, id: string, body: unknown = {}) => manualRefundRoute.POST(req(`/api/bookings/${id}/refund/manual`, who, body), ctx(id));
    expect((await rec(staff, b.id)).status).toBe(403);
    expect([403, 404]).toContain((await rec(other.owner, b.id)).status);
    expect((await rec({ ...owner, site: 'cross-site' }, b.id)).status).toBe(403);
    for (const bad of [0, -1, 6001, 1.5, '100', null]) expect([String(bad), (await rec(owner, b.id, { amount_cents: bad })).status]).toEqual([String(bad), 422]);
    expect((await rec(owner, b.id, { override: true })).status).toBe(422);
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 3_600_000) } });
    expect((await rec(owner, b.id)).status).toBe(403); // step-up
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
    const smsBefore = await prisma.smsLog.count({ where: { businessId: biz.id } });
    const done = await rec(owner, b.id, { amount_cents: 4000 });
    expect(done.status).toBe(200);
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ refundStatus: 'refunded', refundAmountCents: 4000, stripeRefundId: null });
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_recorded_manual', target: `booking:${b.id}` } })).toBe(1);
    expect(await prisma.smsLog.count({ where: { businessId: biz.id } })).toBe(smsBefore); // no customer text
    expect((await json<{ replayed: boolean }>(await rec(owner, b.id, { amount_cents: 4000 }))).data!.replayed).toBe(true);
    expect((await rec(owner, b.id, { amount_cents: 5000 })).status).toBe(409);
    // a refunded manual deposit cannot be unmarked
    const unmark = (id: string) => unmarkRoute.POST(req(`/api/bookings/${id}/deposit/unmark`, owner, {}), ctx(id));
    expect((await unmark(b.id)).status).toBe(409);
    // a card deposit cannot be "manually refunded"
    const card = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
    await prisma.booking.update({ where: { id: card.id }, data: { depositAmount: 5000, depositPaid: true, depositSource: 'stripe' } });
    expect((await rec(owner, card.id)).status).toBe(409);
    leaked();
  });

  test('unmark: undoes only a manual mark, with step-up, audited', async () => {
    const { biz, owner, staff } = await setup(); const other = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    const unmark = (who: Who, id: string) => unmarkRoute.POST(req(`/api/bookings/${id}/deposit/unmark`, who, {}), ctx(id));
    expect((await unmark(owner, b.id)).status).toBe(409); // nothing marked
    await markRoute.POST(req(`/api/bookings/${b.id}/deposit/mark-paid`, owner, { amount_cents: 5000 }), ctx(b.id));
    expect((await unmark(staff, b.id)).status).toBe(403);
    expect([403, 404]).toContain((await unmark(other.owner, b.id)).status);
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 3_600_000) } });
    expect((await unmark(owner, b.id)).status).toBe(403);
    await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
    expect((await unmark(owner, b.id)).status).toBe(200);
    expect(await prisma.booking.findUnique({ where: { id: b.id } })).toMatchObject({ depositPaid: false, depositSource: null, depositMarkedBy: null, depositAmount: 5000 });
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.deposit_unmarked_manual', target: `booking:${b.id}` } })).toBe(1);
    const card = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
    await prisma.booking.update({ where: { id: card.id }, data: { depositAmount: 5000, depositPaid: true, depositSource: 'stripe' } });
    expect((await unmark(owner, card.id)).status).toBe(409);
    leaked();
  });

  test('a manual mark deactivates the booking\'s open Stripe link (only that one) so the customer cannot also pay by card', async () => {
    const { owner } = await setup();
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    await prisma.booking.update({ where: { id: b.id }, data: { stripePaymentLinkId: 'plink_manual1234', depositAmount: 5000 } });
    const calls: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.startsWith('https://api.stripe.com/v1/payment_links/plink_manual1234')) { calls.push(`${url} ${String(init?.body)}`); return new Response('{"id":"plink_manual1234","active":false}', { status: 200 }); }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, async () => {
        expect((await markRoute.POST(req(`/api/bookings/${b.id}/deposit/mark-paid`, owner, {}), ctx(b.id))).status).toBe(200);
        // the deactivation is durable and runs in the background (review 21 H1): wait for it
        await (await import('@/lib/payments/link-store')).flushLinkDeactivations();
      });
    } finally { globalThis.fetch = saved; }
    expect(calls).toEqual(['https://api.stripe.com/v1/payment_links/plink_manual1234 active=false']);
  });

  // ---------------------------------------------------------------- public /pay page

  test('/pay/<bookingId>: production never renders a card form: live Stripe link -> redirect to Stripe, paid -> receipt, anything else -> "not available"', async () => {
    const { biz, owner } = await setup();
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { resetLinkLookupCache } = await import('@/lib/payments/link-lookup');
    const Page = (await import('@/app/pay/[id]/page')).default as (p: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
    const render = async (id: string, q: Record<string, string> = {}) => renderToStaticMarkup(await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(q) }));
    const digestOf = async (id: string) => { try { await render(id); return 'rendered'; } catch (e) { return String((e as { digest?: string }).digest ?? e); } };
    const b = await makeBooking(owner, { scheduled_at: wall(day, '09:00') });
    await prisma.booking.update({ where: { id: b.id }, data: { depositAmount: 5000, stripePaymentLinkId: 'plink_paytest123' } });
    const saved = globalThis.fetch;
    let active = true;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push(url);
      if (url === 'https://api.stripe.com/v1/payment_links/plink_paytest123') return new Response(JSON.stringify({ id: 'plink_paytest123', active, url: 'https://buy.stripe.com/test_paytest' }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await withEnv({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_x', DEMO_MODE: 'true' }, async () => {
        resetLinkLookupCache();
        // live link: redirected to Stripe's own page (DEMO_MODE is ignored in production)
        const redirected = await digestOf(b.id);
        expect(redirected).toContain('NEXT_REDIRECT');
        expect(redirected).toContain('https://buy.stripe.com/test_paytest');
        // the link was deactivated (replaced / cancelled / used): honest page, no form
        active = false; resetLinkLookupCache();
        const html = await render(b.id);
        expect(html).toContain('not available');
        expect(html).not.toMatch(/<input|Demo checkout|Card number/i);
        expect(html).toContain(biz.name);
        // no stored link at all
        await prisma.booking.update({ where: { id: b.id }, data: { stripePaymentLinkId: null } });
        expect(await render(b.id)).toContain('not available');
        // a cancelled booking never forwards, even to a live link
        active = true; resetLinkLookupCache();
        await prisma.booking.update({ where: { id: b.id }, data: { stripePaymentLinkId: 'plink_paytest123', status: 'cancelled' } });
        expect(await render(b.id)).toContain('not available');
        // a booking with no deposit due and unknown ids are 404s; mock ids never work in production
        const noDeposit = await makeBooking(owner, { scheduled_at: wall(day, '11:00') });
        expect(await digestOf(noDeposit.id)).toContain('404');
        expect(await digestOf('00000000-0000-4000-8000-000000000000')).toContain('404');
        expect(await digestOf('mock_abc123456789')).toContain('404');
        // paid: the receipt, with no card digits and no claim of a text
        await prisma.booking.update({ where: { id: b.id }, data: { status: 'confirmed', depositPaid: true, depositSource: 'stripe' } });
        const receipt = await render(b.id);
        expect(receipt).toContain('Payment received');
        expect(receipt).toContain('$50.00');
        expect(receipt).not.toMatch(/texted|tech\b|----/i);
      });
      // outside production without DEMO_MODE there is still no card form
      await withEnv({ NODE_ENV: 'test', DEMO_MODE: undefined, STRIPE_SECRET_KEY: undefined }, async () => {
        await prisma.booking.update({ where: { id: b.id }, data: { depositPaid: false, depositSource: null } });
        expect(await render(b.id)).toContain('not available');
      });
      expect(calls.every((u) => u === 'https://api.stripe.com/v1/payment_links/plink_paytest123')).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(4); // looked up at most once per (cached) state, never per render
    } finally { globalThis.fetch = saved; resetLinkLookupCache(); }
  });
});
