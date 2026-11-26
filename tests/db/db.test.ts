/**
 * DB-level tests. Skipped unless TEST_DATABASE_URL points at a DISPOSABLE Postgres database
 * whose name contains "test" or "scratch" and which already has the migrations applied:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/db
 *
 * Every test uses unique keys/business ids and cleans up after itself; nothing is wiped globally.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}
const suite = url ? describe : describe.skip;

suite('postgres-backed shared state', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any, rl: any, pw: typeof import('../../src/lib/password');
  const run = Math.random().toString(36).slice(2, 8);
  const businessIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url; // before the Prisma client module is evaluated
    db = await import('../../src/lib/db');
    rl = await import('../../src/lib/ratelimit');
    pw = await import('../../src/lib/password');
  });

  afterAll(async () => {
    const { prisma } = db;
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: `t-${run}` } } });
    await prisma.processedEvent.deleteMany({ where: { source: `t-${run}` } });
    await prisma.provisionLock.deleteMany({ where: { key: { startsWith: `t-${run}` } } });
    await prisma.$disconnect();
  });

  async function newBusiness(extra: Record<string, unknown> = {}) {
    const b = await db.createBusiness({ name: `Test ${run}`, ...extra });
    businessIds.push(b.id);
    return b;
  }

  test('rate limit: concurrent hits are counted atomically', async () => {
    const key = `t-${run}-atomic`;
    const results = await Promise.all(Array.from({ length: 25 }, () => rl.rateLimit(key, 10, 60_000)));
    // Window boundary may split the burst only if it falls in these few ms; allow the sum to be exact otherwise.
    const allowed = results.filter((r: { allowed: boolean }) => r.allowed).length;
    expect(allowed).toBeGreaterThanOrEqual(10);
    expect(allowed).toBeLessThanOrEqual(20);
    const rows = await db.prisma.rateLimitBucket.findMany({ where: { key } });
    expect(rows.reduce((n: number, r: { count: number }) => n + r.count, 0)).toBe(25);
    const denied = results.find((r: { allowed: boolean }) => !r.allowed);
    expect(denied.retryAfterS).toBeGreaterThanOrEqual(1);
  });

  test('rate limit: separate keys are independent', async () => {
    expect((await rl.rateLimit(`t-${run}-a`, 1, 60_000)).allowed).toBe(true);
    expect((await rl.rateLimit(`t-${run}-b`, 1, 60_000)).allowed).toBe(true);
  });

  test('rate limit: limitRequest returns 429 once over the limit', async () => {
    const route = `t-${run}-route`;
    const req = new Request('http://x.invalid/');
    let last: Response | null = null;
    for (let i = 0; i < 4; i++) last = await rl.limitRequest(req, route, 2, 60_000);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });

  test('claimEvent: first wins, concurrent duplicates lose, release re-opens', async () => {
    const id = `evt_${run}`;
    const claims = await Promise.all(Array.from({ length: 8 }, () => db.claimEvent(`t-${run}`, id)));
    expect(claims.filter(Boolean).length).toBe(1);
    expect(await db.claimEvent(`t-${run}`, id)).toBe(false);
    expect(await db.claimEvent(`t-${run}-other`, id)).toBe(true); // ids are per-source
    await db.prisma.processedEvent.deleteMany({ where: { source: `t-${run}-other` } });
    await db.releaseEvent(`t-${run}`, id);
    expect(await db.claimEvent(`t-${run}`, id)).toBe(true);
  });

  test('claimEvent: cleanup removes rows older than 30 days only', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    await db.prisma.processedEvent.create({ data: { id: `old_${run}`, source: `t-${run}`, createdAt: old } });
    await db.cleanupProcessedEvents(new Date(), true);
    expect(await db.prisma.processedEvent.count({ where: { source: `t-${run}`, id: `old_${run}` } })).toBe(0);
    expect(await db.prisma.processedEvent.count({ where: { source: `t-${run}`, id: `evt_${run}` } })).toBe(1);
  });

  test('lease: exclusive, expires, renewable, only holder releases', async () => {
    const key = `t-${run}-lease`;
    const a = await Promise.all(Array.from({ length: 6 }, () => db.acquireLease(key, 60_000)));
    const winners = a.filter(Boolean);
    expect(winners.length).toBe(1);
    const lease = winners[0];
    expect(await db.acquireLease(key, 60_000)).toBeNull();
    expect(await db.renewLease(lease, 60_000)).toBe(true);
    await db.releaseLease({ key, holder: 'someone-else' });
    expect(await db.acquireLease(key, 60_000)).toBeNull();
    await db.releaseLease(lease);

    const short = await db.acquireLease(key, 1000);
    expect(short).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1200));
    const takeover = await db.acquireLease(key, 60_000);
    expect(takeover).not.toBeNull();
    expect(await db.renewLease(short, 60_000)).toBe(false); // stale holder lost it
    await db.releaseLease(takeover);
  });

  test('withLease: runs, blocks a second caller, releases on throw', async () => {
    const key = `t-${run}-with`;
    let inner: unknown;
    const first = await db.withLease(key, 30_000, async () => {
      inner = await db.withLease(key, 30_000, async () => 'nested');
      return 'outer';
    });
    expect(first).toEqual({ acquired: true, value: 'outer' });
    expect(inner).toEqual({ acquired: false });
    await expect(db.withLease(key, 30_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await db.withLease(key, 30_000, async () => 1)).acquired).toBe(true);
  });

  test('findActiveCall: id and sid only, never by phone', async () => {
    const b = await newBusiness();
    const c = await db.createCall({ business_id: b.id, caller_phone: '+13055550101', call_sid: `sid-${run}` });
    expect((await db.findActiveCall(b.id, { callId: c.id }))?.id).toBe(c.id);
    expect((await db.findActiveCall(b.id, { callSid: `sid-${run}` }))?.id).toBe(c.id);
    expect(await db.findActiveCall(b.id, {})).toBeNull();
    // callerPhone is no longer a hint (ignored if passed)
    expect(await db.findActiveCall(b.id, { callerPhone: '+13055550101' })).toBeNull();
    const other = await newBusiness();
    expect(await db.findActiveCall(other.id, { callId: c.id })).toBeNull();
  });

  test('opt-out: normalised phone, idempotent, per business, opt-in clears', async () => {
    const b = await newBusiness();
    const b2 = await newBusiness();
    expect(await db.isOptedOut(b.id, '+1 (305) 555-0142')).toBe(false);
    await db.recordOptOut(b.id, '305-555-0142');
    await db.recordOptOut(b.id, '+13055550142'); // idempotent
    expect(await db.prisma.smsOptOut.count({ where: { businessId: b.id } })).toBe(1);
    expect(await db.isOptedOut(b.id, '+13055550142')).toBe(true);
    expect(await db.isOptedOut(b2.id, '+13055550142')).toBe(false);
    expect(await db.recordOptIn(b.id, '3055550142')).toBe(true);
    expect(await db.isOptedOut(b.id, '+13055550142')).toBe(false);
  });

  test('purgeExpiredData honours retention_days and keeps financials', async () => {
    const b = await newBusiness({ retention_days: 30 });
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86_400_000);
    const fresh = new Date(now.getTime() - 5 * 86_400_000);
    const oldCall = await db.createCall({ business_id: b.id, caller_phone: '+13055550111', transcript: 'secret', started_at: old.toISOString() });
    const freshCall = await db.createCall({ business_id: b.id, caller_phone: '+13055550112', transcript: 'ok', started_at: fresh.toISOString() });
    const oldBooking = await db.prisma.booking.create({ data: {
      businessId: b.id, callId: oldCall.id, customerName: 'Ann', customerPhone: '+13055550111', service: 'AC',
      scheduledAt: old, address: '1 Main', priceEstimate: 15000, depositAmount: 5000, depositPaid: true } });
    const freshBooking = await db.prisma.booking.create({ data: {
      businessId: b.id, customerName: 'Bob', customerPhone: '+13055550112', service: 'AC', scheduledAt: fresh, address: '2 Main' } });
    await db.prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550111', body: 'hi', kind: 'other', createdAt: old } });
    await db.prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550112', body: 'hi', kind: 'other', createdAt: fresh } });
    await db.recordOptOut(b.id, '+13055550111');

    const counts = await db.purgeExpiredData(now);
    expect(counts.calls).toBeGreaterThanOrEqual(1);
    expect(await db.getCall(oldCall.id)).toBeNull();
    expect((await db.getCall(freshCall.id))?.transcript).toBe('ok');
    expect(await db.prisma.smsLog.count({ where: { businessId: b.id } })).toBe(1);
    const ob = await db.prisma.booking.findUnique({ where: { id: oldBooking.id } });
    expect(ob).toMatchObject({ customerName: '[redacted]', customerPhone: '', address: null, priceEstimate: 15000, depositAmount: 5000, depositPaid: true, callId: null });
    expect(ob.anonymizedAt).not.toBeNull();
    const fb = await db.prisma.booking.findUnique({ where: { id: freshBooking.id } });
    expect(fb).toMatchObject({ customerName: 'Bob', address: '2 Main', anonymizedAt: null });
    expect(await db.isOptedOut(b.id, '+13055550111')).toBe(true); // suppression survives
    const again = await db.purgeExpiredData(now); // idempotent
    expect(again.bookings_anonymized).toBe(0);
  });

  test('eraseCustomerData removes one customer only, scoped to the business', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    const call = await db.createCall({ business_id: b.id, caller_phone: '+1 (305) 555-0199', transcript: 'x' });
    const keep = await db.createCall({ business_id: b.id, caller_phone: '+13055550188', transcript: 'y' });
    const theirs = await db.createCall({ business_id: other.id, caller_phone: '+13055550199', transcript: 'z' });
    await db.prisma.booking.create({ data: { businessId: b.id, callId: call.id, customerName: 'Cy', customerPhone: '305 555 0199', service: 'AC', scheduledAt: new Date(Date.now() + 86_400_000), address: 'q', priceEstimate: 100 } });
    await db.prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550199', body: 'hello', kind: 'other' } });
    await db.prisma.smsLog.create({ data: { businessId: b.id, toPhone: '+13055550188', body: 'hello', kind: 'other' } });

    // live-transcript rows belong to the call: erased with it, and counted
    await db.appendTranscriptEvents(call.id, [{ seq: 0, role: 'caller', text: 'my name is Cy', at: new Date() }, { seq: 1, role: 'agent', text: 'hello Cy', at: new Date() }]);
    await db.appendTranscriptEvents(keep.id, [{ seq: 0, role: 'caller', text: 'other person', at: new Date() }]);

    const counts = await db.eraseCustomerData(b.id, '+13055550199');
    expect(await db.prisma.callTranscriptEvent.count({ where: { callId: call.id } })).toBe(0);
    expect(await db.prisma.callTranscriptEvent.count({ where: { callId: keep.id } })).toBe(1);
    expect(counts).toEqual({ calls: 1, transcript_events: 2, sms_logs: 1, bookings_anonymized: 1, inbound_messages: 0, briefings: 0, audio_files: 0, recordings: 0, recordings_pending: 0, recording_deletion: 'complete' });
    expect(await db.getCall(call.id)).toBeNull();
    expect(await db.getCall(keep.id)).not.toBeNull();
    expect(await db.getCall(theirs.id)).not.toBeNull();
    expect(await db.prisma.smsLog.count({ where: { businessId: b.id } })).toBe(1);
    await expect(db.eraseCustomerData(b.id, '123')).rejects.toThrow();
  });

  test('users and sessions', async () => {
    const b = await newBusiness();
    const email = `Owner.${run}@Example.com`;
    const u = await db.createUser({ email, password_hash: await pw.hashPassword('pw-12345678'), role: 'owner', business_id: b.id });
    userIds.push(u.id);
    expect(u.email).toBe(email.toLowerCase());
    await expect(db.createUser({ email: email.toUpperCase(), password_hash: 'x', role: 'owner', business_id: b.id })).rejects.toThrow('email already registered');
    await expect(db.createUser({ email: `n.${run}@e.com`, password_hash: 'x', role: 'owner' })).rejects.toThrow();
    const found = await db.getUserByEmail(` ${email.toUpperCase()} `);
    expect(found?.id).toBe(u.id);
    expect(await pw.verifyPassword('pw-12345678', found.password_hash)).toBe(true);

    const { token, session } = await db.createSession(u.id);
    const row = await db.prisma.userSession.findUnique({ where: { id: session.id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.getSessionByToken(token))?.user.id).toBe(u.id);
    expect(await db.getSessionByToken(token + 'x')).toBeNull();
    expect(await db.getSessionByToken(null)).toBeNull();
    // expiry
    expect(await db.getSessionByToken(token, new Date(Date.now() + 8 * 86_400_000))).toBeNull();
    expect(await db.prisma.userSession.count({ where: { id: session.id } })).toBe(0);
    // disabled user
    const s2 = await db.createSession(u.id);
    await db.prisma.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
    expect(await db.getSessionByToken(s2.token)).toBeNull();
    await db.prisma.user.update({ where: { id: u.id }, data: { disabledAt: null } });
    expect(await db.getSessionByToken(s2.token)).not.toBeNull();
    // logout
    expect(await db.deleteSession(s2.token)).toBe(true);
    expect(await db.getSessionByToken(s2.token)).toBeNull();
    await db.createSession(u.id); await db.createSession(u.id);
    expect(await db.deleteUserSessions(u.id)).toBe(2);
    // admin
    const admin = await db.createUser({ email: `admin.${run}@example.com`, password_hash: 'x', role: 'admin' });
    userIds.push(admin.id);
    expect(admin.business_id).toBeNull();
  });
});
