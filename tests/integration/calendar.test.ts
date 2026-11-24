/**
 * Calendar data + owner actions: listBookingsInRange (overlap, pagination, tenant scope, DST), GET/PATCH /api/bookings,
 * resend-confirmation, role + tenant isolation + CSRF, the call-mode owner API roles, and the bounded/paginated list helpers.
 */
import { integration, SECRETS } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, uniq } from '../helpers/fixtures';
import { dayRange, zonedTimeToUtc, addDaysToDateKey, localDateKey } from '../../src/lib/time';

integration('calendar and booking actions (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  type Ctx = { params: Promise<{ id: string }> };
  let listRoute: { GET: (req: Request) => Promise<Response> };
  let oneRoute: { GET: (req: Request, c: Ctx) => Promise<Response>; PATCH: (req: Request, c: Ctx) => Promise<Response> };
  let resend: (req: Request, c: Ctx) => Promise<Response>;
  let modeRoute: { GET: (req: Request, c: Ctx) => Promise<Response>; PATCH: (req: Request, c: Ctx) => Promise<Response> };
  let callsRoute: { GET: (req: Request) => Promise<Response> };
  let briefingsRoute: { GET: (req: Request) => Promise<Response> };
  const userIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    listRoute = await import('@/app/api/bookings/route');
    oneRoute = await import('@/app/api/bookings/[id]/route');
    resend = (await import('@/app/api/bookings/[id]/resend-confirmation/route')).POST;
    modeRoute = await import('@/app/api/businesses/[id]/call-mode/route');
    callsRoute = await import('@/app/api/calls/route');
    briefingsRoute = await import('@/app/api/briefings/route');
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  async function login(businessId: string, role: 'owner' | 'staff') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, user };
  }
  type Who = { cookie?: string; bearer?: boolean; site?: string } | null;
  const req = (path: string, who: Who, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': who?.site ?? 'same-origin', origin: who?.site === 'cross-site' ? 'https://evil.example' : 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie } : {}),
        ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const json = async <T = unknown>(r: Response) => (await r.json()) as { ok: boolean; data?: T; error?: string };

  async function booking(businessId: string, start: Date, o: { minutes?: number; status?: string; name?: string; phoneNumber?: string; callId?: string | null; deposit?: boolean } = {}) {
    return prisma.booking.create({
      data: {
        businessId, customerName: o.name ?? 'Ana Pérez', customerPhone: o.phoneNumber ?? phone(), phoneE164: o.phoneNumber ?? undefined, service: 'AC repair',
        scheduledAt: start, durationMinutes: o.minutes ?? 60, status: o.status ?? 'confirmed', callId: o.callId ?? null,
        ...(o.deposit ? { depositAmount: 5000, depositPaid: true } : {}),
      },
    });
  }
  const NY = 'America/New_York';
  const at = (key: string, hhmm: string, tz = NY) => zonedTimeToUtc(key, hhmm, tz);

  // ------------------------------------------------------------------ listBookingsInRange
  test('listBookingsInRange: half-open range, includes a job that started earlier and runs into it, scoped to one business', async () => {
    const a = await newBusiness();
    const other = await newBusiness();
    const day = '2027-02-09'; // a Tuesday
    const { gte, lt } = dayRange(day, NY);
    const before = await booking(a.id, at('2027-02-08', '09:00'));                                  // the day before: out
    const spill = await booking(a.id, at('2027-02-08', '23:30'), { minutes: 120 });                  // 23:30-01:30: in (runs into the day)
    const early = await booking(a.id, at(day, '08:00'));
    const lastMinute = await booking(a.id, new Date(lt.getTime() - 15 * 60_000), { minutes: 15 });   // 23:45-24:00, in
    const next = await booking(a.id, lt);                                                           // exactly at `to`: out
    const cancelled = await booking(a.id, at(day, '12:00'), { status: 'cancelled' });
    await booking(other.id, at(day, '09:00'));                                                      // another tenant: never returned

    const page = await db.listBookingsInRange(a.id, gte, lt);
    const ids = page.items.map((b) => b.id);
    expect(ids).toEqual([spill.id, early.id, cancelled.id, lastMinute.id]);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(next.id);
    expect(page.next_cursor).toBeNull();
    expect(page.items.every((b) => b.business_id === a.id)).toBe(true);
    // statuses filter + string bounds + bad bounds
    expect((await db.listBookingsInRange(a.id, gte.toISOString(), lt.toISOString(), { statuses: ['cancelled'] })).items.map((b) => b.id)).toEqual([cancelled.id]);
    expect((await db.listBookingsInRange(a.id, lt, gte)).items).toEqual([]);
    expect((await db.listBookingsInRange(a.id, 'junk', lt)).items).toEqual([]);
  });

  test('listBookingsInRange pages with a keyset cursor: no gaps, no repeats, equal start times stay stable', async () => {
    const biz = await newBusiness();
    const start = at('2027-02-10', '08:00');
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(await booking(biz.id, new Date(start.getTime() + Math.floor(i / 2) * 3_600_000 * 2), { status: i % 2 ? 'cancelled' : 'confirmed' })); // pairs share a start (a cancelled one may overlap)
    const { gte, lt } = dayRange('2027-02-10', NY);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Awaited<ReturnType<typeof db.listBookingsInRange>> = await db.listBookingsInRange(biz.id, gte, lt, { limit: 3, cursor });
      seen.push(...p.items.map((b) => b.id));
      cursor = p.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(7);
    const all = await db.listAllBookingsInRange(biz.id, gte, lt);
    expect(all.items.length).toBe(7);
    expect(all.truncated).toBe(false);
    expect((await db.listAllBookingsInRange(biz.id, gte, lt, 5)).truncated).toBe(true);
    // a garbage cursor is ignored (first page), never an error
    expect((await db.listBookingsInRange(biz.id, gte, lt, { limit: 3, cursor: 'not-a-cursor' })).items.length).toBe(3);
  });

  test('DST: the Sunday-first week containing the spring-forward day returns every job of its seven local days', async () => {
    const biz = await newBusiness({ timezone: NY });
    const { rangeFor } = await import('../../src/lib/calendar');
    const range = rangeFor('week', '2027-03-14', NY, 0); // US 2027 spring forward is Sunday March 14
    const ids = [];
    for (const [key, hhmm] of [['2027-03-14', '00:30'], ['2027-03-14', '03:30'], ['2027-03-14', '23:30'], ['2027-03-20', '23:00']] as const) ids.push((await booking(biz.id, at(key, hhmm))).id);
    await booking(biz.id, at('2027-03-13', '23:00')); // Saturday before: out
    await booking(biz.id, at('2027-03-21', '00:00')); // next Sunday: out
    const r = await db.listBookingsInRange(biz.id, range.from, range.to);
    expect(r.items.map((b) => b.id)).toEqual(ids);
  });

  test('agenda pages: upcoming soonest-first (a running job still counts), past newest-first', async () => {
    const biz = await newBusiness();
    const now = new Date('2027-03-01T15:00:00Z');
    const running = await booking(biz.id, new Date(now.getTime() - 30 * 60_000), { minutes: 60 });
    const ended = await booking(biz.id, new Date(now.getTime() - 3 * 3_600_000));
    const later = await booking(biz.id, new Date(now.getTime() + 2 * 3_600_000));
    const much = await booking(biz.id, new Date(now.getTime() + 30 * 3_600_000));
    const muchLater = await booking(biz.id, new Date(now.getTime() + 50 * 3_600_000));
    // the running job leads the first page (on top of `limit` future ones); the cursor then walks the future jobs only
    const up = await db.listBookingsPage(biz.id, { direction: 'upcoming', now, limit: 2 });
    expect(up.items.map((b) => b.id)).toEqual([running.id, later.id, much.id]);
    expect(up.next_cursor).not.toBeNull();
    expect((await db.listBookingsPage(biz.id, { direction: 'upcoming', now, limit: 2, cursor: up.next_cursor })).items.map((b) => b.id)).toEqual([muchLater.id]);
    const past = await db.listBookingsPage(biz.id, { direction: 'past', now: new Date(now.getTime() + 3_600_000), limit: 10 });
    expect(past.items.map((b) => b.id)).toEqual([running.id, ended.id]);
  });

  // ------------------------------------------------------------------ GET /api/bookings
  test('GET /api/bookings: staff may read; tenants are isolated; validation; the zone decides the range', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const staff = await login(a.id, 'staff');
    const ownerB = await login(b.id, 'owner');
    const day = '2027-04-06';
    const mine = await booking(a.id, at(day, '09:00'));
    const theirs = await booking(b.id, at(day, '09:00'));

    const get = async (who: Who, q: string) => listRoute.GET(req(`/api/bookings?${q}`, who));
    const res = await get(staff, `view=day&date=${day}`);
    expect(res.status).toBe(200);
    const body = await json<{ items: { id: string }[]; timezone: string; days: string[]; week_start: number }>(res);
    expect(body.data!.items.map((x) => x.id)).toEqual([mine.id]);
    expect(body.data).toMatchObject({ timezone: NY, days: [day], week_start: 0 }); // en-US business: Sunday first
    // another tenant's id in the query is a 404, and its owner sees only their own
    expect((await get(staff, `view=day&date=${day}&business_id=${b.id}`)).status).toBe(404);
    expect((await json<{ items: { id: string }[] }>(await get(ownerB, `view=day&date=${day}`))).data!.items.map((x) => x.id)).toEqual([theirs.id]);
    // admin must name a business
    expect((await get({ bearer: true }, `view=day&date=${day}`)).status).toBe(422);
    expect((await json<{ items: unknown[] }>(await get({ bearer: true }, `view=day&date=${day}&business_id=${a.id}`))).data!.items.length).toBe(1);
    // validation
    expect((await get(staff, 'view=year')).status).toBe(422);
    expect((await get(staff, 'view=day&date=2027-13-45')).status).toBe(422);
    expect((await get(staff, 'agenda=sideways')).status).toBe(422);
    expect((await listRoute.GET(req('/api/bookings?view=day', null))).status).toBe(401);
    // Monday-first override and the week range
    const wk = await json<{ days: string[] }>(await get(staff, `view=week&date=${day}&ws=1`));
    expect(wk.data!.days[0]).toBe('2027-04-05');
    // agenda
    const ag = await json<{ items: unknown[]; next_cursor: string | null }>(await get(staff, 'agenda=past&limit=5'));
    expect(Array.isArray(ag.data!.items)).toBe(true);
  });

  test('GET /api/bookings/:id returns the booking and its call notes; another tenant gets 404', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const staff = await login(a.id, 'staff');
    const call = await db.createCall({ business_id: a.id, caller_phone: phone(), summary: 'Unit leaking at the air handler', flagged_reason: 'needs a callback' });
    const bk = await booking(a.id, at('2027-04-06', '10:00'), { callId: call.id });
    const res = await oneRoute.GET(req(`/api/bookings/${bk.id}`, staff), ctx(bk.id));
    expect(res.status).toBe(200);
    expect((await json<{ booking: { id: string }; call: { summary: string } }>(res)).data).toMatchObject({ booking: { id: bk.id }, call: { summary: 'Unit leaking at the air handler' } });
    const ownerB = await login(b.id, 'owner');
    expect((await oneRoute.GET(req(`/api/bookings/${bk.id}`, ownerB), ctx(bk.id))).status).toBe(404);
    expect((await oneRoute.GET(req(`/api/bookings/${uniq('x')}`, staff), ctx('nope'))).status).toBe(404);
  });

  // ------------------------------------------------------------------ PATCH /api/bookings/:id
  test('PATCH: owner cancels (slot freed, audited); staff 403; other tenant 404; cross-site and anonymous refused; idempotent; completed cannot be cancelled', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const owner = await login(a.id, 'owner');
    const staff = await login(a.id, 'staff');
    const ownerB = await login(b.id, 'owner');
    const bk = await booking(a.id, new Date(Date.now() + 3 * 86_400_000), { deposit: true });
    const patch = (id: string, who: Who, body: unknown) => oneRoute.PATCH(req(`/api/bookings/${id}`, who, body, 'PATCH'), ctx(id));
    const status = async (id: string) => (await prisma.booking.findUnique({ where: { id } }))?.status;

    expect((await patch(bk.id, staff, { status: 'cancelled' })).status).toBe(403);
    expect((await patch(bk.id, ownerB, { status: 'cancelled' })).status).toBe(404);
    expect((await patch(bk.id, { ...owner, site: 'cross-site' }, { status: 'cancelled' })).status).toBe(403);
    expect((await patch(bk.id, null, { status: 'cancelled' })).status).toBe(401);
    expect(await status(bk.id)).toBe('confirmed');
    for (const bad of [{ status: 'pending' }, { status: 'weird' }, {}, { status: 'cancelled', price_estimate: 1 }, []]) {
      expect((await patch(bk.id, owner, bad)).status).toBe(422);
    }

    const res = await patch(bk.id, owner, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect((await json<{ changed: boolean; deposit_refund_needed: boolean; booking: { status: string } }>(res)).data).toMatchObject({ changed: true, deposit_refund_needed: true, booking: { status: 'cancelled' } });
    expect(await status(bk.id)).toBe('cancelled');
    const audits = await prisma.auditEvent.findMany({ where: { businessId: a.id, action: 'booking.cancelled', target: `booking:${bk.id}` } });
    expect(audits.length).toBe(1);
    expect(audits[0].actorUserId).toBe(owner.user.id);
    // the slot is free again: a new booking at the same time is accepted
    await expect(db.createBooking({ business_id: a.id, customer_name: 'Luis', customer_phone: phone(), service: 'x', scheduled_at: bk.scheduledAt.toISOString() }, { enforce: false })).resolves.toBeTruthy();
    // repeating is a 200 no-op without a second audit row
    const again = await patch(bk.id, owner, { status: 'cancelled' });
    expect((await json<{ changed: boolean }>(again)).data!.changed).toBe(false);
    expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'booking.cancelled', target: `booking:${bk.id}` } })).toBe(1);
    // a cancelled booking cannot be completed
    expect((await patch(bk.id, owner, { status: 'completed' })).status).toBe(409);
    // admin token can act on any business
    const other = await booking(b.id, new Date(Date.now() + 3 * 86_400_000));
    expect((await patch(other.id, { bearer: true }, { status: 'cancelled' })).status).toBe(200);
  });

  test('PATCH complete: only after the job started, only from pending/confirmed; a completed job cannot be cancelled; audited', async () => {
    const a = await newBusiness();
    const owner = await login(a.id, 'owner');
    const patch = (id: string, body: unknown) => oneRoute.PATCH(req(`/api/bookings/${id}`, owner, body, 'PATCH'), ctx(id));
    const future = await booking(a.id, new Date(Date.now() + 2 * 86_400_000));
    expect((await patch(future.id, { status: 'completed' })).status).toBe(409);
    const past = await booking(a.id, new Date(Date.now() - 3 * 3_600_000), { status: 'pending' });
    const done = await patch(past.id, { status: 'completed' });
    expect(done.status).toBe(200);
    expect((await prisma.booking.findUnique({ where: { id: past.id } }))?.status).toBe('completed');
    expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'booking.completed', target: `booking:${past.id}` } })).toBe(1);
    expect((await patch(past.id, { status: 'cancelled' })).status).toBe(409);
    expect((await json<{ changed: boolean }>(await patch(past.id, { status: 'completed' }))).data!.changed).toBe(false);
  });

  test('two concurrent cancel/complete clicks cannot both win', async () => {
    const a = await newBusiness();
    const bk = await booking(a.id, new Date(Date.now() - 3 * 3_600_000));
    const [x, y] = await Promise.all([db.transitionBooking(a.id, bk.id, 'cancelled'), db.transitionBooking(a.id, bk.id, 'completed')]);
    const wins = [x, y].filter((r) => r.ok && r.changed).length;
    expect(wins).toBe(1);
    expect([x, y].some((r) => !r.ok && r.reason === 'invalid_transition') || [x, y].every((r) => r.ok)).toBe(true);
    expect((await db.transitionBooking(a.id, uniq('missing'), 'cancelled'))).toMatchObject({ ok: false, reason: 'not_found' });
    const other = await newBusiness();
    expect(await db.transitionBooking(other.id, bk.id, 'cancelled')).toMatchObject({ ok: false, reason: 'not_found' }); // wrong tenant
  });

  // ------------------------------------------------------------------ resend confirmation
  test('resend confirmation: owner only; goes through the one outbound path (opt-out honoured, deduped), audited; cancelled refused', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const owner = await login(a.id, 'owner');
    const staff = await login(a.id, 'staff');
    const ownerB = await login(b.id, 'owner');
    const number = phone();
    const bk = await booking(a.id, new Date(Date.now() + 2 * 86_400_000), { phoneNumber: number });
    const post = (id: string, who: Who) => resend(req(`/api/bookings/${id}/resend-confirmation`, who, {}), ctx(id));

    expect((await post(bk.id, staff)).status).toBe(403);
    expect((await post(bk.id, ownerB)).status).toBe(404);
    expect((await post(bk.id, null)).status).toBe(401);
    expect((await post(bk.id, { ...owner, site: 'cross-site' })).status).toBe(403);
    expect(await prisma.smsLog.count({ where: { businessId: a.id, kind: 'confirmation' } })).toBe(0);

    const first = await json<{ status: string; deduped: boolean }>(await post(bk.id, owner));
    expect(first.data).toMatchObject({ status: 'mock', deduped: false });
    expect(await prisma.smsLog.count({ where: { businessId: a.id, kind: 'confirmation', bookingId: bk.id } })).toBe(1);
    const second = await json<{ deduped: boolean }>(await post(bk.id, owner));
    expect(second.data!.deduped).toBe(true);
    expect(await prisma.smsLog.count({ where: { businessId: a.id, kind: 'confirmation', bookingId: bk.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'booking.confirmation_resent', target: `booking:${bk.id}` } })).toBe(2);

    // opted-out customer: the text is blocked and the response says so
    const stop = await booking(a.id, new Date(Date.now() + 4 * 86_400_000), { phoneNumber: phone() });
    await db.recordOptOut(a.id, stop.customerPhone, 'test');
    const blocked = await json<{ status: string }>(await post(stop.id, owner));
    expect(blocked.data!.status).toBe('blocked_opt_out');
    // cancelled / completed are refused
    const dead = await booking(a.id, new Date(Date.now() + 5 * 86_400_000), { status: 'cancelled' });
    expect((await post(dead.id, owner)).status).toBe(409);
  });

  test('concurrent resend of one booking sends exactly one text', async () => {
    const a = await newBusiness();
    const bk = await booking(a.id, new Date(Date.now() + 2 * 86_400_000), { phoneNumber: phone() });
    const { sendConfirmation } = await import('@/lib/messaging/actions');
    const results = await Promise.all(Array.from({ length: 6 }, () => sendConfirmation(bk.id).catch((e) => e)));
    expect(await prisma.smsLog.count({ where: { businessId: a.id, kind: 'confirmation', bookingId: bk.id } })).toBe(1);
    expect(results.filter((r) => r && !(r instanceof Error) && r.deduped === false).length).toBe(1);
  });

  // ------------------------------------------------------------------ call-mode API roles
  test('call-mode API: staff can read but not change; another tenant is a 404; a cross-site cookie write is refused', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const owner = await login(a.id, 'owner');
    const staff = await login(a.id, 'staff');
    const ownerB = await login(b.id, 'owner');
    const patch = (id: string, who: Who, body: unknown) => modeRoute.PATCH(req(`/api/businesses/${id}/call-mode`, who, body, 'PATCH'), ctx(id));
    expect((await modeRoute.GET(req(`/api/businesses/${a.id}/call-mode`, staff), ctx(a.id))).status).toBe(200);
    const view = await json<{ forward_number: string | null }>(await modeRoute.GET(req(`/api/businesses/${a.id}/call-mode`, staff), ctx(a.id)));
    expect(view.data!.forward_number).toBeNull(); // staff never receive the full number
    expect((await patch(a.id, staff, { mode: 'paused' })).status).toBe(403);
    expect((await patch(a.id, ownerB, { mode: 'paused' })).status).toBe(404);
    expect((await modeRoute.GET(req(`/api/businesses/${a.id}/call-mode`, ownerB), ctx(a.id))).status).toBe(404);
    expect((await patch(a.id, { ...owner, site: 'cross-site' }, { mode: 'paused' })).status).toBe(403);
    expect((await db.getBusiness(a.id))?.call_mode).toBe('ai');
    expect((await patch(a.id, owner, { mode: 'paused' })).status).toBe(200);
    expect((await db.getBusiness(a.id))?.call_mode).toBe('paused');
    expect((await db.getBusiness(b.id))?.call_mode).toBe('ai');
  });

  // ------------------------------------------------------------------ bounded and paginated lists
  test('calls / briefings / sms / businesses pages: cursor paging with stable order, tenant scoped', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const staff = await login(a.id, 'staff');
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 7; i++) await db.createCall({ business_id: a.id, caller_phone: phone(), started_at: new Date(base + Math.floor(i / 2) * 1000).toISOString() }); // equal timestamps in pairs
    await db.createCall({ business_id: b.id, caller_phone: phone() });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: Awaited<ReturnType<typeof db.listCallsPage>> = await db.listCallsPage(a.id, { limit: 3, cursor });
      expect(p.items.length).toBeLessThanOrEqual(3);
      seen.push(...p.items.map((c) => c.id));
      cursor = p.next_cursor;
    } while (cursor);
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    expect(await db.countCalls(a.id)).toBe(7);

    const viaApi = await json<{ items: { id: string; business_id: string }[]; next_cursor: string | null }>(await callsRoute.GET(req('/api/calls?limit=3', staff)));
    expect(viaApi.data!.items.length).toBe(3);
    expect(viaApi.data!.items.every((c) => c.business_id === a.id)).toBe(true);
    expect(viaApi.data!.next_cursor).not.toBeNull();
    expect((await callsRoute.GET(req(`/api/calls?business_id=${b.id}`, staff))).status).toBe(404);

    // briefings (cursor = the last date)
    for (const d of ['2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']) await db.createBriefing({ business_id: a.id, date: d, transcript: 'x' });
    const b1 = await db.listBriefingsPage(a.id, { limit: 2 });
    expect(b1.items.map((x) => x.date)).toEqual(['2027-01-05', '2027-01-04']);
    const b2 = await db.listBriefingsPage(a.id, { limit: 2, cursor: b1.next_cursor });
    expect(b2.items.map((x) => x.date)).toEqual(['2027-01-03', '2027-01-02']);
    expect((await db.listBriefingsPage(a.id, { limit: 2, cursor: b2.next_cursor })).next_cursor).toBeNull();
    const viaBriefings = await json<{ items: unknown[]; next_cursor: string | null }>(await briefingsRoute.GET(req(`/api/briefings?limit=2`, staff)));
    expect(viaBriefings.data!.items.length).toBe(2);
    expect((await db.listBriefings(a.id)).length).toBe(5); // legacy shape still works (bounded)

    // sms log
    for (let i = 0; i < 5; i++) await db.logSms({ business_id: a.id, to_phone: phone(), body: `m${i}`, kind: 'other', status: 'mock' });
    const s1 = await db.listSmsPage(a.id, { limit: 2 });
    expect(s1.items.length).toBe(2);
    const s2 = await db.listSmsPage(a.id, { limit: 10, cursor: s1.next_cursor });
    expect(s2.items.length).toBe(3);
    expect(s2.next_cursor).toBeNull();
    expect(await db.countSms(a.id)).toBe(5);
    expect((await db.listSms(a.id, { limit: 2 })).length).toBe(2);

    // businesses: the page walker visits everyone exactly once
    const all = await db.listAllBusinesses();
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    expect(all.map((x) => x.id)).toContain(a.id);
    expect((await db.listBusinesses({ limit: 2 })).length).toBeLessThanOrEqual(2);
  });

  test('dashboard stats are computed in the business zone from SQL aggregates (not the UTC date)', async () => {
    const la = await newBusiness({ timezone: 'America/Los_Angeles' });
    // 2027-06-15 03:30 UTC is June 14 8:30 pm in Los Angeles
    const now = new Date('2027-06-15T03:30:00Z');
    await db.createCall({ business_id: la.id, caller_phone: phone(), started_at: '2027-06-15T03:00:00Z', language: 'es' });   // local June 14: today
    await db.createCall({ business_id: la.id, caller_phone: phone(), started_at: '2027-06-14T20:00:00Z' });                    // local June 14 1 pm: today
    await db.createCall({ business_id: la.id, caller_phone: phone(), started_at: '2027-06-13T20:00:00Z' });                    // yesterday
    await db.createCall({ business_id: la.id, caller_phone: phone(), started_at: '2027-06-12T10:00:00Z', flagged_reason: 'x' }); // flagged this week
    await db.createCall({ business_id: la.id, caller_phone: phone(), started_at: '2027-05-01T10:00:00Z', flagged_reason: 'old' }); // flagged long ago
    await booking(la.id, new Date('2027-06-16T16:00:00Z'));                                                                       // upcoming
    await booking(la.id, new Date('2027-06-16T18:00:00Z'), { status: 'cancelled' });                                              // cancelled: not counted
    await booking(la.id, new Date('2027-06-10T16:00:00Z'));                                                                       // past
    await booking(la.id, new Date('2027-06-20T16:00:00Z'), { deposit: true });                                                    // upcoming, deposit paid this month
    await booking(la.id, new Date('2027-07-02T16:00:00Z'), { deposit: true });                                                    // next month: not this month's deposits
    const s = await db.getDashboardStats(la.id, 'America/Los_Angeles', now);
    expect(s).toMatchObject({ calls_today: 2, bilingual_today: 1, bookings_upcoming: 3, deposits_month_cents: 5000, needs_attention: 1 });
    // month bounds are local too
    const m = db.monthRange('2027-06-14', 'America/Los_Angeles');
    expect(m.gte.toISOString()).toBe('2027-06-01T07:00:00.000Z');
    expect(m.lt.toISOString()).toBe('2027-07-01T07:00:00.000Z');
    void addDaysToDateKey; void localDateKey;
  });

  test('isKnownContact: owner, past customer or past caller only (indexed E.164), never a stranger or another tenant\'s contact', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const customer = phone();
    const caller = phone();
    await booking(a.id, new Date(), { phoneNumber: customer });
    await db.createCall({ business_id: a.id, caller_phone: caller });
    expect(await db.isKnownContact(a.id, a.owner_phone!)).toBe(true);
    expect(await db.isKnownContact(a.id, customer)).toBe(true);
    expect(await db.isKnownContact(a.id, caller)).toBe(true);
    expect(await db.isKnownContact(a.id, phone())).toBe(false);
    expect(await db.isKnownContact(b.id, customer)).toBe(false);
    expect(await db.isKnownContact(uniq('nope'), customer)).toBe(false);
  });

  test('gratitude candidates: ranged to the 20-48 h window and skip numbers already texted', async () => {
    const { findGratitudeCandidates } = await import('@/lib/gratitude');
    const a = await newBusiness();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const n1 = phone(); const n2 = phone();
    const ready = await booking(a.id, hoursAgo(44), { status: 'completed', phoneNumber: n1 });
    await booking(a.id, hoursAgo(5), { status: 'completed', phoneNumber: phone() });   // too recent
    await booking(a.id, hoursAgo(80), { status: 'completed', phoneNumber: phone() });  // too old
    await booking(a.id, hoursAgo(35), { status: 'confirmed', phoneNumber: phone() });  // not completed
    const texted = await booking(a.id, hoursAgo(24), { status: 'completed', phoneNumber: n2 });
    await db.logSms({ business_id: a.id, to_phone: n2, body: 'thanks', kind: 'gratitude', status: 'sent' });
    const ids = (await findGratitudeCandidates(a.id)).map((x) => x.id);
    expect(ids).toEqual([ready.id]);
    expect(ids).not.toContain(texted.id);
    // a blocked-for-quiet-hours text does not count as "already texted"
    await prisma.smsLog.deleteMany({ where: { businessId: a.id } });
    await db.logSms({ business_id: a.id, to_phone: n2, body: 'thanks', kind: 'gratitude', status: 'blocked_quiet_hours' });
    expect((await findGratitudeCandidates(a.id)).map((x) => x.id).sort()).toEqual([ready.id, texted.id].sort());
  });

  // ------------------------------------------------------------------ data layer integrity
  test('update helpers: a missing row is null, a real failure is thrown (not disguised as "not found")', async () => {
    expect(await db.updateBooking(uniq('missing'), { service: 'x' })).toBeNull();
    expect(await db.updateCall(uniq('missing'), { summary: 'x' })).toBeNull();
    expect(await db.updateBusiness(uniq('missing'), { name: 'x' })).toBeNull();
    const a = await newBusiness();
    const b = await newBusiness();
    // a unique-constraint violation (two calls with one SID) used to come back as null: now it throws
    const c1 = await db.createCall({ business_id: a.id, call_sid: uniq('CA') });
    const c2 = await db.createCall({ business_id: a.id, call_sid: uniq('CA') });
    await expect(db.updateCall(c2.id, { call_sid: c1.call_sid })).rejects.toBeTruthy();
    await expect(db.updateBusiness(b.id, { phone: a.phone! })).rejects.toBeTruthy(); // duplicate phone
  });

  test('sms_log.booking_id is a real foreign key (SET NULL on delete) and enum columns are constrained', async () => {
    const a = await newBusiness();
    const bk = await booking(a.id, new Date());
    const sms = await db.logSms({ business_id: a.id, to_phone: phone(), body: 'x', kind: 'confirmation', status: 'mock', booking_id: bk.id });
    await prisma.booking.delete({ where: { id: bk.id } });
    expect((await prisma.smsLog.findUnique({ where: { id: sms.id } }))?.bookingId).toBeNull();
    const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return 'accepted'; } catch { return 'rejected'; } };
    expect(await attempt(() => prisma.smsLog.create({ data: { businessId: a.id, toPhone: phone(), body: 'x', kind: 'confirmation', status: 'queued', bookingId: uniq('ghost') } }))).toBe('rejected');

    expect(await attempt(() => prisma.booking.create({ data: { businessId: a.id, customerName: 'x', customerPhone: '1', service: 's', scheduledAt: new Date(), status: 'maybe' } }))).toBe('rejected');
    expect(await attempt(() => prisma.call.create({ data: { businessId: a.id, status: 'sleeping' } }))).toBe('rejected');
    expect(await attempt(() => prisma.call.create({ data: { businessId: a.id, urgency: 'whenever' } }))).toBe('rejected');
    expect(await attempt(() => prisma.business.update({ where: { id: a.id }, data: { status: 'zombie' } }))).toBe('rejected');
    expect(await attempt(() => prisma.smsLog.create({ data: { businessId: a.id, toPhone: phone(), body: 'x', kind: 'spam', status: 'queued' } }))).toBe('rejected');
    expect(await attempt(() => prisma.smsLog.create({ data: { businessId: a.id, toPhone: phone(), body: 'x', kind: 'other', status: 'delivered?' } }))).toBe('rejected');
  });
});
