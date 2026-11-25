/**
 * Residual gaps of reviews 11-15 that need a database and are not covered next to their feature's tests: the usage-warning job (only changed
 * businesses, retry marker, daily full sweep, exactly-once), and the vertical-change call script retry.
 * (Owner budgets / legacy proposals: owner-callin.test.ts; transfers: telephony-phase2.test.ts; refunds + payment links: phase2.test.ts;
 * Google orphans: google-calendar.test.ts; sessions: tests/db/multi-business.test.ts; migration: tests/db/migration.test.ts.)
 */
import { integration, withEnv } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness } from '../helpers/fixtures';

integration('residual gaps (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let job: typeof import('@/lib/jobs/reconcile');
  let agents: typeof import('@/lib/voice/agent-resync');
  const noon = () => { const d = new Date(); d.setUTCHours(17, 0, 0, 0); return d; }; // 12:00-13:00 in New York: never quiet hours
  const night = () => { const d = new Date(); d.setUTCHours(5, 0, 0, 0); return d; }; // 00:00-01:00 in New York: always quiet hours

  beforeAll(async () => {
    db = await loadDb(); prisma = await loadPrisma();
    job = await import('@/lib/jobs/reconcile');
    agents = await import('@/lib/voice/agent-resync');
  });
  afterAll(async () => { await prisma.processedEvent.deleteMany({ where: { source: { in: ['usage-warn-pass', 'usage-warn-retry'] } } }); await cleanup(); });
  beforeEach(async () => { await prisma.processedEvent.deleteMany({ where: { source: { in: ['usage-warn-pass', 'usage-warn-retry'] } } }); });

  async function live(cap: number | null = 100) {
    const b = await newBusiness();
    await prisma.business.update({ where: { id: b.id }, data: { status: 'live', ...(cap !== null ? { smsCapOverride: cap } : {}) } });
    return b;
  }
  /** Usage is written with billing NOT enforced (no inline warning trigger): the job is the only sender in these tests. */
  const use = (id: string, n: number, at: Date = noon()) => db.recordSms(id, n, at);
  const ENFORCED = { BILLING_ENFORCED: 'true', DEMO_MODE: 'true' };
  const alerts = (id: string) => prisma.smsLog.count({ where: { businessId: id, kind: 'owner_alert' } });
  const visited = (r: { items: { business_id?: string; outcome: string }[] }, id: string) => r.items.some((i) => i.business_id === id);

  test('residual L6: the first pass is a full sweep; later passes only visit businesses whose usage changed (or that owe a retry)', async () => {
    const quiet = await live(); const busy = await live();
    await use(quiet.id, 10); await use(busy.id, 10);
    // (the job re-reads counters written in the 2 minutes before its previous pass, so quiet ones are backdated)
    await prisma.$executeRaw`UPDATE usage_counters SET updated_at = now() - interval '10 minutes' WHERE business_id IN (${quiet.id}, ${busy.id})`;
    const first = await job.runUsageWarningsJob({ now: noon() });
    expect(first.counts).toMatchObject({ full_sweep: 1 });
    expect(first.counts!.visited).toBeGreaterThanOrEqual(2);
    // nothing changed since: the dry run (which shows the selection without advancing anything) lists neither
    let dry = await job.runUsageWarningsJob({ now: noon(), dryRun: true });
    expect(dry.counts).toMatchObject({ full_sweep: 0 });
    expect(visited(dry, quiet.id)).toBe(false);
    expect(visited(dry, busy.id)).toBe(false);
    // one business records usage: only it is selected
    await use(busy.id, 5);
    dry = await job.runUsageWarningsJob({ now: noon(), dryRun: true });
    expect(visited(dry, busy.id)).toBe(true);
    expect(visited(dry, quiet.id)).toBe(false);
    // a manual single-business run still works and touches no marker
    const one = await job.runUsageWarningsJob({ now: noon(), businessId: quiet.id });
    expect(one.counts!.visited).toBe(1);
    // the full sweep comes back at least daily
    await prisma.processedEvent.update({ where: { source_id: { source: 'usage-warn-pass', id: 'full' } }, data: { claimedAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await job.runUsageWarningsJob({ now: noon() })).counts).toMatchObject({ full_sweep: 1 });
    expect((await job.runUsageWarningsJob({ now: noon() })).counts).toMatchObject({ full_sweep: 0 });
  });

  test('residual L6: 80% and 100% warnings are still sent exactly once per period, also across passes, and a new month re-arms them', async () => {
    const biz = await live(100);
    await use(biz.id, 70);
    await withEnv(ENFORCED, async () => { await job.runUsageWarningsJob({ now: noon() }); }); // full sweep: 70% -> nothing due
    expect(await alerts(biz.id)).toBe(0);
    await use(biz.id, 10); // 80%
    const sent = async () => withEnv(ENFORCED, async () => job.runUsageWarningsJob({ now: noon() }));
    let r = await sent();
    expect(r.items.filter((i) => i.business_id === biz.id && i.outcome === 'sent').length).toBe(1);
    expect(await alerts(biz.id)).toBe(1);
    await sent(); await sent(); // however often it runs
    expect(await alerts(biz.id)).toBe(1);
    await use(biz.id, 20); // 100%
    r = await sent();
    expect(r.items.filter((i) => i.business_id === biz.id && i.outcome === 'sent').length).toBe(1);
    await sent(); await sent();
    expect(await alerts(biz.id)).toBe(2);
    // next period: a new usage row, new warnings (the job's clock is next month; the counter write is what selects the business)
    const nextMonth = new Date(noon().getTime() + 35 * 86_400_000);
    await use(biz.id, 85, nextMonth);
    r = await withEnv(ENFORCED, async () => job.runUsageWarningsJob({ now: nextMonth }));
    expect(r.items.filter((i) => i.business_id === biz.id && i.outcome === 'sent').length).toBe(1);
    expect(await alerts(biz.id)).toBe(3);
  });

  test('residual L6: a warning deferred by quiet hours stays on a durable retry list and is sent by a later pass although the counter did not change', async () => {
    const biz = await live(10);
    await use(biz.id, 9);
    let r = await withEnv(ENFORCED, async () => job.runUsageWarningsJob({ now: night() }));
    expect(r.items.filter((i) => i.business_id === biz.id).map((i) => i.outcome)).toEqual(['deferred_quiet_hours']);
    expect(await alerts(biz.id)).toBe(0);
    expect(await prisma.processedEvent.count({ where: { source: 'usage-warn-retry', id: biz.id } })).toBe(1);
    // daytime, nothing else changed: the retry list brings the business back
    r = await withEnv(ENFORCED, async () => job.runUsageWarningsJob({ now: noon() }));
    expect(r.items.filter((i) => i.business_id === biz.id && i.outcome === 'sent').length).toBe(1);
    expect(await alerts(biz.id)).toBe(1);
    expect(await prisma.processedEvent.count({ where: { source: 'usage-warn-retry', id: biz.id } })).toBe(0); // done: off the list
  });

  test('residual M2: a vertical change whose knowledge-base rebuild failed is repaired by the agent-dirty retry: the GENERATED call script follows the new trade, an edited one is kept', async () => {
    const { buildCallScript } = await import('@/lib/kb');
    const services = [{ name: 'Panel upgrade', base_price: 500, duration_minutes: 120 }];
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'hvac' } });
    const hvacScript = buildCallScript({ services }, { vertical: 'hvac' });
    await db.upsertKnowledgeBase(biz.id, { services, faqs: [], pricing_notes: '', system_prompt: 'old', call_script: hvacScript });
    // the vertical changed but the rebuild never wrote the row (a database error): the script is still the HVAC one
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'electrical' } });
    expect((await db.getKnowledgeBase(biz.id))!.call_script).toBe(hvacScript);
    await agents.markAgentDirty(biz.id);
    const out = await agents.drainDirtyAgents({ now: new Date(Date.now() + 3_600_000) });
    expect(out.synced).toBeGreaterThanOrEqual(1);
    const kb = (await db.getKnowledgeBase(biz.id))!;
    expect(kb.call_script).toBe(buildCallScript({ services }, { vertical: 'electrical' }));
    expect(kb.call_script).not.toBe(hvacScript);
    expect(kb.system_prompt).not.toBe('old');
    expect(await prisma.processedEvent.count({ where: { source: { startsWith: 'agent-dirty:' }, id: biz.id } })).toBe(0);
    // idempotent: a second repair rewrites nothing
    expect(await agents.rebuildGeneratedCallScript(biz.id)).toBe(false);

    // an owner-edited script (matches no vertical's generated text) is never touched
    const edited = await newBusiness({ agent_id: null });
    await db.upsertKnowledgeBase(edited.id, { services, faqs: [], pricing_notes: '', system_prompt: 'old', call_script: 'My own script: greet by name.' });
    await prisma.business.update({ where: { id: edited.id }, data: { vertical: 'plumbing' } });
    expect(await agents.rebuildGeneratedCallScript(edited.id)).toBe(false);
    expect((await db.getKnowledgeBase(edited.id))!.call_script).toBe('My own script: greet by name.');
    // an empty script counts as generated
    await db.upsertKnowledgeBase(edited.id, { call_script: '' });
    expect(await agents.rebuildGeneratedCallScript(edited.id)).toBe(true);
  });

  test('residual M2: applyVerticalChange that cannot take the per-business lease queues the retry, and the retry rebuilds the script', async () => {
    const { applyVerticalChange } = await import('@/lib/verticals/change');
    const { acquireLease, releaseLease } = await import('@/lib/db');
    const { buildCallScript } = await import('@/lib/kb');
    const services = [{ name: 'Drain clearing', base_price: 150, duration_minutes: 60 }];
    const biz = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'hvac' } });
    const before = (await db.getBusiness(biz.id))!;
    await db.upsertKnowledgeBase(biz.id, { services, faqs: [], pricing_notes: '', system_prompt: 'old', call_script: buildCallScript({ services }, { vertical: 'hvac' }) });
    await prisma.business.update({ where: { id: biz.id }, data: { vertical: 'plumbing' } });
    const after = (await db.getBusiness(biz.id))!;
    const lease = (await acquireLease(`vertical-change:${biz.id}`, 60_000))!;
    try {
      const o = await applyVerticalChange(before, after);
      expect(o).toMatchObject({ prompt_rebuilt: false, retry_queued: true });
    } finally { await releaseLease(lease); }
    expect((await db.getKnowledgeBase(biz.id))!.call_script).toBe(buildCallScript({ services }, { vertical: 'hvac' })); // stale for now
    await agents.drainDirtyAgents({ now: new Date(Date.now() + 3_600_000) });
    expect((await db.getKnowledgeBase(biz.id))!.call_script).toBe(buildCallScript({ services }, { vertical: 'plumbing' }));
  });
});
