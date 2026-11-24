/**
 * Google Calendar two-way sync against a FAKE Google (tests/helpers/fake-google.ts; no live Google): OAuth connect/callback (PKCE, signed
 * state), token refresh / revoked, push webhook auth, incremental + 410 sync, our-own-events exclusion, busy blocks vs availability and
 * createBooking (incl. concurrency), booking push idempotency + owner-edit conflicts, tenant isolation, CSRF, erasure, disconnect.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { ALL_WEEK, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, uniq } from '../helpers/fixtures';
import { FakeGoogle } from '../helpers/fake-google';
import { zonedTimeToUtc } from '../../src/lib/time';
import { isPublicPath } from '../../src/lib/auth';

const TZ = 'America/New_York';

integration('google calendar (postgres, fake google)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let cal: typeof import('@/lib/db/calendar');
  let sync: typeof import('@/lib/integrations/google/sync');
  let push: typeof import('@/lib/integrations/google/push');
  let watch: typeof import('@/lib/integrations/google/watch');
  let http: typeof import('@/lib/integrations/google/http');
  let sched: typeof import('@/lib/scheduler');
  let busy: typeof import('@/lib/integrations/google/busy');
  const fake = new FakeGoogle();
  const userIds: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_URL', 'APP_SECRET_KEY', 'GOOGLE_OAUTH_MOCK', 'NODE_ENV']) saved[k] = process.env[k];
    Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', APP_URL: 'https://app.example.test', APP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') });
    delete process.env.GOOGLE_OAUTH_MOCK;
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    cal = await import('@/lib/db/calendar');
    sync = await import('@/lib/integrations/google/sync');
    push = await import('@/lib/integrations/google/push');
    watch = await import('@/lib/integrations/google/watch');
    http = await import('@/lib/integrations/google/http');
    sched = await import('@/lib/scheduler');
    busy = await import('@/lib/integrations/google/busy');
    http.setGoogleFetch(fake.fetch);
  });
  afterAll(async () => {
    http.setGoogleFetch(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  beforeEach(() => { fake.events.clear(); fake.reset(); fake.refreshError = null; fake.failStatus = null; fake.gone = false; });
  afterEach(() => { http.setGoogleFetch(fake.fetch); });

  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, user };
  }
  type Who = { cookie?: string; bearer?: boolean; site?: string; extra?: string } | null;
  const req = (path: string, who: Who, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': who?.site ?? 'same-origin', origin: who?.site === 'cross-site' ? 'https://evil.example' : 'https://app.example.test',
        ...(who?.cookie ? { cookie: who.cookie + (who.extra ? `; ${who.extra}` : '') } : {}),
        ...(who?.bearer ? { authorization: `Bearer ${SECRETS.adminToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function setup() {
    const biz = await newBusiness({ timezone: TZ, hours: ALL_WEEK });
    const conn = await cal.upsertCalendarConnection({
      business_id: biz.id, account_email: 'owner@example.test', access_token: 'at-initial', refresh_token: 'rt-initial',
      token_expires_at: new Date(Date.now() + 3600_000), scopes: 's',
    });
    return { biz, conn };
  }
  const day = () => futureDateKey(2, TZ, 6);
  const at = (hhmm: string, d = day()) => zonedTimeToUtc(d, hhmm, TZ);
  const book = (bizId: string, hhmm: string, extra: Record<string, unknown> = {}) => db.createBooking({
    business_id: bizId, customer_name: 'Maria Lopez', customer_phone: phone(), service: 'AC repair', scheduled_at: at(hhmm).toISOString(), duration_minutes: 60, address: '12 Palm St', ...extra,
  });
  const gEvent = (id: string, startHHMM: string, endHHMM: string, extra: Record<string, unknown> = {}) => ({
    id, summary: 'SECRET dentist appointment', description: 'private notes', attendees: [{ email: 'x@y.z' }],
    start: { dateTime: at(startHHMM).toISOString() }, end: { dateTime: at(endHHMM).toISOString() }, ...extra,
  });

  // ---------------------------------------------------------------- OAuth
  test('connect: redirect to Google with PKCE + signed state; callback stores ENCRYPTED tokens; tampered / foreign / replayed state is refused', async () => {
    const { biz } = { biz: await newBusiness({ timezone: TZ }) };
    const other = await newBusiness({ timezone: TZ });
    const owner = await login(biz.id);
    const otherOwner = await login(other.id);
    const connect = await import('@/app/api/integrations/google/connect/route');
    const callback = await import('@/app/api/integrations/google/callback/route');

    const r = await connect.GET(req('/api/integrations/google/connect', owner));
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('consent');
    expect(loc.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    expect(loc.searchParams.get('code_verifier')).toBeNull();
    const state = loc.searchParams.get('state')!;
    const setCookie = r.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    const pkce = /rc_gcal_pkce=([^;]+)/.exec(setCookie)![1];
    const withPkce = { ...owner, extra: `rc_gcal_pkce=${pkce}` };

    // tampered state
    let res = await callback.GET(req(`/api/integrations/google/callback?code=c1&state=${state}x`, withPkce));
    expect(res.headers.get('location')).toContain('gcal=error');
    // another tenant's owner replaying MY state
    res = await callback.GET(req(`/api/integrations/google/callback?code=c1&state=${encodeURIComponent(state)}`, { ...otherOwner, extra: `rc_gcal_pkce=${pkce}` }));
    expect(res.headers.get('location')).toContain('gcal=error');
    expect(await cal.getCalendarConnection(other.id)).toBeNull();
    // missing PKCE cookie
    res = await callback.GET(req(`/api/integrations/google/callback?code=c1&state=${encodeURIComponent(state)}`, owner));
    expect(res.headers.get('location')).toContain('gcal=error');
    // the real thing
    res = await callback.GET(req(`/api/integrations/google/callback?code=c1&state=${encodeURIComponent(state)}`, withPkce));
    expect(res.headers.get('location')).toContain('gcal=connected');
    const conn = await cal.getCalendarConnection(biz.id);
    expect(conn?.account_email).toBe('owner@example.test');
    expect(conn?.has_refresh_token).toBe(true);
    const row = await prisma.calendarConnection.findUnique({ where: { id: conn!.id } });
    expect(row!.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('rt-secret-value');
    expect((await cal.getDecryptedTokens(conn!.id))!.refresh_token).toBe('rt-secret-value');
    const exch = fake.calls.find((c) => c.path === '/token' && (c.body as Record<string, string>).grant_type === 'authorization_code')!;
    expect((exch.body as Record<string, string>).code_verifier.length).toBeGreaterThan(40); // PKCE verifier reached Google, never the URL
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'calendar.connected' } })).toBe(1);
    // replay of the same (valid) state + code
    res = await callback.GET(req(`/api/integrations/google/callback?code=c1&state=${encodeURIComponent(state)}`, withPkce));
    expect(res.headers.get('location')).toContain('gcal=error');
    // a user who denied consent
    const r2 = await connect.GET(req('/api/integrations/google/connect', owner));
    const st2 = new URL(r2.headers.get('location')!).searchParams.get('state')!;
    const p2 = /rc_gcal_pkce=([^;]+)/.exec(r2.headers.get('set-cookie')!)![1];
    res = await callback.GET(req(`/api/integrations/google/callback?error=access_denied&state=${encodeURIComponent(st2)}`, { ...owner, extra: `rc_gcal_pkce=${p2}` }));
    expect(res.headers.get('location')).toContain('gcal=denied');
  });

  test('roles, tenant isolation, CSRF and unauthenticated access on the owner routes', async () => {
    const { biz } = await setup();
    const other = await newBusiness({ timezone: TZ });
    const owner = await login(biz.id), staff = await login(biz.id, 'staff'), otherOwner = await login(other.id);
    const status = await import('@/app/api/integrations/google/status/route');
    const connect = await import('@/app/api/integrations/google/connect/route');
    const disconnect = await import('@/app/api/integrations/google/disconnect/route');
    const calendar = await import('@/app/api/integrations/google/calendar/route');
    const calendars = await import('@/app/api/integrations/google/calendars/route');

    expect((await status.GET(req('/api/integrations/google/status', null))).status).toBe(401);
    expect((await connect.GET(req('/api/integrations/google/connect', staff))).status).toBe(403);
    expect((await calendars.GET(req('/api/integrations/google/calendars', staff))).status).toBe(403);
    const s = (await (await status.GET(req('/api/integrations/google/status', staff))).json()).data;
    expect(s.connected).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/at-initial|rt-initial|enc/);
    // another tenant sees nothing of mine, and naming my business is a 404
    const so = (await (await status.GET(req('/api/integrations/google/status', otherOwner))).json()).data;
    expect(so.connected).toBe(false);
    expect((await status.GET(req(`/api/integrations/google/status?business_id=${biz.id}`, otherOwner))).status).toBe(404);
    expect((await disconnect.DELETE(req(`/api/integrations/google/disconnect?business_id=${biz.id}`, otherOwner, undefined, 'DELETE'))).status).toBe(404);
    expect((await calendar.PATCH(req(`/api/integrations/google/calendar?business_id=${biz.id}`, otherOwner, { block_on_busy: false }, 'PATCH'))).status).toBe(404);
    // CSRF: cross-site cookie request refused, nothing changes
    expect((await disconnect.DELETE(req('/api/integrations/google/disconnect', { ...owner, site: 'cross-site' }, undefined, 'DELETE'))).status).toBe(403);
    expect((await calendar.PATCH(req('/api/integrations/google/calendar', { ...owner, site: 'cross-site' }, { block_on_busy: false }, 'PATCH'))).status).toBe(403);
    expect((await cal.getCalendarConnection(biz.id))!.status).toBe('active');
    // validation
    expect((await calendar.PATCH(req('/api/integrations/google/calendar', owner, { block_on_busy: 'no' }, 'PATCH'))).status).toBe(422);
    expect((await calendar.PATCH(req('/api/integrations/google/calendar', owner, { calendar_id: 'not-mine@x' }, 'PATCH'))).status).toBe(422);
    // the toggle persists (and defaults to on)
    expect(await busy.getBlockOnBusy(biz.id)).toBe(true);
    expect((await calendar.PATCH(req('/api/integrations/google/calendar', owner, { block_on_busy: false }, 'PATCH'))).status).toBe(200);
    expect(await busy.getBlockOnBusy(biz.id)).toBe(false);
    expect((await calendars.GET(req('/api/integrations/google/calendars', owner))).status).toBe(200);
  });

  test('picking another calendar resets sync state and moves pushed events', async () => {
    const { biz, conn } = await setup();
    const owner = await login(biz.id);
    const calendar = await import('@/app/api/integrations/google/calendar/route');
    const b = await book(biz.id, '09:00');
    expect(await push.pushBooking(b.id)).toBe('created');
    await sync.syncConnection(conn.id);
    expect((await cal.getCalendarConnection(biz.id))!.sync_token).not.toBeNull();
    const r = await calendar.PATCH(req('/api/integrations/google/calendar', owner, { calendar_id: 'work@group.calendar.google.com' }, 'PATCH'));
    expect(r.status).toBe(200);
    const after = (await cal.getCalendarConnection(biz.id))!;
    expect(after.calendar_id).toBe('work@group.calendar.google.com');
    expect(await cal.getEventLinkByBooking(b.id)).toBeNull();
    expect(fake.count('DELETE', '/events/')).toBe(1);
  });

  // ---------------------------------------------------------------- token lifecycle
  test('token refresh when expired (coalesced); invalid_grant -> needs_reauth once, audit, blocks ignored', async () => {
    const { biz, conn } = await setup();
    await cal.updateCalendarTokens(conn.id, { access_token: 'old', token_expires_at: new Date(Date.now() - 1000) });
    fake.put(gEvent('ev1', '10:00', '11:00'));
    const [a, b2] = await Promise.all([sync.syncConnection(conn.id), sync.syncConnection(conn.id)]);
    expect([a.outcome, b2.outcome].filter((o) => o === 'synced').length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.filter((c) => c.path === '/token').length).toBe(1);
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(1);
    expect((await cal.getDecryptedTokens(conn.id))!.access_token).toMatch(/^at-\d+$/);

    // revoked at Google
    await cal.updateCalendarTokens(conn.id, { access_token: 'old', token_expires_at: new Date(Date.now() - 1000) });
    fake.refreshError = 'invalid_grant';
    expect((await sync.syncConnection(conn.id)).outcome).toBe('needs_reauth');
    expect((await cal.getCalendarConnection(biz.id))!.status).toBe('needs_reauth');
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'calendar.needs_reauth' } })).toBe(1);
    expect((await sync.syncConnection(conn.id)).outcome).toBe('skipped'); // no hammering a dead grant
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'calendar.needs_reauth' } })).toBe(1);
    // availability ignores the (now untrusted) blocks: fail open
    const slots = await sched.slotsForDate((await db.getBusiness(biz.id))!, day(), 60);
    expect(slots.find((s) => s.start === at('10:00').toISOString())!.available).toBe(true);
    // a reconnect restores it
    await cal.upsertCalendarConnection({ business_id: biz.id, account_email: 'owner@example.test', access_token: 'n', refresh_token: 'r', token_expires_at: new Date(Date.now() + 3600_000) });
    fake.refreshError = null;
    expect((await sync.syncConnection(conn.id)).outcome).toBe('synced');
  });

  test('repeated failures back off and finally flip to needs_reauth', async () => {
    const { biz, conn } = await setup();
    fake.failStatus = 503;
    for (let i = 0; i < sync.FAILURES_BEFORE_REAUTH; i++) expect((await sync.syncConnection(conn.id)).outcome).toBe('failed');
    expect((await cal.getCalendarConnection(biz.id))!.status).toBe('needs_reauth');
    const { pollDue } = await import('@/lib/jobs/calendar');
    const c = { ...conn, status: 'error' as const, last_error: '[3] 503 x', updated_at: new Date(Date.now() - 20 * 60_000).toISOString() };
    expect(pollDue(c, new Date())).toBe(false); // 3 failures => 60 min backoff
    expect(pollDue({ ...c, updated_at: new Date(Date.now() - 61 * 60_000).toISOString() }, new Date())).toBe(true);
  });

  // ---------------------------------------------------------------- sync
  test('full sync stores TIMES ONLY; incremental add/update/delete; 410 forces a full resync; transparent and declined do not block', async () => {
    const { biz, conn } = await setup();
    fake.put(gEvent('a', '10:00', '11:00'));
    fake.put(gEvent('free', '12:00', '13:00', { transparency: 'transparent' }));
    fake.put(gEvent('declined', '14:00', '15:00', { attendees: [{ self: true, responseStatus: 'declined' }] }));
    fake.put({ id: 'wl', eventType: 'workingLocation', start: { date: day() }, end: { date: day() } });
    expect((await sync.syncConnection(conn.id))).toMatchObject({ outcome: 'synced', mode: 'full' });
    const rows = await prisma.calendarBusyBlock.findMany({ where: { connectionId: conn.id } });
    expect(rows.map((r) => r.googleEventId).sort()).toEqual(['a', 'free']);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET|dentist|private notes|x@y\.z/);
    expect(rows.find((r) => r.googleEventId === 'free')!.transparency).toBe('transparent');
    expect(fake.calls.find((c) => c.path.endsWith('/events'))!.query.get('singleEvents')).toBe('true');
    expect(fake.calls.find((c) => c.path.endsWith('/events'))!.query.get('fields')).not.toContain('summary');

    fake.reset();
    fake.put(gEvent('b', '15:00', '16:00'));
    fake.put({ id: 'a', start: { dateTime: at('10:30').toISOString() } });
    fake.remove('free');
    expect(await sync.syncConnection(conn.id)).toMatchObject({ outcome: 'synced', mode: 'incremental' });
    expect(fake.calls.find((c) => c.path.endsWith('/events'))!.query.get('syncToken')).toMatch(/^st-/);
    const after = await prisma.calendarBusyBlock.findMany({ where: { connectionId: conn.id }, orderBy: { googleEventId: 'asc' } });
    expect(after.map((r) => r.googleEventId)).toEqual(['a', 'b']);
    expect(after[0].startsAt.toISOString()).toBe(at('10:30').toISOString());

    // 410: token invalidated -> full resync replaces everything
    fake.remove('b'); fake.gone = true;
    fake.reset();
    expect(await sync.syncConnection(conn.id)).toMatchObject({ outcome: 'synced', mode: 'full' });
    expect((await prisma.calendarBusyBlock.findMany({ where: { connectionId: conn.id } })).map((r) => r.googleEventId)).toEqual(['a']);
    expect((await cal.getCalendarConnection(biz.id))!.last_sync_at).not.toBeNull();
  });

  test('all-day events are whole LOCAL days (DST-short day is 23h); timed events keep their instants', async () => {
    const { conn } = await setup();
    const { nextUsDstDay } = await import('../helpers/fixtures');
    const spring = nextUsDstDay('spring');
    const next = new Date(`${spring}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    fake.put({ id: 'allday', start: { date: spring }, end: { date: next.toISOString().slice(0, 10) } });
    await sync.syncConnection(conn.id, { now: new Date(`${spring}T00:00:00Z`) });
    const b = await prisma.calendarBusyBlock.findUnique({ where: { connectionId_googleEventId: { connectionId: conn.id, googleEventId: 'allday' } } });
    expect(b!.allDay).toBe(true);
    expect((b!.endsAt.getTime() - b!.startsAt.getTime()) / 3600_000).toBe(23);
    expect(b!.startsAt.toISOString()).toBe(zonedTimeToUtc(spring, '00:00', TZ).toISOString());
  });

  // ---------------------------------------------------------------- availability
  test('busy blocks make slots unavailable and createBooking refuses (calendar_busy); ignored when switched off / unhealthy; concurrency', async () => {
    const { biz, conn } = await setup();
    fake.put(gEvent('meet', '10:00', '11:30'));
    await sync.syncConnection(conn.id);
    const business = (await db.getBusiness(biz.id))!;
    const slots = await sched.slotsForDate(business, day(), 60);
    const av = (hhmm: string) => slots.find((s) => s.start === at(hhmm).toISOString())!.available;
    expect([av('09:00'), av('10:00'), av('11:00'), av('12:00')]).toEqual([true, false, false, true]);

    const rejected = await book(biz.id, '10:00').catch((e) => e);
    expect(rejected).toBeInstanceOf(db.BookingRejectedError);
    expect(rejected.reason).toBe('calendar_busy');
    // 6 parallel attempts at a busy slot: all refused, none created
    const many = await Promise.allSettled(Array.from({ length: 6 }, () => book(biz.id, '10:00')));
    expect(many.every((m) => m.status === 'rejected' && (m.reason as { reason: string }).reason === 'calendar_busy')).toBe(true);
    // 6 parallel attempts at a free slot: exactly one wins (the others see slot_taken)
    const race = await Promise.allSettled(Array.from({ length: 6 }, () => book(biz.id, '14:00')));
    expect(race.filter((m) => m.status === 'fulfilled').length).toBe(1);
    expect(race.filter((m) => m.status === 'rejected').every((m) => (m as PromiseRejectedResult).reason.reason === 'slot_taken')).toBe(true);
    // next available skips the busy time
    const next = await sched.nextAvailable(business, 40, 60);
    expect(next.some((s) => s.start === at('10:00').toISOString())).toBe(false);
    // rescheduling INTO a busy block is refused too
    const b = await book(biz.id, '16:00');
    const rr = await db.rescheduleBooking({ business_id: biz.id, booking_id: b.id, scheduled_at: at('10:00').toISOString() }).catch((e) => e);
    expect(rr.reason).toBe('calendar_busy');

    // switch off
    const { setBlockOnBusy } = await import('@/lib/integrations/google/settings');
    expect(await setBlockOnBusy(biz.id, false, { kind: 'admin_token', user_id: null })).toBe(true);
    expect((await prisma.calendarConnection.findUniqueOrThrow({ where: { id: conn.id } })).blockOnBusy).toBe(false); // a real column, not an audit-derived value
    expect(await busy.getBlockOnBusy(biz.id)).toBe(false);
    expect((await book(biz.id, '10:00')).status).toBeDefined();
    expect(await setBlockOnBusy(biz.id, true, { kind: 'admin_token', user_id: null })).toBe(true);
    expect(await busy.getBlockOnBusy(biz.id)).toBe(true);
    expect(await setBlockOnBusy(`nobody-${biz.id}`, false, { kind: 'admin_token', user_id: null })).toBe(false); // no connection: nothing to switch
    expect(await busy.calendarBusyIntervals(biz.id, at('00:00').getTime(), at('23:00').getTime())).toHaveLength(1);
    // unhealthy connection: ignored
    await cal.setCalendarConnectionStatus(conn.id, 'needs_reauth', 'x');
    expect(await busy.calendarBusyIntervals(biz.id, at('00:00').getTime(), at('23:00').getTime())).toHaveLength(0);
  });

  // ---------------------------------------------------------------- push
  test('booking push is idempotent: create, unchanged, update, lost-link adoption (409), cancel deletes; description carries phone/address', async () => {
    const { biz, conn } = await setup();
    const b = await book(biz.id, '09:00');
    expect(await push.pushBooking(b.id)).toBe('created');
    expect(await push.pushBooking(b.id)).toBe('unchanged');
    expect(await Promise.all([push.pushBooking(b.id), push.pushBooking(b.id)])).toEqual(['unchanged', 'unchanged']);
    expect(fake.count('POST', '/events')).toBe(1);
    const ev = fake.events.get(push.eventIdFor(b.id))!;
    expect(ev.summary).toBe('AC repair — Maria');
    expect(ev.description).toContain(b.customer_phone);
    expect(ev.description).toContain('12 Palm St');
    expect((ev as { reminders?: { useDefault: boolean } }).reminders?.useDefault).toBe(true);
    // reschedule -> PATCH
    await db.rescheduleBooking({ business_id: biz.id, booking_id: b.id, scheduled_at: at('13:00').toISOString() });
    expect(await push.pushBooking(b.id)).toBe('updated');
    expect(fake.count('PATCH', '/events/')).toBe(1);
    expect((ev as { start?: { dateTime: string } }).start).toBeDefined();
    // the link row is lost (crash between Google and DB): next push adopts the existing event, no duplicate
    await cal.deleteEventLink(b.id);
    await db.rescheduleBooking({ business_id: biz.id, booking_id: b.id, scheduled_at: at('14:00').toISOString() });
    expect(await push.pushBooking(b.id)).toBe('updated');
    expect([...fake.events.keys()].filter((k) => k.startsWith('rc')).length).toBe(1);
    expect((await cal.getEventLinkByBooking(b.id))!.connection_id).toBe(conn.id);
    // cancel -> event deleted, link gone, idempotent
    await db.transitionBooking(biz.id, b.id, 'cancelled');
    expect(await push.pushBooking(b.id)).toBe('deleted');
    expect(await cal.getEventLinkByBooking(b.id)).toBeNull();
    expect(await push.pushBooking(b.id)).toBe('skipped');
  });

  test('our own booking events never become busy blocks (link, or private marker alone)', async () => {
    const { biz, conn } = await setup();
    const b = await book(biz.id, '09:00');
    await push.pushBooking(b.id);
    fake.put({ id: 'orphan', start: { dateTime: at('11:00').toISOString() }, end: { dateTime: at('12:00').toISOString() }, extendedProperties: { private: { rc_booking: 'some-booking' } } });
    fake.put(gEvent('real', '15:00', '16:00'));
    await sync.syncConnection(conn.id);
    expect((await prisma.calendarBusyBlock.findMany({ where: { connectionId: conn.id } })).map((r) => r.googleEventId)).toEqual(['real']);
    // and the booking can still be re-booked-around / the slot stays bookable for the SAME business flow
    const slots = await sched.slotsForDate((await db.getBusiness(biz.id))!, day(), 60);
    expect(slots.find((s) => s.start === at('09:00').toISOString())!.available).toBe(false); // taken by the booking itself, not by a block
  });

  test('owner edits a linked event: audit calendar.event_changed_externally (deduped), booking untouched, push still applies the booking change', async () => {
    const { biz, conn } = await setup();
    const b = await book(biz.id, '09:00');
    await push.pushBooking(b.id);
    const id = push.eventIdFor(b.id);
    fake.put({ id, start: { dateTime: at('17:00').toISOString() }, end: { dateTime: at('18:00').toISOString() } }); // owner moved it
    await sync.syncConnection(conn.id);
    await sync.syncConnection(conn.id);
    const count = () => prisma.auditEvent.count({ where: { businessId: biz.id, action: 'calendar.event_changed_externally' } });
    expect(await count()).toBe(1);
    expect((await db.getBooking(b.id))!.status).toBe('confirmed');
    expect((await db.getBooking(b.id))!.scheduled_at).toBe(at('09:00').toISOString());
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(0);
    // the booking changes: precondition (If-Match) fails => audited, change still applied
    fake.put({ id, summary: 'edited by owner' });
    await db.rescheduleBooking({ business_id: biz.id, booking_id: b.id, scheduled_at: at('10:00').toISOString() });
    expect(await push.pushBooking(b.id)).toBe('updated');
    expect(await count()).toBe(2);
    // owner deletes the event: audited, booking NOT cancelled, link dropped
    fake.remove(id);
    await sync.syncConnection(conn.id);
    expect(await count()).toBe(3);
    expect((await db.getBooking(b.id))!.status).toBe('confirmed');
    expect(await cal.getEventLinkByBooking(b.id)).toBeNull();
    const status = await (await import('@/app/api/integrations/google/status/route')).GET(req('/api/integrations/google/status', await login(biz.id)));
    expect((await status.json()).data.external_changes.length).toBe(3);
  });

  test('registered handler pushes on emitBookingChanged', async () => {
    const { biz } = await setup();
    const hooks = await import('@/lib/booking-hooks');
    const { registerGoogleCalendar } = await import('@/lib/integrations/register');
    registerGoogleCalendar();
    const b = await book(biz.id, '09:00');
    await hooks.emitBookingChanged(b.id, 'created', biz.id);
    for (let i = 0; i < 50 && !(await cal.getEventLinkByBooking(b.id)); i++) await new Promise((r) => setTimeout(r, 40));
    expect(await cal.getEventLinkByBooking(b.id)).not.toBeNull();
  });

  // ---------------------------------------------------------------- webhook
  test('webhook: public path, constant-time channel auth, always 200, only valid notifications sync', async () => {
    const { biz, conn } = await setup();
    expect(isPublicPath('/api/integrations/google/webhook')).toBe(true);
    expect(isPublicPath('/api/integrations/google/status')).toBe(false);
    expect(await watch.ensureWatch(conn.id)).toBe(true);
    const ch = fake.lastChannel!;
    expect(ch.address).toBe('https://app.example.test/api/integrations/google/webhook');
    const c = (await cal.getCalendarConnection(biz.id))!;
    expect(c.watch_channel_id).toBe(ch.id);
    const { POST } = await import('@/app/api/integrations/google/webhook/route');
    const hit = (h: Record<string, string>) => POST(new Request('https://app.example.test/api/integrations/google/webhook', { method: 'POST', headers: h }));
    const listCalls = () => fake.calls.filter((x) => x.path.endsWith('/events') && x.method === 'GET').length;
    fake.put(gEvent('w1', '10:00', '11:00'));
    const good = { 'x-goog-channel-id': ch.id, 'x-goog-channel-token': ch.token, 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'exists' };
    fake.reset();
    for (const bad of [{ ...good, 'x-goog-channel-token': 'nope' }, { ...good, 'x-goog-resource-id': 'other' }, { ...good, 'x-goog-channel-id': 'unknown-channel' }, {}]) {
      expect((await hit(bad)).status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(listCalls()).toBe(0);
    expect((await hit({ ...good, 'x-goog-resource-state': 'sync' })).status).toBe(200); // the handshake does not sync
    await new Promise((r) => setTimeout(r, 100));
    expect(listCalls()).toBe(0);
    const t0 = Date.now();
    expect((await hit(good)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1500); // answered immediately; the sync runs in the background
    for (let i = 0; i < 50 && listCalls() === 0; i++) await new Promise((r) => setTimeout(r, 40));
    expect(listCalls()).toBeGreaterThan(0);
    for (let i = 0; i < 50 && (await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })) === 0; i++) await new Promise((r) => setTimeout(r, 40));
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(1);
    // renewal creates a new channel and stops the old one
    fake.reset();
    await watch.ensureWatch(conn.id, { force: true });
    expect(fake.count('POST', '/events/watch')).toBe(1);
    expect(fake.count('POST', '/channels/stop')).toBe(1);
  });

  test('concurrent sync requests coalesce on the lease (a busy request leaves a dirty marker, the holder re-runs)', async () => {
    const { conn } = await setup();
    fake.put(gEvent('c1', '10:00', '11:00'));
    const out = await Promise.all([sync.syncConnection(conn.id), sync.syncConnection(conn.id), sync.syncConnection(conn.id)]);
    expect(out.some((o) => o.outcome === 'synced')).toBe(true);
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(1);
  });

  // ---------------------------------------------------------------- privacy
  test('customer erasure deletes the pushed Google event; a failed deletion is kept and swept later', async () => {
    const { biz } = await setup();
    const p = phone();
    const b = await book(biz.id, '09:00', { customer_phone: p });
    await push.pushBooking(b.id);
    expect(fake.events.get(push.eventIdFor(b.id))!.status).not.toBe('cancelled');
    await (await import('@/lib/db/compliance')).eraseCustomerData(biz.id, p);
    expect(fake.events.get(push.eventIdFor(b.id))!.status).toBe('cancelled');
    expect(await cal.getEventLinkByBooking(b.id)).toBeNull();
    expect((await db.getBooking(b.id))!.customer_name).toBe('[redacted]');

    // Google unreachable during erasure: the link stays, the sweep finishes the job
    const p2 = phone();
    const b2 = await book(biz.id, '12:00', { customer_phone: p2 });
    await push.pushBooking(b2.id);
    fake.failStatus = 503;
    await (await import('@/lib/db/compliance')).eraseCustomerData(biz.id, p2);
    expect(await cal.getEventLinkByBooking(b2.id)).not.toBeNull();
    fake.failStatus = null;
    const { redactAnonymizedBookingEvents } = await import('@/lib/integrations/google/privacy');
    expect((await redactAnonymizedBookingEvents()).deleted).toBeGreaterThanOrEqual(1);
    expect(await cal.getEventLinkByBooking(b2.id)).toBeNull();
    expect(fake.events.get(push.eventIdFor(b2.id))!.status).toBe('cancelled');
    // an anonymised booking is never pushed again
    expect(await push.pushBooking(b2.id)).toBe('skipped');
  });

  test('disconnect revokes at Google, stops the channel, wipes tokens + blocks; idempotent; optional event removal', async () => {
    const { biz, conn } = await setup();
    const owner = await login(biz.id);
    await watch.ensureWatch(conn.id);
    fake.put(gEvent('d1', '10:00', '11:00'));
    await sync.syncConnection(conn.id);
    const b = await book(biz.id, '09:00');
    await push.pushBooking(b.id);
    const { DELETE } = await import('@/app/api/integrations/google/disconnect/route');
    fake.reset();
    const r = await DELETE(req('/api/integrations/google/disconnect?delete_events=true', owner, undefined, 'DELETE'));
    expect(r.status).toBe(200);
    expect(fake.calls.some((c) => c.path === '/revoke')).toBe(true);
    expect(fake.count('POST', '/channels/stop')).toBe(1);
    const row = await prisma.calendarConnection.findUnique({ where: { id: conn.id } });
    expect(row).toMatchObject({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null, syncToken: null, watchChannelId: null });
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(0);
    expect(await cal.getEventLinkByBooking(b.id)).toBeNull();
    expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'calendar.disconnected' } })).toBe(1);
    expect((await (await DELETE(req('/api/integrations/google/disconnect', owner, undefined, 'DELETE'))).json()).data.changed).toBe(false);
    // no pushes while disconnected
    expect(await push.pushBooking(b.id)).toBe('skipped');
  });

  // ---------------------------------------------------------------- jobs + mock
  test('job: polls due connections (fallback), reconciles unpushed bookings, renews watch', async () => {
    const { biz, conn } = await setup();
    const { runGoogleCalendarWork } = await import('@/lib/jobs/calendar');
    fake.put(gEvent('j1', '10:00', '11:00'));
    const b = await book(biz.id, '15:00');
    const r = await runGoogleCalendarWork({ now: new Date() });
    expect(r.counts.synced).toBeGreaterThanOrEqual(1);
    expect(await cal.getEventLinkByBooking(b.id)).not.toBeNull();
    expect(await prisma.calendarBusyBlock.count({ where: { connectionId: conn.id } })).toBe(1);
    expect(r.counts.renewed).toBeGreaterThanOrEqual(1);
    fake.reset();
    const again = await runGoogleCalendarWork({ now: new Date() }); // not due again within 15 minutes
    expect(again.counts.synced).toBe(0);
  });

  test('mock mode is refused in production; connect route says 503', async () => {
    const { googleMockEnabled, googleMockRefused } = await import('@/lib/integrations/google/config');
    expect(googleMockEnabled({ GOOGLE_OAUTH_MOCK: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(googleMockEnabled({ GOOGLE_OAUTH_MOCK: 'true', NODE_ENV: 'production' })).toBe(false);
    expect(googleMockRefused({ GOOGLE_OAUTH_MOCK: 'true', NODE_ENV: 'production' })).toBe(true);
    const { biz } = await setup();
    const owner = await login(biz.id);
    const connect = await import('@/app/api/integrations/google/connect/route');
    const r = await withEnv({ GOOGLE_OAUTH_MOCK: 'true', NODE_ENV: 'production' }, () => connect.GET(req('/api/integrations/google/connect', owner)));
    expect(r.status).toBe(503);
  });
});
