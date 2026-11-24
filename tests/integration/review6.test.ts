/**
 * Round 6 review fixes (docs/review/10): per-caller limits with a reserved share for known customers, each CallSid charged once and
 * pressure alerts (H1); voicemail / forwarded seconds in their own counters with their own caps, a cap on simultaneous forwards and
 * reserved minutes, carrier-voicemail / canceled legs (M1); durable provider-side recording deletion (M2); step-up for the break-glass
 * cookie session, forward_during_hours and 2FA accounts, the audit actor of DB admins, the line-kind mismatch (L1-L5), and the voicemail
 * proxy limits. The PoCs of the review (scratchpad round6-poc.test.ts) are reproduced here and now assert the FIXED behaviour.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, phone, twilioSignature, uniq } from '../helpers/fixtures';
import { hashPassword } from '../../src/lib/password';
import { clearVoicemailCache } from '../../src/lib/voice/voicemail';

const PASSWORD = 'correct horse battery staple';
const ACCOUNT = `AC${'a'.repeat(32)}`;
let recSeq = 0;
const recUrl = () => `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${(Date.now().toString(16) + (++recSeq).toString(16)).padStart(32, '0').slice(-32)}`;
const REC = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/RE${'e'.repeat(32)}`;

integration('review round 6 fixes (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let totp: typeof import('@/lib/totp');
  let jobs: typeof import('@/lib/jobs');
  let recDel: typeof import('@/lib/voice/recording-deletion');
  type Ctx = { params: Promise<{ id: string }> };
  let incoming: (req: Request) => Promise<Response>;
  let voicemail: (req: Request) => Promise<Response>;
  let dialStatus: (req: Request) => Promise<Response>;
  let modeRoute: { PATCH: (req: Request, c: Ctx) => Promise<Response> };
  let reauth: (req: Request) => Promise<Response>;
  let vmRoute: { GET: (req: Request, c: Ctx) => Promise<Response> };
  let adminJobs: { GET: (req: Request) => Promise<Response> };
  const userIds: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    users = await import('@/lib/db/users');
    totp = await import('@/lib/totp');
    jobs = await import('@/lib/jobs');
    recDel = await import('@/lib/voice/recording-deletion');
    incoming = (await import('@/app/api/voice/incoming/route')).POST;
    voicemail = (await import('@/app/api/voice/voicemail/route')).POST;
    dialStatus = (await import('@/app/api/voice/dial-status/route')).POST;
    modeRoute = await import('@/app/api/businesses/[id]/call-mode/route');
    reauth = (await import('@/app/api/auth/reauth/route')).POST;
    vmRoute = await import('@/app/api/calls/[id]/voicemail/route');
    adminJobs = await import('@/app/api/admin/jobs/route');
  });
  afterAll(async () => {
    await prisma.pendingRecordingDeletion.deleteMany({ where: { accountSid: ACCOUNT } });
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanup();
  });
  beforeEach(async () => {
    clearVoicemailCache();
    await prisma.pendingRecordingDeletion.deleteMany({}); // the queue is global: start every test from an empty one
    await prisma.rateLimitBucket.deleteMany({
      where: { OR: [{ key: { startsWith: 'voice/' } }, { key: { startsWith: 'callmode-notice' } }, { key: { startsWith: 'auth/reauth' } }, { key: { startsWith: 'voicemail-proxy' } }] },
    });
  });

  // ------------------------------------------------------------ helpers
  const URL_IN = `${SECRETS.publicBase}/api/voice/incoming`;
  const URL_VM = `${SECRETS.publicBase}/api/voice/voicemail`;
  const URL_DS = `${SECRETS.publicBase}/api/voice/dial-status`;
  const post = (url: string, params: Record<string, string>, h: (r: Request) => Promise<Response>) => h(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(url, params) },
    body: new URLSearchParams(params).toString(),
  }));
  const FWD = { callMode: 'forward', forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() };
  const ring = (biz: { phone?: string | null }, from: string = phone(), CallSid: string = uniq('CA')) =>
    post(URL_IN, { AccountSid: ACCOUNT, CallSid, CallStatus: 'ringing', From: from, To: biz.phone! }, incoming);
  const kindOf = (xml: string) => (xml.includes('<Dial') ? 'dial' : xml.includes('<Record') ? 'record' : 'hangup');
  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
  const api = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://app.example.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const bearer = { authorization: `Bearer ${SECRETS.adminToken}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const asCookie = (cookie: string): Record<string, string> => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', cookie });

  async function login(businessId: string | null, role: 'owner' | 'staff' | 'admin' = 'owner', opts: { totp?: boolean } = {}) {
    const user = await users.createUser({
      email: `${uniq('u')}@example.test`, password_hash: await hashPassword(PASSWORD), role, business_id: businessId, email_verified: true,
    });
    userIds.push(user.id);
    let secret: string | null = null;
    if (opts.totp) {
      secret = totp.generateTotpSecret();
      await users.beginTotpEnrollment(user.id, totp.encryptSecret(secret, user.id));
      await users.confirmTotpEnrollment(user.id, totp.totpStep(), [`h-${uniq('rc')}`]);
    }
    const { token, session } = await users.createSession(user.id, { mfaVerified: Boolean(opts.totp) });
    return { cookie: `rc_user_session=${token}`, user, sessionId: session.id, secret };
  }
  const ageSudo = (sessionId: string, minutes: number) =>
    prisma.userSession.update({ where: { id: sessionId }, data: { sudoAt: new Date(Date.now() - minutes * 60_000) } });
  const bucketCount = async (keyLike: string) =>
    (await prisma.rateLimitBucket.findMany({ where: { key: { startsWith: keyLike } } })).reduce((n, r) => n + r.count, 0);

  let bookSeq = 1;
  const bookKnown = (businessId: string, n: string) => prisma.booking.create({
    data: { businessId, customerName: 'Known', customerPhone: n, phoneE164: n, service: 'AC repair', scheduledAt: new Date(Date.now() + (++bookSeq) * 86_400_000) },
  });

  // ================================================================== H1
  test('H1 PoC fixed: one anonymous-ish caller placing 60 calls no longer shuts the business off; a genuine customer still gets the owner', () => withEnv({ FORWARD_MAX_CONCURRENT: '50' }, async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const attacker = phone();
    const outcomes: string[] = [];
    for (let i = 0; i < 60; i++) outcomes.push(kindOf(await (await ring(biz, attacker)).text()));
    // defaults: 3 forwards, then 2 voicemails of their own, the rest get the short "try again later" and cost nothing
    expect(outcomes.filter((o) => o === 'dial').length).toBe(3);
    expect(outcomes.filter((o) => o === 'record').length).toBe(2);
    expect(outcomes.filter((o) => o === 'hangup').length).toBe(55);
    // the business budgets saw only what the attacker was allowed: 3 forwards and 2 voicemails, not 60
    expect(await bucketCount(`voice/forward:hour:${biz.id}`)).toBe(3);
    expect(await bucketCount(`voice/voicemail:hour:${biz.id}`)).toBe(2);
    // a genuine customer from another number gets the owner's phone, exactly as before the attack
    const real = await (await ring(biz, phone())).text();
    expect(kindOf(real)).toBe('dial');
    // the attacker's over-limit calls are recorded (not left "in progress") and never texted the owner
    const rows = await prisma.call.findMany({ where: { businessId: biz.id, callerPhone: attacker } });
    expect(rows.length).toBe(60);
    expect(rows.filter((r) => r.status === 'in_progress').length).toBe(0);
    expect(rows.some((r) => /too many calls from this number/.test(r.flaggedReason ?? ''))).toBe(true);
    const texts = await prisma.smsLog.count({ where: { businessId: biz.id, body: { contains: 'MISSED CALL' } } });
    expect(texts).toBeLessThanOrEqual(1); // the 4th call's voicemail notice at most (rate limited), never one per attacker call
  }));

  test('H1 callers that withhold their number share ONE stricter bucket per business', () => withEnv({ FORWARD_MAX_CONCURRENT: '50' }, async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const outcomes: string[] = [];
    for (const from of ['anonymous', '+266696687', 'restricted', 'anonymous', '', 'anonymous', 'anonymous', 'anonymous']) {
      outcomes.push(kindOf(await (await ring(biz, from)).text()));
    }
    expect(outcomes.filter((o) => o === 'dial').length).toBe(5); // FORWARD_WITHHELD_PER_HOUR default 5, for ALL of them together
    expect(outcomes.slice(5).includes('dial')).toBe(false);
    // a caller with a real number is not affected by the anonymous bucket
    expect(kindOf(await (await ring(biz, phone())).text())).toBe('dial');
  }));

  test('H1 PoC fixed: a Twilio retry of the SAME CallSid is charged once (forward and voicemail budgets)', async () => {
    await withEnv({ FORWARD_CALLS_PER_HOUR: '2', CALLER_UNKNOWN_SHARE_PCT: '100', FORWARD_MAX_CONCURRENT: '50' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: FWD });
      const sid = uniq('CA');
      const from = phone();
      expect(kindOf(await (await ring(biz, from, sid)).text())).toBe('dial');
      expect(kindOf(await (await ring(biz, from, sid)).text())).toBe('dial'); // the retry gets the same answer ...
      expect(await bucketCount(`voice/forward:hour:${biz.id}`)).toBe(1); // ... and was not charged again
      expect(await bucketCount(`voice/forward:caller:${biz.id}`)).toBe(1);
      expect(kindOf(await (await ring(biz, phone())).text())).toBe('dial'); // the second REAL call still fits the budget of 2
      expect(kindOf(await (await ring(biz, phone())).text())).not.toBe('dial'); // the third does not
    });
    // the same for the voicemail budget (paused mode)
    await withEnv({ VOICEMAIL_PER_HOUR: '1', CALLER_UNKNOWN_SHARE_PCT: '100' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { callMode: 'paused' } });
      const sid = uniq('CA');
      const from = phone();
      expect(kindOf(await (await ring(biz, from, sid)).text())).toBe('record');
      expect(kindOf(await (await ring(biz, from, sid)).text())).toBe('record');
      expect(kindOf(await (await ring(biz, phone())).text())).toBe('hangup'); // 1/hour was spent by the FIRST call only
    });
  });

  test('H1 a business-wide flood degrades gracefully: strangers hit their share, known customers (a booking in 90 days) still get through', async () => {
    await withEnv({ FORWARD_CALLS_PER_HOUR: '8', FORWARD_PER_CALLER_PER_HOUR: '3', FORWARD_MAX_CONCURRENT: '50' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: FWD });
      // strangers (distinct numbers, so each is within its own limit): the unknown share of 8 is 75% = 6
      const strangers: string[] = [];
      for (let i = 0; i < 10; i++) strangers.push(kindOf(await (await ring(biz, phone())).text()));
      expect(strangers.filter((o) => o === 'dial').length).toBe(6);
      // a known customer arrives AFTER the flood: still dialled; so is a second one (2 reserved of 8)
      const knownA = phone();
      const knownB = phone();
      for (const n of [knownA, knownB]) {
        await bookKnown(biz.id, n);
        expect(kindOf(await (await ring(biz, n)).text())).toBe('dial');
      }
      // ... and when the whole budget is truly spent even a known customer waits (the ceiling guards cost)
      const knownC = phone();
      await bookKnown(biz.id, knownC);
      expect(kindOf(await (await ring(biz, knownC)).text())).not.toBe('dial');
    });
  });

  test('H1 calls the attacker makes never make them "known": forwarded / voicemail calls do not earn the reserved share', async () => {
    const biz = await newBusiness();
    const caller = phone();
    await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: caller, callerE164: caller, status: 'completed', summary: 'Forwarded to ...', durationSec: 300 } });
    await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: caller, callerE164: caller, status: 'handed_off', recordingUrl: REC, durationSec: 60, transcript: 'x' } });
    const { isKnownCaller } = await import('@/lib/voice/caller-limits');
    expect(await isKnownCaller(biz.id, caller)).toBe(false);
    await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: caller, callerE164: caller, status: 'completed', transcript: 'Hi, I need a repair', durationSec: 120 } });
    expect(await isKnownCaller(biz.id, caller)).toBe(true); // an answered AI call counts
    expect(await isKnownCaller(biz.id, null)).toBe(false);
    expect(await isKnownCaller(biz.id, phone())).toBe(false);
  });

  test('H1 pressure: past 80% of the business budget there is a loud log line and ONE owner notice per hour', async () => {
    await withEnv({ FORWARD_CALLS_PER_HOUR: '5', CALLER_UNKNOWN_SHARE_PCT: '100', FORWARD_MAX_CONCURRENT: '50' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: FWD });
      for (let i = 0; i < 5; i++) await ring(biz, phone());
      await new Promise((r) => setTimeout(r, 150)); // the notice is fire-and-forget
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, body: { contains: 'HEADS UP' } } })).toBe(1);
      for (let i = 0; i < 3; i++) await ring(biz, phone());
      await new Promise((r) => setTimeout(r, 150));
      expect(await prisma.smsLog.count({ where: { businessId: biz.id, body: { contains: 'HEADS UP' } } })).toBe(1);
    });
  });

  test('H1 a caller who hangs up while it rings (DialCallStatus=canceled) costs no voicemail unit and gets no recording prompt', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const from = phone();
    const sid = uniq('CA');
    await ring(biz, from, sid);
    const before = await bucketCount(`voice/voicemail:`);
    const res = await post(URL_VM, { CallSid: sid, DialCallStatus: 'canceled' }, voicemail);
    const xml = await res.text();
    expect(xml).toContain('<Hangup/>');
    expect(xml).not.toContain('<Record');
    expect(await bucketCount(`voice/voicemail:`)).toBe(before);
    expect((await prisma.call.findFirst({ where: { callSid: sid } }))?.flaggedReason).toMatch(/hung up before/);
  });

  // ================================================================== M1
  test('M1 PoC fixed: anonymous voicemails fill the VOICEMAIL counter, never the AI minutes; the AI line stays in service', async () => {
    await withEnv({ BILLING_ENFORCED: 'true', TRIAL_CALL_MINUTES_CAP: '30' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { callMode: 'paused' } });
      await db.setBillingState(biz.id, { billing_status: 'trialing' });
      for (let i = 0; i < 20; i++) {
        const CallSid = uniq('CA');
        await post(URL_IN, { AccountSid: ACCOUNT, CallSid, CallStatus: 'ringing', From: phone(), To: biz.phone! }, incoming);
        await post(URL_VM, { AccountSid: ACCOUNT, CallSid, RecordingUrl: REC, RecordingDuration: '90' }, voicemail);
      }
      expect(await db.getUsage(biz.id)).toMatchObject({ call_seconds: 0, voicemail_seconds: 1800, forward_seconds: 0 });
      expect((await db.checkCallAllowed(biz.id)).ok).toBe(true); // the AI line is untouched
      expect((await db.checkVoicemailAllowed(biz.id)).ok).toBe(true); // 30 of its own 60 minutes
    });
  });

  test('M1 voicemail minutes have their own cap (VOICEMAIL_MINUTES_CAP): once used, callers hear "try again later" and the call is recorded as such', async () => {
    await withEnv({ BILLING_ENFORCED: 'true', VOICEMAIL_MINUTES_CAP: '1' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { callMode: 'paused' } });
      await db.setBillingState(biz.id, { billing_status: 'active' });
      expect(kindOf(await (await ring(biz)).text())).toBe('record');
      await db.recordVoicemailSeconds(biz.id, 61);
      expect((await db.checkCallAllowed(biz.id)).ok).toBe(true);
      const sid = uniq('CA');
      expect(kindOf(await (await ring(biz, phone(), sid)).text())).toBe('hangup');
      expect((await prisma.call.findFirst({ where: { callSid: sid } }))?.flaggedReason).toMatch(/voicemail minutes of this month are used up/);
    });
  });

  test('M1 simultaneous forwards: at most FORWARD_MAX_CONCURRENT dial, and the live ones RESERVE the minutes (no N-times overshoot)', async () => {
    await withEnv({ BILLING_ENFORCED: 'true', FORWARD_MINUTES_CAP: '10', FORWARD_MAX_CONCURRENT: '3', CALLER_UNKNOWN_SHARE_PCT: '100' }, async () => {
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: FWD });
      await db.setBillingState(biz.id, { billing_status: 'active' });
      // 600 s of allowance: the first live call reserves ALL of it, so a second simultaneous call cannot be promised the same minutes
      const first = await (await ring(biz)).text();
      expect(first).toContain('timeLimit="600"');
      const second = await (await ring(biz)).text();
      expect(kindOf(second)).toBe('record'); // cap_reached once the reservation is counted

      // concurrency cap without a minutes cap
      await withEnv({ BILLING_ENFORCED: 'false', FORWARD_MAX_CONCURRENT: '2' }, async () => {
        const b2 = await newBusiness();
        await prisma.business.update({ where: { id: b2.id }, data: FWD });
        const sids = [uniq('CA'), uniq('CA'), uniq('CA')];
        const got: string[] = [];
        for (const sid of sids) got.push(kindOf(await (await ring(b2, phone(), sid)).text()));
        expect(got).toEqual(['dial', 'record', 'record']); // strangers hold at most max-1 = 1 slot: the last one is for a known customer
        const knownN = phone();
        await bookKnown(b2.id, knownN);
        sids[1] = uniq('CA');
        expect(kindOf(await (await ring(b2, knownN, sids[1])).text())).toBe('dial');
        expect(kindOf(await (await ring(b2, knownN)).text())).toBe('record'); // both slots are taken now
        expect(await db.liveForwardCount(b2.id)).toBe(2);
        // one call ends (its leg is metered): the slot is free again, and the metered seconds are in forward_seconds
        expect((await post(URL_DS, { ParentCallSid: sids[0], CallSid: uniq('CAc'), CallStatus: 'completed', CallDuration: '90' }, dialStatus)).status).toBe(200);
        expect(await db.liveForwardCount(b2.id)).toBe(1);
        expect(kindOf(await (await ring(b2, phone())).text())).toBe('record'); // the known customer's call holds the stranger slot
        expect((await post(URL_DS, { ParentCallSid: sids[1], CallSid: uniq('CAc'), CallStatus: 'completed', CallDuration: '30' }, dialStatus)).status).toBe(200);
        expect(kindOf(await (await ring(b2, phone())).text())).toBe('dial');
        expect(await db.getUsage(b2.id)).toMatchObject({ forward_seconds: 120, call_seconds: 0 });
      });
    });
  });

  test('M1 a leg "answered" for a few seconds, or by a machine (the owner carrier voicemail), is treated as unanswered: the caller gets OUR voicemail', async () => {
    const { classifyDial } = await import('@/lib/voice/forward-metering');
    expect(classifyDial({ DialCallStatus: 'completed', DialCallDuration: '45' }).result).toBe('answered');
    expect(classifyDial({ DialCallStatus: 'completed', DialCallDuration: '3' }).result).toBe('unanswered');
    expect(classifyDial({ DialCallStatus: 'completed', DialCallDuration: '300', AnsweredBy: 'machine_start' }).result).toBe('unanswered');
    expect(classifyDial({ DialCallStatus: 'completed', DialCallDuration: '300', AnsweredBy: 'human' }).result).toBe('answered');
    expect(classifyDial({ DialCallStatus: 'no-answer' }).result).toBe('unanswered');
    expect(classifyDial({ DialCallStatus: 'busy' }).result).toBe('unanswered');
    expect(classifyDial({ DialCallStatus: 'canceled' }).result).toBe('canceled');
    expect(classifyDial({ DialCallStatus: 'completed', DialCallDuration: '3' }, { FORWARD_MIN_ANSWERED_SECONDS: '0' }).result).toBe('answered'); // switched off

    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD });
    const sid = uniq('CA');
    await ring(biz, phone(), sid);
    const xml = await (await post(URL_VM, { CallSid: sid, DialCallStatus: 'completed', DialCallDuration: '4' }, voicemail)).text();
    expect(xml).toContain('<Record');
    expect(xml.indexOf('will be recorded')).toBeLessThan(xml.indexOf('<Record'));
    expect(await db.getUsage(biz.id)).toMatchObject({ forward_seconds: 4, call_seconds: 0 }); // the bridged seconds are still real minutes
    expect((await prisma.call.findFirst({ where: { callSid: sid } }))?.flaggedReason).toMatch(/not answered/);
  });

  test('M1 the billing summary shows the three counters separately; the ring time is shorter than carrier voicemail pickup', async () => {
    const biz = await newBusiness();
    await db.recordCallSeconds(biz.id, 120);
    await db.recordForwardSeconds(biz.id, 600);
    await db.recordVoicemailSeconds(biz.id, 90);
    const { billingSummary } = await import('@/lib/billing/summary');
    const s = await billingSummary((await db.getBusiness(biz.id))!);
    expect(s.usage.call_minutes).toMatchObject({ used: 2, used_seconds: 120 });
    expect(s.usage.forward_minutes).toMatchObject({ used: 10, used_seconds: 600, cap: 600 });
    expect(s.usage.voicemail_minutes).toMatchObject({ used: 1, used_seconds: 90, cap: 60 });
    const { forwardTwiml, forwardRingSeconds } = await import('@/lib/voice/twiml');
    expect(forwardTwiml('+13055550142')).toContain('timeout="20"');
    expect(forwardRingSeconds({ FORWARD_RING_SECONDS: '15' })).toBe(15);
    expect(forwardRingSeconds({ FORWARD_RING_SECONDS: '99' })).toBe(20);
  });

  // ================================================================== M2
  const fakeTwilio = (status: number) => {
    const seen: { url: string; method: string }[] = [];
    const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
      seen.push({ url: String(input), method: init.method ?? 'GET' });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  };
  const queueRow = (recordingUrl: string) => prisma.pendingRecordingDeletion.findFirst({ where: { recordingSid: recordingUrl.split('/Recordings/')[1] } });

  test('M2 PoC fixed: erasure with a failing Twilio keeps a durable pending deletion, says so, and the jobs runner finishes it (backoff, 404 = done)', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const caller = phone();
      const url = recUrl();
      await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: caller, callerE164: caller, status: 'handed_off', recordingUrl: url, durationSec: 30 } });
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
      try {
        const out = await db.eraseCustomerData(biz.id, caller);
        expect(out).toMatchObject({ calls: 1, recordings: 0, recordings_pending: 1, recording_deletion: 'pending' });
      } finally { globalThis.fetch = saved; }
      // the call row is gone but the recording is NOT forgotten: a queue row with the SIDs exists
      expect(await prisma.call.count({ where: { businessId: biz.id, callerE164: caller } })).toBe(0);
      const row = await queueRow(url);
      expect(row).toMatchObject({ accountSid: ACCOUNT, businessId: biz.id, attempts: 1, lastError: 'http_503' });
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backoff
      // the export is honest about it too
      const { exportCustomerData } = await import('@/lib/privacy');
      expect((await exportCustomerData(biz.id, caller)).recording_deletions_pending).toBe(1);

      // not due yet: the runner leaves it alone
      const failing = fakeTwilio(503);
      expect((await jobs.runRecordingDeletions({ fetchImpl: failing.fetchImpl })).counts).toMatchObject({ attempted: 0 });
      expect(failing.seen.length).toBe(0);
      // due again, Twilio still down: attempts grow, the row stays
      let at = new Date(Date.now() + 3 * 60_000);
      const r2 = await jobs.runRecordingDeletions({ now: at, fetchImpl: failing.fetchImpl });
      expect(r2.errors).toBe(1);
      expect((await queueRow(url))?.attempts).toBe(2);
      // Twilio says 404 (already gone): that is DONE and the row is removed
      at = new Date(at.getTime() + 24 * 3600_000);
      const gone = fakeTwilio(404);
      const r3 = await jobs.runRecordingDeletions({ now: at, fetchImpl: gone.fetchImpl });
      expect(r3.processed).toBe(1);
      expect(gone.seen[0]).toMatchObject({ method: 'DELETE', url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${url.split('/Recordings/')[1]}.json` });
      expect(await queueRow(url)).toBeNull();
      expect((await jobs.runJob('recording_deletions', { dryRun: true })).job).toBe('recording_deletions');
    });
  });

  test('M2 a recording that keeps failing raises ONE alert (log + audit row) and stays queued; a credentials mismatch is retried, never dropped', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const url = recUrl();
      const ids = await prisma.$transaction((tx) => db.enqueueRecordingDeletions(tx, [{ url, businessId: biz.id }]));
      expect(ids.length).toBe(1);
      const failing = fakeTwilio(500);
      let at = new Date();
      let alerted = 0;
      for (let i = 0; i < 7; i++) {
        at = new Date(at.getTime() + 7 * 3600_000);
        alerted += (await recDel.drainRecordingDeletions({ now: at, fetchImpl: failing.fetchImpl })).alerted;
      }
      expect(alerted).toBe(1); // once, not on every failed attempt after the threshold
      expect(await prisma.auditEvent.count({ where: { businessId: biz.id, action: 'recordings.deletion_stuck' } })).toBe(1);
      expect((await queueRow(url))?.attempts).toBe(7);
      expect((await db.recordingDeletionStatus(biz.id))).toMatchObject({ pending: 1, stuck: 1 });
      // the admin diagnostics show the queue and it keeps retrying (a recovered Twilio finishes it)
      const diag = ((await (await adminJobs.GET(api('/api/admin/jobs', 'GET', undefined, bearer))).json()) as { data: { diagnostics: { recording_deletions: { pending: number; stuck: number } } } }).data.diagnostics;
      expect(diag.recording_deletions.stuck).toBeGreaterThanOrEqual(1);
      at = new Date(at.getTime() + 7 * 3600_000);
      expect((await recDel.drainRecordingDeletions({ now: at, fetchImpl: fakeTwilio(204).fetchImpl })).deleted).toBe(1);
      expect(await queueRow(url)).toBeNull();

      // credentials that no longer match the recording's account: no request is made, the row stays (and is retried) instead of being forgotten
      const foreign = `https://api.twilio.com/2010-04-01/Accounts/AC${'c'.repeat(32)}/Recordings/RE${'d'.repeat(32)}`;
      await prisma.$transaction((tx) => db.enqueueRecordingDeletions(tx, [{ url: foreign, businessId: biz.id }]));
      const none = fakeTwilio(204);
      const res = await recDel.drainRecordingDeletions({ now: new Date(at.getTime() + 24 * 3600_000), fetchImpl: none.fetchImpl });
      expect(none.seen.length).toBe(0);
      expect(res.failed).toBe(1);
      expect((await prisma.pendingRecordingDeletion.findFirst({ where: { accountSid: `AC${'c'.repeat(32)}` } }))?.lastError).toBe('no matching Twilio credentials');
      await prisma.pendingRecordingDeletion.deleteMany({ where: { accountSid: `AC${'c'.repeat(32)}` } });
    });
  });

  test('M2 retention purge queues the recordings in the same transaction (failing Twilio: the rows are gone, the queue holds them)', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const url = recUrl();
      await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: phone(), status: 'handed_off', recordingUrl: url, startedAt: new Date(Date.now() - 400 * 86_400_000) } });
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
      try {
        const counts = await db.purgeExpiredData();
        expect(counts.recordings_pending).toBeGreaterThanOrEqual(1);
      } finally { globalThis.fetch = saved; }
      expect(await prisma.call.count({ where: { businessId: biz.id } })).toBe(0);
      expect(await queueRow(url)).toMatchObject({ businessId: biz.id });
      await prisma.pendingRecordingDeletion.deleteMany({ where: { id: (await queueRow(url))!.id } });
    });
  });

  test('M2 the queue write is part of the delete transaction: if it fails, the call row survives', async () => {
    const biz = await newBusiness();
    const caller = phone();
    const url = recUrl();
    const c = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: caller, callerE164: caller, status: 'handed_off', recordingUrl: url } });
    // a queue row that violates the table check (attempts < 0) makes the enqueue throw: nothing may be deleted
    await expect(prisma.$transaction(async (tx) => {
      await tx.call.deleteMany({ where: { id: c.id } });
      await tx.$executeRaw`INSERT INTO "pending_recording_deletions" ("id","account_sid","recording_sid","attempts") VALUES ('x', ${ACCOUNT}, ${url.split('/Recordings/')[1]}, -1)`;
    })).rejects.toThrow();
    expect(await prisma.call.count({ where: { id: c.id } })).toBe(1);
    expect(await queueRow(url)).toBeNull();
  });

  // ================================================================== L1 / L2 / L3 / L4
  test('L1 PoC fixed: the break-glass admin COOKIE session needs the step-up (admin token) for a call mode change; the Bearer token stays exempt and audited', async () => {
    const biz = await newBusiness();
    const { token, session } = await users.createAdminSession();
    await ageSudo(session.id, 11 * 60);
    const cookie = `rc_session=${token}`;
    const patch = (body: unknown, h: Record<string, string> = asCookie(cookie)) => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', body, h), ctx(biz.id));
    const denied = await patch({ mode: 'paused' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'reauth_required' });
    expect((await db.getBusiness(biz.id))?.call_mode).toBe('ai');
    const doReauth = (body: unknown) => reauth(api('/api/auth/reauth', 'POST', body, asCookie(cookie)));
    expect((await doReauth({ admin_token: 'not-the-token' })).status).toBe(401);
    expect((await doReauth({})).status).toBe(422);
    expect((await doReauth({ password: PASSWORD })).status).toBe(422); // a password is not what this session has
    expect((await doReauth({ admin_token: SECRETS.adminToken })).status).toBe(200);
    expect((await patch({ mode: 'paused' })).status).toBe(200);
    expect(await prisma.auditEvent.count({ where: { action: 'auth.reauth', actorKind: 'admin_token', target: `session:${session.id}` } })).toBe(1);
    // switching back never asks; stale again after 5 minutes
    await ageSudo(session.id, 6);
    expect((await patch({ mode: 'ai' })).status).toBe(200);
    expect((await patch({ mode: 'paused' })).status).toBe(403);

    // the Bearer header is not ambient: exempt, and the audit row says admin_token with the role in meta
    expect((await patch({ mode: 'paused' }, bearer)).status).toBe(200);
    const row = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.call_mode_changed' }, orderBy: { at: 'desc' } });
    expect(row).toMatchObject({ actorKind: 'admin_token', actorUserId: null });
    expect((row!.meta as Record<string, unknown>).actor_role).toBe('admin');
  });

  test('L2 changing forward_during_hours needs the step-up, even with the mode re-sent or already forward', async () => {
    const biz = await newBusiness();
    await prisma.business.update({ where: { id: biz.id }, data: FWD }); // forward_during_hours defaults to false
    const { cookie, sessionId } = await login(biz.id);
    const patch = (body: unknown) => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', body, asCookie(cookie)), ctx(biz.id));
    await ageSudo(sessionId, 30);
    for (const body of [{ forward_during_hours: true }, { mode: 'forward', forward_during_hours: true }]) {
      const res = await patch(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 403]);
    }
    expect((await db.getBusiness(biz.id))?.forward_during_hours).toBe(false);
    // re-sending the current value is not a change
    expect((await patch({ forward_during_hours: false })).status).toBe(200);
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, asCookie(cookie)))).status).toBe(200);
    expect((await patch({ forward_during_hours: true })).status).toBe(200);
    expect((await db.getBusiness(biz.id))?.forward_during_hours).toBe(true);
  });

  test('L3 an account with 2FA must give the authenticator code for a step-up: the password alone (right or wrong) is refused', async () => {
    const biz = await newBusiness();
    const { cookie, sessionId, user, secret } = await login(biz.id, 'owner', { totp: true });
    const patch = (body: unknown) => modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', body, asCookie(cookie)), ctx(biz.id));
    const re = (body: unknown) => reauth(api('/api/auth/reauth', 'POST', body, asCookie(cookie)));
    await ageSudo(sessionId, 30);
    const pwOnly = await re({ password: PASSWORD });
    expect(pwOnly.status).toBe(422);
    expect(await pwOnly.json()).toMatchObject({ code: 'totp_required' });
    expect((await re({})).status).toBe(422);
    expect((await patch({ mode: 'paused' })).status).toBe(403); // still stale
    expect((await re({ password: PASSWORD, code: '000000' })).status).toBe(401); // wrong code, even with the right password
    await prisma.user.update({ where: { id: user.id }, data: { totpLastUsedStep: null } });
    expect((await re({ code: totp.generateTotp(secret!) })).status).toBe(200); // the code alone is enough
    expect((await patch({ mode: 'paused' })).status).toBe(200);
    // a user WITHOUT 2FA still uses the password
    const plain = await login(biz.id, 'owner');
    await ageSudo(plain.sessionId, 30);
    expect((await reauth(api('/api/auth/reauth', 'POST', { password: PASSWORD }, asCookie(plain.cookie)))).status).toBe(200);
  });

  test('L4 a DB admin user is audited as actor kind "user" with the role in meta (not the break-glass "admin_token")', async () => {
    const biz = await newBusiness();
    const admin = await login(null, 'admin');
    const res = await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'paused' }, asCookie(admin.cookie)), ctx(biz.id));
    expect(res.status).toBe(200); // a fresh login counts as recent
    const row = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'business.call_mode_changed' }, orderBy: { at: 'desc' } });
    expect(row).toMatchObject({ actorKind: 'user', actorUserId: admin.user.id });
    expect(row!.meta).toMatchObject({ actor_role: 'admin', actor_via: 'user' });

    // the voicemail playback audit row too
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const call = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: phone(), status: 'handed_off', recordingUrl: REC } });
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-length': '2' } })) as unknown as typeof fetch;
      try {
        expect((await vmRoute.GET(api(`/api/calls/${call.id}/voicemail`, 'GET', undefined, asCookie(admin.cookie)), ctx(call.id))).status).toBe(200);
      } finally { globalThis.fetch = saved; }
      const played = await prisma.auditEvent.findFirst({ where: { businessId: biz.id, action: 'call.voicemail_played' } });
      expect(played).toMatchObject({ actorKind: 'user', actorUserId: admin.user.id });
    });
  });

  // ================================================================== L5
  test('L5 VOICE_LINE_KIND=webhook on a native ElevenLabs line: the safe (native) reading wins, loudly, and admin diagnostics show the mismatch', async () => {
    const { lineKind, lineKindMismatch } = await import('@/lib/voice/line');
    const env = { ELEVENLABS_API_KEY: 'k', ELEVENLABS_PHONE_NUMBER_ID: 'phnum_1', VOICE_LINE_KIND: 'webhook' };
    expect(lineKind(env)).toBe('native');
    expect(lineKindMismatch(env)).toMatch(/can never forward/);
    await withEnv(env, async () => {
      const res = await adminJobs.GET(api('/api/admin/jobs', 'GET', undefined, bearer));
      const diag = ((await res.json()) as { data: { diagnostics: { voice_line: { effective: string; forced: string; mismatch: string | null } } } }).data.diagnostics;
      expect(diag.voice_line).toMatchObject({ effective: 'native', forced: 'webhook' });
      expect(diag.voice_line.mismatch).toMatch(/VOICE_LINE_KIND=webhook/);
      // so an owner on that line cannot choose Forward (the dashboard would have promised it)
      const biz = await newBusiness();
      await prisma.business.update({ where: { id: biz.id }, data: { forwardNumber: '+13055550142', forwardNumberE164: '+13055550142', forwardNumberVerifiedAt: new Date() } });
      expect((await modeRoute.PATCH(api(`/api/businesses/${biz.id}/call-mode`, 'PATCH', { mode: 'forward' }, bearer), ctx(biz.id))).status).toBe(422);
    });
  });

  // ================================================================== voicemail proxy limits
  test('the voicemail proxy is rate limited per person and per business (a seek is a request), without touching Twilio when refused', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const biz = await newBusiness();
      const { cookie } = await login(biz.id, 'staff');
      const call = await prisma.call.create({ data: { businessId: biz.id, callSid: uniq('CA'), callerPhone: phone(), status: 'handed_off', recordingUrl: recUrl() } });
      let upstream = 0;
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => { upstream++; return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-length': '4' } }); }) as unknown as typeof fetch;
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 45; i++) statuses.push((await vmRoute.GET(api(`/api/calls/${call.id}/voicemail`, 'GET', undefined, { ...asCookie(cookie), range: 'bytes=0-1' }), ctx(call.id))).status);
        expect(statuses.filter((s) => s === 429).length).toBe(5); // 40 per person per minute
        expect(upstream).toBe(1); // 40 seeks cost ONE Twilio fetch (the short-lived cache), the refused ones none
        const limited = await vmRoute.GET(api(`/api/calls/${call.id}/voicemail`, 'GET', undefined, asCookie(cookie)), ctx(call.id));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBeTruthy();
      } finally { globalThis.fetch = saved; }
    });
  });

  test('a recording queued for deletion is dropped from the playback cache at once', async () => {
    await withEnv({ TWILIO_ACCOUNT_SID: ACCOUNT }, async () => {
      const { fetchVoicemailAudio } = await import('@/lib/voice/voicemail');
      const url = recUrl();
      let upstream = 0;
      const f = (async () => { upstream++; return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-length': '2' } }); }) as unknown as typeof fetch;
      expect((await fetchVoicemailAudio(url, null, f)).ok).toBe(true);
      expect((await fetchVoicemailAudio(url, 'bytes=1-', f)).ok).toBe(true);
      expect(upstream).toBe(1);
      await prisma.$transaction((tx) => db.enqueueRecordingDeletions(tx, [{ url }]));
      expect((await fetchVoicemailAudio(url, null, f)).ok).toBe(true);
      expect(upstream).toBe(2); // fetched again: nothing was served from memory after the deletion was queued
      await prisma.pendingRecordingDeletion.deleteMany({ where: { recordingSid: url.split('/Recordings/')[1] } });
    });
  });
});
