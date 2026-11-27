/**
 * Operations views against a real database (agent D): roles and CSRF of every new route, SMS delivery failures, webhook claims, provider health history, the alerts center
 * (open, acknowledge, grow, notify, spacing), usage and revenue, the impact previews (library and the preview route), the job run route's critical rules and stored reports,
 * the audit enrichment, and the maintenance policy. Time-of-day independent; no outbound request leaves the machine.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { captureMail } from '../helpers/auth-harness';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

type Who = { cookie?: string; user?: { id: string; email: string } } | 'bearer' | null;

integration('admin console operations views (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let R: Record<string, any> = {};
  let alerts: typeof import('@/lib/admin/alerts');
  let health: typeof import('@/lib/admin/provider-health');
  let impact: typeof import('@/lib/admin/impact');
  let usageMod: typeof import('@/lib/admin/usage-overview');
  let cfg: typeof import('@/lib/config');
  const userIds: string[] = [];
  const startedAt = new Date(Date.now() - 2000);
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const ORIGIN = 'https://app.example.test';
  const SOURCE = `ops-test-${Math.random().toString(36).slice(2, 8)}`;
  const PROV = 'testprov';
  const JOB = 'ops_test_job';
  const SID = `AC${'0'.repeat(30)}77`;
  const rec = (n: number) => `RE${'0'.repeat(31)}${n}`;
  const planKeys: string[] = [];
  const bizIds: string[] = [];
  let mail: ReturnType<typeof captureMail> | null = null;

  const mk = async (role: 'owner' | 'ops' | 'support' | 'read_only') => {
    const user = await users.createUser({ email: `${uniq('ops')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, platform_role: role });
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    await users.markSessionMfaVerified(session.id);
    return { user: { id: user.id, email: user.email }, cookie: `rc_user_session=${token}` } as Who & { user: { id: string; email: string }; cookie: string };
  };
  const reqOf = (method: string, path: string, who: Who, body?: unknown): Request => new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...(who === 'bearer' ? { authorization: `Bearer ${SECRETS.adminToken}` } : who && who.cookie ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const call = async (handler: (req: Request, ctx?: any) => Promise<Response>, method: string, path: string, who: Who, body?: unknown) => {
    const res = await handler(reqOf(method, path, who, body));
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, data: json?.data, code: json?.code, headers: res.headers };
  };
  const biz = async (name: string, data: Record<string, unknown> = {}) => {
    const b = await newBusiness({ name: `${name} ${uniq('b')}`, agent_id: null });
    bizIds.push(b.id);
    if (Object.keys(data).length) await prisma.business.update({ where: { id: b.id }, data: data as any });
    return b;
  };
  const failAudit = (businessId: string | null, code: string | null, at: Date = new Date()) => prisma.auditEvent.create({ data: { actorKind: 'webhook', businessId, action: 'sms.delivery_failed', target: `sms:${crypto.randomUUID()}`, at, meta: { status: 'undelivered', error_code: code, kind: 'confirmation' } } });

  beforeAll(async () => {
    for (const k of ['BILLING_ENFORCED', 'PLAN_SMS_CAP', 'TRIAL_SMS_CAP', 'PLAN_CALL_MINUTES_CAP', 'SMS_ALLOWED_COUNTRY_CODES', 'ALERT_EMAIL', 'TENANT_RELEASE_JOB', 'RETENTION_JOB', 'BILLING_PAST_DUE_GRACE_DAYS', 'STRIPE_PRICE_ID', 'STRIPE_PRICE_ID_ANNUAL', 'SETTINGS_FREEZE']) setEnv(k, undefined);
    setEnv('APP_SECRET_KEY', crypto.randomBytes(32).toString('base64'));
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users'); cfg = await import('@/lib/config');
    alerts = await import('@/lib/admin/alerts'); health = await import('@/lib/admin/provider-health'); impact = await import('@/lib/admin/impact'); usageMod = await import('@/lib/admin/usage-overview');
    const m = async (p: string) => await import(p);
    R = {
      alerts: await m('@/app/api/admin/alerts/route'), ack: await m('@/app/api/admin/alerts/ack/route'), notify: await m('@/app/api/admin/alerts/notify/route'),
      sms: (await m('@/app/api/admin/deliveries/sms/route')).GET, events: (await m('@/app/api/admin/deliveries/events/route')).GET, health: (await m('@/app/api/admin/provider-health/route')).GET,
      usage: (await m('@/app/api/admin/usage/route')).GET, instances: (await m('@/app/api/admin/instances/route')).GET,
      preview: (await m('@/app/api/admin/settings/preview/route')).POST, audit: (await m('@/app/api/admin/audit/route')).GET,
      jobs: (await m('@/app/api/admin/jobs/route')).GET, jobsRun: (await m('@/app/api/admin/jobs/run/route')).POST, signup: (await m('@/app/api/auth/signup/route')).POST,
      smsStatus: (await m('@/app/api/sms/status/route')).POST,
    };
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/' } } });
  });
  beforeEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/' } } }); });
  afterEach(async () => { cfg.setSnapshotSource(null); mail?.restore?.(); mail = null; });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    await prisma.auditEvent.deleteMany({ where: { at: { gte: startedAt }, action: { in: ['sms.delivery_failed', 'settings.integrity_failure', 'alerts.acknowledged', 'alerts.notified', 'provider.health', 'jobs.tenant_release_report', 'jobs.grandfather_report', 'admin.bearer_use', 'test.ops'] } } });
    await prisma.processedEvent.deleteMany({ where: { source: SOURCE } });
    await prisma.jobRun.deleteMany({ where: { OR: [{ job: JOB }, { startedAt: { gte: startedAt } }] } });
    await prisma.instanceHeartbeat.deleteMany({ where: { instanceId: { startsWith: 'ops-test' } } });
    await prisma.pendingRecordingDeletion.deleteMany({ where: { accountSid: SID } });
    await prisma.business.updateMany({ where: { plan: { in: planKeys } }, data: { plan: null } });
    await prisma.plan.deleteMany({ where: { key: { in: planKeys } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  test('every new route: 401 without a credential, 403 for a tenant owner, reads for every role, writes only for ops and owner', async () => {
    const b = await biz('Role Probe');
    const ownerUser = await users.createUser({ email: `${uniq('own')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: b.id, email_verified: true });
    userIds.push(ownerUser.id);
    const { token } = await users.createSession(ownerUser.id);
    const tenantOwner: Who = { cookie: `rc_user_session=${token}` };
    const [owner, ops, support, ro] = [await mk('owner'), await mk('ops'), await mk('support'), await mk('read_only')];
    const reads: [string, (req: Request) => Promise<Response>, string][] = [
      ['alerts', R.alerts.GET, '/api/admin/alerts'], ['notify info', R.notify.GET, '/api/admin/alerts/notify'], ['sms', R.sms, '/api/admin/deliveries/sms'], ['events', R.events, '/api/admin/deliveries/events'],
      ['health', R.health, '/api/admin/provider-health'], ['usage', R.usage, '/api/admin/usage'], ['instances', R.instances, '/api/admin/instances'],
    ];
    for (const [name, h, path] of reads) {
      expect([name, (await call(h, 'GET', path, null)).status]).toEqual([name, 401]);
      expect([name, (await call(h, 'GET', path, tenantOwner)).status]).toEqual([name, 403]);
      for (const who of [owner, ops, support, ro, 'bearer' as const]) expect([name, (await call(h, 'GET', path, who)).status]).toEqual([name, 200]);
    }
    const writes: [string, (req: Request) => Promise<Response>, string, string, unknown][] = [
      ['ack', R.ack.POST, 'POST', '/api/admin/alerts/ack', { id: 'maintenance_active' }], ['unack', R.ack.DELETE, 'DELETE', '/api/admin/alerts/ack', { id: 'maintenance_active' }], ['notify', R.notify.POST, 'POST', '/api/admin/alerts/notify', {}],
    ];
    for (const [name, h, method, path, body] of writes) {
      expect([name, (await call(h, method, path, null, body)).status]).toEqual([name, 401]);
      expect([name, (await call(h, method, path, tenantOwner, body)).status]).toEqual([name, 403]);
      expect([name, (await call(h, method, path, support, body)).status]).toEqual([name, 403]);
      expect([name, (await call(h, method, path, ro, body)).status]).toEqual([name, 403]);
    }
    // a cross-site cookie write is refused
    const cross = await R.ack.POST(new Request(`${ORIGIN}/api/admin/alerts/ack`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', cookie: (ops as any).cookie }, body: JSON.stringify({ id: 'x' }) }));
    expect(cross.status).toBe(403);
  });

  test('SMS delivery failures: totals, codes with classes, tenants, days, filters, paging, no message text anywhere', async () => {
    const a = await biz('Sms Alpha');
    const other = await biz('Sms Beta');
    const ops = await mk('ops');
    for (const code of ['30007', '30007', '30007', '30005', null]) await failAudit(a.id, code);
    await failAudit(other.id, '30034');
    await failAudit(a.id, '30003', new Date(Date.now() - 40 * 86_400_000)); // outside the 7 day window
    for (const status of ['sent', 'sent', 'failed', 'blocked_cap']) await prisma.smsLog.create({ data: { businessId: a.id, toPhone: '+13055550100', body: 'SECRET BODY TEXT', kind: 'confirmation', status } });
    const r = await call(R.sms, 'GET', `/api/admin/deliveries/sms?days=7&business_id=${a.id}`, ops);
    expect(r.status).toBe(200);
    expect(r.data.totals).toMatchObject({ delivery_failures: 5, sent: 2, send_failures: 1, blocked: 1, failure_rate_pct: 100 });
    expect(r.data.by_code[0]).toMatchObject({ code: '30007', count: 3, failure_class: 'carrier' });
    expect(r.data.by_code.map((c: any) => String(c.code)).sort()).toEqual(['30005', '30007', 'null']);
    expect(r.data.by_tenant).toHaveLength(1);
    expect(r.data.by_tenant[0]).toMatchObject({ business_id: a.id, count: 5 });
    expect(r.data.by_tenant[0].business_name).toContain('Sms Alpha');
    expect(r.data.by_day.reduce((n: number, d: any) => n + d.count, 0)).toBe(5);
    expect(r.text).not.toContain('SECRET BODY TEXT');
    expect((await call(R.sms, 'GET', `/api/admin/deliveries/sms?days=90&business_id=${a.id}`, ops)).data.totals.delivery_failures).toBe(6);
    expect((await call(R.sms, 'GET', `/api/admin/deliveries/sms?business_id=${a.id}&code=30005`, ops)).data.totals.delivery_failures).toBe(1);
    expect((await call(R.sms, 'GET', `/api/admin/deliveries/sms?business_id=${a.id}&code=none`, ops)).data.recent.items).toHaveLength(1);
    const p1 = await call(R.sms, 'GET', `/api/admin/deliveries/sms?business_id=${a.id}&limit=2`, ops);
    expect(p1.data.recent.items).toHaveLength(2);
    expect(p1.data.recent.next_cursor).toBeTruthy();
    const p2 = await call(R.sms, 'GET', `/api/admin/deliveries/sms?business_id=${a.id}&limit=2&before=${encodeURIComponent(p1.data.recent.next_cursor)}`, ops);
    expect(p2.data.recent.items).toHaveLength(2);
    expect(new Set([...p1.data.recent.items, ...p2.data.recent.items].map((i: any) => i.id)).size).toBe(4);
    expect((await call(R.sms, 'GET', `/api/admin/deliveries/sms?before=not-a-date`, ops)).status).toBe(422);
    const empty = await call(R.sms, 'GET', `/api/admin/deliveries/sms?business_id=${(await biz('Sms Empty')).id}`, ops);
    expect(empty.data.totals.delivery_failures).toBe(0);
    expect(empty.data.recent.items).toEqual([]);
  });

  test('webhook / event claims: per source counts and stuck claims', async () => {
    const ops = await mk('support');
    const old = new Date(Date.now() - 40 * 60_000);
    await prisma.processedEvent.createMany({ data: [
      { source: SOURCE, id: 'a1', status: 'done' }, { source: SOURCE, id: 'a2', status: 'done' }, { source: SOURCE, id: 'a3', status: 'processing' },
      { source: SOURCE, id: 'a4', status: 'processing', claimedAt: old }, { source: SOURCE, id: 'a5', status: 'processing', claimedAt: old },
    ] });
    const r = await call(R.events, 'GET', '/api/admin/deliveries/events?hours=24', ops);
    const row = r.data.sources.find((s: any) => s.source === SOURCE);
    expect(row).toMatchObject({ total: 5, done: 2, processing: 3, stuck: 2, kind: 'internal' });
    expect(row.oldest_stuck_at).toBeTruthy();
    expect(r.data.stuck.filter((s: any) => s.source === SOURCE).map((s: any) => s.id).sort()).toEqual(['a4', 'a5']);
    expect(r.data.stuck.find((s: any) => s.source === SOURCE).age_minutes).toBeGreaterThanOrEqual(39);
    expect(r.data.totals.stuck).toBeGreaterThanOrEqual(2);
    expect(r.data.retention_days).toBe(30);
  });

  test('provider health: recorded on change or every 30 minutes, de-duplicated, summarised', async () => {
    const ops = await mk('ops');
    const t0 = new Date();
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'ok', ms: 120, tested_at: t0.toISOString() }, { kind: 'system' }, t0)).toBe(true);
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'ok', ms: 90, tested_at: new Date(t0.getTime() + 1000).toISOString() }, { kind: 'system' }, new Date(t0.getTime() + 60_000))).toBe(false); // same outcome, recent
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'auth_failed', ms: 80, tested_at: new Date(t0.getTime() + 2000).toISOString(), checks: { account: 'failed', 'bad key!': 'x' } }, { kind: 'system' }, new Date(t0.getTime() + 120_000))).toBe(true); // changed
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'ok', ms: 70, tested_at: new Date(t0.getTime() + 3000).toISOString() }, { kind: 'system' }, new Date(t0.getTime() + 31 * 60_000))).toBe(true); // changed back
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'ok', ms: 70, tested_at: new Date(t0.getTime() + 3000).toISOString() }, { kind: 'system' }, new Date(t0.getTime() + 90 * 60_000))).toBe(false); // the same cached result seen again
    expect(await health.recordProviderHealth({ provider: 'Bad Name', outcome: 'ok' })).toBe(false);
    expect(await health.recordProviderHealth({ provider: PROV, outcome: 'weird' })).toBe(false);
    const r = await call(R.health, 'GET', `/api/admin/provider-health?days=1&provider=${PROV}`, ops);
    expect(r.status).toBe(200);
    const p = r.data.providers[0];
    expect(p).toMatchObject({ provider: PROV, checks: 3 });
    expect(p.current.outcome).toBe('ok');
    expect(p.ok_pct).toBeCloseTo(66.7, 1);
    expect(p.last_failure_at).toBeTruthy();
    expect(p.history.find((h: any) => h.outcome === 'auth_failed').checks).toEqual({ account: 'failed' }); // an invalid check name is dropped
    expect((await call(R.health, 'GET', '/api/admin/provider-health?provider=Bad%20Name', ops)).data.providers).toEqual([]);
    const all = await call(R.health, 'GET', '/api/admin/provider-health', ops);
    for (const n of ['twilio', 'stripe', 'turnstile']) expect(all.data.providers.map((x: any) => x.provider)).toContain(n);
  });

  test('alerts: computed from live state, acknowledged, re-opened when worse, routed to the admins once per 6 hours', async () => {
    mail = captureMail();
    const ops = await mk('ops'); const ro = await mk('read_only');
    const b = await biz('Alert Tenant');
    await prisma.pendingRecordingDeletion.create({ data: { accountSid: SID, recordingSid: rec(1), businessId: b.id, alertedAt: new Date(), attempts: 9 } });
    for (let i = 0; i < 4; i++) await failAudit(b.id, '30007');
    await prisma.jobRun.create({ data: { id: crypto.randomUUID(), job: JOB, startedAt: new Date(Date.now() - 3600_000), finishedAt: new Date(Date.now() - 3590_000), status: 'error', errors: 1, errorSample: 'boom', actor: 'system', trigger: 'schedule', counts: {} } });
    await prisma.jobRun.create({ data: { id: crypto.randomUUID(), job: JOB, startedAt: new Date(Date.now() - 1800_000), finishedAt: new Date(Date.now() - 1790_000), status: 'error', errors: 1, errorSample: 'boom again', actor: 'system', trigger: 'schedule', counts: {} } });
    await prisma.auditEvent.create({ data: { actorKind: 'system', action: 'settings.integrity_failure', target: 'settings', meta: { key: 'x' } } });
    await health.recordProviderHealth({ provider: 'opsbad', outcome: 'auth_failed' }, { kind: 'system' });
    await prisma.processedEvent.create({ data: { source: SOURCE, id: 'stuck-1', status: 'processing', claimedAt: new Date(Date.now() - 60 * 60_000) } });
    // drift: a live instance behind the published version, the version older than the grace
    const cur = Number((await prisma.settingsState.findUnique({ where: { id: 1 } }))?.globalVersion ?? 0);
    await prisma.settingsState.upsert({ where: { id: 1 }, create: { id: 1, globalVersion: BigInt(5), updatedAt: new Date(Date.now() - 10 * 60_000) }, update: { globalVersion: BigInt(Math.max(cur, 3)), updatedAt: new Date(Date.now() - 10 * 60_000) } });
    const ver = Number((await prisma.settingsState.findUnique({ where: { id: 1 } }))!.globalVersion);
    await prisma.instanceHeartbeat.create({ data: { instanceId: 'ops-test-behind', settingsVersion: BigInt(Math.max(0, ver - 1)), seenAt: new Date() } });

    const r = await call(R.alerts.GET, 'GET', '/api/admin/alerts', ro);
    expect(r.status).toBe(200);
    const by = (id: string) => r.data.alerts.find((a: any) => a.id === id);
    expect(by('recording_deletions_stuck')).toMatchObject({ severity: 'critical', acknowledged: null, href: '/admin/operations/jobs' });
    expect(by('recording_deletions_stuck').count).toBeGreaterThanOrEqual(1);
    expect(by('sms_delivery_failures').count).toBeGreaterThanOrEqual(4);
    expect(by(`job_errors:${JOB}`)).toMatchObject({ kind: 'job_errors', subject: JOB, count: 2, severity: 'warning', detail: { last_error: 'boom again' } });
    expect(by('settings_integrity')).toMatchObject({ severity: 'critical' });
    expect(by('provider_unhealthy:opsbad')).toMatchObject({ severity: 'critical', detail: { provider: 'opsbad', outcome: 'auth_failed' } });
    expect(by('stuck_events').count).toBeGreaterThanOrEqual(1);
    expect(by('settings_drift')).toMatchObject({ severity: 'warning' });
    expect(by('settings_drift').detail.instances_behind).toBeGreaterThanOrEqual(1);
    expect(r.data.alerts.map((a: any) => a.severity)).toEqual([...r.data.alerts.map((a: any) => a.severity)].sort((x: string, y: string) => ['critical', 'warning', 'info'].indexOf(x) - ['critical', 'warning', 'info'].indexOf(y))); // critical first
    expect(r.data.summary.open).toBeGreaterThan(0);
    expect(JSON.stringify(r.data)).not.toContain('SECRET');

    // acknowledge: validation, permission, effect
    expect((await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, { id: 'no_such_alert' })).status).toBe(404);
    expect((await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, { id: 'Bad Id!' })).status).toBe(422);
    expect((await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, {})).status).toBe(422);
    expect((await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ro, { id: `job_errors:${JOB}` })).status).toBe(403);
    const ack = await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, { id: `job_errors:${JOB}`, hours: 99999, reason: 'known, fixing' });
    expect(ack.status).toBe(200);
    expect(ack.data.acknowledged.reason).toBe('known, fixing');
    expect(new Date(ack.data.acknowledged.until).getTime() - Date.now()).toBeLessThanOrEqual(24 * 14 * 3_600_000 + 5000); // clamped to two weeks
    const after = await call(R.alerts.GET, 'GET', '/api/admin/alerts', ro);
    expect(after.data.alerts.find((a: any) => a.id === `job_errors:${JOB}`).acknowledged).toMatchObject({ reason: 'known, fixing' });
    expect(after.data.summary.acknowledged).toBeGreaterThanOrEqual(1);
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'alerts.acknowledged', target: `alert:job_errors:${JOB}` }, orderBy: { at: 'desc' } });
    expect(audit?.actorUserId).toBe((ops as any).user.id);
    // a worse problem re-opens it
    await prisma.jobRun.create({ data: { id: crypto.randomUUID(), job: JOB, startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 590_000), status: 'error', errors: 1, errorSample: 'third', actor: 'system', trigger: 'schedule', counts: {} } });
    const grown = await call(R.alerts.GET, 'GET', '/api/admin/alerts', ro);
    expect(grown.data.alerts.find((a: any) => a.id === `job_errors:${JOB}`)).toMatchObject({ count: 3, severity: 'critical', acknowledged: null });
    // withdrawing an acknowledgement shows it again at once
    await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, { id: 'settings_drift', hours: 4 });
    expect((await call(R.alerts.GET, 'GET', '/api/admin/alerts', ro)).data.alerts.find((a: any) => a.id === 'settings_drift').acknowledged).toBeTruthy();
    expect((await call(R.ack.DELETE, 'DELETE', '/api/admin/alerts/ack', ops, { id: 'settings_drift' })).status).toBe(200);
    expect((await call(R.alerts.GET, 'GET', '/api/admin/alerts', ro)).data.alerts.find((a: any) => a.id === 'settings_drift').acknowledged).toBeNull();

    // routing: who is told, the forced notice, then the 6 hour spacing
    const info = await call(R.notify.GET, 'GET', '/api/admin/alerts/notify', ro);
    expect(info.data.recipients).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(info.data)).not.toContain('@');
    const sent = await call(R.notify.POST, 'POST', '/api/admin/alerts/notify', ops, {});
    expect(sent.status).toBe(200);
    expect(sent.data.due).toContain('recording_deletions_stuck');
    expect(sent.data.due).toContain('settings_integrity');
    expect(sent.data.sent).toBeGreaterThanOrEqual(2);
    const mine = mail!.mails.filter((m: any) => /platform alert/.test(m.subject));
    expect(mine.length).toBe(sent.data.sent);
    expect(mine.map((m: any) => m.to)).toContain((ops as any).user.email);
    expect(mine[0].text).toContain('recording');
    expect(mine[0].text).not.toMatch(/boom|SECRET/); // no job error text, no secret in the mail
    const again = await alerts.dispatchAlertNotices({});
    expect(again.due).toEqual([]); // nothing grew, nothing is due
    expect(again.skipped).toContain('recording_deletions_stuck');
    await prisma.pendingRecordingDeletion.create({ data: { accountSid: SID, recordingSid: rec(2), businessId: b.id, alertedAt: new Date(), attempts: 9 } });
    const grew = await alerts.dispatchAlertNotices({});
    expect(grew.due).toContain('recording_deletions_stuck'); // it grew: due again
    const notified = await prisma.auditEvent.count({ where: { action: 'alerts.notified', target: 'alert:recording_deletions_stuck' } });
    expect(notified).toBeGreaterThanOrEqual(2);
    // an acknowledged critical alert is not mailed
    await call(R.ack.POST, 'POST', '/api/admin/alerts/ack', ops, { id: 'settings_integrity', hours: 4 });
    const quiet = await alerts.dispatchAlertNotices({ force: true });
    expect(quiet.due).not.toContain('settings_integrity');
  });

  test('the hourly cleanup job does not mail alerts under test (and never throws on them)', async () => {
    mail = captureMail();
    const { runCleanup } = await import('@/lib/jobs');
    const report = await runCleanup({});
    expect(report.errors).toBe(0);
    expect(mail.mails.filter((m: any) => /platform alert/.test(m.subject))).toEqual([]);
  });

  test('usage and revenue: tenants by status and plan, MRR from the plan price, comped and past-due excluded, caps, trials', async () => {
    const ops = await mk('ops');
    const pk = `opsplan${Math.random().toString(36).slice(2, 7)}`;
    planKeys.push(pk);
    await prisma.plan.create({ data: { key: pk, name: 'Ops Plan', stripePriceId: 'price_opstest1', stripePriceIdAnnual: 'price_opstest2' } });
    const price = async (id: string | null | undefined) => (id === 'price_opstest1' ? { amount_cents: 10000, currency: 'USD', interval: 'month' as const, interval_count: 1 } : id === 'price_opstest2' ? { amount_cents: 96000, currency: 'USD', interval: 'year' as const, interval_count: 1 } : null);
    const before = await usageMod.usageOverview({ fetchPrice: price });
    const now = new Date();
    await biz('Pay One', { plan: pk, billingStatus: 'active', status: 'live' });
    await biz('Pay Two', { plan: pk, billingStatus: 'active', status: 'live' });
    await biz('Pay Annual', { plan: pk, billingStatus: 'active', status: 'live', billingInterval: 'year' });
    await biz('Late', { plan: pk, billingStatus: 'past_due', pastDueSince: now });
    await biz('Suspended Payer', { plan: pk, billingStatus: 'active', suspendedAt: now, suspendedBy: 'x', suspendedReason: 'x' }).catch(() => undefined);
    await biz('Comped', { plan: 'legacy', billingStatus: 'active' });
    const trial = await biz('Trial Soon', { plan: pk, billingStatus: 'trialing', trialEndsAt: new Date(now.getTime() + 2 * 86_400_000) });
    const heavy = await db.getBusiness(trial.id);
    expect(heavy).toBeTruthy();
    const usage = await import('@/lib/db/usage');
    await usage.recordSms(trial.id, 60); // trial cap is 50: over the cap
    const after = await usageMod.usageOverview({ fetchPrice: price });
    const d = (k: (o: typeof after) => number) => k(after) - k(before);
    expect(d((o) => o.revenue.paying)).toBe(3);
    expect(d((o) => o.revenue.past_due)).toBe(1);
    expect(d((o) => o.revenue.mrr_cents ?? 0)).toBe(10000 * 2 + 8000); // 2 monthly + the annual price / 12
    const planRow = after.revenue.mrr_by_plan.find((p) => p.plan === pk)!;
    expect(planRow).toMatchObject({ paying: 3, price_source: 'plan' });
    expect(after.revenue.currency).toBe('USD');
    expect(d((o) => o.trials.trialing)).toBe(1);
    expect(d((o) => o.trials.ending_3d)).toBe(1);
    expect(after.trials.upcoming.some((t) => t.business_id === trial.id)).toBe(true);
    expect(d((o) => o.usage.sms.over_100)).toBe(1);
    expect(d((o) => o.usage.sms.used)).toBe(60);
    expect(after.top_usage.some((t) => t.business_id === trial.id && t.sms === 60 && t.sms_cap === 50)).toBe(true);
    expect(after.tenants.by_plan.find((p) => p.plan === 'legacy')?.comped).toBe(true);
    expect(after.tenants.comped).toBeGreaterThanOrEqual(1);
    // a price Stripe cannot read: no made-up number
    const none = await usageMod.usageOverview({ fetchPrice: async () => null });
    expect(none.revenue.mrr_by_plan.find((p) => p.plan === pk)?.subtotal_cents).toBeNull();
    // the route
    const r = await call(R.usage, 'GET', '/api/admin/usage', ops);
    expect(r.status).toBe(200);
    expect(r.data.revenue.note).toBe('estimate_monthly_price');
  });

  test('impact previews: tenants over a lowered cap, owner phones after narrowing countries, retention per tenant, billing enforcement, past-due grace; through the preview route', async () => {
    const ops = await mk('ops');
    const usage = await import('@/lib/db/usage');
    // SMS cap
    const heavy = await biz('Impact Heavy', { billingStatus: 'active' });
    await usage.recordSms(heavy.id, 400);
    const lowered = await impact.impactsFor([{ key: 'billing.plan_sms_cap', value: 300 }]);
    expect(lowered).toHaveLength(1);
    expect(lowered[0]).toMatchObject({ id: 'tenants_over_sms_cap', key: 'billing.plan_sms_cap' });
    expect(lowered[0].count).toBeGreaterThanOrEqual(1);
    expect(lowered[0].rows.some((r) => r.label === heavy.name && r.value === 400)).toBe(true);
    expect(((await impact.impactsFor([{ key: 'billing.plan_sms_cap', value: 450 }]))[0]).rows.some((r) => r.label === heavy.name)).toBe(false); // 400 < 450: not over
    expect(((await impact.impactsFor([{ key: 'billing.plan_sms_cap', value: 600 }]))[0]).rows.some((r) => r.label === heavy.name)).toBe(false); // raising never puts anyone over
    expect(((await impact.impactsFor([{ key: 'billing.plan_sms_cap', remove: true }]))[0]).count).toBeGreaterThanOrEqual(0); // reset to the default 500
    // AI minutes cap
    await usage.recordCallSeconds(heavy.id, 200 * 60);
    expect((await impact.impactsFor([{ key: 'billing.plan_call_minutes_cap', value: 100 }]))[0].rows.some((r) => r.label === heavy.name && r.value === 200)).toBe(true);
    // owner phones
    setEnv('SMS_ALLOWED_COUNTRY_CODES', '1,52');
    const mx = await biz('Impact Mexico', { ownerPhoneE164: '+525512345678' });
    const narrowed = await impact.impactsFor([{ key: 'messaging.sms_allowed_countries', value: ['1'] }]);
    expect(narrowed[0]).toMatchObject({ id: 'owner_phones_invalid', facts: { countries_before: '1,52', countries_after: '1' } });
    expect(narrowed[0].count).toBeGreaterThanOrEqual(1);
    expect((await impact.impactsFor([{ key: 'messaging.sms_allowed_countries', value: ['1', '52', '44'] }]))[0].count).toBe(0); // widening invalidates nobody
    setEnv('SMS_ALLOWED_COUNTRY_CODES', undefined);
    void mx;
    // retention: per tenant
    const old = await biz('Impact Retention', { retentionDays: 30 });
    await prisma.smsLog.create({ data: { businessId: old.id, toPhone: '+13055550101', body: 'x', kind: 'confirmation', status: 'sent', createdAt: new Date(Date.now() - 100 * 86_400_000) } });
    const purge = await impact.impactsFor([{ key: 'jobs.retention_enabled', value: true }]);
    expect(purge[0]).toMatchObject({ id: 'retention_purge' });
    expect(purge[0].count).toBeGreaterThanOrEqual(1);
    expect(purge[0].rows.some((r) => r.label === old.name && r.value >= 1)).toBe(true);
    expect(purge[0].facts.texts).toBeGreaterThanOrEqual(1);
    expect(await impact.impactsFor([{ key: 'jobs.retention_enabled', value: false }])).toEqual([]);
    // billing enforcement and the past-due grace
    const live = await biz('Impact Unpaid', { status: 'live', billingStatus: 'none' });
    const enforce = await impact.impactsFor([{ key: 'billing.enforced', value: true }]);
    expect(enforce[0]).toMatchObject({ id: 'billing_enforcement' });
    expect(enforce[0].count).toBeGreaterThanOrEqual(1);
    expect(await impact.impactsFor([{ key: 'billing.enforced', value: false }])).toEqual([]);
    setEnv('BILLING_ENFORCED', 'true');
    await biz('Impact Late', { status: 'live', billingStatus: 'past_due', pastDueSince: new Date(Date.now() - 3 * 86_400_000) });
    expect((await impact.impactsFor([{ key: 'billing.past_due_grace_days', value: 2 }]))[0].count).toBeGreaterThanOrEqual(1);
    expect((await impact.impactsFor([{ key: 'billing.past_due_grace_days', value: 30 }]))[0].count).toBe(0);
    setEnv('BILLING_ENFORCED', undefined);
    void live;
    // keys without a preview, secrets and unknown keys are skipped, never an error
    expect(await impact.impactsFor([{ key: 'platform.announcement', value: 'x' }, { key: 'stripe.secret_key', secret: 'sk_test_' + 'a'.repeat(24) }, { key: 'nope.nope', value: 1 }])).toEqual([]);
    // through the route
    const p = await call(R.preview, 'POST', '/api/admin/settings/preview', ops, { changes: [{ key: 'billing.plan_sms_cap', value: 300 }] });
    expect(p.status).toBe(200);
    expect(p.data.impacts[0]).toMatchObject({ id: 'tenants_over_sms_cap' });
    expect(p.data.requires.reason).toBe(true); // the tier requirements are still there
    const plain = await call(R.preview, 'POST', '/api/admin/settings/preview', ops, { changes: [{ key: 'platform.announcement', value: 'hello' }] });
    expect(plain.status).toBe(200);
    expect(plain.data.impacts).toEqual([]);
    const bad = await call(R.preview, 'POST', '/api/admin/settings/preview', ops, { changes: [{ key: 'billing.plan_sms_cap', value: -5 }] });
    expect(bad.status).toBe(422); // validation still comes first
  });

  test('jobs: a real run of a critical job from a console session needs a reason and mails the admins; the Bearer is recovery; reports store their rows', async () => {
    mail = captureMail();
    const ops = await mk('ops'); const ro = await mk('read_only');
    const noReason = await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'tenant_release', dry_run: false });
    expect(noReason.status).toBe(422);
    expect(noReason.code).toBe('reason_required');
    expect((await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'tenant_release', dry_run: false, reason: 'x'.repeat(501) })).status).toBe(422);
    expect((await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'tenant_release', dry_run: false, reason: 42 })).status).toBe(422);
    const dry = await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'tenant_release' });
    expect(dry.status).toBe(200); // a dry run (the default) never needs a reason
    expect(dry.data.dry_run).toBe(true);
    const refused = await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'tenant_release', dry_run: false, reason: 'cleaning up canceled tenants', confirm: 'run tenant_release' });
    expect(refused.status).toBe(200);
    expect(refused.data.dry_run).toBe(true); // TENANT_RELEASE_JOB is not "on": reported as a dry run
    expect(refused.data.items.some((i: any) => i.outcome === 'refused_not_enabled')).toBe(true);
    expect((await call(R.jobsRun, 'POST', '/api/admin/jobs/run', 'bearer', { job: 'tenant_release', dry_run: false })).status).toBe(200); // the break-glass token needs no reason
    expect((await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ro, { job: 'cleanup' })).status).toBe(403);
    const cleanupReal = await call(R.jobsRun, 'POST', '/api/admin/jobs/run', ops, { job: 'cleanup', dry_run: false });
    expect(cleanupReal.status).toBe(200); // not critical: no reason needed
    expect(mail.mails.filter((m: any) => /run for real/.test(m.subject))).toEqual([]); // the refused / dry runs changed nothing and mailed nothing
    // the stored report keeps the rows the console renders as a table
    const g = await call(R.jobs, 'GET', '/api/admin/jobs', ops);
    const last = g.data.diagnostics.tenant_release.last_report;
    expect(typeof last.meta.items_total).toBe('number');
    expect(Array.isArray(last.meta.items)).toBe(true);
    for (const row of last.meta.items) { expect(row).toHaveLength(2); expect(typeof row[1]).toBe('string'); }
    expect(g.data.diagnostics.tenant_release.setting).toBe('off');
  });

  test('audit: rows carry the business name and the admin e-mail; filters and the audited export still work', async () => {
    const ops = await mk('ops'); const owner = await mk('owner');
    const b = await biz('Audit Named Tenant');
    await prisma.auditEvent.create({ data: { actorKind: 'user', actorUserId: (ops as any).user.id, businessId: b.id, action: 'test.ops', target: `business:${b.id}`, meta: { note: 'hello' } } });
    const r = await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}&action=test.ops`, ops);
    expect(r.status).toBe(200);
    expect(r.data.items).toHaveLength(1);
    expect(r.data.items[0]).toMatchObject({ business_name: b.name, actor_email: (ops as any).user.email, action: 'test.ops', meta: { note: 'hello' } });
    expect((await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}&q=hello`, ops)).data.items).toHaveLength(1);
    expect((await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}&q=nothing-like-this`, ops)).data.items).toHaveLength(0);
    const ro = await mk('read_only');
    expect((await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}&export=1&format=csv`, ro)).status).toBe(403); // reading is not exporting
    expect((await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}`, ro)).status).toBe(200);
    const csv = await call(R.audit, 'GET', `/api/admin/audit?business_id=${b.id}&export=1&format=csv`, owner);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('id,at,actor_kind,actor_user_id,business_id,action,target,ip,meta');
    expect(await prisma.auditEvent.count({ where: { action: 'audit.export', actorUserId: (owner as any).user.id } })).toBeGreaterThanOrEqual(1);
    await prisma.auditEvent.deleteMany({ where: { action: 'audit.export', actorUserId: (owner as any).user.id } });
  });

  test('instances: heartbeat table with applied version, build and mixed builds', async () => {
    const ops = await mk('ops');
    await prisma.settingsState.upsert({ where: { id: 1 }, create: { id: 1, globalVersion: BigInt(7) }, update: {} });
    const ver = Number((await prisma.settingsState.findUnique({ where: { id: 1 } }))!.globalVersion);
    await prisma.instanceHeartbeat.createMany({ data: [
      { instanceId: 'ops-test-a', settingsVersion: BigInt(ver), buildSha: 'aaaaaaaaaaaa1111', seenAt: new Date() },
      { instanceId: 'ops-test-b', settingsVersion: BigInt(ver), buildSha: 'bbbbbbbbbbbb2222', seenAt: new Date() },
      { instanceId: 'ops-test-gone', settingsVersion: BigInt(ver), buildSha: 'aaaaaaaaaaaa1111', seenAt: new Date(Date.now() - 600_000) },
    ] }).catch(() => undefined);
    await prisma.instanceHeartbeat.deleteMany({ where: { instanceId: 'ops-test-behind' } });
    const r = await call(R.instances, 'GET', '/api/admin/instances', ops);
    const row = (id: string) => r.data.instances.find((i: any) => i.instance_id === id);
    expect(row('ops-test-a')).toMatchObject({ alive: true, current: true, build_sha: 'aaaaaaaaaaaa1111', behind_by: 0 });
    expect(row('ops-test-gone')).toMatchObject({ alive: false });
    expect(r.data.mixed_builds).toBe(true);
    expect(r.data.builds.length).toBeGreaterThanOrEqual(2);
    expect(r.data.version).toBe(ver);
  });

  test('maintenance: sign-ups are refused with 503 and Retry-After; provider webhooks are never refused', async () => {
    cfg.setSnapshotSource(() => new cfg.ConfigSnapshot({ version: 1, values: { 'platform.maintenance_mode': true }, secrets: {} }));
    const signup = await R.signup(new Request(`${ORIGIN}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ email: `${uniq('m')}@example.test`, password: 'correct horse battery staple', business_name: 'Maint Co' }) }));
    expect(signup.status).toBe(503);
    expect(signup.headers.get('retry-after')).toBe('300');
    expect(((await signup.json()) as any).code).toBe('maintenance');
    const webhook = await R.smsStatus(new Request(`${ORIGIN}/api/sms/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MessageSid=SM1&MessageStatus=delivered' }));
    expect(webhook.status).toBe(403); // the signature check answers, not a maintenance refusal: the webhook is still processed
    cfg.setSnapshotSource(null);
    const open = await R.signup(new Request(`${ORIGIN}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({}) }));
    expect(open.status).not.toBe(503);
  });
});
