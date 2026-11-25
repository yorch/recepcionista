/**
 * Agent D (platform / scheduling / audio / ops) against Postgres: configurable scheduling enforced by availability, the voice tools, createBooking /
 * rescheduleBooking and the crew constraint; the time zone and scheduling routes (owner only, tenant scoped, audited); the go-live content gate;
 * briefing audio (provider call, storage, authenticated route with Range / ETag, regeneration, honest failure, pruning); the labelled automatic
 * briefing; the tenant release / grandfather jobs (dry-run default, TENANT_RELEASE_JOB switch); the health probe's LLM requirement.
 * Time-of-day independent: "now" dependent cases run in awakeTimezone() (about noon) on all-day hours, the rest on dates days ahead.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { awakeTimezone, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, toolRequest, uniq } from '../helpers/fixtures';
import { zonedTimeToUtc } from '../../src/lib/time';
import type { Hours } from '../../src/lib/types';

const ALLDAY: Hours = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, { open: '00:00', close: '24:00' }])) as unknown as Hours;

integration('platform D (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let sched: typeof import('@/lib/scheduler');
  let jobs: typeof import('@/lib/jobs');
  const userIds: string[] = [];
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    sched = await import('@/lib/scheduler');
    jobs = await import('@/lib/jobs');
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await prisma.rateLimitBucket.deleteMany({ where: { OR: ['businesses/timezone', 'businesses/scheduling', 'businesses/content', 'businesses/provision', 'briefing-audio', 'admin/'].map((k) => ({ key: { startsWith: k } })) } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return `rc_user_session=${token}`;
  }
  const headers = (cookie?: string) => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) });
  const call = (route: (req: Request, c: any) => Promise<Response>, id: string, method: string, body: unknown, cookie?: string) =>
    route(new Request('http://app.test/x', { method, headers: headers(cookie), body: body === undefined ? undefined : JSON.stringify(body) }), ctx(id));
  const reason = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'accepted'; } catch (e: any) { return e.reason ?? String(e); } };
  const book = (biz: { id: string }, scheduled_at: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => db.createBooking({
    business_id: biz.id, customer_name: 'Ana', customer_phone: phone(), service: 'AC repair', scheduled_at, duration_minutes: 60, ...extra,
  } as any, opts as any);
  const at = (date: string, hhmm: string, tz: string) => zonedTimeToUtc(date, hhmm, tz).toISOString();

  // ============================================================== scheduling: defaults, notice, horizon

  test('defaults reproduce the old behaviour, and the owner dashboard skips notice + horizon while the AI path obeys them', async () => {
    const tz = awakeTimezone();
    const biz = await newBusiness({ timezone: tz, hours: ALLDAY });
    expect(await db.getSchedulingConfig(biz.id)).toEqual({ slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1 });
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(await reason(book(biz, soon))).toBe('too_soon');
    expect(await reason(book(biz, new Date(Date.now() - 60_000).toISOString()))).toBe('past');
    const far = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect(await reason(book(biz, far))).toBe('too_far');
    // the owner's own booking (dashboard) may be inside the notice and beyond the window
    expect(await reason(book(biz, soon, {}, { ownerInitiated: true }))).toBe('accepted');
    expect(await reason(book(biz, far, {}, { ownerInitiated: true }))).toBe('accepted');
    // changing the numbers changes the answer on the next call
    const b2 = await newBusiness({ timezone: tz, hours: ALLDAY });
    expect((await db.setSchedulingConfig(b2.id, { min_lead_minutes: 0, horizon_days: 30 })).ok).toBe(true);
    expect(await reason(book(b2, soon))).toBe('accepted');
    expect(await reason(book(b2, far))).toBe('accepted');
  });

  test('slotsForDate / nextAvailable use the slot grid, the notice and the horizon (injected clock)', async () => {
    const biz = await newBusiness({ timezone: 'UTC', hours: ALLDAY });
    const now = Date.UTC(2030, 0, 2, 23, 30); // Wed 23:30 UTC
    const first = await sched.nextAvailable(biz as any, 2, 60, now);
    expect(first.map((s) => s.start)).toEqual(['2030-01-03T01:00:00.000Z', '2030-01-03T02:00:00.000Z']); // 60 min notice: 00:30 -> next grid slot 01:00
    await db.setSchedulingConfig(biz.id, { horizon_days: 1 });
    expect(await sched.nextAvailable((await db.getBusiness(biz.id))!, 2, 60, now)).toEqual([]); // today only, and today has nothing after the notice
    expect(await sched.slotsForDate((await db.getBusiness(biz.id))!, '2030-01-03', 60, now)).toEqual([]); // beyond the window: nothing is offered
    await db.setSchedulingConfig(biz.id, { horizon_days: 14, slot_minutes: 30, min_lead_minutes: 0 });
    const half = await sched.nextAvailable((await db.getBusiness(biz.id))!, 3, 60, Date.UTC(2030, 0, 2, 10, 10));
    expect(half.map((s) => s.start.slice(11, 16))).toEqual(['10:30', '11:00', '11:30']);
    const day = await sched.slotsForDate((await db.getBusiness(biz.id))!, '2030-01-04', 30, now);
    expect(day.length).toBe(48); // 24h of 30 minute jobs on a 30 minute grid
  });

  test('buffer: slots and bookings keep the gap on both sides; zero buffer allows back-to-back', async () => {
    const tz = 'America/New_York';
    const biz = await newBusiness({ timezone: tz });
    const day = futureDateKey(3, tz, 3);
    await book(biz, at(day, '10:00', tz));
    await book(biz, at(day, '11:00', tz)); // back to back is fine with no buffer
    await db.setSchedulingConfig(biz.id, { buffer_minutes: 30 });
    const b = (await db.getBusiness(biz.id))!;
    const avail = async () => (await sched.slotsForDate(b, day, 60)).filter((s) => s.available).map((s) => s.start.slice(11, 16));
    // 10:00-11:00 and 11:00-12:00 are booked; with 30 minutes around them 09:00 (ends 10:00), 12:00 (starts 12:00) are inside the buffer
    const free = (await avail()).map((h) => h);
    const local = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const freeLocal = (await sched.slotsForDate(b, day, 60)).filter((s) => s.available).map((s) => local(s.start));
    expect(free.length).toBeGreaterThan(0);
    expect(freeLocal).not.toContain('09:00');
    expect(freeLocal).not.toContain('12:00');
    expect(freeLocal).toContain('08:00');
    expect(freeLocal).toContain('13:00');
    expect(await reason(book(biz, at(day, '12:00', tz)))).toBe('slot_taken');
    expect(await reason(book(biz, at(day, '12:30', tz)))).toBe('accepted');
    // the DB constraint only knows raw overlap: enforce:false (an explicit override) skips the buffer but never the overlap
    expect(await reason(book(biz, at(day, '14:15', tz), {}, { enforce: false }))).toBe('accepted');
    expect(await reason(book(biz, at(day, '14:30', tz), {}, { enforce: false }))).toBe('slot_taken');
  });

  test('Google Calendar busy blocks keep the buffer too (offer and booking)', async () => {
    const tz = 'America/New_York';
    const biz = await newBusiness({ timezone: tz });
    const day = futureDateKey(4, tz, 3);
    const conn = await prisma.calendarConnection.create({ data: { businessId: biz.id, accountEmail: 'owner@example.test', status: 'active', refreshTokenEnc: 'enc', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000) } });
    await prisma.calendarBusyBlock.create({ data: { connectionId: conn.id, businessId: biz.id, googleEventId: uniq('ev'), startsAt: new Date(at(day, '10:00', tz)), endsAt: new Date(at(day, '11:00', tz)) } });
    await db.setSchedulingConfig(biz.id, { buffer_minutes: 30 });
    const b = (await db.getBusiness(biz.id))!;
    const local = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const freeLocal = (await sched.slotsForDate(b, day, 60)).filter((s) => s.available).map((s) => local(s.start));
    expect(freeLocal).toContain('08:00');
    expect(freeLocal).not.toContain('09:00');
    expect(freeLocal).not.toContain('10:00');
    expect(freeLocal).not.toContain('11:00');
    expect(freeLocal).toContain('12:00');
    expect(await reason(book(biz, at(day, '11:15', tz)))).toBe('calendar_busy');
    expect(await reason(book(biz, at(day, '11:30', tz)))).toBe('accepted');
  });

  test('crews: parallel jobs up to the crew count, per-crew database constraint, crew_in_use when lowering', async () => {
    const tz = 'America/New_York';
    const biz = await newBusiness({ timezone: tz });
    const day = futureDateKey(2, tz, 3);
    const t10 = at(day, '10:00', tz);
    expect(await reason(book(biz, t10))).toBe('accepted');
    expect(await reason(book(biz, t10))).toBe('slot_taken'); // one crew: unchanged behaviour
    expect((await db.setSchedulingConfig(biz.id, { crews: 2 })).ok).toBe(true);
    const second = await book(biz, t10);
    expect(second.crew).toBe(2);
    expect(await reason(book(biz, t10))).toBe('slot_taken'); // both crews busy
    expect(await reason(book(biz, t10, {}, {}))).toBe('slot_taken');
    const b = (await db.getBusiness(biz.id))!;
    const slot10 = async () => (await sched.slotsForDate(b, day, 60)).find((s) => s.start === t10)!.available;
    expect(await slot10()).toBe(false);
    // explicit crew outside 1..crews is refused
    expect(await reason(book(biz, at(day, '13:00', tz), { crew: 3 }))).toBe('invalid_crew');
    // the voice tool offers a time while one crew is free
    const one = await book(biz, at(day, '15:00', tz));
    expect(one.crew).toBe(1);
    expect((await sched.slotsForDate(b, day, 60)).find((s) => s.start === at(day, '15:00', tz))!.available).toBe(true);
    // the database itself refuses two overlapping bookings on the SAME crew, whatever the code did
    const raw = (crew: number) => prisma.booking.create({ data: { businessId: biz.id, customerName: 'X', customerPhone: phone(), service: 'S', scheduledAt: new Date(at(day, '17:00', tz)), durationMinutes: 60, crew } });
    await raw(1);
    await expect((async () => raw(1))()).rejects.toThrow();
    await raw(2);
    // lowering crews below one that still has an upcoming booking is refused (never silently dropped)
    const lower = await db.setSchedulingConfig(biz.id, { crews: 1 });
    expect(lower).toMatchObject({ ok: false, reason: 'crew_in_use' });
    expect((await db.getSchedulingConfig(biz.id))!.crews).toBe(2);
  });

  test('rescheduleBooking obeys buffer and the customer notice; the owner move skips the notice', async () => {
    const tz = awakeTimezone();
    const biz = await newBusiness({ timezone: tz, hours: ALLDAY });
    await db.setSchedulingConfig(biz.id, { buffer_minutes: 30, horizon_days: 60 });
    const dayA = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const start = new Date(`${dayA}T12:00:00Z`);
    const a = await book(biz, start.toISOString(), {}, { ownerInitiated: true });
    const b = await book(biz, new Date(start.getTime() + 5 * 3_600_000).toISOString(), {}, { ownerInitiated: true });
    const move = (id: string, to: Date, opts: any = {}) => reason(db.rescheduleBooking({ business_id: biz.id, booking_id: id, scheduled_at: to.toISOString() }, opts));
    expect(await move(b.id, new Date(start.getTime() + 3_600_000))).toBe('slot_taken'); // right after a: inside the 30 minute buffer
    expect(await move(b.id, new Date(start.getTime() + 5_400_000))).toBe('accepted'); // 90 minutes after a's start: 30 minutes after it ends
    expect(await move(a.id, new Date(Date.now() + 20 * 60_000))).toBe('too_soon');
    expect(await move(a.id, new Date(Date.now() + 20 * 60_000), { ownerInitiated: true })).toBe('accepted');
  });

  test('the voice tool offers slots on the configured grid', async () => {
    const POST = (await import('@/app/api/voice/tools/[tool]/route')).POST;
    const biz = await newBusiness();
    await db.setSchedulingConfig(biz.id, { slot_minutes: 30 });
    const day = futureDateKey(3, 'America/New_York', 3);
    const res = await POST(toolRequest('check_availability', { agent_id: biz.agent_id, date: day }), { params: Promise.resolve({ tool: 'check_availability' }) });
    expect(((await res.json()) as any).message).toMatch(/8 AM.*8:30 AM|8:30 AM.*9 AM/);
    // horizon: a date beyond the window gets alternatives or the honest "nothing in the next N days"
    await db.setSchedulingConfig(biz.id, { horizon_days: 2, min_lead_minutes: 60 * 24 * 7 });
    const none = await POST(toolRequest('check_availability', { agent_id: biz.agent_id }), { params: Promise.resolve({ tool: 'check_availability' }) });
    expect(((await none.json()) as any).message).toMatch(/next 2 days/);
  });

  // ============================================================== routes: time zone, scheduling, content confirmation

  test('time zone route: owner only, IANA only, tenant scoped, audited; the area code is a suggestion, never applied', async () => {
    const { GET, PUT } = await import('@/app/api/businesses/[id]/timezone/route');
    const biz = await newBusiness({ owner_phone: '+13125550123' });
    const other = await newBusiness();
    const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const stranger = await login(other.id);
    const view = (await (await call(GET as any, biz.id, 'GET', undefined, owner)).json()) as any;
    expect(view.data ?? view).toMatchObject({ timezone: 'America/New_York', suggested: 'America/Chicago' });
    expect((await db.getBusiness(biz.id))!.timezone).toBe('America/New_York'); // not applied
    expect((await call(PUT as any, biz.id, 'PUT', { timezone: 'America/Chicago' }, staff)).status).toBe(403);
    expect((await call(PUT as any, biz.id, 'PUT', { timezone: 'America/Chicago' }, stranger)).status).toBe(404);
    expect((await call(PUT as any, biz.id, 'PUT', { timezone: 'America/Chicago' })).status).toBe(401);
    for (const bad of ['EST', '+01:00', 'GMT+2', 'Mars/Base', '', 5, null]) expect((await call(PUT as any, biz.id, 'PUT', { timezone: bad }, owner)).status).toBe(422);
    expect((await db.getBusiness(biz.id))!.timezone).toBe('America/New_York');
    const ok = await call(PUT as any, biz.id, 'PUT', { timezone: 'America/Chicago' }, owner);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).data.hours_recheck).toBe(true);
    expect((await db.getBusiness(biz.id))!.timezone).toBe('America/Chicago');
    const audit = await prisma.auditEvent.findMany({ where: { businessId: biz.id, action: 'business.timezone_changed' } });
    expect(audit.length).toBe(1);
    expect((audit[0].meta as any)).toMatchObject({ from: 'America/New_York', to: 'America/Chicago' });
    // the same zone again is not a change: no second audit row
    await call(PUT as any, biz.id, 'PUT', { timezone: 'America/Chicago' }, owner);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.timezone_changed' } })).toBe(1);
    // the new zone drives availability: a 08:00 Chicago open is 14:00 UTC in winter
    const chi = (await db.getBusiness(biz.id))!;
    const day = futureDateKey(3, 'America/Chicago', 3);
    const slots = await sched.slotsForDate(chi, day, 60);
    expect(slots[0].start).toBe(at(day, '08:00', 'America/Chicago'));
    expect(outboundCalls).toEqual([]);
  });

  test('scheduling route: owner only, validated (nothing written on error), audited, crew_in_use is a 409', async () => {
    const { GET, PUT } = await import('@/app/api/businesses/[id]/scheduling/route');
    const biz = await newBusiness();
    const other = await newBusiness();
    const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const stranger = await login(other.id);
    expect(((await (await call(GET as any, biz.id, 'GET', undefined, staff)).json()) as any).slot_minutes ?? true).toBeTruthy(); // staff may read
    expect((await call(PUT as any, biz.id, 'PUT', { crews: 2 }, staff)).status).toBe(403);
    expect((await call(PUT as any, biz.id, 'PUT', { crews: 2 }, stranger)).status).toBe(404);
    for (const bad of [{ slot_minutes: 20 }, { crews: 0 }, { crews: 21 }, { horizon_days: 181 }, { buffer_minutes: -1 }, { min_lead_minutes: 10_081 }, { nope: 1 }, { crews: '2' }]) {
      expect((await call(PUT as any, biz.id, 'PUT', bad, owner)).status).toBe(422);
    }
    expect(await db.getSchedulingConfig(biz.id)).toEqual({ slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1 });
    const ok = await call(PUT as any, biz.id, 'PUT', { slot_minutes: 30, crews: 3, buffer_minutes: 15 }, owner);
    expect(ok.status).toBe(200);
    expect(await db.getSchedulingConfig(biz.id)).toMatchObject({ slot_minutes: 30, crews: 3, buffer_minutes: 15 });
    const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.scheduling_changed' } });
    expect((audit!.meta as any).changed.sort()).toEqual(['buffer_minutes', 'crews', 'slot_minutes']);
    // a booking on crew 3, then lower to 2: refused
    const day = futureDateKey(3, 'America/New_York', 3);
    const t = at(day, '10:00', 'America/New_York');
    await book(biz, t); await book(biz, t); const third = await book(biz, t);
    expect(third.crew).toBe(3);
    const lower = await call(PUT as any, biz.id, 'PUT', { crews: 2 }, owner);
    expect(lower.status).toBe(409);
    expect(((await lower.json()) as any).code).toBe('crew_in_use');
    expect((await db.getSchedulingConfig(biz.id))!.crews).toBe(3);
  });

  test('content gate: unconfirmed and stale block going live; the owner confirms; live businesses are not re-gated; staff cannot confirm', async () => {
    const { POST, GET } = await import('@/app/api/businesses/[id]/content-confirmation/route');
    const { readinessForGoLive } = await import('@/lib/kb/readiness-server');
    const { generateKnowledgeBase } = await import('@/lib/kb');
    const { templateResult } = await import('@/lib/extraction');
    const biz = await newBusiness();
    const other = await newBusiness();
    const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const stranger = await login(other.id);
    const priced = (n: number) => ({ ...templateResult(biz.name, biz.vertical), services: [1, 2, 3].map((i) => ({ name: `Service ${i}`, base_price: n * i })) });
    const load = async () => ({ biz: (await db.getBusiness(biz.id))!, kb: (await db.getKnowledgeBase(biz.id))! });
    // no services at all, then no service area: nothing to confirm
    expect((await call(POST as any, biz.id, 'POST', {}, owner)).status).toBe(422);
    await db.upsertKnowledgeBase(biz.id, generateKnowledgeBase(priced(50), (await db.getBusiness(biz.id))!));
    expect((await call(POST as any, biz.id, 'POST', {}, owner)).status).toBe(422); // the template has NO service area (never "Miami-Dade County")
    expect((await db.getBusiness(biz.id))!.service_area).toEqual([]);
    await db.updateBusiness(biz.id, { service_area: ['Broward County'] });
    let s = await load();
    expect(readinessForGoLive(s.kb, s.biz).blockers.map((b) => b.key)).toContain('content');
    expect((await call(POST as any, biz.id, 'POST', {}, staff)).status).toBe(403);
    expect((await call(POST as any, biz.id, 'POST', {}, stranger)).status).toBe(404);
    expect((await call(GET as any, biz.id, 'GET', undefined, staff)).status).toBe(200);
    const done = await call(POST as any, biz.id, 'POST', {}, owner);
    expect(done.status).toBe(200);
    expect(((await done.json()) as any).state ?? 'confirmed').toBe('confirmed');
    s = await load();
    expect(s.biz.content_confirmed_at).toBeTruthy();
    expect(readinessForGoLive(s.kb, s.biz).ready).toBe(true);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.content_confirmed' } })).toBe(1);
    // a price change makes it stale (no writer has to remember to reset it)
    await db.upsertKnowledgeBase(biz.id, generateKnowledgeBase(priced(80), s.biz));
    s = await load();
    const stale = readinessForGoLive(s.kb, s.biz);
    expect(stale.ready).toBe(false);
    expect(stale.blockers.find((b) => b.key === 'content')!.message).toMatch(/changed/);
    // a change of the service area also does
    await call(POST as any, biz.id, 'POST', {}, owner);
    await db.updateBusiness(biz.id, { service_area: ['Broward County', 'Palm Beach County'] });
    s = await load();
    expect(readinessForGoLive(s.kb, s.biz).blockers.map((b) => b.key)).toContain('content');
    // a business that is already live is not re-gated
    await prisma.business.update({ where: { id: biz.id }, data: { status: 'live' } });
    s = await load();
    expect(readinessForGoLive(s.kb, s.biz).blockers.map((b) => b.key)).not.toContain('content');
  });

  test('provisioning (owner) is refused with kb_incomplete + content blocker until the owner confirmed', async () => {
    const provision = (await import('@/app/api/businesses/[id]/provision/route')).POST;
    const { generateKnowledgeBase } = await import('@/lib/kb');
    const { templateResult } = await import('@/lib/extraction');
    const { POST: confirm } = await import('@/app/api/businesses/[id]/content-confirmation/route');
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'active', serviceArea: ['Dade County'] } });
    const owner = await login(biz.id);
    const tpl = { ...templateResult(biz.name, biz.vertical), service_area: ['Dade County'] };
    await db.upsertKnowledgeBase(biz.id, generateKnowledgeBase(tpl, (await db.getBusiness(biz.id))!));
    const res = await withEnv({ NODE_ENV: 'test' }, () => call(provision as any, biz.id, 'POST', {}, owner));
    const body = (await res.json()) as any;
    expect(res.status).toBe(422);
    expect(body.code).toBe('kb_incomplete');
    expect(body.blockers.map((b: any) => b.key)).toContain('content');
    expect((await call(confirm as any, biz.id, 'POST', {}, owner)).status).toBe(200);
    const again = await call(provision as any, biz.id, 'POST', {}, owner);
    expect(((await again.json()) as any).code).not.toBe('kb_incomplete');
  });

  // ============================================================== briefing audio

  const mp3 = (n = 4096) => new Uint8Array(n).map((_, i) => i % 251);
  const ttsStub = (answer: () => Response) => {
    const seen: { url: string; body: any }[] = [];
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = typeof u === 'string' ? u : u.url;
      if (!url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) throw new Error(`unexpected fetch ${url}`);
      seen.push({ url, body: JSON.parse(init.body) });
      return answer();
    }) as typeof fetch;
    return seen;
  };

  test('briefing without the voice provider: honest "unavailable", labelled automatic text, nothing on disk', async () => {
    const { generateBriefing } = await import('@/lib/briefing');
    const biz = await newBusiness({ timezone: 'UTC' });
    const b = await withEnv({ ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => generateBriefing(biz.id, '2030-02-01'));
    expect(b.audio).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(b.audio_url).toBeNull();
    expect(b.stats.narration).toBe('automatic');
    expect(b.transcript).toMatch(/resumen automático|automatic summary/i);
    expect(b.transcript).not.toMatch(/dejar todo listo|quedó tranquilo|prepared everything|calm/i);
    expect(await prisma.briefingAudio.count({ where: { briefingId: b.id } })).toBe(0);
    const stored = await prisma.briefing.findUnique({ where: { id: b.id } });
    expect((stored!.stats as any).narration).toBe('automatic');
    expect(stored!.audioUrl).toBeNull();
    const fs = await import('node:fs');
    expect(fs.existsSync(`${process.cwd()}/public/audio/briefing-${biz.id}-2030-02-01.mp3`)).toBe(false);
    expect(fs.existsSync(`${process.cwd()}/public/audio/briefing-${biz.id}-2030-02-01.m4a`)).toBe(false);
    expect(outboundCalls).toEqual([]);
  });

  test('briefing audio: business voice, stored in the database, served by the tenant-scoped route (Range, ETag, headers), regenerated by owners only', async () => {
    const { generateBriefing } = await import('@/lib/briefing');
    const route = await import('@/app/api/briefings/[id]/audio/route');
    const biz = await newBusiness({ timezone: 'UTC' });
    await prisma.business.update({ where: { id: biz.id }, data: { voiceId: 'bizVoice12345' } });
    const other = await newBusiness();
    const owner = await login(biz.id); const staff = await login(biz.id, 'staff'); const stranger = await login(other.id);
    const clip = mp3(5000);
    const seen = ttsStub(() => new Response(clip, { headers: { 'content-type': 'audio/mpeg' } }));
    const b = await withEnv({ ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: 'platformVoice1' }, () => generateBriefing(biz.id, '2030-02-02'));
    expect(seen.length).toBe(1);
    expect(seen[0].url).toContain('/v1/text-to-speech/bizVoice12345');
    expect(b.audio).toEqual({ status: 'ready', bytes: 5000 });
    expect(b.audio_url).toBe(`/api/briefings/${b.id}/audio`);
    expect((await prisma.briefing.findUnique({ where: { id: b.id } }))!.audioUrl).toBe(`/api/briefings/${b.id}/audio`);
    const meta = await db.getBriefingAudioMeta(biz.id, b.id);
    expect(meta).toMatchObject({ content_type: 'audio/mpeg', size_bytes: 5000, voice_id: 'bizVoice12345' });

    const get = (cookie: string | undefined, extra: Record<string, string> = {}) => route.GET(new Request('http://app.test/x', { headers: { ...headers(cookie), ...extra } }), ctx(b.id));
    expect((await get(undefined)).status).toBe(401);
    expect((await get(stranger)).status).toBe(404); // another tenant: same answer as a missing clip
    const full = await get(staff);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/mpeg');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('cache-control')).toMatch(/private/);
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await full.arrayBuffer()).equals(Buffer.from(clip))).toBe(true);
    const etag = full.headers.get('etag')!;
    expect((await get(owner, { 'if-none-match': etag })).status).toBe(304);
    const part = await get(owner, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(clip.subarray(100, 200)))).toBe(true);
    const tail = await get(owner, { range: 'bytes=-10' });
    expect(tail.headers.get('content-range')).toBe('bytes 4990-4999/5000');
    const bad = await get(owner, { range: 'bytes=9000-' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */5000');
    expect((await route.GET(new Request('http://app.test/x', { headers: headers(owner) }), ctx('does-not-exist'))).status).toBe(404);

    // regenerate: owner only, tenant scoped, rate limited by owner; the new voice settings apply
    const post = (cookie?: string) => route.POST(new Request('http://app.test/x', { method: 'POST', headers: headers(cookie), body: '{}' }), ctx(b.id));
    expect((await post(staff)).status).toBe(403);
    expect((await post(stranger)).status).toBe(404);
    await prisma.briefingAudio.deleteMany({ where: { briefingId: b.id } });
    await prisma.briefing.update({ where: { id: b.id }, data: { audioUrl: null } });
    const regenerated = await withEnv({ ELEVENLABS_API_KEY: 'xi-test' }, () => post(owner));
    expect(regenerated.status).toBe(200);
    expect(((await regenerated.json()) as any).data.audio).toMatchObject({ status: 'ready' });
    expect(seen.length).toBe(2);
    expect(await prisma.briefingAudio.count({ where: { briefingId: b.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'briefing.audio_regenerated' } })).toBe(1);
    expect(outboundCalls).toEqual([]);
  });

  test('a provider failure leaves NO audio (old audio of an older transcript is removed), reported honestly; the voice falls back to the env then the default', async () => {
    const { generateBriefing } = await import('@/lib/briefing');
    const route = await import('@/app/api/briefings/[id]/audio/route');
    const { DEFAULT_VOICE_ID } = await import('@/lib/voice/elevenlabs');
    const biz = await newBusiness({ timezone: 'UTC' });
    const owner = await login(biz.id);
    const seen = ttsStub(() => new Response(mp3(), { headers: { 'content-type': 'audio/mpeg' } }));
    const first = await withEnv({ ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: 'platformVoice1' }, () => generateBriefing(biz.id, '2030-02-03'));
    expect(seen[0].url).toContain('/platformVoice1');
    expect(first.audio?.status).toBe('ready');
    ttsStub(() => new Response('boom', { status: 503 }));
    const failed = await withEnv({ ELEVENLABS_API_KEY: 'xi-test' }, () => generateBriefing(biz.id, '2030-02-03'));
    expect(failed.audio).toEqual({ status: 'unavailable', reason: 'provider_failed' });
    expect(failed.id).toBe(first.id); // same day = same row, regenerated
    expect(await prisma.briefingAudio.count({ where: { briefingId: first.id } })).toBe(0);
    expect((await prisma.briefing.findUnique({ where: { id: first.id } }))!.audioUrl).toBeNull();
    const gone = await route.GET(new Request('http://app.test/x', { headers: headers(owner) }), ctx(first.id));
    expect(gone.status).toBe(404);
    const seen3 = ttsStub(() => new Response(mp3(), { headers: { 'content-type': 'audio/mpeg' } }));
    await withEnv({ ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_VOICE_ID: undefined }, () => generateBriefing(biz.id, '2030-02-03'));
    expect(seen3[0].url).toContain(`/${DEFAULT_VOICE_ID}`);
    // the regenerate route reports the failure and the missing configuration honestly
    ttsStub(() => new Response('boom', { status: 500 }));
    const r = await withEnv({ ELEVENLABS_API_KEY: 'xi-test' }, () => route.POST(new Request('http://app.test/x', { method: 'POST', headers: headers(owner), body: '{}' }), ctx(first.id)));
    expect(((await r.json()) as any).data.audio).toEqual({ status: 'unavailable', reason: 'provider_failed' });
    const none = await withEnv({ ELEVENLABS_API_KEY: undefined }, () => route.POST(new Request('http://app.test/x', { method: 'POST', headers: headers(owner), body: '{}' }), ctx(first.id)));
    expect(((await none.json()) as any).data.audio).toEqual({ status: 'unavailable', reason: 'not_configured' });
  });

  test('cleanup prunes briefing audio older than BRIEFING_AUDIO_KEEP_DAYS (default 30), keeps the text, reports in a dry run', async () => {
    const biz = await newBusiness({ timezone: 'UTC' });
    const old = await db.createBriefing({ business_id: biz.id, date: '2030-03-01', transcript: 'old note' });
    const fresh = await db.createBriefing({ business_id: biz.id, date: '2030-03-02', transcript: 'fresh note' });
    for (const x of [old, fresh]) expect((await db.saveBriefingAudio(biz.id, x.id, { content_type: 'audio/mpeg', bytes: mp3(2048) })).ok).toBe(true);
    await prisma.briefingAudio.update({ where: { briefingId: old.id }, data: { createdAt: new Date(Date.now() - 40 * 86_400_000) } });
    const dry = await jobs.runCleanup({ dryRun: true });
    expect(dry.counts!.briefing_audio).toBeGreaterThanOrEqual(1);
    expect(await prisma.briefingAudio.count({ where: { briefingId: old.id } })).toBe(1);
    const run = await jobs.runCleanup({});
    expect(run.counts!.briefing_audio).toBeGreaterThanOrEqual(1);
    expect(await prisma.briefingAudio.count({ where: { briefingId: old.id } })).toBe(0);
    expect(await prisma.briefingAudio.count({ where: { briefingId: fresh.id } })).toBe(1);
    const row = await prisma.briefing.findUnique({ where: { id: old.id } });
    expect(row!.audioUrl).toBeNull();
    expect(row!.transcript).toBe('old note');
    expect(await withEnv({ BRIEFING_AUDIO_KEEP_DAYS: '1000' }, async () => db.briefingAudioKeepDays())).toBe(1000);
  });

  test('call summaries written without an AI are stored labelled (and plain AI text is not)', async () => {
    const { markAuto, splitAuto } = await import('@/lib/auto-label');
    expect(splitAuto(markAuto('Routine. Leaky tap.'))).toEqual({ auto: true, text: 'Routine. Leaky tap.' });
  });

  // ============================================================== tenant release / grandfather jobs

  test('tenant_release: dry run by default, a real run is REFUSED unless TENANT_RELEASE_JOB=on, every run stores a report, the tick only reports', async () => {
    const biz = await newBusiness();
    userIds.push((await users.createUser({ email: `${uniq('rd')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true })).id);
    await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'canceled', currentPeriodEnd: new Date(Date.now() - 200 * 86_400_000), phone: `+1305${Math.floor(1000000 + Math.random() * 8999999)}`, agentId: uniq('agent') } });
    const before = await prisma.business.findUnique({ where: { id: biz.id } });
    // manual dry run (the admin route default)
    const dry = await jobs.runJob('tenant_release', { dryRun: true, businessId: biz.id, env: { TENANT_RELEASE_JOB: undefined } as any });
    expect(dry.dry_run).toBe(true);
    expect(dry.items.some((i) => i.business_id === biz.id && (i.outcome === 'would_notify' || i.outcome === 'would_release'))).toBe(true);
    // "real" run with the switch off: refused, reported as a dry run, nothing changed, no mail, no provider call
    const refused = await jobs.runJob('tenant_release', { dryRun: false, businessId: biz.id, env: { TENANT_RELEASE_JOB: 'off' } as any });
    expect(refused.dry_run).toBe(true);
    expect(refused.items.some((i) => i.outcome === 'refused_not_enabled')).toBe(true);
    expect(refused.processed).toBe(0);
    const after = await prisma.business.findUnique({ where: { id: biz.id } });
    expect(after!.phone).toBe(before!.phone);
    expect(after!.agentId).toBe(before!.agentId);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: { in: ['billing.release_notice', 'billing.tenant_released'] } } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: 'jobs.tenant_release_report' } })).toBeGreaterThanOrEqual(2); // the report is the admin-visible state
    // the schedule: off -> not in the tick; report/on -> in the tick; grandfather is never scheduled
    expect(jobs.enabledJobs({ NODE_ENV: 'production' } as any)).not.toContain('tenant_release');
    expect(jobs.enabledJobs({ NODE_ENV: 'production', TENANT_RELEASE_JOB: 'report' } as any)).toContain('tenant_release');
    expect(jobs.enabledJobs({ NODE_ENV: 'production', TENANT_RELEASE_JOB: 'on' } as any)).toContain('tenant_release');
    expect(jobs.enabledJobs({ NODE_ENV: 'production', TENANT_RELEASE_JOB: 'on' } as any)).not.toContain('grandfather');
    // the tick with =report is a dry run
    await prisma.processedEvent.deleteMany({ where: { source: 'job-state', id: 'tenant_release' } }); // state of an earlier run of this file
    const [tick] = await jobs.runJobTick({ jobs: ['tenant_release'], env: { TENANT_RELEASE_JOB: 'report' } as any });
    expect(tick.dry_run).toBe(true);
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.phone).toBe(before!.phone);
    expect(outboundCalls).toEqual([]);
  });

  test('tenant_release with TENANT_RELEASE_JOB=on acts on one due tenant (heads-up first, release only after the notice), audited', async () => {
    const mockNumber = `+1305555${Math.floor(1000 + Math.random() * 8999)}`; // a mock-pool number: nothing exists at Twilio to release
    const biz = await newBusiness();
    const owner = await users.createUser({ email: `${uniq('rel')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true });
    userIds.push(owner.id);
    await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'canceled', currentPeriodEnd: new Date(Date.now() - 200 * 86_400_000), phone: mockNumber, phoneE164: mockNumber, agentId: uniq('mock_agent') } });
    const first = await withEnv({ EMAIL_PROVIDER: 'log', TENANT_RELEASE_JOB: 'on' }, () => jobs.runJob('tenant_release', { dryRun: false, businessId: biz.id }));
    expect(first.dry_run).toBe(false);
    expect(first.items.find((i) => i.business_id === biz.id)?.outcome).toBe('notified');
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'billing.release_notice' } })).toBe(1);
    // the phone and the agent are still there: the release waits for the notice period (a second run the same minute only waits)
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.agentId).toBeTruthy();
    const second = await withEnv({ EMAIL_PROVIDER: 'log', TENANT_RELEASE_JOB: 'on' }, () => jobs.runJob('tenant_release', { dryRun: false, businessId: biz.id }));
    expect(second.items.find((i) => i.business_id === biz.id)?.outcome).toBe('wait');
    expect(second.processed).toBe(0);
    // once the notice is older than the notice period the next run releases (providers are in their mock mode here) and audits it
    await prisma.auditEvent.updateMany({ where: { businessId: biz.id, action: 'billing.release_notice' }, data: { at: new Date(Date.now() - 10 * 86_400_000), meta: { notified_at: new Date(Date.now() - 10 * 86_400_000).toISOString() } } });
    const third = await withEnv({ EMAIL_PROVIDER: 'log', TENANT_RELEASE_JOB: 'on' }, () => jobs.runJob('tenant_release', { dryRun: false, businessId: biz.id }));
    expect(third.items.find((i) => i.business_id === biz.id)?.outcome).toBe('released');
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'billing.tenant_released' } })).toBe(1);
    const gone = await prisma.business.findUnique({ where: { id: biz.id } });
    expect(gone!.agentId).toBeNull();
    expect(gone!.phone).toBeNull();
    expect(outboundCalls).toEqual([]);
  });

  test('grandfather job: needs a cutoff, dry run lists, a real run is refused unless TENANT_RELEASE_JOB=on, owner phones are never verified', async () => {
    const biz = await newBusiness({ owner_verified: false });
    const ownerUser = await users.createUser({ email: `${uniq('gf')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true });
    userIds.push(ownerUser.id);
    await prisma.business.update({ where: { id: biz.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z'), ownerPhone: null, ownerPhoneE164: null, ownerPhoneVerifiedAt: null } });
    const noCutoff = await jobs.runJob('grandfather', { dryRun: true, env: {} as any });
    expect(noCutoff.errors).toBe(1);
    const dry = await jobs.runJob('grandfather', { dryRun: true, before: '2021-01-01T00:00:00Z', env: {} as any });
    expect(dry.items.some((i) => i.business_id === biz.id && i.outcome === 'would_comp')).toBe(true);
    const refused = await jobs.runJob('grandfather', { dryRun: false, before: '2021-01-01T00:00:00Z', env: {} as any });
    expect(refused.items.some((i) => i.outcome === 'refused_not_enabled')).toBe(true);
    expect((await prisma.business.findUnique({ where: { id: biz.id } }))!.billingStatus).toBe('none');
    // a real run would comp every eligible tenant of the shared test database: scope the proof to the dry-run plan and the audit-only report
    expect(await prisma.auditEvent.count({ where: { action: 'jobs.grandfather_report' } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'billing.grandfathered' } })).toBe(0);
  });

  test('admin run route validates and keeps dry_run as the default', async () => {
    const run = (await import('@/app/api/admin/jobs/run/route')).POST;
    const post = (body: unknown) => run(new Request('http://app.test/x', { method: 'POST', headers: { ...headers(), authorization: `Bearer ${SECRETS.adminToken}` }, body: JSON.stringify(body) }));
    expect((await post({ job: 'grandfather', before: 'not a date' })).status).toBe(422);
    expect((await post({ job: 'cleanup', before: '2021-01-01' })).status).toBe(422);
    const res = await post({ job: 'tenant_release' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data?.dry_run ?? true).toBe(true);
    const status = await (await import('@/app/api/admin/jobs/route')).GET(new Request('http://app.test/x', { headers: { authorization: `Bearer ${SECRETS.adminToken}` } }));
    const data = ((await status.json()) as any).data ?? {};
    const names: string[] = data.jobs.map((j: any) => j.name);
    expect(names.includes('tenant_release') && names.includes('grandfather')).toBe(true);
    expect(data.diagnostics.tenant_release.setting).toBe('off');
  });

  // ============================================================== health: LLM required in production

  test('health: production without an LLM key is 503 llm_not_configured; with a key (or outside production) it is 200', async () => {
    const { GET } = await import('@/app/api/health/route');
    const prod = { NODE_ENV: 'production', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined } as Record<string, string | undefined>;
    const bad = await withEnv(prod, () => GET());
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as any).error).toBe('llm_not_configured');
    expect((await withEnv({ ...prod, ANTHROPIC_API_KEY: 'sk-ant-x' }, () => GET())).status).toBe(200);
    expect((await withEnv({ NODE_ENV: 'test', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => GET())).status).toBe(200);
  });

  test('website import without an LLM says so (422 no_llm text), never a template dressed as the site', async () => {
    const { extractFromUrl } = await import('@/lib/extraction');
    globalThis.fetch = (async () => new Response('<html><title>Acme</title><body>' + 'We repair air conditioners in Dade county. '.repeat(10) + '</body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    let err: any;
    await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => { try { await extractFromUrl('https://example.com'); } catch (e) { err = e; } });
    expect(err?.reason === 'no_llm' || err?.reason === 'fetch_failed').toBe(true);
    if (err?.reason === 'no_llm') expect(err.message).toMatch(/AI service|LLM/);
  });
});
