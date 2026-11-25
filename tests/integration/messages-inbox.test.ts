/**
 * Agent B: the owner's inbox of customer texts (docs/review/18f #16 / N3), the manual text and reply path (#17), the owner privacy tools (#17)
 * and the per-business review link (#8). Providers are in mock mode (DEMO_MODE where a mock must count as delivered); every outbound fetch is refused.
 * Time of day never matters: the business time zone is quietTimezone() / awakeTimezone().
 */
import { integration, outboundCalls, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { awakeTimezone, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, phone, quietTimezone, twilioSignature, uniq } from '../helpers/fixtures';
import { hashPassword } from '../../src/lib/password';

const PASSWORD = 'correct horse battery staple';
const DEMO = { DEMO_MODE: 'true' };

integration('customer messages: inbox, replies, privacy, review link (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  type Ctx = { params: Promise<{ id: string }> };
  type MCtx = { params: Promise<{ id: string; messageId: string }> };
  let inbound: (req: Request) => Promise<Response>;
  let listRoute: { GET: (req: Request, c: Ctx) => Promise<Response> };
  let oneRoute: { GET: (req: Request, c: MCtx) => Promise<Response>; PATCH: (req: Request, c: MCtx) => Promise<Response> };
  let replyRoute: { POST: (req: Request, c: MCtx) => Promise<Response> };
  let sendRoute: { POST: (req: Request, c: Ctx) => Promise<Response> };
  let logRoute: { GET: (req: Request, c: Ctx) => Promise<Response> };
  let lookupRoute: { POST: (req: Request, c: Ctx) => Promise<Response> };
  let exportRoute: { POST: (req: Request, c: Ctx) => Promise<Response> };
  let eraseRoute: { POST: (req: Request, c: Ctx) => Promise<Response> };
  let reviewRoute: { GET: (req: Request, c: Ctx) => Promise<Response>; PUT: (req: Request, c: Ctx) => Promise<Response> };
  let gratReply: (bookingId: string, score: number) => Promise<{ routed: string; sms: { body: string } | null; body: string }>;
  const userIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    inbound = (await import('@/app/api/sms/inbound/route')).POST;
    listRoute = await import('@/app/api/businesses/[id]/messages/route');
    oneRoute = await import('@/app/api/businesses/[id]/messages/[messageId]/route');
    replyRoute = await import('@/app/api/businesses/[id]/messages/[messageId]/reply/route');
    sendRoute = await import('@/app/api/businesses/[id]/messages/send/route');
    logRoute = await import('@/app/api/businesses/[id]/messages/log/route');
    lookupRoute = await import('@/app/api/businesses/[id]/privacy/lookup/route');
    exportRoute = await import('@/app/api/businesses/[id]/privacy/export/route');
    eraseRoute = await import('@/app/api/businesses/[id]/privacy/erase/route');
    reviewRoute = await import('@/app/api/businesses/[id]/review-url/route');
    gratReply = (await import('@/lib/gratitude/reply')).routeGratitudeReply as typeof gratReply;
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
    expect(outboundCalls).toEqual([]); // nothing tried to leave the machine
  });
  beforeEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'inbox' } }, { key: { startsWith: 'manual-sms' } }, { key: { startsWith: 'privacy:' } }] } });
  });

  // ------------------------------------------------------------ helpers
  const URL_IN = `${SECRETS.publicBase}/api/sms/inbound`;
  const text = async (biz: { id: string; phone?: string | null }, from: string, body: string, sid = uniq('SM')) => {
    const params = { From: from, To: biz.phone!, Body: body, MessageSid: sid };
    const res = await inbound(new Request(URL_IN, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(URL_IN, params) }, body: new URLSearchParams(params).toString(),
    }));
    return { res, sid };
  };
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const mctx = (id: string, messageId: string): MCtx => ({ params: Promise.resolve({ id, messageId }) });
  const admin = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const asUser = (cookie: string): Record<string, string> => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', cookie });
  const api = (path: string, method: string, body?: unknown, headers: Record<string, string> = admin) =>
    new Request(`https://app.example.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  async function login(businessId: string, role: 'owner' | 'staff' = 'owner') {
    const user = await users.createUser({ email: `${uniq('u')}@example.test`, password_hash: await hashPassword(PASSWORD), role, business_id: businessId, email_verified: true });
    userIds.push(user.id);
    const { token, session } = await users.createSession(user.id);
    return { cookie: `rc_user_session=${token}`, sessionId: session.id };
  }
  /** `day` at `hhmm` wall time in a fixed-offset zone such as Etc/GMT+5 (what quietTimezone/awakeTimezone return), as an ISO instant. */
  const isoAt = (tz: string | undefined, day: string, hhmm: string) => {
    const m = /^Etc\/GMT([+-])(\d+)$/.exec(tz ?? '');
    const off = m ? `${m[1] === '+' ? '-' : '+'}${m[2].padStart(2, '0')}:00` : 'Z';
    return new Date(`${day}T${hhmm}:00${off}`).toISOString();
  };
  const bizAt = (tz: string, extra: { owner_phone?: string | null; owner_verified?: boolean } = {}) => newBusiness({ timezone: tz, ...extra });
  const rows = (businessId: string) => prisma.inboundMessage.findMany({ where: { businessId }, orderBy: { receivedAt: 'asc' } });
  const sms = (businessId: string, kind: string) => prisma.smsLog.findMany({ where: { businessId, kind } });

  // ================================================================== webhook branch
  test('a free-form text is stored, texted to the verified owner phone and acknowledged once (EN, then not again within 24 h)', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      const first = await text(biz, from, 'Can you come at 3 instead? gate code is 1234 http://x.example/y');
      expect(first.res.status).toBe(200);
      expect(await first.res.text()).not.toContain('<Message>'); // the ack goes through the send path, not TwiML
      const [m] = await rows(biz.id);
      expect(m).toMatchObject({ fromE164: from, status: 'new', twilioMessageSid: first.sid });
      expect(m.forwardedToOwnerAt).not.toBeNull();
      expect(m.autoRepliedAt).not.toBeNull();
      const alerts = await sms(biz.id, 'owner_alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].toE164).toBe(biz.owner_phone_e164 ?? alerts[0].toE164);
      expect(alerts[0].body).toContain(`...${from.slice(-4)}`);
      expect(alerts[0].body).not.toContain('x.example'); // links typed by a stranger never reach the owner
      const acks = await sms(biz.id, 'inbox_autoreply');
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ toE164: from, consentBasis: 'customer_initiated_reply' });
      expect(acks[0].body).toContain('Maria'); // default assistant name
      expect(acks[0].body).toContain('Reply STOP to opt out');
      expect((await db.getUsage(biz.id))!.sms_count).toBeGreaterThan(0); // counted against the plan

      // a second text from the same sender: stored and forwarded, but no second acknowledgement
      await text(biz, from, 'Also: please call before coming');
      expect(await rows(biz.id)).toHaveLength(2);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(1);
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(2);
      // after 24 h the sender is acknowledged again
      await prisma.smsLog.updateMany({ where: { businessId: biz.id, kind: 'inbox_autoreply' }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
      await text(biz, from, 'Anyone there?');
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(2);
    });
  });

  test('Spanish text on a business with an assistant name: Spanish ack signed with that name', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      await prisma.business.update({ where: { id: biz.id }, data: { assistantName: 'Sofia' } });
      await text(biz, phone(), 'Hola, necesito que vengan mañana por favor');
      const [ack] = await sms(biz.id, 'inbox_autoreply');
      expect(ack.body).toContain('Sofia');
      expect(ack.body).toContain('Recibimos su mensaje');
    });
  });

  test('a redelivery of the same MessageSid neither stores, forwards nor acknowledges twice', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      const sid = uniq('SMdup');
      await text(biz, from, 'hello there', sid);
      await text(biz, from, 'hello there', sid);
      await text(biz, from, 'hello there', sid);
      expect(await rows(biz.id)).toHaveLength(1);
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(1);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(1);
    });
  });

  test('quiet hours: stored and counted in the inbox, the owner is NOT texted; the customer still gets the ack', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(quietTimezone());
      await text(biz, phone(), 'night text');
      const [m] = await rows(biz.id);
      expect(m.forwardedToOwnerAt).toBeNull();
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(0);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(1);
      expect((await db.countInboundByStatus(biz.id)).new).toBe(1);
    });
  });

  test('unverified or missing owner phone: stored, never texted to an unproven number', async () => {
    await withEnv(DEMO, async () => {
      const unverified = await bizAt(awakeTimezone(), { owner_verified: false });
      await text(unverified, phone(), 'hi');
      expect((await rows(unverified.id))[0].forwardedToOwnerAt).toBeNull();
      expect(await sms(unverified.id, 'owner_alert')).toHaveLength(0);
      const none = await bizAt(awakeTimezone(), { owner_phone: null });
      await text(none, phone(), 'hi');
      expect(await rows(none.id)).toHaveLength(1);
      expect(await sms(none.id, 'owner_alert')).toHaveLength(0);
    });
  });

  test('hourly forward budget: past it the text is stored but the owner is not texted again; the stamp is reverted', async () => {
    await withEnv({ ...DEMO, INBOX_FORWARD_HOURLY_LIMIT: '2' }, async () => {
      const biz = await bizAt(awakeTimezone());
      for (let i = 0; i < 4; i++) await text(biz, phone(), `msg ${i}`);
      expect(await rows(biz.id)).toHaveLength(4);
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(2);
      expect((await rows(biz.id)).filter((r) => r.forwardedToOwnerAt).length).toBe(2);
    });
  });

  test('opt-out is respected: STOP is not stored; a later text from that number is stored but never answered', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      await text(biz, from, 'STOP');
      expect(await rows(biz.id)).toHaveLength(0); // keywords stay with messaging/inbound
      await text(biz, from, 'actually, can you call me?');
      expect(await rows(biz.id)).toHaveLength(1);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(0);
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(1); // the owner still learns of it
    });
  });

  test('keywords, a bare C and the owner\'s own number never enter the inbox; an unparseable sender is dropped', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      await text(biz, phone(), 'HELP');
      await text(biz, phone(), 'C');
      await text(biz, biz.owner_phone!, 'just testing');
      await text(biz, 'short', 'hi');
      await text(biz, phone(), '   ');
      expect(await rows(biz.id)).toHaveLength(0);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(0);
    });
  });

  test('"ok" / "thanks" / "yes" are stored as ignored: no owner text, no acknowledgement, no new-badge noise', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      await text(biz, phone(), 'ok');
      await text(biz, phone(), 'Thanks!');
      const all = await rows(biz.id);
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.status === 'ignored' && r.handledBy === 'auto:acknowledgement' && r.forwardedToOwnerAt === null)).toBe(true);
      expect(await sms(biz.id, 'owner_alert')).toHaveLength(0);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(0);
      expect((await db.countInboundByStatus(biz.id)).new).toBe(0);
    });
  });

  test('a bare 1-5 with no gratitude text behind it is just a message', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      await text(biz, phone(), '4');
      expect(await rows(biz.id)).toHaveLength(1);
    });
  });

  test('per-sender flood limit: the 11th text in an hour is dropped (and nothing more is sent)', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      for (let i = 0; i < 12; i++) await text(biz, from, `spam ${i}`);
      expect(await rows(biz.id)).toHaveLength(10);
      expect(await sms(biz.id, 'inbox_autoreply')).toHaveLength(1);
    });
  });

  test('the text is linked to the sender\'s latest booking', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      const day = futureDateKey(2, awakeTimezone(), 3);
      const b = await db.createBooking({ business_id: biz.id, customer_name: 'Ana', customer_phone: from, service: 'AC repair', scheduled_at: isoAt(biz.timezone, day, '15:00'), duration_minutes: 60 });
      await text(biz, from, 'running 10 minutes late');
      expect((await rows(biz.id))[0].bookingId).toBe(b.id);
    });
  });

  test('the plan cap blocks the acknowledgement (counted against the SMS caps), not the inbox', async () => {
    await withEnv({ ...DEMO, BILLING_ENFORCED: 'true' }, async () => {
      const biz = await bizAt(quietTimezone()); // quiet: no metered usage-warning text to the owner muddies the count
      await prisma.business.update({ where: { id: biz.id }, data: { billingStatus: 'active', smsCapOverride: 1 } });
      await text(biz, phone(), 'hello');
      expect(await rows(biz.id)).toHaveLength(1);
      const [ack] = await sms(biz.id, 'inbox_autoreply');
      expect(ack.status).toBe('blocked_cap');
      expect((await db.getUsage(biz.id))?.sms_count ?? 0).toBe(0);
    });
  });

  // ================================================================== authz / tenancy
  test('list / detail / triage / reply: tenant isolated, staff allowed, anonymous refused', async () => {
    await withEnv(DEMO, async () => {
      const a = await bizAt(awakeTimezone());
      const b = await bizAt(awakeTimezone());
      await text(a, phone(), 'for A only');
      const m = (await rows(a.id))[0];
      const staffA = await login(a.id, 'staff');
      const ownerB = await login(b.id, 'owner');

      expect((await listRoute.GET(api(`/api/businesses/${a.id}/messages`, 'GET', undefined, {}), ctx(a.id))).status).toBe(401);
      const list = await listRoute.GET(api(`/api/businesses/${a.id}/messages?status=new`, 'GET', undefined, asUser(staffA.cookie)), ctx(a.id));
      expect(list.status).toBe(200);
      const page = (await list.json()).data;
      expect(page.items).toHaveLength(1);
      expect(page.items[0].from_last4).toHaveLength(4);
      expect(page.items[0]).not.toHaveProperty('from_e164'); // the list shows last 4 only
      expect(page.counts.new).toBe(1);
      const detail = await oneRoute.GET(api(`/api/businesses/${a.id}/messages/${m.id}`, 'GET', undefined, asUser(staffA.cookie)), mctx(a.id, m.id));
      expect((await detail.json()).data.from_e164).toBe(m.fromE164);

      // B's owner cannot see, triage or answer A's message, by A's id or through B's own id
      for (const bid of [a.id, b.id]) {
        expect((await listRoute.GET(api(`/api/businesses/${bid}/messages`, 'GET', undefined, asUser(ownerB.cookie)), ctx(bid))).status).toBe(bid === a.id ? 404 : 200);
        expect((await oneRoute.GET(api(`/api/businesses/${bid}/messages/${m.id}`, 'GET', undefined, asUser(ownerB.cookie)), mctx(bid, m.id))).status).toBe(404);
        expect((await oneRoute.PATCH(api(`/api/businesses/${bid}/messages/${m.id}`, 'PATCH', { status: 'handled' }, asUser(ownerB.cookie)), mctx(bid, m.id))).status).toBe(404);
        expect((await replyRoute.POST(api(`/api/businesses/${bid}/messages/${m.id}/reply`, 'POST', { body: 'hi' }, asUser(ownerB.cookie)), mctx(bid, m.id))).status).toBe(404);
      }
      expect((await rows(a.id))[0].status).toBe('new');

      // staff triage (audited), same-origin enforced for cookies
      const cross = await oneRoute.PATCH(new Request(`https://app.example.test/x`, { method: 'PATCH', headers: { ...asUser(staffA.cookie), 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ status: 'handled' }) }), mctx(a.id, m.id));
      expect(cross.status).toBe(403);
      const ok = await oneRoute.PATCH(api(`/api/businesses/${a.id}/messages/${m.id}`, 'PATCH', { status: 'handled' }, asUser(staffA.cookie)), mctx(a.id, m.id));
      expect(ok.status).toBe(200);
      const after = (await rows(a.id))[0];
      expect(after.status).toBe('handled');
      expect(after.handledAt).not.toBeNull();
      expect(await prisma.auditEvent.count({ where: { businessId: a.id, action: 'inbox.status_changed' } })).toBe(1);
      expect((await oneRoute.PATCH(api(`/api/businesses/${a.id}/messages/${m.id}`, 'PATCH', { status: 'bogus' }, asUser(staffA.cookie)), mctx(a.id, m.id))).status).toBe(422);
      expect((await listRoute.GET(api(`/api/businesses/${a.id}/messages?status=nope`, 'GET', undefined, asUser(staffA.cookie)), ctx(a.id))).status).toBe(422);
      expect(((await (await listRoute.GET(api(`/api/businesses/${a.id}/messages?status=new`, 'GET', undefined, asUser(staffA.cookie)), ctx(a.id))).json()).data.items)).toHaveLength(0);
    });
  });

  // ================================================================== reply / manual text
  test('reply: goes to the stored sender through sendAndLog (kind, STOP footer, logged), marks handled, refuses quiet hours / opt-out / empty / too long', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      await text(biz, from, 'when can you come?');
      const m = (await rows(biz.id))[0];
      const owner = await login(biz.id, 'owner');
      const post = (body: unknown) => replyRoute.POST(api(`/api/businesses/${biz.id}/messages/${m.id}/reply`, 'POST', body, asUser(owner.cookie)), mctx(biz.id, m.id));

      expect((await post({ body: '   ' })).status).toBe(422);
      expect((await post({ body: 'x'.repeat(321) })).status).toBe(422);
      const good = await post({ to: '+13055550000', body: 'Tomorrow at 3pm works.\nSee you then.' }); // a client-supplied number is never used
      expect(good.status).toBe(200);
      const [out] = await sms(biz.id, 'owner_inbox_reply');
      expect(out).toMatchObject({ toE164: from, consentBasis: 'customer_reply' });
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, toE164: '+13055550000' } })).toBe(0);
      expect(out.body).toContain('Tomorrow at 3pm works.');
      expect(out.body).toContain('Reply STOP to opt out');
      expect((await rows(biz.id))[0].status).toBe('handled');
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'inbox.reply_sent' } })).toBeGreaterThanOrEqual(1);
    });
  });

  test('reply: a full 320-character answer keeps every word; opted-out and quiet-hours customers are refused with a code', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const from = phone();
      await text(biz, from, 'question');
      const m = (await rows(biz.id))[0];
      const owner = await login(biz.id, 'owner');
      const post = (body: unknown) => replyRoute.POST(api(`/api/businesses/${biz.id}/messages/${m.id}/reply`, 'POST', body, asUser(owner.cookie)), mctx(biz.id, m.id));
      const long = `${'a'.repeat(319)}z`;
      expect((await post({ body: long })).status).toBe(200);
      expect((await sms(biz.id, 'owner_inbox_reply'))[0].body.startsWith(long)).toBe(true);

      await db.recordOptOut(biz.id, from, 'stop_keyword');
      const blocked = await post({ body: 'one more' });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).code).toBe('opted_out');
      expect(await sms(biz.id, 'owner_inbox_reply')).toHaveLength(2); // the blocked attempt is logged as blocked_opt_out, never sent
      expect((await sms(biz.id, 'owner_inbox_reply')).filter((r) => r.status === 'blocked_opt_out')).toHaveLength(1);
      const det = await oneRoute.GET(api(`/api/businesses/${biz.id}/messages/${m.id}`, 'GET', undefined, asUser(owner.cookie)), mctx(biz.id, m.id));
      expect((await det.json()).data.opted_out).toBe(true);

      const night = await bizAt(quietTimezone());
      await text(night, phone(), 'late question');
      const nm = (await rows(night.id))[0];
      const res = await replyRoute.POST(api(`/api/businesses/${night.id}/messages/${nm.id}/reply`, 'POST', { body: 'ok' }, admin), mctx(night.id, nm.id));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('quiet_hours');
      expect(await sms(night.id, 'owner_inbox_reply')).toHaveLength(0);
    });
  });

  test('manual text: only to a number the business knows; limits per recipient; logged and audited without the body', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const known = phone();
      const day = futureDateKey(3, awakeTimezone(), 3);
      await db.createBooking({ business_id: biz.id, customer_name: 'Luis', customer_phone: known, service: 'Tune-up', scheduled_at: isoAt(biz.timezone, day, '10:00'), duration_minutes: 60 });
      const staff = await login(biz.id, 'staff');
      const send = (to: string, body: string) => sendRoute.POST(api(`/api/businesses/${biz.id}/messages/send`, 'POST', { to, body }, asUser(staff.cookie)), ctx(biz.id));

      const stranger = await send(phone(), 'hello stranger');
      expect(stranger.status).toBe(422);
      expect((await stranger.json()).code).toBe('unknown_recipient');
      expect((await send('12', 'x')).status).toBe(422);
      expect((await send(biz.owner_phone!, 'to myself')).status).toBe(422);
      expect(await sms(biz.id, 'manual')).toHaveLength(0);

      const ok = await send(known, 'Your tech is on the way');
      expect(ok.status).toBe(200);
      const [row] = await sms(biz.id, 'manual');
      expect(row).toMatchObject({ toE164: known, consentBasis: 'owner_manual' });
      expect(row.body).toContain('Reply STOP to opt out');
      const audit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'sms.manual_sent' } });
      expect(JSON.stringify(audit?.meta)).not.toContain('on the way');
      for (let i = 0; i < 5; i++) await send(known, `again ${i}`);
      const limited = await send(known, 'one too many');
      expect(limited.status).toBe(429);
      expect((await limited.json()).code).toBe('rate_limited');

      const log = await logRoute.GET(api(`/api/businesses/${biz.id}/messages/log?direction=out`, 'GET', undefined, asUser(staff.cookie)), ctx(biz.id));
      const items = (await log.json()).data.items as { kind: string; who_last4: string; status: string }[];
      expect(items.some((i) => i.kind === 'manual' && i.who_last4 === known.slice(-4))).toBe(true);
      const inLog = await logRoute.GET(api(`/api/businesses/${biz.id}/messages/log?direction=in`, 'GET', undefined, asUser(staff.cookie)), ctx(biz.id));
      expect(inLog.status).toBe(200);
    });
  });

  test('manual text in quiet hours is refused (409) and sends nothing', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(quietTimezone());
      const known = phone();
      await db.recordInboundMessage({ business_id: biz.id, from: known, body: 'hi', twilio_message_sid: uniq('SMq') });
      const res = await sendRoute.POST(api(`/api/businesses/${biz.id}/messages/send`, 'POST', { to: known, body: 'ok' }), ctx(biz.id));
      expect(res.status).toBe(409);
      expect(await sms(biz.id, 'manual')).toHaveLength(0);
    });
  });

  // ================================================================== privacy
  test('privacy: owner only, step-up for export and erase, typed confirmation, audit without the number, tenant isolated', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const other = await bizAt(awakeTimezone());
      const cust = phone();
      await text(biz, cust, 'my gate code is 1234');
      const day = futureDateKey(3, awakeTimezone(), 3);
      await db.createBooking({ business_id: biz.id, customer_name: 'Zed Customer', customer_phone: cust, service: 'Tune-up', scheduled_at: isoAt(biz.timezone, day, '10:00'), duration_minutes: 60 });
      const owner = await login(biz.id, 'owner');
      const staff = await login(biz.id, 'staff');
      const otherOwner = await login(other.id, 'owner');
      const call = (route: { POST: (r: Request, c: Ctx) => Promise<Response> }, kind: string, headers: Record<string, string>, body: unknown, id = biz.id) =>
        route.POST(api(`/api/businesses/${id}/privacy/${kind}`, 'POST', body, headers), ctx(id));

      expect((await call(lookupRoute, 'lookup', asUser(staff.cookie), { phone: cust })).status).toBe(403);
      expect((await call(exportRoute, 'export', asUser(staff.cookie), { phone: cust })).status).toBe(403);
      expect((await call(eraseRoute, 'erase', asUser(staff.cookie), { phone: cust, confirm: 'ERASE' })).status).toBe(403);
      expect((await call(lookupRoute, 'lookup', asUser(otherOwner.cookie), { phone: cust })).status).toBe(404); // another tenant's id
      const own = await call(lookupRoute, 'lookup', asUser(otherOwner.cookie), { phone: cust }, other.id);
      expect(own.status).toBe(200); // own tenant: nothing about this customer
      expect((await own.json()).data).toMatchObject({ inbound_messages: 0, bookings: 0, calls: 0 });
      expect((await call(eraseRoute, 'erase', asUser(otherOwner.cookie), { phone: cust, confirm: 'ERASE' }, biz.id)).status).toBe(404);
      expect((await rows(biz.id))).toHaveLength(1);

      const look = await call(lookupRoute, 'lookup', asUser(owner.cookie), { phone: cust });
      expect((await look.json()).data).toMatchObject({ phone_last4: cust.slice(-4), inbound_messages: 1, bookings: 1 });
      expect((await call(lookupRoute, 'lookup', asUser(owner.cookie), { phone: '12' })).status).toBe(422);

      // step-up: an old proof of identity is asked to re-enter the password
      await prisma.userSession.update({ where: { id: owner.sessionId }, data: { sudoAt: new Date(Date.now() - 30 * 60_000) } });
      const stale = await call(exportRoute, 'export', asUser(owner.cookie), { phone: cust });
      expect(stale.status).toBe(403);
      expect((await stale.json()).code).toBe('reauth_required');
      const staleErase = await call(eraseRoute, 'erase', asUser(owner.cookie), { phone: cust, confirm: 'ERASE' });
      expect(staleErase.status).toBe(403);
      expect((await rows(biz.id))).toHaveLength(1);

      await prisma.userSession.update({ where: { id: owner.sessionId }, data: { sudoAt: new Date() } });
      const exp = await call(exportRoute, 'export', asUser(owner.cookie), { phone: cust });
      expect(exp.status).toBe(200);
      const data = (await exp.json()).data;
      expect(data.inbound_messages).toHaveLength(1);
      expect(data.bookings).toHaveLength(1);
      const expAudit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'privacy.export' } });
      expect(expAudit?.target).toBe(`customer:...${cust.slice(-4)}`);
      expect(JSON.stringify(expAudit)).not.toContain(cust);

      // typed confirmation is required
      expect((await call(eraseRoute, 'erase', asUser(owner.cookie), { phone: cust })).status).toBe(422);
      expect((await call(eraseRoute, 'erase', asUser(owner.cookie), { phone: cust, confirm: 'erase' })).status).toBe(422);
      expect((await rows(biz.id))).toHaveLength(1);
      const er = await call(eraseRoute, 'erase', asUser(owner.cookie), { phone: cust, confirm: 'ERASE' });
      expect(er.status).toBe(200);
      expect((await er.json()).data).toMatchObject({ inbound_messages: 1, bookings_anonymized: 1 });
      expect(await rows(biz.id)).toHaveLength(0);
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, toE164: cust } })).toBe(0);
      const eraseAudit = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'privacy.erase' } });
      expect(eraseAudit?.actorUserId).toBeTruthy();
      expect(JSON.stringify(eraseAudit)).not.toContain(cust);

      // the break-glass bearer token is not an ambient credential: it passes without step-up (and is audited as admin_token)
      expect((await call(exportRoute, 'export', admin, { phone: cust })).status).toBe(200);
      expect((await prisma.auditEvent.findMany({ where: { businessId: biz.id, action: 'privacy.export' } })).some((e) => e.actorKind === 'admin_token')).toBe(true);
    });
  });

  test('privacy routes are rate limited per business', async () => {
    const biz = await bizAt(awakeTimezone());
    let last = 200;
    for (let i = 0; i < 22; i++) {
      last = (await exportRoute.POST(api(`/api/businesses/${biz.id}/privacy/export`, 'POST', { phone: phone() }), ctx(biz.id))).status;
    }
    expect(last).toBe(429);
  });

  // ================================================================== review link (#8)
  test('review link: owner sets / clears it (https only, audited); rating 4-5 sends the business\'s own link, or none, never the old placeholder', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const owner = await login(biz.id, 'owner');
      const staff = await login(biz.id, 'staff');
      const put = (headers: Record<string, string>, review_url: unknown) => reviewRoute.PUT(api(`/api/businesses/${biz.id}/review-url`, 'PUT', { review_url }, headers), ctx(biz.id));
      expect((await put(asUser(staff.cookie), 'https://g.page/r/abc/review')).status).toBe(403);
      expect((await put(asUser(owner.cookie), 'http://g.page/r/abc/review')).status).toBe(422);
      expect((await put(asUser(owner.cookie), 'https://g.page/r/abc/ review')).status).toBe(422);
      expect((await put(asUser(owner.cookie), 12)).status).toBe(422);
      expect((await db.getBusiness(biz.id))!.review_url ?? null).toBeNull();

      const day = futureDateKey(3, awakeTimezone(), 3);
      const bk = await db.createBooking({ business_id: biz.id, customer_name: 'Rosa Diaz', customer_phone: phone(), service: 'Tune-up', scheduled_at: isoAt(biz.timezone, day, '10:00'), duration_minutes: 60 });
      const none = await gratReply(bk.id, 5);
      expect(none.routed).toBe('review');
      expect(none.body).not.toMatch(/https?:|g\.page|demo/);
      expect(none.sms?.body ?? none.body).toContain('Maria, ');

      expect((await put(asUser(owner.cookie), '  https://g.page/r/abc/review ')).status).toBe(200);
      expect((await db.getBusiness(biz.id))!.review_url).toBe('https://g.page/r/abc/review');
      const withLink = await gratReply(bk.id, 4);
      expect(withLink.body).toContain('https://g.page/r/abc/review');
      expect((await (await reviewRoute.GET(api(`/api/businesses/${biz.id}/review-url`, 'GET', undefined, asUser(staff.cookie)), ctx(biz.id))).json()).data.review_url).toBe('https://g.page/r/abc/review');
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'business.review_url_changed' } })).toBe(1);

      expect((await put(asUser(owner.cookie), null)).status).toBe(200);
      expect((await gratReply(bk.id, 5)).body).not.toContain('g.page');
      // a low rating still goes to the owner, never to a review link
      expect((await gratReply(bk.id, 2)).routed).toBe('owner');
    });
  });

  // ================================================================== owner voice channel hook
  test('a new inbox text makes a known customer a "text" lead for the owner call-in reply channel', async () => {
    await withEnv(DEMO, async () => {
      const biz = await bizAt(awakeTimezone());
      const cust = phone();
      const day = futureDateKey(3, awakeTimezone(), 3);
      await db.createBooking({ business_id: biz.id, customer_name: 'Pat', customer_phone: cust, service: 'Tune-up', scheduled_at: isoAt(biz.timezone, day, '10:00'), duration_minutes: 60 });
      const leads = await import('@/lib/voice/owner/reply-leads');
      const before = await leads.collectLeads(biz, new Date(Date.now() + 1000));
      expect(before.find((l) => l.e164 === cust)?.kind).toBe('booking');
      await prisma.booking.updateMany({ where: { businessId: biz.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });
      await text(biz, cust, 'is the tech still coming?');
      const after = await leads.collectLeads(biz, new Date(Date.now() + 1000));
      expect(after.find((l) => l.e164 === cust)?.kind).toBe('text');
      const stranger = phone();
      await text(biz, stranger, 'no booking, no call');
      expect((await leads.collectLeads(biz, new Date(Date.now() + 1000))).some((l) => l.e164 === stranger)).toBe(false);
    });
  });

  test('retention: inbox rows older than the business retention are purged; erasing a business removes them', async () => {
    const biz = await bizAt(awakeTimezone());
    await prisma.business.update({ where: { id: biz.id }, data: { retentionDays: 30 } });
    await db.recordInboundMessage({ business_id: biz.id, from: phone(), body: 'old', twilio_message_sid: uniq('SMold'), received_at: new Date(Date.now() - 40 * 86_400_000) });
    await db.recordInboundMessage({ business_id: biz.id, from: phone(), body: 'new', twilio_message_sid: uniq('SMnew') });
    const counts = await db.purgeExpiredData(new Date());
    expect(counts.inbound_messages).toBeGreaterThanOrEqual(1);
    expect((await rows(biz.id)).map((r) => r.body)).toEqual(['new']);
  });
});
