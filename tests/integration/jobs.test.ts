/**
 * The job runner: per-business-timezone daily briefing, hourly gratitude sweep, cleanup, admin endpoints.
 * Injectable clock (`now`) and stubbed generation: the tests never wait for 6 PM and never leave the machine.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (iso: string) => new Date(iso);
const ENFORCED = { BILLING_ENFORCED: 'true', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;

integration('job runner (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let jobs: typeof import('@/lib/jobs');
  let listRoute: (req: Request) => Promise<Response>;
  let runRoute: (req: Request) => Promise<Response>;
  const mine: string[] = [];

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    jobs = await import('@/lib/jobs');
    listRoute = (await import('@/app/api/admin/jobs/route')).GET as any;
    runRoute = (await import('@/app/api/admin/jobs/run/route')).POST as any;
  });
  afterAll(async () => {
    await prisma.processedEvent.deleteMany({ where: { OR: [{ source: 'job-state' }, { source: 'it-old' }, { id: { in: mine.flatMap((id) => [id]) } }, ...mine.map((id) => ({ id: { contains: id } }))] } });
    await prisma.auditEvent.deleteMany({ where: { action: { startsWith: 'jobs.' } } });
    await prisma.provisionLock.deleteMany({ where: { key: { startsWith: 'job:' } } });
    await cleanup();
  });
  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin' } } });
  });

  async function live(timezone: string, over: Record<string, unknown> = {}) {
    const b = await newBusiness({ timezone });
    await prisma.business.update({ where: { id: b.id }, data: { status: 'live', billingStatus: 'active', ...over } });
    mine.push(b.id);
    return (await db.getBusiness(b.id))!;
  }

  /** Stubbed generation that records the calls (and writes the briefing row like the real one). */
  function stubs(opts: { delayMs?: number; failTimes?: number } = {}) {
    const generated: Array<{ id: string; date: string }> = [];
    const swept: string[] = [];
    let failures = opts.failTimes ?? 0;
    return {
      generated, swept,
      deps: {
        async generateBriefing(id: string, date: string) {
          if (opts.delayMs) await sleep(opts.delayMs);
          if (failures > 0) { failures--; throw new Error('tts exploded'); }
          generated.push({ id, date });
          return db.createBriefing({ business_id: id, date, transcript: 'x'.repeat(40) });
        },
        async notifyOwner() { return 'skipped_test'; },
        async sweepGratitude(id: string) { if (opts.delayMs) await sleep(opts.delayMs); swept.push(id); return { sent: 0 }; },
        async countGratitudeCandidates() { return 2; },
      },
    };
  }
  const itemsFor = (r: { items: Array<{ business_id?: string; outcome: string }> }, id: string) => r.items.filter((i) => i.business_id === id).map((i) => i.outcome);

  describe('daily briefing', () => {
    test('is generated at 18:00 in EACH business zone, once per local day (DST day included)', async () => {
      const ny = await live('America/New_York');
      const la = await live('America/Los_Angeles');
      const s = stubs();
      // 2027-03-14 is the US spring-forward day. 21:59Z = 17:59 EDT in New York: not yet.
      let r = await jobs.runDailyBriefings({ now: at('2027-03-14T21:59:00Z'), deps: s.deps, env: ENFORCED });
      expect(s.generated.filter((g) => mine.includes(g.id))).toEqual([]);
      expect(r.errors).toBe(0);
      // 22:00Z = 18:00 EDT in New York, 15:00 PDT in Los Angeles.
      r = await jobs.runDailyBriefings({ now: at('2027-03-14T22:00:00Z'), deps: s.deps, env: ENFORCED });
      expect(s.generated.filter((g) => mine.includes(g.id))).toEqual([{ id: ny.id, date: '2027-03-14' }]);
      expect(itemsFor(r, ny.id)).toEqual(['generated']);
      // 01:00Z next day = 18:00 PDT: Los Angeles gets ITS briefing, for ITS local day.
      await jobs.runDailyBriefings({ now: at('2027-03-15T01:00:00Z'), deps: s.deps, env: ENFORCED });
      expect(s.generated.filter((g) => g.id === la.id)).toEqual([{ id: la.id, date: '2027-03-14' }]);
      expect(s.generated.filter((g) => g.id === ny.id).length).toBe(1); // New York is not generated again
      expect(await prisma.briefing.count({ where: { businessId: { in: [ny.id, la.id] } } })).toBe(2);
    });

    test('two runners ticking at the same instant generate ONE briefing (lease + claim)', async () => {
      const b = await live('America/New_York');
      const s = stubs({ delayMs: 150 });
      const now = at('2027-06-01T23:00:00Z'); // 19:00 EDT
      const runs = await Promise.all([
        jobs.runDailyBriefings({ now, deps: s.deps, env: ENFORCED, businessId: b.id }),
        jobs.runDailyBriefings({ now, deps: s.deps, env: ENFORCED, businessId: b.id }),
        jobs.runDailyBriefings({ now, deps: s.deps, env: ENFORCED, businessId: b.id }),
      ]);
      expect(s.generated.filter((g) => g.id === b.id).length).toBe(1);
      const outcomes = runs.flatMap((r) => itemsFor(r, b.id)).sort();
      expect(outcomes.filter((o) => o === 'generated').length).toBe(1);
      expect(outcomes.every((o) => ['generated', 'busy', 'already_claimed', 'already_generated'].includes(o))).toBe(true);
      expect(await prisma.briefing.count({ where: { businessId: b.id } })).toBe(1);
      expect((await prisma.processedEvent.findUnique({ where: { source_id: { source: 'daily-briefing', id: `${b.id}:2027-06-01` } } }))?.status).toBe('done');
      // a later tick, same evening: nothing to do
      const again = await jobs.runDailyBriefings({ now: at('2027-06-01T23:30:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(itemsFor(again, b.id)).toEqual(['already_generated']);
      expect(s.generated.filter((g) => g.id === b.id).length).toBe(1);
      // the next local day gets a fresh one
      await jobs.runDailyBriefings({ now: at('2027-06-02T22:30:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(s.generated.filter((g) => g.id === b.id).map((g) => g.date)).toEqual(['2027-06-01', '2027-06-02']);
    });

    test('a failed generation releases its claim: the next tick retries (and the error is counted, not thrown)', async () => {
      const b = await live('America/Chicago');
      const s = stubs({ failTimes: 1 });
      const first = await jobs.runDailyBriefings({ now: at('2027-06-01T23:05:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(first.errors).toBe(1);
      expect(itemsFor(first, b.id)).toEqual(['error']);
      const second = await jobs.runDailyBriefings({ now: at('2027-06-01T23:06:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(itemsFor(second, b.id)).toEqual(['generated']);
      expect(s.generated.length).toBe(1);
    });

    test('only live businesses whose billing allows service', async () => {
      const ok = await live('America/New_York');
      const canceled = await live('America/New_York', { billingStatus: 'canceled' });
      const none = await live('America/New_York', { billingStatus: 'none' });
      const trial = await live('America/New_York', { billingStatus: 'trialing' });
      const pastDueFresh = await live('America/New_York', { billingStatus: 'past_due', pastDueSince: at('2027-05-30T00:00:00Z') });
      const pastDueStale = await live('America/New_York', { billingStatus: 'past_due', pastDueSince: at('2027-04-01T00:00:00Z') });
      const onboarding = await live('America/New_York');
      await prisma.business.update({ where: { id: onboarding.id }, data: { status: 'onboarding' } });
      const s = stubs();
      const r = await jobs.runDailyBriefings({ now: at('2027-06-01T23:00:00Z'), deps: s.deps, env: ENFORCED });
      const gen = new Set(s.generated.map((g) => g.id));
      for (const b of [ok, trial, pastDueFresh]) expect(gen.has(b.id)).toBe(true);
      for (const b of [canceled, none, pastDueStale, onboarding]) expect(gen.has(b.id)).toBe(false);
      expect(itemsFor(r, canceled.id)).toEqual(['skipped_billing']);
      expect(itemsFor(r, onboarding.id)).toEqual([]); // not live: not even listed
    });

    test('billing not enforced outside production: a plan-less live business still gets its briefing', async () => {
      const b = await live('America/New_York', { billingStatus: 'none' });
      const s = stubs();
      await jobs.runDailyBriefings({ now: at('2027-06-01T23:00:00Z'), deps: s.deps, env: { NODE_ENV: 'test' } as any, businessId: b.id });
      expect(s.generated.length).toBe(1);
      // ...but in production a plan is always required (isProvisioningAllowed)
      const b2 = await live('America/New_York', { billingStatus: 'none' });
      const s2 = stubs();
      const r = await jobs.runDailyBriefings({ now: at('2027-06-01T23:00:00Z'), deps: s2.deps, env: { NODE_ENV: 'production' } as any, businessId: b2.id });
      expect(itemsFor(r, b2.id)).toEqual(['skipped_billing']);
    });

    test('a manual evening briefing does not block the scheduled one; one generated after 18:00 does', async () => {
      const b = await live('America/New_York');
      // generated at 12:00 local by hand
      await prisma.briefing.create({ data: { businessId: b.id, date: '2027-06-01', transcript: 'midday', createdAt: at('2027-06-01T16:00:00Z') } });
      const s = stubs();
      const r1 = await jobs.runDailyBriefings({ now: at('2027-06-01T22:00:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(itemsFor(r1, b.id)).toEqual(['generated']);
      // another day, a briefing already generated after 18:00 local: skip
      await prisma.briefing.create({ data: { businessId: b.id, date: '2027-06-02', transcript: 'evening', createdAt: at('2027-06-02T22:10:00Z') } });
      const r2 = await jobs.runDailyBriefings({ now: at('2027-06-02T23:00:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(itemsFor(r2, b.id)).toEqual(['already_generated']);
    });

    test('bounded work per tick: the rest are deferred, then picked up by the next tick', async () => {
      const total = jobs.MAX_BRIEFINGS_PER_TICK + 3;
      const ids: string[] = [];
      for (let i = 0; i < total; i++) ids.push((await live('Asia/Kolkata')).id);
      const s = stubs();
      const now = at('2027-06-01T13:00:00Z'); // 18:30 IST
      const first = await jobs.runDailyBriefings({ now, deps: s.deps, env: ENFORCED });
      expect(first.processed).toBeLessThanOrEqual(jobs.MAX_BRIEFINGS_PER_TICK);
      expect(first.items.some((i) => i.outcome === 'deferred_to_next_tick')).toBe(true);
      for (let i = 0; i < 6 && s.generated.filter((g) => ids.includes(g.id)).length < total; i++) {
        await jobs.runDailyBriefings({ now, deps: s.deps, env: ENFORCED });
      }
      const mineGenerated = s.generated.filter((g) => ids.includes(g.id));
      expect(mineGenerated.length).toBe(total);
      expect(new Set(mineGenerated.map((g) => g.id)).size).toBe(total); // each exactly once
    });

    test('owner notice: link texted to a VERIFIED owner phone only, never in quiet hours, never past the cap', async () => {
      await withEnv({ DEMO_MODE: 'true', PUBLIC_BASE_URL: 'https://app.example.test' }, async () => {
        const b = await live('America/New_York');
        const note = (when: string, biz = b, over: Record<string, string> = {}) => withEnv(over, async () => {
          const briefing = await db.createBriefing({ business_id: biz.id, date: '2027-06-01', transcript: 'x' });
          return jobs.notifyOwnerOfBriefing((await db.getBusiness(biz.id))!, briefing, at(when));
        });
        expect(await note('2027-06-01T23:00:00Z')).toBe('sent'); // 19:00 local
        const sms = await prisma.smsLog.findFirst({ where: { businessId: b.id, kind: 'owner_alert' }, orderBy: { createdAt: 'desc' } });
        expect(sms?.body).toContain('https://app.example.test/dashboard/briefings');
        expect(await note('2027-06-02T02:30:00Z')).toBe('skipped_quiet_hours'); // 22:30 local
        // cap reached (plan cap 0) -> not sent
        expect(await note('2027-06-01T23:00:00Z', b, { BILLING_ENFORCED: 'true', PLAN_SMS_CAP: '0' })).toBe('skipped_cap');
        // unverified / missing owner phone
        const unverified = await live('America/New_York');
        await prisma.business.update({ where: { id: unverified.id }, data: { ownerPhoneVerifiedAt: null } });
        expect(await note('2027-06-01T23:00:00Z', unverified)).toBe('skipped_owner_unverified');
        const noPhone = await live('America/New_York');
        await prisma.business.update({ where: { id: noPhone.id }, data: { ownerPhone: null, ownerPhoneE164: null } });
        expect(await note('2027-06-01T23:00:00Z', noPhone)).toBe('skipped_no_owner_phone');
      });
    });

    test('end to end with the real generator (mock LLM/TTS): row saved with the local date, owner notified', async () => {
      await withEnv({ DEMO_MODE: 'true', PUBLIC_BASE_URL: 'https://app.example.test' }, async () => {
        const b = await live('America/Denver');
        const r = await jobs.runDailyBriefings({ now: at('2027-06-02T00:30:00Z'), env: ENFORCED, businessId: b.id }); // 18:30 MDT on 06-01
        expect(itemsFor(r, b.id)).toEqual(['generated']);
        expect(r.items[0].detail).toMatchObject({ date: '2027-06-01', owner_notice: 'sent' });
        const row = await prisma.briefing.findUnique({ where: { businessId_date: { businessId: b.id, date: '2027-06-01' } } });
        expect(row?.transcript.length).toBeGreaterThan(20);
      });
    });
  });

  describe('gratitude sweep', () => {
    test('hourly per business; two runners in the same hour sweep once; the next hour sweeps again', async () => {
      const b = await live('America/New_York');
      const s = stubs({ delayMs: 100 });
      const now = at('2027-06-01T16:10:00Z'); // 12:10 local
      await Promise.all([
        jobs.runGratitudeJob({ now, deps: s.deps, env: ENFORCED, businessId: b.id }),
        jobs.runGratitudeJob({ now, deps: s.deps, env: ENFORCED, businessId: b.id }),
      ]);
      expect(s.swept.filter((id) => id === b.id).length).toBe(1);
      await jobs.runGratitudeJob({ now: at('2027-06-01T16:50:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(s.swept.filter((id) => id === b.id).length).toBe(1); // same hour: already swept
      await jobs.runGratitudeJob({ now: at('2027-06-01T17:05:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id });
      expect(s.swept.filter((id) => id === b.id).length).toBe(2);
    });

    test('quiet hours (9pm-8am local) and billing gate: nothing is swept', async () => {
      const night = await live('America/New_York');
      const lapsed = await live('America/New_York', { billingStatus: 'canceled' });
      const s = stubs();
      const r = await jobs.runGratitudeJob({ now: at('2027-06-02T02:30:00Z'), deps: s.deps, env: ENFORCED }); // 22:30 EDT
      expect(s.swept.includes(night.id)).toBe(false);
      expect(itemsFor(r, night.id)).toEqual(['skipped_quiet_hours']);
      expect(itemsFor(r, lapsed.id)).toEqual(['skipped_billing']);
      // same instant is morning in Auckland: that business IS swept
      const nz = await live('Pacific/Auckland');
      await jobs.runGratitudeJob({ now: at('2027-06-02T02:30:00Z'), deps: s.deps, env: ENFORCED, businessId: nz.id }); // 14:30 NZST
      expect(s.swept.includes(nz.id)).toBe(true);
    });

    test('a failing sweep is counted, releases its claim and is retried by the next tick', async () => {
      const b = await live('America/New_York');
      let boom = true;
      const s = stubs();
      const deps = { ...s.deps, async sweepGratitude(id: string) { if (boom) { boom = false; throw new Error('db hiccup'); } s.swept.push(id); return {}; } };
      const now = at('2027-06-01T16:10:00Z');
      const first = await jobs.runGratitudeJob({ now, deps, env: ENFORCED, businessId: b.id });
      expect(first.errors).toBe(1);
      await jobs.runGratitudeJob({ now: at('2027-06-01T16:11:00Z'), deps, env: ENFORCED, businessId: b.id });
      expect(s.swept).toEqual([b.id]);
    });

    test('bounded work per tick', async () => {
      const total = jobs.MAX_GRATITUDE_PER_TICK + 2;
      const ids: string[] = [];
      for (let i = 0; i < total; i++) ids.push((await live('Asia/Tokyo')).id);
      const s = stubs();
      const now = at('2027-06-01T03:00:00Z'); // 12:00 JST
      const first = await jobs.runGratitudeJob({ now, deps: s.deps, env: ENFORCED });
      expect(first.processed).toBeLessThanOrEqual(jobs.MAX_GRATITUDE_PER_TICK);
      for (let i = 0; i < 6 && s.swept.filter((id) => ids.includes(id)).length < total; i++) await jobs.runGratitudeJob({ now, deps: s.deps, env: ENFORCED });
      expect(s.swept.filter((id) => ids.includes(id)).length).toBe(total);
    });

    test('dry run reports candidates and sweeps nothing', async () => {
      const b = await live('America/New_York');
      const s = stubs();
      const r = await jobs.runGratitudeJob({ now: at('2027-06-01T16:10:00Z'), deps: s.deps, env: ENFORCED, businessId: b.id, dryRun: true });
      expect(r.items).toEqual([{ business_id: b.id, outcome: 'would_sweep', detail: { candidates: 2 } }]);
      expect(s.swept).toEqual([]);
    });

    test('the real sweep keeps its consent rule: a completed job without recorded consent is NOT texted', async () => {
      const b = await live('America/New_York');
      const old = new Date(Date.now() - 24 * 3600_000);
      await prisma.booking.create({ data: {
        businessId: b.id, customerName: 'Ana', customerPhone: '+13055550111', service: 'AC repair', scheduledAt: old, status: 'completed',
      } as any });
      // the job's default sweep IS runGratitudeSweep: consent / quiet-hours / cap rules are untouched
      const r = await jobs.defaultDeps.sweepGratitude(b.id);
      expect(r).toMatchObject({ sent: 0, skipped_no_consent: 1 });
      expect(await prisma.smsLog.count({ where: { businessId: b.id, kind: 'gratitude' } })).toBe(0);
    });
  });

  describe('cleanup + tick', () => {
    test('dry run counts, a real run deletes expired rows only, the tick does not rerun it within the hour', async () => {
      const users = await import('@/lib/db/users');
      const biz = await live('America/New_York');
      const user = await users.createUser({ email: `${uniq('cj')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true });
      const { token } = await users.createSession(user.id);
      await prisma.userSession.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 3600_000) } });
      const fresh = await users.createSession(user.id);
      const oldEvent = uniq('old');
      await prisma.processedEvent.create({ data: { source: 'it-old', id: oldEvent, status: 'done', createdAt: new Date(Date.now() - 40 * 86_400_000) } });
      const bucketKey = uniq('it-bucket');
      await prisma.rateLimitBucket.create({ data: { key: bucketKey, windowStart: new Date(Date.now() - 5 * 3600_000), count: 3 } });
      void token;
      // expired passkey challenges are removed by THIS job (not by a random side effect of issuing a challenge); live and recently expired ones stay
      const chal = (ageMs: number, ttlMs: number) => prisma.webauthnChallenge.create({
        data: { purpose: 'login', challengeHash: uniq('ch'), expiresAt: new Date(Date.now() - ageMs + ttlMs), createdAt: new Date(Date.now() - ageMs) },
      });
      const oldChallenge = await chal(3 * 86_400_000, 60_000); // expired ~3 days ago
      const recentChallenge = await chal(2 * 3600_000, 60_000); // expired 2 h ago: inside the one-day grace
      const liveChallenge = await chal(1000, 5 * 60_000);

      const dry = await jobs.runCleanup({ dryRun: true });
      expect(dry.counts!.webauthn_challenges).toBeGreaterThanOrEqual(1);
      expect(await prisma.webauthnChallenge.count({ where: { id: oldChallenge.id } })).toBe(1);
      expect(dry.counts!.sessions).toBeGreaterThanOrEqual(1);
      expect(dry.counts!.processed_events).toBeGreaterThanOrEqual(1);
      expect(dry.counts!.rate_limit_buckets).toBeGreaterThanOrEqual(1);
      expect(await prisma.processedEvent.count({ where: { source: 'it-old', id: oldEvent } })).toBe(1); // dry run deleted nothing

      const real = await jobs.runCleanup({});
      expect(real.errors).toBe(0);
      expect(real.counts!.sessions).toBeGreaterThanOrEqual(1);
      expect(await prisma.processedEvent.count({ where: { source: 'it-old', id: oldEvent } })).toBe(0);
      expect(await prisma.rateLimitBucket.count({ where: { key: bucketKey } })).toBe(0);
      expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(1); // the live session survives
      expect(real.counts!.webauthn_challenges).toBeGreaterThanOrEqual(1);
      expect(await prisma.webauthnChallenge.count({ where: { id: oldChallenge.id } })).toBe(0);
      expect(await prisma.webauthnChallenge.count({ where: { id: { in: [recentChallenge.id, liveChallenge.id] } } })).toBe(2);
      await prisma.webauthnChallenge.deleteMany({ where: { id: { in: [recentChallenge.id, liveChallenge.id] } } });
      void fresh;

      const tick = await jobs.runJobTick({ jobs: ['cleanup'] });
      expect(tick).toEqual([]); // ran moments ago: not due again
      const later = await jobs.runJobTick({ jobs: ['cleanup'], now: new Date(Date.now() + 61 * 60_000) });
      expect(later.map((r) => r.job)).toEqual(['cleanup']);
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    test('retention is part of the same runner and respects its own switch', async () => {
      const r = await jobs.runJob('retention', { dryRun: true });
      expect(r.job).toBe('retention');
      expect(r.errors).toBe(0);
      expect(typeof r.counts!.calls).toBe('number');
      expect(typeof r.counts!.sms_logs).toBe('number');
      // the tick never purges while RETENTION_JOB is not on
      const tick = await jobs.runJobTick({ env: { NODE_ENV: 'production', JOBS: 'on' } as any, jobs: jobs.enabledJobs({ NODE_ENV: 'production' } as any).filter((j) => j !== 'daily_briefing' && j !== 'gratitude_sweep' && j !== 'cleanup' && j !== 'recording_deletions' && j !== 'reconcile' && j !== 'usage_warnings' && j !== 'google_calendar') });
      expect(tick).toEqual([]);
    });
  });

  describe('admin endpoints', () => {
    const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test' };
    const admin = { ...headers, authorization: `Bearer ${SECRETS.adminToken}` };
    const get = (h: Record<string, string>) => listRoute(new Request('https://app.example.test/api/admin/jobs', { headers: h }));
    const post = (body: unknown, h: Record<string, string> = admin) => runRoute(new Request('https://app.example.test/api/admin/jobs/run', { method: 'POST', headers: h, body: JSON.stringify(body) }));

    test('GET /api/admin/jobs: admin only; last run and next due per job', async () => {
      expect((await get(headers)).status).toBe(401);
      const b = await live('America/New_York');
      await jobs.runCleanup({});
      const res = await get(admin);
      expect(res.status).toBe(200);
      const data = ((await res.json()) as any).data;
      expect(data.runner).toMatchObject({ tick_seconds: 60, jobs_setting: 'off' }); // test env: JOBS unset => off outside production
      expect(data.jobs.map((j: any) => j.name)).toEqual(['daily_briefing', 'gratitude_sweep', 'cleanup', 'retention', 'recording_deletions', 'reconcile', 'usage_warnings', 'google_calendar']);
      const cleanupJob = data.jobs.find((j: any) => j.name === 'cleanup');
      expect(cleanupJob.last_run_at).toBeTruthy();
      expect(new Date(cleanupJob.next_due_at).getTime()).toBeGreaterThan(Date.now());
      const brief = data.jobs.find((j: any) => j.name === 'daily_briefing');
      expect(brief.next_due_at).toBeTruthy();
      expect(brief.note).toContain('eligible');
      const retention = data.jobs.find((j: any) => j.name === 'retention');
      expect(retention).toMatchObject({ enabled: false, next_due_at: null });
      void b;
    });

    test('POST /api/admin/jobs/run: validation, dry run is the default and changes nothing', async () => {
      expect((await post({ job: 'cleanup' }, headers)).status).toBe(401);
      expect((await post({ job: 'nope' })).status).toBe(422);
      expect((await post({ job: 'cleanup', dry_run: 'yes' })).status).toBe(422);
      expect((await post({ job: 'cleanup', business_id: 'x' })).status).toBe(422);
      expect((await post({ job: 'daily_briefing', business_id: 'does-not-exist' })).status).toBe(404);

      const b = await live('America/New_York');
      const dry = await post({ job: 'daily_briefing', business_id: b.id });
      expect(dry.status).toBe(200);
      const body = ((await dry.json()) as any).data;
      expect(body).toMatchObject({ job: 'daily_briefing', dry_run: true, processed: 0 });
      expect(body.items.length).toBe(1);
      expect(body.items[0]).toMatchObject({ business_id: b.id, outcome: 'would_generate' });
      expect(await prisma.briefing.count({ where: { businessId: b.id } })).toBe(0);

      const dryCleanup = ((await (await post({ job: 'cleanup' })).json()) as any).data;
      expect(dryCleanup).toMatchObject({ dry_run: true });
      expect(dryCleanup.counts).toHaveProperty('sessions');
    });

    test('POST dry_run:false really runs it (manual run bypasses only the 18:00 gate) and is audited', async () => {
      const b = await live('America/New_York');
      const res = await post({ job: 'daily_briefing', business_id: b.id, dry_run: false });
      expect(res.status).toBe(200);
      const data = ((await res.json()) as any).data;
      expect(data).toMatchObject({ dry_run: false, processed: 1, errors: 0 });
      expect(await prisma.briefing.count({ where: { businessId: b.id } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { action: 'jobs.manual_run', businessId: b.id } })).toBe(1);
      // billing still applies to a manual run
      const lapsed = await live('America/New_York', { billingStatus: 'canceled' });
      await withEnv({ BILLING_ENFORCED: 'true' }, async () => {
        const r2 = ((await (await post({ job: 'daily_briefing', business_id: lapsed.id, dry_run: false })).json()) as any).data;
        expect(r2.items).toEqual([{ business_id: lapsed.id, outcome: 'skipped_billing' }]);
      });
    });
  });

  describe('F8: the scheduler does not scan every tenant\'s history on every tick', () => {
    test('a tick reads NARROW business columns and a fixed number of statements, however many tenants have finished their day', async () => {
      const { recordQueries } = await import('@/lib/db/client');
      const s = stubs();
      const now = at('2027-08-02T23:30:00Z'); // 19:30 EDT: every New York tenant is past 18:00
      const first = await Promise.all([live('America/New_York'), live('America/New_York')]);
      // everybody gets their briefing (10 per tick; other tests leave live tenants behind), then the next ticks have nothing to do
      const drain = async (t: Date) => { for (let i = 0; i < 40; i++) if ((await jobs.runDailyBriefings({ now: t, deps: s.deps, env: ENFORCED })).processed === 0) return; };
      await drain(now);
      expect(first.every((b) => s.generated.some((g) => g.id === b.id))).toBe(true);
      const small = await recordQueries(() => jobs.runDailyBriefings({ now: at('2027-08-02T23:31:00Z'), deps: s.deps, env: ENFORCED }));
      await Promise.all([live('America/New_York'), live('America/New_York'), live('America/New_York')]);
      await drain(at('2027-08-02T23:32:00Z'));
      const big = await recordQueries(() => jobs.runDailyBriefings({ now: at('2027-08-02T23:33:00Z'), deps: s.deps, env: ENFORCED }));
      expect(small.queries.length).toBeGreaterThan(0);
      expect(big.queries.length).toBe(small.queries.length); // constant: no per-tenant point queries after 18:00
      expect(big.queries.length).toBeLessThanOrEqual(5);
      const tenantReads = big.queries.filter((q) => /FROM "public"\."businesses"/.test(q));
      expect(tenantReads.length).toBe(1);
      expect(tenantReads[0]).not.toContain('"hours"'); // never the whole row
      expect(tenantReads[0]).not.toContain('"name"');
      expect(tenantReads[0]).toContain('"status"');
    });

    test('the gratitude tick loads only the booking window, never the sms/booking history', async () => {
      const { recordQueries } = await import('@/lib/db/client');
      const b = await live('America/Chicago');
      // a long history: 40 old completed bookings and 40 gratitude texts, none inside the 20-48 h window
      for (let i = 0; i < 40; i++) {
        await prisma.booking.create({ data: { businessId: b.id, customerName: 'Old', customerPhone: `+1305555${String(1000 + i)}`, phoneE164: `+1305555${String(1000 + i)}`, service: 'x', scheduledAt: new Date(Date.now() - (10 + i) * 86400_000), durationMinutes: 60, status: 'completed' } });
      }
      const { queries } = await recordQueries(() => jobs.runGratitudeJob({ now: at('2027-08-03T17:00:00Z'), env: ENFORCED, businessId: b.id, force: true, deps: { sweepGratitude: async (id: string) => ({ ...(await (await import('@/lib/gratitude')).runGratitudeSweep(id)) }) } }));
      const bookingReads = queries.filter((q) => /FROM "public"\."bookings"/.test(q));
      expect(bookingReads.length).toBe(1);
      expect(bookingReads[0]).toContain('"scheduled_at" >=');
      expect(bookingReads[0]).toContain('"scheduled_at" <');
      expect(queries.some((q) => /FROM "public"\."sms_log"/.test(q))).toBe(false); // no candidates: the sms history is not touched at all
    });
  });

  describe('lease loss: a job that lost its lease stops before the next side effect', () => {
    const steal = (id: string, kind: 'briefing' | 'gratitude') => prisma.provisionLock.updateMany({ where: { key: `job:${kind}:${id}` }, data: { holder: 'thief' } });

    test('briefing: the lease is stolen during generation -> the owner is NOT texted by the stale holder', async () => {
      const b = await live('America/New_York');
      let notified = 0;
      const generated: string[] = [];
      const deps = {
        async generateBriefing(id: string, date: string) { generated.push(id); await steal(id, 'briefing'); await sleep(450); return db.createBriefing({ business_id: id, date, transcript: 'x'.repeat(40) }); },
        async notifyOwner() { notified++; return 'sent'; },
      };
      const r = await jobs.runDailyBriefings({ now: at('2027-09-01T23:00:00Z'), businessId: b.id, deps, env: ENFORCED, leaseRenewMs: 100 });
      expect(generated).toEqual([b.id]);
      expect(notified).toBe(0);
      expect(r.items[0]).toMatchObject({ business_id: b.id, outcome: 'generated', detail: { owner_notice: 'skipped_lease_lost' } });
      await prisma.provisionLock.deleteMany({ where: { key: `job:briefing:${b.id}` } });
    });

    test('gratitude: lease lost mid-sweep -> reported as lease_lost and the hour is given back for the next tick', async () => {
      const b = await live('America/New_York');
      const now = at('2027-09-01T17:00:00Z');
      const deps = {
        async sweepGratitude(id: string, signal?: AbortSignal) { await steal(id, 'gratitude'); await sleep(450); return { sent: 0, aborted: signal?.aborted ?? false }; },
      };
      const r = await jobs.runGratitudeJob({ now, businessId: b.id, deps, env: ENFORCED, leaseRenewMs: 100 });
      expect(itemsFor(r, b.id)).toEqual(['lease_lost']);
      expect(r.errors).toBe(1);
      expect(await prisma.processedEvent.count({ where: { source: 'gratitude-sweep', id: `${jobs.hourBucket(now)}:${b.id}` } })).toBe(0); // claim released
      await prisma.provisionLock.deleteMany({ where: { key: `job:gratitude:${b.id}` } });
    });

    test('runGratitudeSweep with an aborted signal sends nothing', async () => {
      const { runGratitudeSweep } = await import('@/lib/gratitude');
      const b = await live('America/New_York');
      await prisma.booking.create({ data: { businessId: b.id, customerName: 'C', customerPhone: '+13055550177', phoneE164: '+13055550177', service: 'x', scheduledAt: new Date(Date.now() - 26 * 3600_000), durationMinutes: 60, status: 'completed', followupConsentAt: new Date() } });
      const ctl = new AbortController();
      ctl.abort();
      const res = await runGratitudeSweep(b.id, { signal: ctl.signal });
      expect(res.aborted).toBe(true);
      expect(res.sent).toBe(0);
      expect(await prisma.smsLog.count({ where: { businessId: b.id, kind: 'gratitude' } })).toBe(0);
    });
  });
});
