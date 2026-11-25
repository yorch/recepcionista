/**
 * Phase 2 against a real database: reschedule (route, rules, concurrency, customer text suppression), voice tools that change a booking
 * (ownership), cancellation + refunds (policy, step-up, idempotency, Stripe failure, webhook reconciliation, disputes), recording proxy,
 * voice selection, readiness gate on provisioning.
 */
import { integration, outboundCalls, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { cleanup, eventId, futureDateKey, loadDb, loadPrisma, newBusiness, nextUsDstDay, phone, stripeSignature, uniq } from '../helpers/fixtures';
import { confirmGoLive } from '../helpers/golive';
import { zonedTimeToUtc } from '../../src/lib/time';

integration('phase 2: reschedule, cancel/refund, voice tools, recording, voice, readiness (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  type Ctx = { params: Promise<{ id: string }> };
  type Route = (req: Request, c: Ctx) => Promise<Response>;
  let rescheduleRoute: Route; let slotsRoute: Route; let refundRoute: Route; let notifyRoute: Route;
  let oneRoute: { GET: Route; PATCH: Route };
  let audioRoute: Route; let voiceRoute: { GET: Route; PUT: Route }; let previewRoute: Route; let policyRoute: { GET: Route; PUT: Route };
  let provisionRoute: Route; let webhook: (req: Request) => Promise<Response>;
  let tools: typeof import('@/lib/voice/tools');
  let changes: typeof import('@/lib/booking-changes');
  const userIds: string[] = [];
  const NY = 'America/New_York';

  let ipSeq = 10;
  beforeAll(async () => {
    // Customer texts obey quiet hours (9pm-8am business time): run the whole file at 14:00 New York time today so the result never depends on when CI runs.
    setSystemTime(zonedTimeToUtc(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), '14:00', 'America/New_York'));
    process.env.TRUSTED_PROXY = 'true'; // per-request client ips below, so route rate limits do not couple tests
    db = await loadDb(); prisma = await loadPrisma(); users = await import('@/lib/db/users');
    rescheduleRoute = (await import('@/app/api/bookings/[id]/reschedule/route')).POST;
    slotsRoute = (await import('@/app/api/bookings/[id]/slots/route')).GET;
    refundRoute = (await import('@/app/api/bookings/[id]/refund/route')).POST;
    notifyRoute = (await import('@/app/api/bookings/[id]/notify/route')).POST;
    oneRoute = await import('@/app/api/bookings/[id]/route');
    audioRoute = (await import('@/app/api/calls/[id]/audio/route')).GET;
    voiceRoute = await import('@/app/api/businesses/[id]/voice/route');
    previewRoute = (await import('@/app/api/businesses/[id]/voice/preview/route')).GET;
    policyRoute = await import('@/app/api/businesses/[id]/refund-policy/route');
    provisionRoute = (await import('@/app/api/businesses/[id]/provision/route')).POST as Route;
    webhook = (await import('@/app/api/payments/webhook/route')).POST;
    tools = await import('@/lib/voice/tools');
    changes = await import('@/lib/booking-changes');
  });
  afterAll(async () => {
    setSystemTime();
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  beforeEach(async () => { (await import('@/lib/voice/recording-audio')).clearRecordingCache(); (await import('@/lib/voice/voices')).clearVoicesCache(); });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token, session } = await users.createSession(user.id) as { token: string; session?: { id: string } };
    return { cookie: `rc_user_session=${token}`, user, sessionId: session?.id };
  }
  type Who = { cookie?: string; site?: string } | null;
  const req = (path: string, who: Who, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'x-forwarded-for': `198.51.${(ipSeq = (ipSeq + 1) % 250)}.${Math.floor(ipSeq / 3) + 1}`, 'sec-fetch-site': who?.site ?? 'same-origin', origin: who?.site === 'cross-site' ? 'https://evil.example' : 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie } : {}), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const json = async <T = unknown>(r: Response) => (await r.json()) as { ok: boolean; data?: T; error?: string; code?: string };

  let hourSeq = 0;
  const dayKey = futureDateKey(2, NY, 10);
  /** A booking on a far-future Tuesday; each call a different hour so they never overlap. */
  async function booking(businessId: string, o: { hour?: number; day?: string; phoneNumber?: string; status?: string; deposit?: number; paid?: boolean; callId?: string | null; minutes?: number; scheduledAt?: Date } = {}) {
    const h = o.hour ?? 8 + (hourSeq++ % 9);
    const ph = o.phoneNumber ?? phone();
    return prisma.booking.create({
      data: {
        businessId, customerName: 'Ana Pérez', customerPhone: ph, phoneE164: ph, service: 'AC repair', callId: o.callId ?? null,
        scheduledAt: o.scheduledAt ?? zonedTimeToUtc(o.day ?? dayKey, `${String(h).padStart(2, '0')}:00`, NY), durationMinutes: o.minutes ?? 60, status: o.status ?? 'confirmed',
        ...(o.deposit ? { depositAmount: o.deposit, depositPaid: o.paid !== false } : {}),
      },
    });
  }
  const iso = (key: string, hhmm: string) => zonedTimeToUtc(key, hhmm, NY).toISOString();

  // ---------------------------------------------------------------- reschedule

  test('reschedule: moves, audits, frees the old slot, texts the customer and stamps customer_notified_at', async () => {
    const biz = await newBusiness(); const { cookie } = await login(biz.id);
    const b = await booking(biz.id, { hour: 9 });
    const target = iso(dayKey, '14:00');
    const res = await rescheduleRoute(req(`/api/bookings/${b.id}/reschedule`, { cookie }, { scheduled_at: target }), ctx(b.id));
    expect(res.status).toBe(200);
    const d = (await json<{ changed: boolean; notice: { status: string; delivered: boolean }; booking: { scheduled_at: string; reschedule_count: number; customer_notified_at: string | null } }>(res)).data!;
    expect(d.changed).toBe(true);
    expect(new Date(d.booking.scheduled_at).toISOString()).toBe(target);
    expect(d.booking.reschedule_count).toBe(1);
    expect(d.notice.delivered).toBe(true); // mock SMS provider: logged as 'mock'
    expect(d.booking.customer_notified_at).not.toBeNull();
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.rescheduled', target: `booking:${b.id}` } });
    expect(audit).not.toBeNull();
    const sms = await prisma.smsLog.findFirst({ where: { bookingId: b.id, kind: 'other' } });
    expect(sms?.body).toContain('was moved to');
    expect(sms?.consentBasis).toBe('transactional_booking');
    // the old slot is free again: another booking can take it
    await booking(biz.id, { hour: 9 });
    // idempotent: moving to where it already is changes nothing and texts nobody
    const again = await rescheduleRoute(req(`/api/bookings/${b.id}/reschedule`, { cookie }, { scheduled_at: target }), ctx(b.id));
    expect((await json<{ changed: boolean; notice: unknown }>(again)).data).toMatchObject({ changed: false, notice: null });
    expect(await prisma.smsLog.count({ where: { bookingId: b.id, kind: 'other' } })).toBe(1);
  });

  test('reschedule: overlap, outside hours, past, closed day, bad input, notify:false', async () => {
    const biz = await newBusiness({ hours: { ...(await import('../helpers/fixtures')).ALL_WEEK, sunday: null } as never }); const { cookie } = await login(biz.id);
    const a = await booking(biz.id, { hour: 9 }); await booking(biz.id, { hour: 11 });
    const post = (id: string, body: unknown) => rescheduleRoute(req(`/api/bookings/${id}/reschedule`, { cookie }, body), ctx(id));
    expect((await post(a.id, { scheduled_at: iso(dayKey, '11:30') })).status).toBe(409); // overlaps `other` (11:00-12:00)
    expect((await post(a.id, { scheduled_at: iso(dayKey, '07:00') })).status).toBe(422); // before opening
    expect((await post(a.id, { scheduled_at: iso(dayKey, '17:30') })).status).toBe(422); // runs past closing
    expect((await post(a.id, { scheduled_at: '2020-01-06T15:00:00Z' })).status).toBe(422); // past
    const sunday = futureDateKey(0, NY, 10);
    expect((await post(a.id, { scheduled_at: iso(sunday, '10:00') })).status).toBe(422); // closed day
    expect((await post(a.id, { scheduled_at: 'tomorrow' })).status).toBe(422);
    expect((await post(a.id, { scheduled_at: iso(dayKey, '15:00'), evil: 1 })).status).toBe(422);
    expect((await post(a.id, { scheduled_at: iso(dayKey, '15:00'), notify: 'yes' })).status).toBe(422);
    const quiet = await post(a.id, { scheduled_at: iso(dayKey, '15:00'), notify: false });
    expect(quiet.status).toBe(200);
    expect((await json<{ notice: { reason: string } }>(quiet)).data!.notice.reason).toBe('not_requested');
    expect(await prisma.smsLog.count({ where: { bookingId: a.id } })).toBe(0);
    // wall-clock input (no offset) is read in the business zone
    const wall = await post(a.id, { scheduled_at: `${dayKey}T16:00:00`, notify: false });
    expect(new Date((await json<{ booking: { scheduled_at: string } }>(wall)).data!.booking.scheduled_at).toISOString()).toBe(iso(dayKey, '16:00'));
    // cancelled / completed bookings do not move
    const done = await booking(biz.id, { hour: 13, status: 'cancelled' });
    expect((await post(done.id, { scheduled_at: iso(dayKey, '15:00') })).status).toBe(409);
  });

  test('reschedule: tenant isolation, roles, CSRF, unauthenticated', async () => {
    const biz = await newBusiness(); const other = await newBusiness();
    const owner = await login(biz.id); const foreign = await login(other.id); const staff = await login(biz.id, 'staff');
    const b = await booking(biz.id);
    const target = iso(dayKey, '15:00');
    const post = (who: Who) => rescheduleRoute(req(`/api/bookings/${b.id}/reschedule`, who, { scheduled_at: target }), ctx(b.id));
    expect((await post(foreign)).status).toBe(404);
    expect((await post(staff)).status).toBe(403);
    expect((await post(null)).status).toBe(401);
    expect((await post({ cookie: owner.cookie, site: 'cross-site' })).status).toBe(403);
    expect((await slotsRoute(req(`/api/bookings/${b.id}/slots?date=${dayKey}`, foreign), ctx(b.id))).status).toBe(404);
    expect((await slotsRoute(req(`/api/bookings/${b.id}/slots?date=${dayKey}`, staff), ctx(b.id))).status).toBe(403);
    expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.rescheduleCount).toBe(0);
  });

  test('reschedule: 6 concurrent moves into one slot -> exactly one wins, no overlap', async () => {
    const biz = await newBusiness(); const { cookie } = await login(biz.id);
    const bs = await Promise.all([8, 9, 10, 11, 12, 13].map((h) => booking(biz.id, { hour: h })));
    const target = iso(dayKey, '16:00');
    const res = await Promise.all(bs.map((b) => rescheduleRoute(req(`/api/bookings/${b.id}/reschedule`, { cookie }, { scheduled_at: target, notify: false }), ctx(b.id))));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    expect(res.filter((r) => r.status === 409).length).toBe(5);
    expect(await prisma.booking.count({ where: { businessId: biz.id, scheduledAt: new Date(target) } })).toBe(1);
  });

  test('slots: the booking does not block itself; other bookings do; DST day lists real local hours', async () => {
    const biz = await newBusiness(); const { cookie } = await login(biz.id);
    const b = await booking(biz.id, { hour: 10 }); await booking(biz.id, { hour: 12 });
    const r = await slotsRoute(req(`/api/bookings/${b.id}/slots?date=${dayKey}`, { cookie }), ctx(b.id));
    const slots = (await json<{ slots: { start: string; available: boolean; current: boolean }[] }>(r)).data!.slots;
    const by = (h: string) => slots.find((s) => s.start === iso(dayKey, h))!;
    expect(by('10:00').current).toBe(true); expect(by('10:00').available).toBe(true);
    expect(by('12:00').available).toBe(false);
    expect(by('09:00').available).toBe(true);
    expect((await slotsRoute(req(`/api/bookings/${b.id}/slots?date=nope`, { cookie }), ctx(b.id))).status).toBe(422);
    // spring-forward Sunday: 08:00 local is EDT (UTC-4), 18:00 close; all slots are on local hours
    const spring = nextUsDstDay('spring');
    const tz = await newBusiness({ timezone: NY }); const o2 = await login(tz.id);
    const sb = await booking(tz.id, { hour: 9 });
    const sr = await slotsRoute(req(`/api/bookings/${sb.id}/slots?date=${spring}`, o2), ctx(sb.id));
    const ss = (await json<{ slots: { start: string }[] }>(sr)).data!.slots;
    expect(ss[0].start).toBe(zonedTimeToUtc(spring, '08:00', NY).toISOString());
    expect(ss.length).toBe(10);
    expect(new Date(ss[0].start).getUTCHours()).toBe(12); // 08:00 EDT
  });

  test('customer text suppression: opt-out, quiet hours (owner) vs live caller, anonymised, retry route', async () => {
    const biz = await newBusiness(); const { cookie } = await login(biz.id);
    const optedPhone = phone();
    const b = await booking(biz.id, { phoneNumber: optedPhone });
    await db.recordOptOut(biz.id, optedPhone);
    const target = iso(dayKey, '15:00');
    const res = await rescheduleRoute(req(`/api/bookings/${b.id}/reschedule`, { cookie }, { scheduled_at: target }), ctx(b.id));
    const d = (await json<{ notice: { status: string; delivered: boolean }; booking: { customer_notified_at: string | null } }>(res)).data!;
    expect(d.notice.status).toBe('blocked_opt_out'); expect(d.notice.delivered).toBe(false); expect(d.booking.customer_notified_at).toBeNull();
    expect((await prisma.smsLog.findFirst({ where: { bookingId: b.id } }))?.status).toBe('blocked_opt_out');

    // quiet hours: 23:00 local. The owner's change is held back; the customer's own call is not.
    const b2 = await booking(biz.id);
    await prisma.booking.update({ where: { id: b2.id }, data: { rescheduleCount: 1 } });
    const night = new Date(zonedTimeToUtc(dayKey, '23:00', NY));
    const held = await changes.notifyBookingChange(b2.id, { initiator: 'owner', now: night });
    expect(held.status).toBe('blocked_quiet_hours'); expect(held.delivered).toBe(false);
    expect((await db.getBooking(b2.id))!.customer_notified_at ?? null).toBeNull();
    const live = await changes.notifyBookingChange(b2.id, { initiator: 'customer', now: night });
    expect(live.delivered).toBe(true);
    expect((await db.getBooking(b2.id))!.customer_notified_at).not.toBeNull();
    // the retry route refuses once the customer was told
    expect((await notifyRoute(req(`/api/bookings/${b2.id}/notify`, { cookie }, {}), ctx(b2.id))).status).toBe(409);

    // anonymised: no text, no number
    const b3 = await booking(biz.id);
    await prisma.booking.update({ where: { id: b3.id }, data: { rescheduleCount: 1, anonymizedAt: new Date() } });
    expect((await changes.notifyBookingChange(b3.id)).reason).toBe('anonymized');

    // plan cap: a full cap blocks the notice and says so
    const capped = await newBusiness(); const cu = await login(capped.id);
    await prisma.business.update({ where: { id: capped.id }, data: { smsCapOverride: 1, billingStatus: 'active' } });
    const statuses: string[] = [];
    for (const h of [8, 10]) {
      const cb = await booking(capped.id, { hour: h });
      const cr = await withEnv({ BILLING_ENFORCED: 'true' }, () => rescheduleRoute(req(`/api/bookings/${cb.id}/reschedule`, cu, { scheduled_at: iso(dayKey, h === 8 ? '15:00' : '16:00') }), ctx(cb.id)));
      statuses.push((await json<{ notice: { status: string } }>(cr)).data!.notice.status);
    }
    expect(statuses).toContain('blocked_cap'); // the cap of 1 segment is used up by the first text (or too small for it): never claimed as sent
  });

  // ---------------------------------------------------------------- voice tools

  async function callFor(businessId: string, callerPhone: string) {
    return db.createCall({ business_id: businessId, caller_phone: callerPhone, call_sid: uniq('conv') });
  }
  const toolArgs = (biz: { id: string }, call: { call_sid?: string | null }, caller: string, extra: Record<string, unknown> = {}) =>
    ({ business_id: biz.id, call_sid: call.call_sid, caller_phone: caller, language: 'en', ...extra });

  test('voice tools: the caller moves and cancels their OWN booking; honest messages', async () => {
    const biz = await newBusiness(); const caller = phone();
    const b = await booking(biz.id, { phoneNumber: caller, hour: 9 });
    const call = await callFor(biz.id, caller);
    const moved = await tools.runTool('reschedule_booking', toolArgs(biz, call, caller, { new_scheduled_at: `${dayKey}T14:00:00` }));
    expect(moved.ok).toBe(true); expect(moved.message).toContain('is now');
    expect(moved.message).toContain('text'); // delivered (mock) -> says so
    expect((await db.getBooking(b.id))!.scheduled_at).toBe(iso(dayKey, '14:00'));
    expect((await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.rescheduled', target: `booking:${b.id}` } }))!.actorKind).toBe('system');
    // taken slot: honest refusal with real alternatives
    await booking(biz.id, { hour: 15 });
    const taken = await tools.runTool('reschedule_booking', toolArgs(biz, call, caller, { new_scheduled_at: `${dayKey}T15:00:00` }));
    expect(taken.ok).toBe(false); expect(taken.message).toContain("isn't available"); expect(taken.message).toContain('I can do');
    expect((await db.getBooking(b.id))!.scheduled_at).toBe(iso(dayKey, '14:00'));
    // cancel needs an explicit yes
    const ask = await tools.runTool('cancel_booking', toolArgs(biz, call, caller, {}));
    expect(ask.ok).toBe(false); expect(ask.message).toContain('Is that right');
    expect((await db.getBooking(b.id))!.status).toBe('confirmed');
    const gone = await tools.runTool('cancel_booking', toolArgs(biz, call, caller, { confirmed: true }));
    expect(gone.ok).toBe(true); expect(gone.message).toContain('cancelled');
    expect((await db.getBooking(b.id))!.status).toBe('cancelled');
    expect((await db.getBooking(b.id))!.cancel_reason).toContain('caller');
  });

  test('voice tools: a spoofed or mismatched caller can never touch somebody else\'s booking', async () => {
    const biz = await newBusiness(); const victim = phone(); const attacker = phone();
    const b = await booking(biz.id, { phoneNumber: victim, hour: 9 });
    const before = (await db.getBooking(b.id))!.scheduled_at;
    const call = await callFor(biz.id, attacker);
    const tryAll = async (args: Record<string, unknown>) => {
      for (const [name, extra] of [['reschedule_booking', { new_scheduled_at: `${dayKey}T14:00:00` }], ['cancel_booking', { confirmed: true }]] as const) {
        const r = await tools.runTool(name, { ...args, ...extra });
        expect(r.ok).toBe(false);
      }
      const after = (await db.getBooking(b.id))!;
      expect(after.scheduled_at).toBe(before); expect(after.status).toBe('confirmed');
    };
    // the attacker names the victim's booking id, name and number: ignored
    await tryAll(toolArgs(biz, call, attacker, { booking_id: b.id, customer_phone: victim, customer_name: 'Ana Pérez', current_time: `${dayKey}T09:00:00` }));
    // no caller id at all (withheld)
    const anon = await db.createCall({ business_id: biz.id, call_sid: uniq('conv') });
    await tryAll({ business_id: biz.id, call_sid: anon.call_sid, booking_id: b.id });
    // platform caller id disagrees with the call row: refused
    await tryAll(toolArgs(biz, call, victim, { booking_id: b.id }));
    // a call with failed STIR/SHAKEN attestation is refused even for the right number
    const spoofCall = await db.createCall({ business_id: biz.id, caller_phone: victim, call_sid: uniq('conv') });
    await prisma.call.update({ where: { id: spoofCall.id }, data: { callerVerified: false } });
    await tryAll(toolArgs(biz, spoofCall, victim, { booking_id: b.id }));
    // same number but ANOTHER business's call/tenant: nothing found there
    const other = await newBusiness(); const oc = await callFor(other.id, victim);
    const r = await tools.runTool('cancel_booking', toolArgs(other, oc, victim, { confirmed: true, booking_id: b.id }));
    expect(r.ok).toBe(false);
    expect((await db.getBooking(b.id))!.status).toBe('confirmed');
    // the refusal text is identical whether or not a booking exists (no probing)
    const nobody = await tools.runTool('cancel_booking', toolArgs(biz, call, attacker, { confirmed: true }));
    const someone = await tools.runTool('cancel_booking', toolArgs(biz, call, attacker, { confirmed: true, booking_id: b.id }));
    expect(someone.message).toBe(nobody.message);
  });

  test('voice tools: several bookings -> asks which; picks by current_time', async () => {
    const biz = await newBusiness(); const caller = phone(); const call = await callFor(biz.id, caller);
    const a = await booking(biz.id, { phoneNumber: caller, hour: 9 }); const c = await booking(biz.id, { phoneNumber: caller, hour: 11 });
    const ask = await tools.runTool('cancel_booking', toolArgs(biz, call, caller, { confirmed: true }));
    expect(ask.ok).toBe(false); expect(ask.message).toContain('more than one');
    expect((await db.getBooking(a.id))!.status).toBe('confirmed');
    const pick = await tools.runTool('cancel_booking', toolArgs(biz, call, caller, { confirmed: true, current_time: `${dayKey}T11:00:00` }));
    expect(pick.ok).toBe(true);
    expect((await db.getBooking(c.id))!.status).toBe('cancelled'); expect((await db.getBooking(a.id))!.status).toBe('confirmed');
  });

  // ---------------------------------------------------------------- cancel + refund

  test('cancel texts the customer, is policy aware and never refunds by itself', async () => {
    const biz = await newBusiness(); const { cookie } = await login(biz.id);
    await db.updateBusiness(biz.id, { refund_policy: 'full_24h' });
    const far = await booking(biz.id, { deposit: 5000, hour: 9 });
    const r = await oneRoute.PATCH(req(`/api/bookings/${far.id}`, { cookie }, { status: 'cancelled' }, 'PATCH'), ctx(far.id));
    const d = (await json<{ deposit_refund_needed: boolean; refund: { eligible: boolean; reason: string }; notice: { delivered: boolean }; booking: { refund_status: string; cancelled_at: string } }>(r)).data!;
    expect(d.refund.eligible).toBe(true); expect(d.deposit_refund_needed).toBe(true); expect(d.notice.delivered).toBe(true);
    expect(d.booking.refund_status).toBe('none'); // offered, not issued
    const text = await prisma.smsLog.findFirst({ where: { bookingId: far.id } });
    expect(text?.body).toContain('eligible for a refund');
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.cancelled', target: `booking:${far.id}` } })).toBe(1);
    // idempotent: a repeat texts nobody
    const again = await oneRoute.PATCH(req(`/api/bookings/${far.id}`, { cookie }, { status: 'cancelled' }, 'PATCH'), ctx(far.id));
    expect((await json<{ changed: boolean }>(again)).data!.changed).toBe(false);
    expect(await prisma.smsLog.count({ where: { bookingId: far.id } })).toBe(1);
    // too late for the policy: not refundable, marked not_applicable, text says so
    const soon = await booking(biz.id, { deposit: 5000, scheduledAt: new Date(Date.now() + 3 * 3_600_000), hour: 9 });
    const r2 = await oneRoute.PATCH(req(`/api/bookings/${soon.id}`, { cookie }, { status: 'cancelled', notify: true }, 'PATCH'), ctx(soon.id));
    const d2 = (await json<{ refund: { eligible: boolean }; booking: { refund_status: string }; deposit_refund_needed: boolean }>(r2)).data!;
    expect(d2.refund.eligible).toBe(false); expect(d2.booking.refund_status).toBe('not_applicable'); expect(d2.deposit_refund_needed).toBe(false);
    expect((await prisma.smsLog.findFirst({ where: { bookingId: soon.id } }))?.body).toContain('not refunded');
    // notify:false sends nothing
    const quiet = await booking(biz.id, { hour: 12 });
    await oneRoute.PATCH(req(`/api/bookings/${quiet.id}`, { cookie }, { status: 'cancelled', notify: false }, 'PATCH'), ctx(quiet.id));
    expect(await prisma.smsLog.count({ where: { bookingId: quiet.id } })).toBe(0);
    // the detail view carries the verdict for the panel
    const detail = await oneRoute.GET(req(`/api/bookings/${far.id}`, { cookie }), ctx(far.id));
    expect((await json<{ refund: { eligible: boolean; policy_label: string } }>(detail)).data!.refund).toMatchObject({ eligible: true });
  });

  /** Fake Stripe: records refund calls; `mode` decides the answer. */
  function fakeStripe(mode: { kind: 'ok'; status?: string } | { kind: 'reject' } | { kind: 'timeout' }) {
    const calls: { url: string; key: string | null; body: URLSearchParams }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.startsWith('https://api.stripe.com/v1/refunds')) {
        const body = new URLSearchParams(String(init?.body ?? ''));
        calls.push({ url, key: new Headers(init?.headers).get('idempotency-key'), body });
        if (mode.kind === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        if (mode.kind === 'reject') return new Response(JSON.stringify({ error: { message: 'Charge ch_1 has already been refunded.', code: 'charge_already_refunded' } }), { status: 400 });
        return new Response(JSON.stringify({ id: `re_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, status: mode.status ?? 'succeeded', amount: Number(body.get('amount')), payment_intent: body.get('payment_intent') }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = saved; } };
  }
  const withStripe = <T>(fn: () => Promise<T>) => withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, fn);
  /** The deposit-link deactivation after a cancel runs in the background (never awaited by the cancel): tests wait for it here. */
  const flushLinks = async () => (await import('@/lib/payments/link-store')).flushLinkDeactivations();
  /** The booking's deposit link was texted to the customer (the signal that a link may exist at all). */
  const textedLink = (businessId: string, bookingId: string) => prisma.smsLog.create({ data: { businessId, toPhone: '+13055550100', body: 'Pay your deposit: https://buy.stripe.com/test', kind: 'payment_link', bookingId, status: 'sent' } });
  async function paidBooking(biz: { id: string }, o: { policy?: 'none' | 'full_24h' | 'full_48h' | 'full_always'; cancelAt?: 'far' | 'soon'; pi?: string | null; deposit?: number } = {}) {
    await db.updateBusiness(biz.id, { refund_policy: o.policy ?? 'full_24h' });
    const soon = o.cancelAt === 'soon';
    const b = await booking(biz.id, { deposit: o.deposit ?? 5000, scheduledAt: soon ? new Date(Date.now() + 3 * 3_600_000) : undefined, hour: 9 });
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date(), ...(o.pi === null ? {} : { stripePaymentIntentId: o.pi ?? `pi_${uniq('x').replace(/[^A-Za-z0-9]/g, '')}` }) } });
    return b;
  }
  const refundReq = (id: string, who: Who, body: unknown) => refundRoute(req(`/api/bookings/${id}/refund`, who, body), ctx(id));

  test('refund: full, idempotent replay, one Stripe call with a stable Idempotency-Key, audit, customer text', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok' });
    try {
      await withStripe(async () => {
        const r = await refundReq(b.id, owner, {});
        expect(r.status).toBe(200);
        const d = (await json<{ status: string; amount_cents: number; replayed: boolean; override: boolean; notice: { delivered: boolean }; booking: { refund_status: string; refund_amount_cents: number } }>(r)).data!;
        expect(d).toMatchObject({ status: 'refunded', amount_cents: 5000, replayed: false, override: false });
        expect(d.booking).toMatchObject({ refund_status: 'refunded', refund_amount_cents: 5000 });
        expect(d.notice.delivered).toBe(true);
        expect(stripe.calls.length).toBe(1);
        expect(stripe.calls[0].body.get('amount')).toBe('5000');
        expect(stripe.calls[0].body.get('payment_intent')).toStartWith('pi_');
        expect(stripe.calls[0].key).toBe(`rc-refund-${b.id}-5000`);
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refunded', target: `booking:${b.id}` } })).toBe(1);
        // same request again: no second Stripe call, still 200
        const again = await refundReq(b.id, owner, {});
        expect((await json<{ replayed: boolean }>(again)).data!.replayed).toBe(true);
        expect(stripe.calls.length).toBe(1);
        // a different amount after a full refund is refused
        expect((await refundReq(b.id, owner, { amount_cents: 100 })).status).toBe(409);
        expect(stripe.calls.length).toBe(1);
      });
    } finally { stripe.restore(); }
  });

  test('refund: partial, amount validation, never more than paid', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz, { deposit: 5000 });
    const stripe = fakeStripe({ kind: 'ok' });
    try {
      await withStripe(async () => {
        for (const bad of [0, -1, 5001, 12.5, '100', null, NaN]) expect((await refundReq(b.id, owner, { amount_cents: bad })).status).toBe(422);
        expect(stripe.calls.length).toBe(0);
        const r = await refundReq(b.id, owner, { amount_cents: 2000 });
        expect(r.status).toBe(200);
        const d = (await json<{ partial: boolean; booking: { refund_amount_cents: number } }>(r)).data!;
        expect(d.partial).toBe(true); expect(d.booking.refund_amount_cents).toBe(2000);
        expect(stripe.calls[0].key).toBe(`rc-refund-${b.id}-2000`);
      });
    } finally { stripe.restore(); }
  });

  test('refund: policy matrix over HTTP: eligible needs no override; ineligible needs override and is audited', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const stripe = fakeStripe({ kind: 'ok' });
    try {
      await withStripe(async () => {
        const noRefund = await paidBooking(biz, { policy: 'none' });
        const denied = await refundReq(noRefund.id, owner, {});
        expect(denied.status).toBe(422); expect((await json(denied)).code).toBe('policy_ineligible');
        expect(stripe.calls.length).toBe(0);
        expect((await refundReq(noRefund.id, owner, { override: 'yes' })).status).toBe(422);
        const forced = await refundReq(noRefund.id, owner, { override: true });
        expect(forced.status).toBe(200); expect((await json<{ override: boolean }>(forced)).data!.override).toBe(true);
        const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.refunded', target: `booking:${noRefund.id}` } });
        expect((audit!.meta as { override: boolean }).override).toBe(true);
        // a cancelled-but-too-late booking (24h policy): same
        const late = await paidBooking(biz, { policy: 'full_24h', cancelAt: 'soon' });
        expect((await refundReq(late.id, owner, {})).status).toBe(422);
        // always: refundable
        const always = await paidBooking(biz, { policy: 'full_always', cancelAt: 'soon' });
        expect((await refundReq(always.id, owner, {})).status).toBe(200);
        // an unpaid deposit / no deposit: nothing to refund
        const unpaid = await booking(biz.id, { deposit: 5000, paid: false });
        expect((await refundReq(unpaid.id, owner, { override: true })).status).toBe(409);
      });
    } finally { stripe.restore(); }
  });

  test('refund: step-up (recent auth) is required; staff, other tenants, CSRF and anonymous are refused', async () => {
    const biz = await newBusiness(); const other = await newBusiness();
    const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const foreign = await login(other.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok' });
    try {
      await withStripe(async () => {
        expect((await refundReq(b.id, staff, {})).status).toBe(403);
        expect((await refundReq(b.id, foreign, {})).status).toBe(404);
        expect((await refundReq(b.id, null, {})).status).toBe(401);
        expect((await refundReq(b.id, { cookie: owner.cookie, site: 'cross-site' }, {})).status).toBe(403);
        await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 10 * 60_000) } });
        const stale = await refundReq(b.id, owner, {});
        expect(stale.status).toBe(403); expect((await json(stale)).code).toBe('reauth_required');
        expect(stripe.calls.length).toBe(0);
        await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
        expect((await refundReq(b.id, owner, {})).status).toBe(200);
      });
    } finally { stripe.restore(); }
  });

  test('refund: Stripe refusal -> failed + audited + retry with a NEW key; timeout -> pending + SAME key (never twice)', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    await withStripe(async () => {
      let stripe = fakeStripe({ kind: 'reject' });
      try {
        const r = await refundReq(b.id, owner, {});
        expect(r.status).toBe(502); expect((await json(r)).code).toBe('provider_refused');
        expect((await db.getBooking(b.id))!.refund_status).toBe('failed');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(1);
      } finally { stripe.restore(); }
      stripe = fakeStripe({ kind: 'timeout' });
      try {
        const t = await refundReq(b.id, owner, {});
        expect(t.status).toBe(502); expect((await json(t)).code).toBe('outcome_unknown');
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending'); // unknown, not failed
        const key1 = stripe.calls[0].key;
        expect(key1).toBe(`rc-refund-${b.id}-5000-a1`); // a definite failure happened before: new key
        await refundReq(b.id, owner, {});
        expect(stripe.calls[1].key).toBe(key1); // an unknown outcome retries with the same key
      } finally { stripe.restore(); }
      stripe = fakeStripe({ kind: 'ok' });
      try {
        expect((await refundReq(b.id, owner, {})).status).toBe(200);
        expect(stripe.calls[0].key).toBe(`rc-refund-${b.id}-5000-a1`);
        expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
      } finally { stripe.restore(); }
    });
  });

  test('refund: pending from Stripe stays pending until the webhook confirms; no payment reference is explained; mock mode works outside production', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok', status: 'pending' });
    try {
      await withStripe(async () => {
        const r = await refundReq(b.id, owner, {});
        expect((await json<{ status: string }>(r)).data!.status).toBe('pending');
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending');
        // refund.updated -> succeeded reconciles it
        const reId = (await db.getBooking(b.id))!.stripe_refund_id!;
        const ev = { id: eventId(), type: 'refund.updated', data: { object: { id: reId, status: 'succeeded', amount: 5000, payment_intent: (await db.getBooking(b.id))!.stripe_payment_intent_id } } };
        const raw = JSON.stringify(ev);
        const w = await webhook(new Request('https://app.example.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': stripeSignature(raw) }, body: raw }));
        expect(w.status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
        // replay of the same event id is a duplicate
        const dup = await webhook(new Request('https://app.example.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': stripeSignature(raw) }, body: raw }));
        expect((await json<{ duplicate?: boolean }>(dup)).data!.duplicate).toBe(true);
      });
      const noRef = await paidBooking(biz, { pi: null });
      await withStripe(async () => {
        const r = await refundReq(noRef.id, owner, {});
        expect(r.status).toBe(409); expect((await json(r)).code).toBe('no_payment_reference');
      });
    } finally { stripe.restore(); }
    // no Stripe key (test env): the mock refund records it without any network call
    const mockB = await paidBooking(biz);
    const before = outboundCalls.length;
    const r = await refundReq(mockB.id, owner, {});
    expect(r.status).toBe(200); expect(outboundCalls.length).toBe(before);
    expect((await db.getBooking(mockB.id))!.refund_status).toBe('refunded');
  });

  test('refund: two concurrent clicks make one Stripe call', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok' });
    try {
      await withStripe(async () => {
        const rs = await Promise.all([refundReq(b.id, owner, {}), refundReq(b.id, owner, {}), refundReq(b.id, owner, {})]);
        expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
        expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
        expect(stripe.calls.length).toBe(1);
        expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
      });
    } finally { stripe.restore(); }
  });

  // ---------------------------------------------------------------- stripe webhook: refs, reconciliation, disputes

  const post = (ev: unknown) => { const raw = JSON.stringify(ev); return webhook(new Request('https://app.example.test/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': stripeSignature(raw) }, body: raw })); };

  test('webhook: deposit payment stores the payment intent and checkout session', async () => {
    const biz = await newBusiness();
    const b = await booking(biz.id, { status: 'pending' });
    const pi = `pi_${uniq('p').replace(/[^A-Za-z0-9]/g, '')}`; const cs = `cs_${uniq('c').replace(/[^A-Za-z0-9]/g, '')}`;
    const res = await post({ id: eventId(), type: 'checkout.session.completed', data: { object: { id: cs, payment_intent: pi, amount_total: 4000, payment_status: 'paid', metadata: { booking_id: b.id, business_id: biz.id } } } });
    expect(res.status).toBe(200);
    const fresh = (await db.getBooking(b.id))!;
    expect(fresh).toMatchObject({ deposit_paid: true, deposit_amount: 4000, stripe_payment_intent_id: pi, stripe_checkout_session_id: cs });
    const found = await db.getBookingByStripeRef({ payment_intent_id: pi });
    expect(found?.id).toBe(b.id);
    // payment_intent.succeeded carries the intent id as its own id
    const b2 = await booking(biz.id, { status: 'pending' });
    const pi2 = `pi_${uniq('q').replace(/[^A-Za-z0-9]/g, '')}`;
    await post({ id: eventId(), type: 'payment_intent.succeeded', data: { object: { id: pi2, amount_received: 3000, metadata: { booking_id: b2.id, business_id: biz.id } } } });
    expect((await db.getBooking(b2.id))!.stripe_payment_intent_id).toBe(pi2);
  });

  test('webhook: charge.refunded reconciles an outside (dashboard) refund; replays and reordering converge; other tenant metadata is ignored', async () => {
    const biz = await newBusiness(); const other = await newBusiness();
    const b = await paidBooking(biz);
    const pi = (await db.getBooking(b.id))!.stripe_payment_intent_id!;
    const ev = { id: eventId(), type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: pi, amount: 5000, amount_refunded: 3000, metadata: { booking_id: b.id, business_id: biz.id }, refunds: { data: [{ id: 're_dash1' }] } } } };
    expect((await post(ev)).status).toBe(200);
    expect((await db.getBooking(b.id))!).toMatchObject({ refund_status: 'refunded', refund_amount_cents: 3000, stripe_refund_id: 're_dash1' });
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_reconciled', target: `booking:${b.id}` } })).toBe(1);
    // the same event again (and a NEW event id about the same state) change nothing
    expect((await json<{ duplicate?: boolean }>(await post(ev))).data!.duplicate).toBe(true);
    await post({ ...ev, id: eventId() });
    expect((await db.getBooking(b.id))!.refund_amount_cents).toBe(3000);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_reconciled', target: `booking:${b.id}` } })).toBe(1);
    // a late "pending" update never downgrades a refunded booking
    await post({ id: eventId(), type: 'refund.updated', data: { object: { id: 're_dash1', status: 'pending', amount: 3000, payment_intent: pi } } });
    expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
    // metadata naming another business than the booking's: refused, nothing changes
    const b2 = await paidBooking(biz);
    const r = await post({ id: eventId(), type: 'charge.refunded', data: { object: { id: 'ch_2', payment_intent: 'pi_unknown000', amount_refunded: 5000, metadata: { booking_id: b2.id, business_id: other.id } } } });
    expect(r.status).toBe(200);
    expect((await db.getBooking(b2.id))!.refund_status).not.toBe('refunded');
    // a failed refund marks the booking failed (and never touches a refunded one)
    const b3 = await paidBooking(biz);
    const pi3 = (await db.getBooking(b3.id))!.stripe_payment_intent_id!;
    await post({ id: eventId(), type: 'refund.failed', data: { object: { id: 're_f', status: 'failed', amount: 5000, payment_intent: pi3 } } });
    expect((await db.getBooking(b3.id))!.refund_status).toBe('none'); // a failure of a refund this booking never recorded is ignored (R15 H1)
    await post({ id: eventId(), type: 'refund.updated', data: { object: { id: 're_f', status: 'pending', amount: 5000, payment_intent: pi3 } } });
    await post({ id: eventId(), type: 'refund.failed', data: { object: { id: 're_f', status: 'failed', amount: 5000, payment_intent: pi3 } } });
    expect((await db.getBooking(b3.id))!.refund_status).toBe('failed');
    await post({ id: eventId(), type: 'refund.failed', data: { object: { id: 're_f2', status: 'failed', amount: 3000, payment_intent: pi } } });
    expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
  });

  test('webhook: charge.dispute.created is audited and alerts the owner; nothing is refunded', async () => {
    const biz = await newBusiness();
    const b = await paidBooking(biz);
    const pi = (await db.getBooking(b.id))!.stripe_payment_intent_id!;
    const before = await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } });
    const ev = { id: eventId(), type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: pi, amount: 5000, reason: 'fraudulent', status: 'needs_response' } } };
    expect((await post(ev)).status).toBe(200);
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'payment.dispute_created', target: `booking:${b.id}` } });
    expect(audit).not.toBeNull(); expect((audit!.meta as { reason: string }).reason).toBe('fraudulent');
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(before + 1);
    expect((await db.getBooking(b.id))!.refund_status).toBe('none');
    await post(ev); // replay: one audit row
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'payment.dispute_created' } })).toBe(1);
  });

  test('webhook: charge.dispute.* sets bookings.dispute_status (open -> won / lost), monotonic and replay-safe', async () => {
    const biz = await newBusiness();
    const b = await paidBooking(biz);
    const lost = await paidBooking(biz);
    const pi = (await db.getBooking(b.id))!.stripe_payment_intent_id!;
    const piLost = (await db.getBooking(lost.id))!.stripe_payment_intent_id!;
    const d = (type: string, payment_intent: string, status: string) => post({ id: eventId(), type, data: { object: { id: 'dp_x', payment_intent, amount: 5000, status, reason: 'general' } } });
    expect((await db.getBooking(b.id))!.dispute_status).toBe('none');
    await d('charge.dispute.created', pi, 'needs_response');
    expect((await db.getBooking(b.id))!.dispute_status).toBe('open');
    await d('charge.dispute.updated', pi, 'under_review');
    expect((await db.getBooking(b.id))!.dispute_status).toBe('open');
    await d('charge.dispute.closed', pi, 'won');
    expect((await db.getBooking(b.id))!.dispute_status).toBe('won');
    await d('charge.dispute.updated', pi, 'needs_response'); // a late, reordered event never reopens a settled dispute
    expect((await db.getBooking(b.id))!.dispute_status).toBe('won');
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'payment.dispute_updated', target: `booking:${b.id}` } })).toBe(1);

    await d('charge.dispute.created', piLost, 'needs_response');
    const alerts = await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } });
    await d('charge.dispute.closed', piLost, 'lost');
    expect((await db.getBooking(lost.id))!.dispute_status).toBe('lost');
    expect(await prisma.smsLog.count({ where: { businessId: biz.id, kind: 'owner_alert' } })).toBe(alerts + 1); // a loss is worth a text
    // the other booking's dispute is untouched, and the unknown payment is ignored
    expect((await db.getBooking(b.id))!.dispute_status).toBe('won');
    expect((await d('charge.dispute.closed', 'pi_unknown', 'lost')).status).toBe(200);
  });

  // ---------------------------------------------------------------- recording proxy

  test('recording proxy: consent, tenant, auth, Range, no raw provider URL, audit, no key -> 503', async () => {
    const biz = await newBusiness(); const other = await newBusiness();
    const owner = await login(biz.id); const foreign = await login(other.id);
    const conv = `conv_${uniq('r').replace(/[^A-Za-z0-9]/g, '')}`;
    const call = await db.createCall({ business_id: biz.id, caller_phone: phone(), conversation_id: conv, status: 'completed' });
    await prisma.call.update({ where: { id: call.id }, data: { consentStatus: 'disclosed' } });
    const noConsent = await db.createCall({ business_id: biz.id, caller_phone: phone(), conversation_id: `conv_${uniq('n').replace(/[^A-Za-z0-9]/g, '')}`, status: 'completed' });
    await prisma.call.update({ where: { id: noConsent.id }, data: { consentStatus: 'declined' } });
    const audio = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
    const seen: { url: string; key: string | null }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      seen.push({ url, key: new Headers(init?.headers).get('xi-api-key') });
      return new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof fetch;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi_test_key' }, async () => {
        const get = (id: string, who: Who, headers: Record<string, string> = {}) => audioRoute(req(`/api/calls/${id}/audio`, who, undefined, 'GET', headers), ctx(id));
        expect((await get(call.id, null)).status).toBe(401);
        expect((await get(call.id, foreign)).status).toBe(404); // another tenant: like a missing call
        expect((await get(noConsent.id, owner)).status).toBe(404); // consent was declined
        expect(seen.length).toBe(0);
        const r = await get(call.id, owner);
        expect(r.status).toBe(200);
        expect(r.headers.get('cache-control')).toContain('no-store'); expect(r.headers.get('accept-ranges')).toBe('bytes'); expect(r.headers.get('content-type')).toBe('audio/mpeg');
        expect((await r.arrayBuffer()).byteLength).toBe(300);
        expect(seen[0].url).toBe(`https://api.elevenlabs.io/v1/convai/conversations/${conv}/audio`);
        expect(seen[0].key).toBe('xi_test_key');
        for (const [k, v] of r.headers) expect(`${k}:${v}`).not.toMatch(/elevenlabs|xi_test_key/i);
        // Range: served from the short in-memory cache (no second provider call)
        const part = await get(call.id, owner, { range: 'bytes=100-199' });
        expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe('bytes 100-199/300');
        expect(new Uint8Array(await part.arrayBuffer())[0]).toBe(100);
        expect(seen.length).toBe(1);
        expect((await get(call.id, owner, { range: 'bytes=900-' })).status).toBe(416);
        // one audit row for the listen; seeks are not logged again
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'call.recording_played', target: `call:${call.id}` } })).toBe(1);
      });
      await withEnv({ ELEVENLABS_API_KEY: undefined }, async () => {
        (await import('@/lib/voice/recording-audio')).clearRecordingCache();
        expect((await audioRoute(req(`/api/calls/${call.id}/audio`, owner), ctx(call.id))).status).toBe(503);
      });
    } finally { globalThis.fetch = saved; }
  });

  // ---------------------------------------------------------------- voice selection

  test('voice: allowlist validation, owner only, saved + audited; disabled without a key; preview only for allowed voices', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const foreign = await login((await newBusiness()).id);
    const providerVoices = { voices: [
      { voice_id: 'premade00001', name: 'Rachel', category: 'premade', preview_url: 'https://samples.test/rachel.mp3', labels: { gender: 'female' } },
      { voice_id: 'cloned000001', name: 'Someone', category: 'cloned', preview_url: 'https://samples.test/x.mp3' },
    ] };
    const saved = globalThis.fetch; const patched: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url === 'https://api.elevenlabs.io/v1/voices') return new Response(JSON.stringify(providerVoices), { status: 200 });
      if (url === 'https://samples.test/rachel.mp3') return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      if (init?.method === 'PATCH' || init?.method === 'POST' || url.includes('/convai/')) { patched.push(`${init?.method ?? 'GET'} ${url}`); return new Response('{}', { status: 500 }); }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      const put = (id: string, who: Who, body: unknown) => voiceRoute.PUT(req(`/api/businesses/${id}/voice`, who, body, 'PUT'), ctx(id));
      // without a provider key: disabled
      const off = await voiceRoute.GET(req(`/api/businesses/${biz.id}/voice`, owner), ctx(biz.id));
      expect((await json<{ available: boolean; voices: unknown[] }>(off)).data).toMatchObject({ available: false, voices: [] });
      expect((await put(biz.id, owner, { voice_id: 'premade00001' })).status).toBe(503);
      await withEnv({ ELEVENLABS_API_KEY: 'xi_k' }, async () => {
        const list = (await json<{ available: boolean; voices: { voice_id: string; has_preview: boolean }[] }>(await voiceRoute.GET(req(`/api/businesses/${biz.id}/voice`, owner), ctx(biz.id)))).data!;
        expect(list.available).toBe(true); expect(list.voices.map((v) => v.voice_id)).toEqual(['premade00001']);
        expect(JSON.stringify(list)).not.toContain('samples.test'); // no provider URL to the browser
        for (const bad of ['cloned000001', 'not a voice', '../../x', 7, '', undefined]) expect((await put(biz.id, owner, { voice_id: bad })).status).toBe(422);
        expect((await put(biz.id, owner, { voice_id: 'premade00001', extra: 1 })).status).toBe(422);
        expect((await put(biz.id, staff, { voice_id: 'premade00001' })).status).toBe(403);
        expect((await put(biz.id, foreign, { voice_id: 'premade00001' })).status).toBe(404);
        expect((await put(biz.id, { cookie: owner.cookie, site: 'cross-site' }, { voice_id: 'premade00001' })).status).toBe(403);
        expect((await db.getBusiness(biz.id))!.voice_id ?? null).toBeNull();
        const ok = await put(biz.id, owner, { voice_id: 'premade00001' });
        expect(ok.status).toBe(200);
        expect((await db.getBusiness(biz.id))!).toMatchObject({ voice_id: 'premade00001', voice_name: 'Rachel' });
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.voice_changed' } })).toBe(1);
        expect(patched.some((p) => p.includes('/convai/agents/'))).toBe(true); // the agent was re-synced (the fake provider refused: synced=false)
        expect((await json<{ synced: boolean }>(ok)).data!.synced).toBe(false);
        // back to the default
        expect((await put(biz.id, owner, { voice_id: null })).status).toBe(200);
        expect((await db.getBusiness(biz.id))!.voice_id ?? null).toBeNull();
        // preview: allowed voice only
        const pv = await previewRoute(req(`/api/businesses/${biz.id}/voice/preview?voice_id=premade00001`, owner), ctx(biz.id));
        expect(pv.status).toBe(200); expect(pv.headers.get('content-type')).toBe('audio/mpeg');
        expect((await previewRoute(req(`/api/businesses/${biz.id}/voice/preview?voice_id=cloned000001`, owner), ctx(biz.id))).status).toBe(404);
      });
    } finally { globalThis.fetch = saved; }
  });

  test('voice id reaches the agent body (tts.voice_id) and defaults otherwise', async () => {
    const biz = await newBusiness();
    await db.updateBusiness(biz.id, { voice_id: 'premade00001', voice_name: 'Rachel' });
    const bodies: Record<string, unknown>[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/convai/tools') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      if (url.includes('/convai/tools')) return new Response(JSON.stringify({ id: 'tool_x' }), { status: 200 });
      if (url.includes('/convai/agents/')) { bodies.push(JSON.parse(String(init?.body ?? '{}'))); return new Response(JSON.stringify({ agent_id: biz.agent_id }), { status: 200 }); }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await withEnv({ ELEVENLABS_API_KEY: 'xi_k' }, async () => {
        const el = await import('@/lib/voice/elevenlabs');
        el.clearToolIdCache();
        await el.createOrUpdateAgent({ business: (await db.getBusiness(biz.id))!, kb: null });
        const tts = (bodies[0]?.conversation_config as { tts?: { voice_id?: string } } | undefined)?.tts;
        expect(tts?.voice_id).toBe('premade00001');
        const toolIds = (bodies[0]?.conversation_config as { agent: { prompt: { tool_ids: string[] } } }).agent.prompt.tool_ids;
        expect(toolIds.length).toBeGreaterThan(0);
      });
    } finally { globalThis.fetch = saved; }
  });

  // ---------------------------------------------------------------- refund policy settings

  test('refund policy settings: validation, escaping-safe text, owner only, audited', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id); const staff = await login(biz.id, 'staff');
    const put = (who: Who, body: unknown) => policyRoute.PUT(req(`/api/businesses/${biz.id}/refund-policy`, who, body, 'PUT'), ctx(biz.id));
    expect((await put(owner, { refund_policy: 'sometimes' })).status).toBe(422);
    expect((await put(owner, { refund_policy_text: 'x'.repeat(2001) })).status).toBe(422);
    expect((await put(owner, { refund_policy_text: 5 })).status).toBe(422);
    expect((await put(owner, { other: 1 })).status).toBe(422);
    expect((await put(staff, { refund_policy: 'none' })).status).toBe(403);
    const r = await put(owner, { refund_policy: 'full_48h', refund_policy_text: '  <script>alert(1)</script>\u0007 Call us.\r\n\r\nThanks  ' });
    expect(r.status).toBe(200);
    const b = (await db.getBusiness(biz.id))!;
    expect(b.refund_policy).toBe('full_48h');
    expect(b.refund_policy_text).toBe('<script>alert(1)</script> Call us.\n\nThanks'); // stored as plain text; React escapes it on render
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.refund_policy_changed' } })).toBe(1);
    expect((await put(owner, { refund_policy_text: '' })).status).toBe(200);
    expect((await db.getBusiness(biz.id))!.refund_policy_text ?? null).toBeNull();
  });

  // ---------------------------------------------------------------- readiness gate

  test('provision: a thin KB is refused (422 kb_incomplete) for an owner before anything is bought; an admin may override', async () => {
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { phone: null } });
    await db.upsertKnowledgeBase(biz.id, { services: [{ name: 'Tune-up', base_price: 99 }], faqs: [], pricing_notes: '', system_prompt: `You are the receptionist for ${biz.name}.`, call_script: '' } as never);
    const owner = await login(biz.id);
    const before = outboundCalls.length;
    const r = await provisionRoute(req(`/api/businesses/${biz.id}/provision`, owner, {}), ctx(biz.id));
    expect(r.status).toBe(422);
    const j = await json(r) as { code?: string; blockers?: { key: string }[] };
    expect(j.code).toBe('kb_incomplete');
    expect(j.blockers!.map((b) => b.key).sort()).toEqual(['content', 'faqs', 'service_area', 'services']); // + the service area the owner must give and the go-live confirmation
    expect((await db.getBusiness(biz.id))!.phone ?? null).toBeNull(); // nothing was bought
    expect(outboundCalls.length).toBe(before);
    // complete the KB: the gate opens (the rest of provisioning is exercised in provision-numbers.test.ts)
    await db.upsertKnowledgeBase(biz.id, {
      services: [{ name: 'A', base_price: 90 }, { name: 'B', base_price: 120 }, { name: 'C', base_price: 200 }], faqs: [{ question: 'Hours?', answer: 'Daily 8-6.' }], pricing_notes: '',
      system_prompt: `You are the receptionist for ${biz.name}.`, call_script: '',
    } as never);
    await confirmGoLive(biz.id);
    const open = await provisionRoute(req(`/api/businesses/${biz.id}/provision`, owner, {}), ctx(biz.id));
    expect(open.status).not.toBe(422);
  });

  // ---------------------------------------------------------------- review 14 (report 13)
  test('R14 H2: while a refund is pending only the SAME amount may be re-sent; a different amount can never create a second Stripe refund', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok', status: 'pending' });
    try {
      await withStripe(async () => {
        const first = await refundReq(b.id, owner, { amount_cents: 2000 });
        expect((await json<{ status: string }>(first)).data!.status).toBe('pending');
        expect(stripe.calls.length).toBe(1);
        const other = await refundReq(b.id, owner, { amount_cents: 3000 }); // "partial" edited while it still says processing
        expect(other.status).toBe(409);
        expect((await json(other)).code).toBe('in_progress');
        const full = await refundReq(b.id, owner, {}); // the whole deposit is a different amount too
        expect(full.status).toBe(409);
        expect(stripe.calls.length).toBe(1); // NOTHING new reached Stripe
        expect((await db.getBooking(b.id))).toMatchObject({ refund_status: 'pending', refund_amount_cents: 2000 });
        // the exact replay is allowed and reuses the key (Stripe answers with the same refund)
        expect((await refundReq(b.id, owner, { amount_cents: 2000 })).status).toBe(200);
        expect(stripe.calls.length).toBe(2);
        expect(stripe.calls[1].key).toBe(stripe.calls[0].key);
        // after Stripe reports the refund FAILED (webhook), another amount may go out, under a NEW key
        const reId = (await db.getBooking(b.id))!.stripe_refund_id!;
        const ev = { id: eventId(), type: 'refund.failed', data: { object: { id: reId, status: 'failed', amount: 2000, payment_intent: (await db.getBooking(b.id))!.stripe_payment_intent_id } } };
        expect((await post(ev)).status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('failed');
        expect((await refundReq(b.id, owner, { amount_cents: 3000 })).status).toBe(200);
        expect(stripe.calls[2].key).toBe(`rc-refund-${b.id}-3000-a1`);
      });
    } finally { stripe.restore(); }
  });

  test('R14 M1: a refund that fails asynchronously (webhook) counts as a failed attempt, so the retry is not a cached replay', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok', status: 'pending' });
    try {
      await withStripe(async () => {
        await refundReq(b.id, owner, {});
        expect(stripe.calls[0].key).toBe(`rc-refund-${b.id}-5000`);
        const fresh = (await db.getBooking(b.id))!;
        const ev = { id: eventId(), type: 'refund.updated', data: { object: { id: fresh.stripe_refund_id, status: 'failed', amount: 5000, payment_intent: fresh.stripe_payment_intent_id } } };
        expect((await post(ev)).status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('failed');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(1);
        await refundReq(b.id, owner, {});
        expect(stripe.calls[1].key).toBe(`rc-refund-${b.id}-5000-a1`); // not the first key: Stripe would replay the cached first response for 24 h
      });
    } finally { stripe.restore(); }
  });

  test('R15 H1: a late failure event for an OLDER refund changes nothing (no failed status, no audit row, no new key, no second live refund)', async () => {
    const biz = await newBusiness({ owner_phone: '+13055550188', owner_verified: true } as never); const owner = await login(biz.id);
    const b = await paidBooking(biz);
    const stripe = fakeStripe({ kind: 'ok', status: 'pending' });
    try {
      await withStripe(async () => {
        expect((await refundReq(b.id, owner, { amount_cents: 2000 })).status).toBe(200);
        const r0 = (await db.getBooking(b.id))!.stripe_refund_id!;
        const pi = (await db.getBooking(b.id))!.stripe_payment_intent_id;
        const failed = (id: string, type = 'refund.failed') => ({ id: eventId(), type, data: { object: { id, status: 'failed', amount: 2000, payment_intent: pi } } });
        expect((await post(failed(r0))).status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('failed');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(1);
        // the owner retries: a NEW refund r1 is pending under the second key
        expect((await refundReq(b.id, owner, { amount_cents: 2000 })).status).toBe(200);
        expect(stripe.calls[1].key).toBe(`rc-refund-${b.id}-2000-a1`);
        const r1 = (await db.getBooking(b.id))!.stripe_refund_id!;
        expect(r1).not.toBe(r0);
        const texts = await prisma.smsLog.count({ where: { bookingId: b.id } });
        // the sibling event (refund.updated, failed) and a redelivery of the first one for r0 arrive late
        for (const ev of [failed(r0, 'refund.updated'), failed(r0)]) expect((await post(ev)).status).toBe(200);
        expect(await db.getBooking(b.id)).toMatchObject({ refund_status: 'pending', stripe_refund_id: r1 });
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(1);
        expect(await prisma.smsLog.count({ where: { bookingId: b.id } })).toBe(texts);
        // the retry while r1 is pending reuses r1's key: Stripe returns r1, not a third refund
        expect((await refundReq(b.id, owner, { amount_cents: 2000 })).status).toBe(200);
        expect(stripe.calls.map((c) => c.key)).toEqual([`rc-refund-${b.id}-2000`, `rc-refund-${b.id}-2000-a1`, `rc-refund-${b.id}-2000-a1`]);
        // the CURRENT refund failing still works, and an event with no refund id is never matched
        expect((await post({ id: eventId(), type: 'refund.failed', data: { object: { status: 'failed', amount: 2000, payment_intent: pi } } })).status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending');
        // (this fake Stripe is not idempotent: the third call returned a new id, which is now the booking's current refund)
        const current = (await db.getBooking(b.id))!.stripe_refund_id!;
        expect((await post(failed(current))).status).toBe(200);
        expect((await db.getBooking(b.id))!.refund_status).toBe('failed');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(2);
      });
    } finally { stripe.restore(); }
  });

  test('R15 L2: a second payment link deactivates the first; a cancelled booking gets no new link and a link that raced the cancel is deactivated', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await booking(biz.id, { status: 'confirmed' });
    const { rememberPaymentLink } = await import('@/lib/payments/link-store');
    const calls: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : (input as Request).url} ${String(init?.body ?? '')}`);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await withStripe(async () => {
        await rememberPaymentLink(b.id, 'plink_1AaaaaAAAA111');
        expect(calls).toEqual([]); // the first link has nothing to replace
        await rememberPaymentLink(b.id, 'plink_1BbbbbBBBB222'); // e.g. the dashboard after the voice tool
        expect(calls).toEqual(['POST https://api.stripe.com/v1/payment_links/plink_1AaaaaAAAA111 active=false']);
        expect(await db.getBookingPaymentLinkId(b.id)).toBe('plink_1BbbbbBBBB222');
        // the booking is cancelled (the cancel already ran and deactivated what it knew); a link whose creation raced it is deactivated at once
        await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
        calls.length = 0;
        await rememberPaymentLink(b.id, 'plink_1CcccCCCC333');
        expect(calls).toContain('POST https://api.stripe.com/v1/payment_links/plink_1CcccCCCC333 active=false');
        expect(calls).toContain('POST https://api.stripe.com/v1/payment_links/plink_1BbbbbBBBB222 active=false');
        // and no new link is created for a cancelled booking (dashboard route and SMS route)
        calls.length = 0;
        const createLink = (await import('@/app/api/payments/create-link/route')).POST;
        const r = await createLink(req('/api/payments/create-link', owner, { business_id: biz.id, booking_id: b.id, amount_cents: 4000 }));
        expect(r.status).toBe(409);
        const smsLink = (await import('@/app/api/sms/payment-link/route')).POST;
        const r2 = await smsLink(req('/api/sms/payment-link', owner, { business_id: biz.id, booking_id: b.id, amount_cents: 4000 }));
        expect(r2.status).toBe(409);
        expect(calls.filter((c) => c.includes('payment_links') && !c.includes('active=false'))).toEqual([]); // nothing was created at Stripe
      });
    } finally { globalThis.fetch = saved; }
  });

  test('R14 L1: cancelling deactivates the deposit link; a payment that still arrives for a cancelled booking alerts the owner and reopens the refund', async () => {
    const biz = await newBusiness({ owner_phone: '+13055550177', owner_verified: true } as never); const owner = await login(biz.id);
    const b = await booking(biz.id, { status: 'confirmed' });
    expect(await db.setBookingPaymentLink(b.id, 'mock_link_1')).toBe(false); // mock links have nothing to deactivate
    expect(await db.setBookingPaymentLink(b.id, 'plink_1AbCdEf123456')).toBe(true);
    const calls: { url: string; body: string; method: string }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push({ url, body: String(init?.body ?? ''), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await withStripe(async () => {
        const r = await oneRoute.PATCH(req(`/api/bookings/${b.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(b.id));
        expect(r.status).toBe(200);
        await flushLinks(); // the deactivation runs in the background (report 17 M4): the cancel never waits for Stripe
        expect(calls).toEqual([{ url: 'https://api.stripe.com/v1/payment_links/plink_1AbCdEf123456', body: 'active=false', method: 'POST' }]);
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.payment_link_deactivated', target: `booking:${b.id}` } })).toBe(1);
        expect((await db.getBooking(b.id))!.refund_status).toBe('not_applicable'); // no deposit at cancel time
      });
    } finally { globalThis.fetch = saved; }
    // the link was paid anyway (the deactivation failed / the customer already had the checkout open)
    const res = await post({ id: eventId(), type: 'checkout.session.completed', data: { object: { id: `cs_${uniq('c').replace(/[^A-Za-z0-9]/g, '')}`, payment_intent: `pi_${uniq('p').replace(/[^A-Za-z0-9]/g, '')}`, amount_total: 4000, payment_status: 'paid', metadata: { booking_id: b.id, business_id: biz.id } } } });
    expect(res.status).toBe(200);
    const after = (await db.getBooking(b.id))!;
    expect(after).toMatchObject({ status: 'cancelled', deposit_paid: true, deposit_amount: 4000, refund_status: 'none' }); // refund offered again
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'payment.paid_for_cancelled_booking', target: `booking:${b.id}` } })).toBe(1);
    expect((await prisma.smsLog.findFirst({ where: { businessId: biz.id, kind: 'owner_alert', bookingId: b.id }, orderBy: { createdAt: 'desc' } }))?.body).toContain('CANCELLED booking');
  });
  // ---------------------------------------------------------------- residual gaps (reports 13 H2, 13 L1)

  /** A Stripe whose refund LIST and Payment-Link list answer from the given data; POST /refunds behaves like fakeStripe. */
  function stripeWith(o: { refunds?: { id: string; status: string; amount: number; created?: number; metadata?: Record<string, string> }[]; links?: { id: string; metadata?: Record<string, string> }[]; down?: boolean; post?: 'ok' | 'timeout' } = {}) {
    const calls: { method: string; url: string; key: string | null; body: string }[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, key: new Headers(init?.headers).get('idempotency-key'), body: String(init?.body ?? '') });
      if (o.down) throw new DOMException('down', 'TimeoutError');
      if (url.startsWith('https://api.stripe.com/v1/refunds') && method === 'GET') return new Response(JSON.stringify({ data: o.refunds ?? [] }), { status: 200 });
      if (url.startsWith('https://api.stripe.com/v1/refunds') && method === 'POST') {
        if (o.post === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        const b = new URLSearchParams(String(init?.body ?? ''));
        return new Response(JSON.stringify({ id: `re_new_${calls.length}`, status: 'succeeded', amount: Number(b.get('amount')), payment_intent: b.get('payment_intent') }), { status: 200 });
      }
      if (url.startsWith('https://api.stripe.com/v1/payment_links?')) {
        const all = o.links ?? [];
        const q = new URL(url).searchParams;
        const start = q.get('starting_after') ? all.findIndex((l) => l.id === q.get('starting_after')) + 1 : 0;
        const page = all.slice(start, start + 2); // tiny pages to exercise paging
        return new Response(JSON.stringify({ data: page, has_more: start + 2 < all.length }), { status: 200 });
      }
      if (url.startsWith('https://api.stripe.com/v1/payment_links/') && method === 'POST') return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = saved; } };
  }
  const checkReq = async (id: string, who: Who) => (await import('@/app/api/bookings/[id]/refund/check/route')).POST(req(`/api/bookings/${id}/refund/check`, who, {}), ctx(id));
  const age = (id: string, ms: number) => prisma.booking.update({ where: { id }, data: { refundRequestedAt: new Date(Date.now() - ms) } });

  test('residual H2: a refund that never reached Stripe is recovered with "check with Stripe": too early, then failed so the retry uses a NEW key; audited, step-up, owner only', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const foreign = await login((await newBusiness()).id);
    const b = await paidBooking(biz);
    const lost = stripeWith({ post: 'timeout', refunds: [] });
    try {
      await withStripe(async () => {
        expect((await refundReq(b.id, owner, {})).status).toBe(502); // outcome unknown: pending forever
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending');
        expect((await prisma.booking.findUnique({ where: { id: b.id } }))!.refundRequestedAt).not.toBeNull();
        // a retry of the same amount is still the only thing the app allows; a different amount is refused (it could be a SECOND refund)
        expect((await refundReq(b.id, owner, { amount_cents: 1000 })).status).toBe(409);
        // access: staff 403, another tenant 404, unauthenticated 401, stale step-up 403 reauth_required
        expect((await checkReq(b.id, staff)).status).toBe(403);
        expect((await checkReq(b.id, foreign)).status).toBe(404);
        expect((await checkReq(b.id, null)).status).toBe(401);
        await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date(Date.now() - 3_600_000) } });
        const stale = await checkReq(b.id, owner);
        expect(stale.status).toBe(403);
        expect((await json(stale)).code).toBe('reauth_required');
        await prisma.userSession.updateMany({ where: { userId: owner.user.id }, data: { sudoAt: new Date() } });
        // the attempt is a minute old and Stripe lists nothing: too early to conclude it never arrived
        const early = await checkReq(b.id, owner);
        expect(early.status).toBe(409);
        expect((await json(early)).code).toBe('too_early');
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending');
        // an hour later: it never reached Stripe, so it is marked failed (never creates a refund)
        await age(b.id, 3_600_000);
        const before = lost.calls.filter((c) => c.method === 'POST').length;
        const done = await json<{ result: string; booking: { refund_status: string } }>(await checkReq(b.id, owner));
        expect(done.data).toMatchObject({ result: 'marked_failed', booking: { refund_status: 'failed' } });
        expect(lost.calls.filter((c) => c.method === 'POST').length).toBe(before); // read only towards Stripe
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_checked', target: `booking:${b.id}` } })).toBe(1);
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(1);
        // idempotent: a second check has nothing pending
        expect((await checkReq(b.id, owner)).status).toBe(409);
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_checked', target: `booking:${b.id}` } })).toBe(1);
      });
    } finally { lost.restore(); }
    // the retry is allowed and uses the NEXT key (a new Stripe request)
    const ok = stripeWith({});
    try {
      await withStripe(async () => {
        expect((await refundReq(b.id, owner, {})).status).toBe(200);
        expect(ok.calls.find((c) => c.method === 'POST')!.key).toBe(`rc-refund-${b.id}-5000-a1`);
        expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
      });
    } finally { ok.restore(); }
  });

  test('residual H2: when Stripe DID make the refund the check adopts it (id, status, one customer text); a processing one is adopted once; a failed one frees the retry; other refunds are ignored', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const mk = async () => { const b = await paidBooking(biz); await prisma.booking.update({ where: { id: b.id }, data: { refundStatus: 'pending', refundAmountCents: 5000 } }); await age(b.id, 3_600_000); return b; };
    // (a) succeeded at Stripe, the answer was lost
    const a = await mk();
    let st = stripeWith({ refunds: [{ id: 're_other', status: 'succeeded', amount: 5000, metadata: { booking_id: 'someone-else' } }, { id: 're_wrong_amount', status: 'succeeded', amount: 1000, metadata: { booking_id: a.id } }, { id: 're_mine', status: 'succeeded', amount: 5000, metadata: { booking_id: a.id } }] });
    try {
      await withStripe(async () => {
        const texts = await prisma.smsLog.count({ where: { bookingId: a.id } });
        const r = await json<{ result: string; refund_id: string }>(await checkReq(a.id, owner));
        expect(r.data).toMatchObject({ result: 'adopted_refunded', refund_id: 're_mine' });
        expect(await db.getBooking(a.id)).toMatchObject({ refund_status: 'refunded', stripe_refund_id: 're_mine', refund_amount_cents: 5000 });
        expect(await prisma.smsLog.count({ where: { bookingId: a.id } })).toBe(texts + 1);
        expect((await checkReq(a.id, owner)).status).toBe(409); // not pending any more: no second text
        expect(await prisma.smsLog.count({ where: { bookingId: a.id } })).toBe(texts + 1);
      });
    } finally { st.restore(); }
    // (b) still processing: adopted once, then unchanged without more audit rows
    const b = await mk();
    st = stripeWith({ refunds: [{ id: 're_proc', status: 'pending', amount: 5000, metadata: { booking_id: b.id } }] });
    try {
      await withStripe(async () => {
        expect((await json<{ result: string }>(await checkReq(b.id, owner))).data!.result).toBe('adopted_pending');
        expect(await db.getBooking(b.id)).toMatchObject({ refund_status: 'pending', stripe_refund_id: 're_proc' });
        expect((await json<{ result: string }>(await checkReq(b.id, owner))).data!.result).toBe('unchanged');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_checked', target: `booking:${b.id}` } })).toBe(1);
      });
    } finally { st.restore(); }
    // (c) failed at Stripe: marked failed (the retry key moves on)
    const c = await mk();
    st = stripeWith({ refunds: [{ id: 're_dead', status: 'failed', amount: 5000, metadata: { booking_id: c.id } }] });
    try {
      await withStripe(async () => {
        expect((await json<{ result: string }>(await checkReq(c.id, owner))).data!.result).toBe('marked_failed');
        expect((await db.getBooking(c.id))!.refund_status).toBe('failed');
      });
    } finally { st.restore(); }
    // (d) Stripe unreachable: 502, nothing changes; no payment reference: 409
    const d = await mk();
    st = stripeWith({ down: true });
    try {
      await withStripe(async () => {
        const r = await checkReq(d.id, owner);
        expect(r.status).toBe(502);
        expect((await json(r)).code).toBe('unavailable');
        expect((await db.getBooking(d.id))!.refund_status).toBe('pending');
      });
    } finally { st.restore(); }
    const e = await mk();
    await prisma.booking.update({ where: { id: e.id }, data: { stripePaymentIntentId: null } });
    st = stripeWith({});
    try { await withStripe(async () => { expect((await json(await checkReq(e.id, owner))).code).toBe('no_payment_reference'); }); } finally { st.restore(); }
  });

  test('residual H2: the reconcile job resolves refunds that stayed pending past REFUND_RECONCILE_AFTER_HOURS, as the system, and leaves younger ones alone', async () => {
    const { reconcileStuckRefunds } = await import('@/lib/refund-service');
    const biz = await newBusiness();
    const old = await paidBooking(biz); const young = await paidBooking(biz);
    for (const b of [old, young]) await prisma.booking.update({ where: { id: b.id }, data: { refundStatus: 'pending', refundAmountCents: 5000 } });
    await age(old.id, 7 * 3_600_000); await age(young.id, 3_600_000);
    const st = stripeWith({ refunds: [] });
    try {
      await withStripe(async () => {
        const r = await reconcileStuckRefunds({ fetchImpl: globalThis.fetch, env: { REFUND_RECONCILE_AFTER_HOURS: '6' } });
        expect(r.items.find((i) => i.booking_id === old.id)?.outcome).toBe('marked_failed');
        expect(r.items.find((i) => i.booking_id === young.id)).toBeUndefined();
        expect((await db.getBooking(old.id))!.refund_status).toBe('failed');
        expect((await db.getBooking(young.id))!.refund_status).toBe('pending');
        const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'booking.refund_checked', target: `booking:${old.id}` } });
        expect(audit?.actorKind).toBe('system');
      });
    } finally { st.restore(); }
  });

  test('residual L1 / 17 M4: cancelling a booking whose link was texted but whose id was never stored finds its payment link(s) in Stripe by metadata, in the BACKGROUND (bounded pages, tenant scoped, audited)', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const other = await booking(biz.id, { status: 'confirmed' });
    const b = await booking(biz.id, { status: 'confirmed' });
    expect(await prisma.booking.findUnique({ where: { id: b.id }, select: { stripePaymentLinkId: true } })).toMatchObject({ stripePaymentLinkId: null });
    await textedLink(biz.id, b.id); // a legacy link: texted before the id was stored
    const foreignBiz = await newBusiness();
    const st = stripeWith({ links: [
      { id: 'plink_1OtherBooking001', metadata: { booking_id: other.id } }, { id: 'plink_1NoMetadata00001' }, { id: 'plink_1MineFirst000001', metadata: { booking_id: b.id } },
      { id: 'plink_1WrongTenant0001', metadata: { booking_id: b.id, business_id: foreignBiz.id } }, // same booking id but another tenant: never touched
      { id: 'plink_1BeyondTheBound01', metadata: { booking_id: b.id } }, // page 3: beyond the 2-page background bound (documented)
    ] });
    try {
      await withStripe(async () => {
        const r = await oneRoute.PATCH(req(`/api/bookings/${b.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(b.id));
        expect(r.status).toBe(200);
        await flushLinks();
        const deactivated = st.calls.filter((c) => c.method === 'POST' && c.url.includes('/payment_links/')).map((c) => c.url.split('/').pop());
        expect(deactivated).toEqual(['plink_1MineFirst000001']);
        expect(st.calls.filter((c) => c.url.includes('/payment_links?')).length).toBe(2); // 5 links in pages of 2, at most 2 pages
        const audits = await prisma.auditEvent.findMany({ where: { businessId: biz.id, action: 'booking.payment_link_deactivated', target: `booking:${b.id}` } });
        expect(audits.length).toBe(1);
        expect(audits.every((a) => (a.meta as { via?: string }).via === 'stripe_lookup')).toBe(true);
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: b.id } })).toBe(0); // done: nothing left to retry
      });
    } finally { st.restore(); }
    // a STORED id is used as before, with no lookup at all
    const c = await booking(biz.id, { status: 'confirmed' });
    expect(await db.setBookingPaymentLink(c.id, 'plink_1StoredLink00001')).toBe(true);
    const st2 = stripeWith({ links: [{ id: 'plink_1ShouldNotBeSeen01', metadata: { booking_id: c.id } }] });
    try {
      await withStripe(async () => {
        expect((await oneRoute.PATCH(req(`/api/bookings/${c.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(c.id))).status).toBe(200);
        await flushLinks();
        expect(st2.calls.map((x) => `${x.method} ${x.url}`)).toEqual(['POST https://api.stripe.com/v1/payment_links/plink_1StoredLink00001']);
      });
    } finally { st2.restore(); }
    // no Stripe key (dev / demo): nothing is looked up
    const e = await booking(biz.id, { status: 'confirmed' });
    await textedLink(biz.id, e.id);
    const st4 = stripeWith({ links: [{ id: 'plink_1NeverCalled0001', metadata: { booking_id: e.id } }] });
    try { expect((await oneRoute.PATCH(req(`/api/bookings/${e.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(e.id))).status).toBe(200); await flushLinks(); expect(st4.calls.length).toBe(0); } finally { st4.restore(); }
  });

  test('17 M4: a booking that never had a deposit link causes NO Stripe call at all on cancel (no account-wide payment-link paging)', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await booking(biz.id, { status: 'confirmed' });
    const st = stripeWith({ links: [{ id: 'plink_1WouldMatch000001', metadata: { booking_id: b.id } }] });
    try {
      await withStripe(async () => {
        expect((await oneRoute.PATCH(req(`/api/bookings/${b.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(b.id))).status).toBe(200);
        await flushLinks();
        expect(st.calls).toEqual([]);
      });
    } finally { st.restore(); }
  });

  test('17 M4: a slow Stripe never delays the cancel; a failed deactivation stays queued and the reconcile job finishes it', async () => {
    const link = await import('@/lib/payments/link-store');
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await booking(biz.id, { status: 'confirmed' });
    expect(await db.setBookingPaymentLink(b.id, 'plink_1SlowStripe00001')).toBe(true);
    const saved = globalThis.fetch;
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async () => { await gate; return new Response('{}', { status: 200 }); }) as typeof fetch; // Stripe is slow until released
    try {
      await withStripe(async () => {
        const t0 = Date.now();
        const res = await oneRoute.PATCH(req(`/api/bookings/${b.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(b.id));
        expect(res.status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(3000); // Stripe is still "thinking": the cancel did not wait for it
        expect((await db.getBooking(b.id))!.status).toBe('cancelled');
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: b.id } })).toBe(1); // durable
        release(); await link.flushLinkDeactivations();
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: b.id } })).toBe(0);
      });
    } finally { globalThis.fetch = saved; }
    // Stripe down at cancel time: the marker stays, and the job retries it later (after the 2 minute spacing)
    const c = await booking(biz.id, { status: 'confirmed' });
    expect(await db.setBookingPaymentLink(c.id, 'plink_1StripeWasDown01')).toBe(true);
    globalThis.fetch = (async () => { throw new DOMException('down', 'TimeoutError'); }) as typeof fetch;
    try {
      await withStripe(async () => {
        expect((await oneRoute.PATCH(req(`/api/bookings/${c.id}`, owner, { status: 'cancelled', notify: false }, 'PATCH'), ctx(c.id))).status).toBe(200);
        await link.flushLinkDeactivations();
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: c.id } })).toBe(1);
        const before = (await prisma.processedEvent.findUnique({ where: { source_id: { source: 'link-deactivate', id: c.id } } }))!.claimedAt.getTime();
        await link.drainLinkDeactivations({ now: new Date(before + 1000) }); // too soon (2 minute spacing): the first attempt was just made, so this row is left alone
        expect((await prisma.processedEvent.findUnique({ where: { source_id: { source: 'link-deactivate', id: c.id } } }))!.claimedAt.getTime()).toBe(before);
      });
    } finally { globalThis.fetch = saved; }
    const st = stripeWith({});
    try {
      await withStripe(async () => {
        const marker = (await prisma.processedEvent.findUnique({ where: { source_id: { source: 'link-deactivate', id: c.id } } }))!.claimedAt.getTime();
        const rep = await link.drainLinkDeactivations({ now: new Date(marker + 5 * 60_000) });
        expect(rep.done).toBeGreaterThanOrEqual(1);
        expect(st.calls.map((x) => x.url)).toContain('https://api.stripe.com/v1/payment_links/plink_1StripeWasDown01');
        expect(await prisma.processedEvent.count({ where: { source: 'link-deactivate', id: c.id } })).toBe(0);
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.payment_link_deactivated', target: `booking:${c.id}` } })).toBe(1);
      });
    } finally { st.restore(); }
  });

  // ---------------------------------------------------------------- report 17: refund recovery

  const pendingRefund = async (biz: { id: string }, o: { ageMs?: number; refundId?: string | null; amount?: number } = {}) => {
    const b = await paidBooking(biz);
    await prisma.booking.update({ where: { id: b.id }, data: { refundStatus: 'pending', refundAmountCents: o.amount ?? 5000, refundRequestedAt: new Date(Date.now() - (o.ageMs ?? 7 * 3_600_000)), ...(o.refundId ? { stripeRefundId: o.refundId } : {}) } });
    return b;
  };

  test('17 H1: a refund made in the Stripe dashboard and recorded as pending is matched by its stored id: still processing -> unchanged (never "never reached Stripe", no second refund); succeeded -> refunded; failed -> failed', async () => {
    const { reconcileStuckRefunds } = await import('@/lib/refund-service');
    const biz = await newBusiness(); const owner = await login(biz.id);
    // processing, no metadata, a different amount than the booking's recorded one: found by id
    const b = await pendingRefund(biz, { refundId: 're_dash1' });
    let st = stripeWith({ refunds: [{ id: 're_dash1', status: 'pending', amount: 3000, metadata: {} }] });
    try {
      await withStripe(async () => {
        const r = await reconcileStuckRefunds({ fetchImpl: globalThis.fetch, env: { REFUND_RECONCILE_AFTER_HOURS: '6' } });
        expect(r.items.find((i) => i.booking_id === b.id)?.outcome).toBe('unchanged');
        expect(await db.getBooking(b.id)).toMatchObject({ refund_status: 'pending', stripe_refund_id: 're_dash1' });
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(0);
        // the owner clicking Refund again while it processes must NOT create a second refund
        const again = await refundReq(b.id, owner, {});
        expect(again.status).toBe(409);
        expect(st.calls.filter((c) => c.method === 'POST' && c.url.includes('/refunds'))).toEqual([]);
      });
    } finally { st.restore(); }
    // now Stripe says it succeeded
    st = stripeWith({ refunds: [{ id: 're_dash1', status: 'succeeded', amount: 3000, metadata: {} }] });
    try { await withStripe(async () => { expect((await json<{ result: string }>(await checkReq(b.id, owner))).data!.result).toBe('adopted_refunded'); }); } finally { st.restore(); }
    expect((await db.getBooking(b.id))!.refund_status).toBe('refunded');
    // and a dashboard refund that failed
    const f = await pendingRefund(biz, { refundId: 're_dash2' });
    st = stripeWith({ refunds: [{ id: 're_dash2', status: 'failed', amount: 5000, metadata: {} }] });
    try { await withStripe(async () => { expect((await json<{ result: string }>(await checkReq(f.id, owner))).data!.result).toBe('marked_failed'); }); } finally { st.restore(); }
  });

  test('17 H1: a LIVE refund on the payment that this app did not make for this attempt blocks "never reached Stripe" (409 foreign_refund, nothing changes)', async () => {
    const { reconcileStuckRefunds } = await import('@/lib/refund-service');
    const biz = await newBusiness(); const owner = await login(biz.id);
    const b = await pendingRefund(biz); // no stored refund id: our own attempt never got an answer
    const st = stripeWith({ refunds: [{ id: 're_unknown1', status: 'pending', amount: 2000, metadata: {} }, { id: 're_old_dead', status: 'failed', amount: 5000, metadata: {} }] });
    try {
      await withStripe(async () => {
        const res = await checkReq(b.id, owner);
        expect(res.status).toBe(409);
        expect((await json(res)).code).toBe('foreign_refund');
        const rec = await reconcileStuckRefunds({ fetchImpl: globalThis.fetch, env: { REFUND_RECONCILE_AFTER_HOURS: '6' } });
        expect(rec.items.find((i) => i.booking_id === b.id)?.outcome).toBe('foreign_refund');
        expect((await db.getBooking(b.id))!.refund_status).toBe('pending');
        expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'booking.refund_failed', target: `booking:${b.id}` } })).toBe(0);
      });
    } finally { st.restore(); }
  });

  test('17 M2: an OLDER failed attempt of the same amount does not stand for the current attempt: the age gate still applies; a failure created after the attempt is definitive', async () => {
    const biz = await newBusiness(); const owner = await login(biz.id);
    const nowS = Math.floor(Date.now() / 1000);
    // attempt 2 was recorded a minute ago; Stripe lists only attempt 1's failed refund (created an hour ago)
    const young = await pendingRefund(biz, { ageMs: 60_000 });
    let st = stripeWith({ refunds: [{ id: 're_attempt1', status: 'failed', amount: 5000, created: nowS - 3600, metadata: { booking_id: young.id } }] });
    try {
      await withStripe(async () => {
        const res = await checkReq(young.id, owner);
        expect(res.status).toBe(409);
        expect((await json(res)).code).toBe('too_early');
        expect((await db.getBooking(young.id))!.refund_status).toBe('pending');
      });
    } finally { st.restore(); }
    // an hour later and still only the old failed refund: now it is "never reached Stripe"
    const old = await pendingRefund(biz, { ageMs: 3_600_000 });
    st = stripeWith({ refunds: [{ id: 're_attempt1b', status: 'failed', amount: 5000, created: nowS - 7200, metadata: { booking_id: old.id } }] });
    try { await withStripe(async () => { expect((await json<{ result: string }>(await checkReq(old.id, owner))).data!.result).toBe('marked_failed'); }); } finally { st.restore(); }
    // a failed refund created AFTER the attempt is this attempt's own failure: definitive at once
    const mine = await pendingRefund(biz, { ageMs: 60_000 });
    st = stripeWith({ refunds: [{ id: 're_attempt2', status: 'failed', amount: 5000, created: nowS, metadata: { booking_id: mine.id } }] });
    try { await withStripe(async () => { expect((await json<{ result: string }>(await checkReq(mine.id, owner))).data!.result).toBe('marked_failed'); }); } finally { st.restore(); }
  });

  test('17 L6: the stuck-refund pass is fair: refunds Stripe keeps processing do not fill the window; each pass looks at the least recently checked', async () => {
    const { reconcileStuckRefunds } = await import('@/lib/refund-service');
    const biz = await newBusiness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pendingRefund(biz, { refundId: `re_slow${i}_${uniq('r')}` })).id);
    const rows = await prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, stripeRefundId: true } });
    const st = stripeWith({ refunds: rows.map((r) => ({ id: r.stripeRefundId!, status: 'pending', amount: 5000, metadata: {} })) });
    try {
      await withStripe(async () => {
        // the production path (claims, no fetchImpl): two per pass, then the third, then nothing for an hour
        const seen: string[] = [];
        for (let pass = 0; pass < 3; pass++) {
          const r = await reconcileStuckRefunds({ limit: 2, env: { REFUND_RECONCILE_AFTER_HOURS: '6' } });
          for (const i of r.items) if (ids.includes(i.booking_id)) seen.push(i.booking_id);
        }
        expect(new Set(seen).size).toBe(3); // all three were looked at, none starved
        expect(seen.length).toBe(3); // and none twice within the hour
      });
    } finally { st.restore(); }
  });

});
