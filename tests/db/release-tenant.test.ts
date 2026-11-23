/**
 * Release of canceled tenants' provider resources (src/lib/billing/release.ts, POST /api/admin/release-tenant) against a
 * DISPOSABLE Postgres (skipped unless TEST_DATABASE_URL is set). Providers are faked (injected deps); mail is captured.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ADMIN_TOKEN, PASSWORD, TEST_URL, captureMail, clearLimiter, cookieFrom, loadAuthModules, req, rid } from '../helpers/auth-harness';

const suite = TEST_URL ? describe : describe.skip;

suite('release canceled tenants (postgres)', () => {
  let db: any, pw: any, rel: any, route: any, login: any, mail: ReturnType<typeof captureMail>;
  const run = rid();
  const bizIds: string[] = [];
  const userEmails: string[] = [];
  const DAY = 86_400_000;
  const NOW = new Date();
  const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
  let n = 0;
  const phone = () => `+1786${String(4_120_000 + (++n) * 7 + Math.floor(Math.random() * 5))}`.slice(0, 12);

  const calls: string[] = [];
  const okDeps = (extra: { number?: any; agent?: any } = {}) => ({
    releaseNumber: async (p: string) => { calls.push(`number:${p}`); return extra.number ?? { ok: true, sid: 'PN1' }; },
    deleteAgent: async (a: string) => { calls.push(`agent:${a}`); return extra.agent ?? { ok: true }; },
    deleteAgentTools: async () => { calls.push('tools'); return { ok: true, deleted: 7, already_deleted: 0 }; },
  });

  beforeAll(async () => {
    ({ db, pw } = await loadAuthModules());
    rel = await import('../../src/lib/billing/release');
    route = await import('../../src/app/api/admin/release-tenant/route');
    login = await import('../../src/app/api/auth/login/route');
    mail = captureMail();
  });
  afterEach(() => { calls.length = 0; mail.mails.length = 0; });
  afterAll(async () => {
    mail.restore();
    await db.prisma.auditEvent.deleteMany({ where: { businessId: { in: bizIds } } });
    await db.prisma.user.deleteMany({ where: { email: { in: userEmails } } });
    await db.prisma.business.deleteMany({ where: { id: { in: bizIds } } });
    await clearLimiter(db, ['admin/release-tenant', 'auth/login']);
    await db.prisma.$disconnect();
  });

  async function mk(name: string, o: { status?: string; plan?: string | null; periodEnd?: Date | null; agent?: string | null; phone?: string | null; owner?: boolean } = {}) {
    const p = o.phone === undefined ? phone() : o.phone;
    const biz = await db.prisma.business.create({
      data: {
        id: `biz_rel_${name}_${run}`, name: `Rel ${name}`, status: 'live', phone: p, phoneE164: p, phoneKey: p ? p.slice(-10) : null,
        agentId: o.agent === undefined ? `agent_${name}_${run}` : o.agent, billingStatus: o.status ?? 'canceled', plan: o.plan === undefined ? 'standard' : o.plan,
        currentPeriodEnd: o.periodEnd === undefined ? ago(60) : o.periodEnd,
      },
    });
    bizIds.push(biz.id);
    if (o.owner !== false) {
      const e = `own-${name}-${run}@example.test`;
      userEmails.push(e);
      await db.createUser({ email: e, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true });
    }
    return biz;
  }
  const fresh = (id: string) => db.prisma.business.findUnique({ where: { id } });
  const audits = (id: string, action?: string) => db.prisma.auditEvent.findMany({ where: { businessId: id, ...(action ? { action } : {}) }, orderBy: { at: 'asc' } });

  test('DRY RUN (no apply): reports the decision, writes nothing, calls nothing, sends nothing', async () => {
    const b = await mk('dry');
    const r = await rel.processBusiness(b.id, { now: NOW, apply: false }, okDeps());
    expect(r.decision.action).toBe('notify');
    expect(r.applied).toBe(false);
    expect(calls).toHaveLength(0);
    expect(mail.mails).toHaveLength(0);
    expect(await audits(b.id)).toHaveLength(0);
    const after = await fresh(b.id);
    expect(after.phone).toBe(b.phone);
    expect(after.agentId).toBe(b.agentId);
  });

  test('full flow: heads-up mail once (notified_at in audit meta), wait out the lead time, then release; clears fields; idempotent', async () => {
    const b = await mk('flow');
    const email = `own-flow-${run}@example.test`;
    const first = await rel.processBusiness(b.id, { now: NOW, apply: true, script: 't' }, okDeps());
    expect(first.decision.action).toBe('notify');
    expect(first.notified).toBe(1);
    expect(mail.to(email)).toHaveLength(1);
    expect(mail.to(email)[0].subject).toMatch(/released/);
    const notice = await audits(b.id, 'billing.release_notice');
    expect(notice).toHaveLength(1);
    expect(new Date(notice[0].meta.notified_at).getTime()).toBe(NOW.getTime());
    expect(calls).toHaveLength(0); // NOT released in the same run

    // same day again: waits, no second mail
    const again = await rel.processBusiness(b.id, { now: new Date(NOW.getTime() + DAY), apply: true }, okDeps());
    expect(again.decision.action).toBe('wait');
    expect(mail.to(email)).toHaveLength(1);
    expect(await audits(b.id, 'billing.release_notice')).toHaveLength(1);

    // after the lead time (7 days): released
    const later = new Date(NOW.getTime() + 8 * DAY);
    const done = await rel.processBusiness(b.id, { now: later, apply: true, script: 't' }, okDeps());
    expect(done.decision).toEqual({ action: 'release', notice: 'sent' });
    expect(calls.slice(0, 2)).toEqual([`agent:${b.agentId}`, `number:${b.phone}`]); // agent first, then the number (tools only when no other tenant has an agent)
    const after = await fresh(b.id);
    expect(after.phone).toBeNull();
    expect(after.phoneE164).toBeNull();
    expect(after.phoneKey).toBeNull();
    expect(after.agentId).toBeNull();
    expect(after.status).toBe('paused');
    const rows = await audits(b.id, 'billing.tenant_released');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.cleared).toEqual({ phone: true, agent: true });
    expect(rows[0].meta.phone_last4).toBe(b.phone.slice(-4));
    expect(JSON.stringify(rows[0].meta)).not.toContain(b.phone); // only the last 4 digits are audited

    // idempotent: nothing left to release, no more provider calls
    calls.length = 0;
    const third = await rel.processBusiness(b.id, { now: later, apply: true }, okDeps());
    expect(third.decision.action).toBe('skip');
    expect(calls).toHaveLength(0);
  });

  test('a provider failure keeps the reference in the database (retry next run); success afterwards clears it', async () => {
    const b = await mk('retry');
    await db.prisma.auditEvent.create({ data: { actorKind: 'system', businessId: b.id, action: 'billing.release_notice', target: 'x', meta: { notified_at: ago(10).toISOString() } } });
    const bad = await rel.processBusiness(b.id, { now: NOW, apply: true }, okDeps({ number: { ok: false, error: 'delete 500' } }));
    expect(bad.outcome.errors).toEqual(['number: delete 500']);
    let row = await fresh(b.id);
    expect(row.phone).toBe(b.phone); // kept for the retry
    expect(row.agentId).toBeNull(); // the agent part succeeded
    const good = await rel.processBusiness(b.id, { now: NOW, apply: true }, okDeps());
    expect(good.outcome.errors).toEqual([]);
    row = await fresh(b.id);
    expect(row.phone).toBeNull();
  });

  test('never released: active/trialing/past_due within grace, comped plans, recent calls (unless included), inside the grace period', async () => {
    for (const s of ['active', 'trialing', 'past_due', 'none']) {
      const b = await mk(`st${s}`, { status: s });
      expect((await rel.processBusiness(b.id, { now: NOW, apply: true }, okDeps())).decision.action).toBe('skip');
    }
    const comped = await mk('comped', { plan: 'legacy' });
    expect((await rel.processBusiness(comped.id, { now: NOW, apply: true }, okDeps())).decision.action).toBe('skip');
    const young = await mk('young', { periodEnd: ago(5) });
    expect((await rel.processBusiness(young.id, { now: NOW, apply: true }, okDeps())).decision.action).toBe('wait');
    const busy = await mk('busy');
    await db.prisma.call.create({ data: { businessId: busy.id, startedAt: ago(2) } });
    expect((await rel.processBusiness(busy.id, { now: NOW, apply: false }, okDeps())).decision.action).toBe('skip');
    expect((await rel.processBusiness(busy.id, { now: NOW, apply: false, includeRecent: true }, okDeps())).decision.action).toBe('notify');
    expect(calls).toHaveLength(0);
  });

  test('a number shared with another business (same E.164) is never released at the provider; only this business\'s reference is dropped', async () => {
    const a = await mk('sharedA');
    const other = await mk('sharedB', { status: 'active' });
    // same E.164 under a different `phone` string, same agent id
    await db.prisma.business.update({ where: { id: other.id }, data: { phone: `(${a.phone.slice(2, 5)}) ${a.phone.slice(5, 8)}-${a.phone.slice(8)}`, phoneE164: a.phone } });
    await db.prisma.auditEvent.create({ data: { actorKind: 'system', businessId: a.id, action: 'billing.release_notice', target: 'x', meta: { notified_at: ago(10).toISOString() } } });
    const r = await rel.processBusiness(a.id, { now: NOW, apply: true }, okDeps());
    expect(r.decision.action).toBe('release');
    expect(calls).toEqual([`agent:${a.agentId}`]); // the Twilio number is NOT released (the agent id is unique per business in the schema)
    expect(r.outcome.number.result).toEqual({ skipped: expect.stringContaining('another business') });
    const keep = await fresh(other.id);
    expect(keep.phoneE164).toBe(a.phone);
    expect(keep.agentId).toBe(other.agentId);
    expect((await fresh(a.id)).phone).toBeNull();
  });

  test('the shared workspace tools are only deleted when no other business has an agent', async () => {
    const a = await mk('toolsA');
    await mk('toolsB', { status: 'active' }); // keeps its own agent
    await db.prisma.auditEvent.create({ data: { actorKind: 'system', businessId: a.id, action: 'billing.release_notice', target: 'x', meta: { notified_at: ago(10).toISOString() } } });
    const r = await rel.processBusiness(a.id, { now: NOW, apply: true }, okDeps());
    expect(r.outcome.tools).toEqual({ skipped: expect.stringContaining('shared workspace tools') });
    expect(calls).not.toContain('tools');
    // ...and they ARE deleted when this was the last business with an agent
    const last = await mk('toolsLast');
    const facts = { ...(await rel.loadReleaseFacts(last.id, NOW)), other_agents_exist: false };
    const out = await rel.executeRelease(facts, { notice: 'sent' }, okDeps());
    expect(calls).toContain('tools');
    expect(out.tools).toEqual({ ok: true, deleted: 7, already_deleted: 0 });
  });

  test('a notice from an earlier cancellation does not count: re-cancelled tenants are notified again', async () => {
    const b = await mk('recancel', { periodEnd: ago(40) });
    await db.prisma.auditEvent.create({ data: { actorKind: 'system', businessId: b.id, action: 'billing.release_notice', target: 'x', meta: { notified_at: ago(200).toISOString() } } });
    const f = await rel.loadReleaseFacts(b.id, NOW);
    expect(f.notified_at).toBeNull();
    expect((await rel.processBusiness(b.id, { now: NOW, apply: false }, okDeps())).decision.action).toBe('notify');
  });

  test('no owner e-mail: the notice cannot be sent -> skipped; a failed mail is not recorded (retried next run)', async () => {
    const b = await mk('noowner', { owner: false });
    expect((await rel.processBusiness(b.id, { now: NOW, apply: true }, okDeps())).decision.action).toBe('skip');
  });

  describe('POST /api/admin/release-tenant', () => {
    const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const call = (json: unknown, headers: Record<string, string> = admin) => route.POST(req('/api/admin/release-tenant', { method: 'POST', json, headers }));

    test('admin only', async () => {
      const b = await mk('api0');
      expect((await call({ business_id: b.id }, {})).status).toBe(401);
      const e = `own-api0-${run}@example.test`;
      await db.prisma.user.update({ where: { email: e }, data: { passwordHash: await pw.hashPassword(PASSWORD) } });
      await clearLimiter(db, ['auth/login']);
      const owner = cookieFrom(await login.POST(req('/api/auth/login', { method: 'POST', json: { email: e, password: PASSWORD } }))) as string;
      expect([401, 403]).toContain((await call({ business_id: b.id }, { cookie: owner })).status);
    });

    test('dry_run defaults to TRUE: reports, changes nothing; validates input; 404 for unknown', async () => {
      const b = await mk('api1');
      const r = await call({ business_id: b.id });
      expect(r.status).toBe(200);
      const body = (await r.json()).data;
      expect(body.dry_run).toBe(true);
      expect(body.decision.action).toBe('notify');
      expect(body.applied).toBe(false);
      expect(mail.mails).toHaveLength(0);
      expect((await fresh(b.id)).phone).toBe(b.phone);
      expect((await call({ business_id: b.id, dry_run: 'no' })).status).toBe(422);
      expect((await call({ business_id: b.id, grace_days: -1 })).status).toBe(422);
      expect((await call({})).status).toBe(422);
      expect((await call({ business_id: 'nope' })).status).toBe(404);
    });

    test('dry_run:false performs ONE step: the heads-up first, then (skip_notice / after the lead time) the release (mock providers)', async () => {
      const b = await mk('api2');
      const step1 = (await (await call({ business_id: b.id, dry_run: false })).json()).data;
      expect(step1.decision.action).toBe('notify');
      expect(step1.notified).toBe(1);
      expect((await fresh(b.id)).phone).toBe(b.phone);
      const step2 = (await (await call({ business_id: b.id, dry_run: false })).json()).data;
      expect(step2.decision.action).toBe('wait');
      const forced = (await (await call({ business_id: b.id, dry_run: false, skip_notice: true })).json()).data;
      expect(forced.decision).toEqual({ action: 'release', notice: 'skipped' });
      const after = await fresh(b.id);
      expect(after.phone).toBeNull();
      expect(after.agentId).toBeNull();
      const row = (await audits(b.id, 'billing.tenant_released'))[0];
      expect(row.actorKind).toBe('admin_token');
      expect(row.meta.notice).toBe('skipped');
    });

    test('refuses an active tenant even when asked to act', async () => {
      const b = await mk('api3', { status: 'active' });
      const d = (await (await call({ business_id: b.id, dry_run: false, skip_notice: true, grace_days: 0 })).json()).data;
      expect(d.decision.action).toBe('skip');
      expect((await fresh(b.id)).phone).toBe(b.phone);
    });
  });
});
