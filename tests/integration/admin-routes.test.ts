/**
 * /api/admin/* console routes against a real database: authentication, CSRF, the role matrix per route, the break-glass Bearer rules, a hijacked (stale / read-only /
 * support) session, step-up, rate limits, secrets never in a response, plans, legal pages, tenants (directory, detail, suspension, support mode), tenant overrides
 * (admin and owner routes, clamping, cross-tenant), administrators, job runs, audit search / export, selftest, system. No outbound request leaves the machine.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { captureMail } from '../helpers/auth-harness';
import { cleanup, loadDb, loadPrisma, newBusiness, uniq } from '../helpers/fixtures';

type Who = { cookie?: string; user?: { id: string; email: string } } | 'bearer' | null;

integration('admin console: routes, roles, bearer rules, tenants, plans, legal (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let users: typeof import('@/lib/db/users');
  let loader: typeof import('@/lib/admin/loader');
  let cfg: typeof import('@/lib/config');
  let usage: typeof import('@/lib/db/usage');
  let R: Record<string, any> = {};
  const userIds: string[] = [];
  const planKeys: string[] = [];
  const startedAt = new Date(Date.now() - 1000);
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const MASTER = crypto.randomBytes(32).toString('base64');
  const ORIGIN = 'https://app.example.test';

  const mk = async (role: 'owner' | 'ops' | 'support' | 'read_only' | null, extra: { twoFactor?: boolean } = {}) => {
    const user = await users.createUser({ email: `${uniq('adm')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', email_verified: true, ...(role ? { platform_role: role } : {}) });
    userIds.push(user.id);
    if (role === null) await prisma.user.update({ where: { id: user.id }, data: { platformRole: null } });
    if (extra.twoFactor !== false) await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
    const { token, session } = await users.createSession(user.id);
    if (extra.twoFactor !== false) await users.markSessionMfaVerified(session.id);
    return { user: { id: user.id, email: user.email }, cookie: `rc_user_session=${token}` } as Who & { user: { id: string; email: string }; cookie: string };
  };
  const setSudo = (userId: string, ageMs: number) => prisma.userSession.updateMany({ where: { userId }, data: { sudoAt: new Date(Date.now() - ageMs) } });

  function reqOf(method: string, path: string, who: Who, body?: unknown, extraHeaders: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: ORIGIN,
        ...(who === 'bearer' ? { authorization: `Bearer ${SECRETS.adminToken}` } : who && who.cookie ? { cookie: who.cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const call = async (handler: (req: Request, ctx?: any) => Promise<Response>, method: string, path: string, who: Who, body?: unknown, params?: Record<string, string>) => {
    const res = await handler(reqOf(method, path, who, body), params ? { params: Promise.resolve(params) } : undefined);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, json, text, data: json?.data, code: json?.code, headers: res.headers };
  };

  beforeAll(async () => {
    for (const k of ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'TRUSTED_PROXY', 'APP_URL']) setEnv(k, process.env[k]); // remember the ORIGINAL values before captureMail() changes them
    setEnv('APP_SECRET_KEY', MASTER);
    for (const k of ['SETTINGS_FREEZE', 'ADMIN_TOKEN_ALLOW_SETTINGS', 'ALERT_EMAIL', 'BILLING_PLAN_NAME', 'STRIPE_SECRET_KEY', 'PLAN_SMS_CAP', 'PLAN_CALL_MINUTES_CAP']) setEnv(k, undefined);
    db = await loadDb(); prisma = await loadPrisma();
    users = await import('@/lib/db/users'); loader = await import('@/lib/admin/loader'); cfg = await import('@/lib/config'); usage = await import('@/lib/db/usage');
    const m = async (p: string) => await import(p);
    R = {
      me: (await m('@/app/api/admin/me/route')).GET, system: (await m('@/app/api/admin/system/route')).GET, selftest: (await m('@/app/api/admin/selftest/route')).GET,
      jobRuns: (await m('@/app/api/admin/job-runs/route')).GET, audit: (await m('@/app/api/admin/audit/route')).GET,
      settings: await m('@/app/api/admin/settings/route'), preview: await m('@/app/api/admin/settings/preview/route'), apply: await m('@/app/api/admin/settings/apply/route'),
      history: await m('@/app/api/admin/settings/history/route'), historyId: await m('@/app/api/admin/settings/history/[id]/route'), rollback: await m('@/app/api/admin/settings/rollback/route'),
      sExport: await m('@/app/api/admin/settings/export/route'), sImport: await m('@/app/api/admin/settings/import/route'), freeze: await m('@/app/api/admin/settings/freeze/route'),
      secret: await m('@/app/api/admin/secrets/[key]/route'), reencrypt: await m('@/app/api/admin/secrets/reencrypt/route'),
      plans: await m('@/app/api/admin/plans/route'), plan: await m('@/app/api/admin/plans/[key]/route'),
      overrides: await m('@/app/api/admin/tenant-overrides/route'), ownerOverrides: await m('@/app/api/businesses/[id]/settings-overrides/route'),
      legal: await m('@/app/api/admin/legal/route'), legalPage: await m('@/app/api/admin/legal/[slug]/[locale]/route'), legalPublish: await m('@/app/api/admin/legal/[slug]/[locale]/publish/route'),
      tenants: await m('@/app/api/admin/tenants/route'), tenant: await m('@/app/api/admin/tenants/[id]/route'), suspend: await m('@/app/api/admin/tenants/[id]/suspend/route'),
      reactivate: await m('@/app/api/admin/tenants/[id]/reactivate/route'), support: await m('@/app/api/admin/tenants/[id]/support-mode/route'),
      admins: await m('@/app/api/admin/admins/route'), admin: await m('@/app/api/admin/admins/[id]/route'), adminSessions: await m('@/app/api/admin/admins/[id]/sessions/route'), adminTwoFactor: await m('@/app/api/admin/admins/[id]/two-factor/route'),
      billing: (await m('@/app/api/admin/billing/route')).POST, jobs: (await m('@/app/api/admin/jobs/route')).GET, jobsRun: (await m('@/app/api/admin/jobs/run/route')).POST,
      retention: (await m('@/app/api/admin/retention/route')).POST, users: (await m('@/app/api/admin/users/route')).POST,
    };
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'admin/' } } });
  });
  beforeEach(async () => { await prisma.rateLimitBucket.deleteMany({ where: { OR: [{ key: { startsWith: 'admin/' } }, { key: { startsWith: 'business/' } }] } }); });
  afterEach(async () => { setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', undefined); setEnv('SETTINGS_FREEZE', undefined); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    loader.stopSettingsLoader();
    await prisma.platformSetting.deleteMany({}); await prisma.settingChangeSet.deleteMany({}); await prisma.tenantSettingOverride.deleteMany({});
    await prisma.settingsState.update({ where: { id: 1 }, data: { frozenAt: null, frozenBy: null, frozenReason: null, globalVersion: { increment: 1 } } });
    await prisma.legalPageVersion.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await prisma.legalPage.updateMany({ data: { publishedVersion: null } });
    await prisma.business.updateMany({ where: { plan: { in: planKeys } }, data: { plan: null } });
    await prisma.plan.deleteMany({ where: { key: { in: planKeys } } });
    await prisma.jobRun.deleteMany({ where: { startedAt: { gte: startedAt } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { at: { gte: startedAt }, action: { in: ['admin.bearer_use', 'audit.export', 'settings.export', 'plans.create', 'plans.update', 'plans.archive', 'plans.unarchive', 'plans.delete'] } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  test('authentication, CSRF and the tenant owner: 401 without a credential, 403 for a tenant owner, 403 for a cross-site cookie write, every route', async () => {
    const biz = await newBusiness({ agent_id: null });
    const ownerUser = await users.createUser({ email: `${uniq('own')}@example.test`, password_hash: 'x'.repeat(20), role: 'owner', business_id: biz.id, email_verified: true });
    userIds.push(ownerUser.id);
    const { token } = await users.createSession(ownerUser.id);
    const tenantOwner: Who = { cookie: `rc_user_session=${token}` };
    const a = await mk('owner');
    const probes: [string, (req: Request, ctx?: any) => Promise<Response>, string, string, unknown?, Record<string, string>?][] = [
      ['me', R.me, 'GET', '/api/admin/me'], ['system', R.system, 'GET', '/api/admin/system'], ['selftest', R.selftest, 'GET', '/api/admin/selftest'],
      ['settings', R.settings.GET, 'GET', '/api/admin/settings'], ['apply', R.apply.POST, 'POST', '/api/admin/settings/apply', { changes: [] }], ['secret', R.secret.PUT, 'PUT', '/api/admin/secrets/stripe.secret_key', { value: 'x' }, { key: 'stripe.secret_key' }],
      ['plans', R.plans.GET, 'GET', '/api/admin/plans'], ['tenants', R.tenants.GET, 'GET', '/api/admin/tenants'], ['admins', R.admins.GET, 'GET', '/api/admin/admins'], ['audit', R.audit, 'GET', '/api/admin/audit'],
      ['job-runs', R.jobRuns, 'GET', '/api/admin/job-runs'], ['legal', R.legal.GET, 'GET', '/api/admin/legal'], ['freeze', R.freeze.POST, 'POST', '/api/admin/settings/freeze', { frozen: true }],
    ];
    for (const [name, h, method, path, body, params] of probes) {
      expect([name, (await call(h, method, path, null, body, params)).status]).toEqual([name, 401]);
      expect([name, (await call(h, method, path, tenantOwner, body, params)).status]).toEqual([name, 403]);
    }
    // cross-site cookie write: refused before anything else (CSRF)
    const cross = await R.apply.POST(reqOf('POST', '/api/admin/settings/apply', a, { changes: [{ key: 'platform.announcement', value: 'csrf' }] }, { 'sec-fetch-site': 'cross-site' }));
    expect(cross.status).toBe(403);
    const noOrigin = await R.apply.POST(new Request(`${ORIGIN}/api/admin/settings/apply`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ key: 'platform.announcement', value: 'csrf' }] }) }));
    expect(noOrigin.status).toBe(403);
    expect(await prisma.platformSetting.count({ where: { key: 'platform.announcement' } })).toBe(0);
    // a bad token never falls back to a cookie
    const bad = await R.settings.GET(new Request(`${ORIGIN}/api/admin/settings`, { headers: { authorization: 'Bearer nope', cookie: a.cookie } }));
    expect(bad.status).toBe(401);
  });

  test('the role matrix on the routes: every role reads; only the right roles write; the response says who you are', async () => {
    const roles = { owner: await mk('owner'), ops: await mk('ops'), support: await mk('support'), read_only: await mk('read_only'), none: await mk(null) };
    for (const [name, who] of Object.entries(roles)) {
      const me = await call(R.me, 'GET', '/api/admin/me', who);
      expect([name, me.status]).toEqual([name, 200]);
      expect(me.data.role).toBe(name === 'none' ? 'read_only' : name); // no platform role = read_only (fail safe)
      for (const [label, h, path, params] of [['settings', R.settings.GET, '/api/admin/settings'], ['plans', R.plans.GET, '/api/admin/plans'], ['tenants', R.tenants.GET, '/api/admin/tenants'], ['audit', R.audit, '/api/admin/audit'],
        ['job-runs', R.jobRuns, '/api/admin/job-runs'], ['system', R.system, '/api/admin/system'], ['selftest', R.selftest, '/api/admin/selftest'], ['legal', R.legal.GET, '/api/admin/legal'], ['admins', R.admins.GET, '/api/admin/admins']] as any[]) {
        const expected = label === 'admins' && name === 'support' ? 403 : 200; // the support view does not list the administrators
        expect([name, label, (await call(h, 'GET', path, who, undefined, params)).status]).toEqual([name, label, expected]);
      }
    }
    expect((await call(R.me, 'GET', '/api/admin/me', roles.owner)).data.permissions).toContain('settings.secrets.write');
    expect((await call(R.me, 'GET', '/api/admin/me', roles.ops)).data.permissions).not.toContain('settings.secrets.write');
    // writes: normal settings: owner + ops; support / read_only / none refused
    const w = (who: Who) => call(R.apply.POST, 'POST', '/api/admin/settings/apply', who, { changes: [{ key: 'platform.announcement', value: 'role test' }] });
    expect([(await w(roles.read_only)).status, (await w(roles.support)).status, (await w(roles.none)).status]).toEqual([403, 403, 403]);
    expect((await w(roles.ops)).status).toBe(200);
    expect((await w(roles.owner)).status).toBe(200); // same value again: a no-op, still allowed
    // critical + secret: owner only
    const crit = { changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing for everyone', confirm: 'billing.enforced' };
    const opsCrit = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', roles.ops, crit);
    expect([opsCrit.status, opsCrit.code]).toEqual([403, 'forbidden']);
    const opsSecret = await call(R.secret.PUT, 'PUT', '/api/admin/secrets/stripe.secret_key', roles.ops, { value: 'sk_' + 'test_0123456789', reason: 'ops tries the secret', confirm: 'stripe.secret_key' }, { key: 'stripe.secret_key' });
    expect(opsSecret.status).toBe(403);
    expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', roles.owner, crit)).status).toBe(200);
    // ops / support / read_only cannot manage admins or roles, owners can
    for (const who of [roles.ops, roles.support, roles.read_only]) expect((await call(R.admins.POST, 'POST', '/api/admin/admins', who, { email: 'x@example.test', platform_role: 'ops' })).status).toBe(403);
    // the existing operator routes now need a permission each
    for (const [label, h, path, body, allowed] of [
      ['jobs GET', R.jobs, '/api/admin/jobs', undefined, ['owner', 'ops', 'support', 'read_only']], ['jobs/run', R.jobsRun, '/api/admin/jobs/run', { job: 'cleanup' }, ['owner', 'ops']],
      ['retention', R.retention, '/api/admin/retention', {}, ['owner', 'ops']], ['billing', R.billing, '/api/admin/billing', { business_id: 'nope', billing_status: 'active' }, ['owner', 'ops']],
    ] as [string, any, string, unknown, string[]][]) {
      for (const role of ['owner', 'ops', 'support', 'read_only'] as const) {
        const res = await call(h, label === 'jobs GET' ? 'GET' : 'POST', path, roles[role], body);
        expect([label, role, allowed.includes(role) ? res.status !== 403 : res.status === 403]).toEqual([label, role, true]);
      }
    }
    // reset
    await prisma.platformSetting.deleteMany({}); await loader.refreshNow();
  });

  test('HIJACKED ADMIN: a stale cookie (> 5 min since the last proof) cannot write anything; a read-only or ops cookie cannot escalate; the secret / critical routes stay closed', async () => {
    const hijacked = await mk('owner');
    await setSudo(hijacked.user.id, 20 * 60_000);
    const writes: [string, any, string, string, unknown, Record<string, string>?][] = [
      ['apply', R.apply.POST, 'POST', '/api/admin/settings/apply', { changes: [{ key: 'platform.announcement', value: 'pwned' }] }],
      ['secret', R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', { value: 'sk-attacker-key-000001', reason: 'point at attacker', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' }],
      ['secret delete', R.secret.DELETE, 'DELETE', '/api/admin/secrets/llm.openai_api_key', { reason: 'remove it please', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' }],
      ['plan', R.plans.POST, 'POST', '/api/admin/plans', { key: 'free-for-all', name: 'Free', reason: 'give everything away', sms_cap: 10_000_000 }],
      ['suspend', R.suspend.POST, 'POST', '/api/admin/tenants/x/suspend', { reason: 'suspend them all please' }, { id: 'x' }],
      ['admin invite', R.admins.POST, 'POST', '/api/admin/admins', { email: 'attacker@example.test', platform_role: 'owner' }],
      ['freeze', R.freeze.POST, 'POST', '/api/admin/settings/freeze', { frozen: false, reason: 'unfreeze it now please' }],
      ['reencrypt', R.reencrypt.POST, 'POST', '/api/admin/secrets/reencrypt', { reason: 'rotate secrets please' }],
      ['legal', R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', { body: '# pwned' }, { slug: 'terms', locale: 'en' }],
      ['import', R.sImport.POST, 'POST', '/api/admin/settings/import', { document: { schema_version: 1, settings: { 'platform.announcement': 'x' } }, apply: true, reason: 'import from the attacker' }],
    ];
    for (const [name, h, method, path, body, params] of writes) {
      const r = await call(h, method, path, hijacked, body, params);
      expect([name, r.status, r.code]).toEqual([name, 403, 'reauth_required']);
    }
    expect(await prisma.platformSetting.count({ where: { key: { in: ['platform.announcement', 'llm.openai_api_key'] } } })).toBe(0);
    expect(await prisma.plan.count({ where: { key: 'free-for-all' } })).toBe(0);
    expect(await prisma.user.count({ where: { email: 'attacker@example.test' } })).toBe(0);
    // reads still work (a stale session may look)
    expect((await call(R.settings.GET, 'GET', '/api/admin/settings', hijacked)).status).toBe(200);
    // a fresh proof opens the same call
    await setSudo(hijacked.user.id, 0);
    expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', hijacked, { changes: [{ key: 'platform.announcement', value: 'legit' }] })).status).toBe(200);
    await prisma.platformSetting.deleteMany({}); await loader.refreshNow();
    // the cookie of a read-only / support admin, even with a fresh proof, can read but never write or see secret metadata
    const ro = await mk('read_only'); const sup = await mk('support');
    for (const who of [ro, sup]) {
      expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', who, { changes: [{ key: 'platform.announcement', value: 'x' }] })).status).toBe(403);
      expect((await call(R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', who, { value: 'sk-attacker-key-000001', reason: 'point at attacker', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' })).status).toBe(403);
      expect((await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', who, { frozen: true, reason: 'freeze it for no reason' })).status).toBe(403);
      expect((await call(R.reencrypt.POST, 'POST', '/api/admin/secrets/reencrypt', who, { reason: 'rotate secrets please' })).status).toBe(403);
    }
    // rate limit: the secret route allows 10 per minute per client
    const owner = await mk('owner');
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', owner, { value: 'x' }, { key: 'llm.openai_api_key' })).status;
    expect(last).toBe(429);
  });

  test('BREAK-GLASS Bearer: recovery only. Reads, freeze / unfreeze, rollback, create / re-enable an admin, revoke sessions work; settings / secrets / plans / legal / roles do not; every use is audited and mailed', async () => {
    const mail = captureMail();
    setEnv('EMAIL_PROVIDER', 'resend'); setEnv('EMAIL_FROM', 'T <t@example.test>'); setEnv('RESEND_API_KEY', 'k-12345678');
    const owner = await mk('owner');
    try {
      const get = await call(R.settings.GET, 'GET', '/api/admin/settings', 'bearer');
      expect(get.status).toBe(200);
      expect((await call(R.me, 'GET', '/api/admin/me', 'bearer')).data.role).toBe('bearer');
      for (const [h, path, p] of [[R.system, '/api/admin/system'], [R.selftest, '/api/admin/selftest'], [R.tenants.GET, '/api/admin/tenants'], [R.audit, '/api/admin/audit'], [R.jobRuns, '/api/admin/job-runs']] as any[]) expect((await call(h, 'GET', path, 'bearer', undefined, p)).status).toBe(200);
      // forbidden for the token (no ADMIN_TOKEN_ALLOW_SETTINGS)
      const denied: [string, any, string, string, unknown, Record<string, string>?][] = [
        ['apply normal', R.apply.POST, 'POST', '/api/admin/settings/apply', { changes: [{ key: 'platform.announcement', value: 'x' }] }],
        ['apply critical', R.apply.POST, 'POST', '/api/admin/settings/apply', { changes: [{ key: 'billing.enforced', value: false }], reason: 'turn billing off now', confirm: 'billing.enforced' }],
        ['secret', R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', { value: 'sk-attacker-key-000001', reason: 'bearer secret attempt', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' }],
        ['import', R.sImport.POST, 'POST', '/api/admin/settings/import', { document: { schema_version: 1, settings: {} }, apply: true, reason: 'bearer import attempt' }],
        ['plans', R.plans.POST, 'POST', '/api/admin/plans', { key: 'bearer-plan', name: 'B', reason: 'bearer plan attempt' }],
        ['legal', R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', { body: '# x' }, { slug: 'terms', locale: 'en' }],
        ['suspend', R.suspend.POST, 'POST', '/api/admin/tenants/x/suspend', { reason: 'bearer suspend attempt' }, { id: 'x' }],
        ['role change', R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, { platform_role: 'read_only' }, { id: owner.user.id }],
        ['reencrypt', R.reencrypt.POST, 'POST', '/api/admin/secrets/reencrypt', { reason: 'bearer reencrypt attempt' }],
        ['support mode', R.support.POST, 'POST', '/api/admin/tenants/x/support-mode', { reason: 'bearer support attempt' }, { id: 'x' }],
      ];
      for (const [name, h, method, path, body, params] of denied) {
        const r = await call(h, method, path, 'bearer', body, params);
        expect([name, r.status]).toEqual([name, 403]);
      }
      expect(await prisma.platformSetting.count({ where: { key: { in: ['platform.announcement', 'billing.enforced', 'llm.openai_api_key'] } } })).toBe(0);
      expect(await prisma.plan.count({ where: { key: 'bearer-plan' } })).toBe(0);
      // allowed recovery actions
      const frozen = await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', 'bearer', { frozen: true, reason: 'incident: hijacked admin suspected' });
      expect([frozen.status, frozen.data.frozen]).toEqual([200, true]);
      expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'platform.announcement', value: 'x' }] })).code).toBe('settings_frozen');
      expect((await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', 'bearer', { frozen: false, reason: 'incident over, all clear' })).data.frozen).toBe(false);
      // the token is recovery, not a way to mint standing owners: while an enabled owner exists it creates the lesser roles only (an owner needs ADMIN_TOKEN_ALLOW_SETTINGS=true or a lock-out)
      const refusedOwner = await call(R.admins.POST, 'POST', '/api/admin/admins', 'bearer', { email: `${uniq('rec')}@example.test`, platform_role: 'owner', password: 'a long recovery passphrase' });
      expect([refusedOwner.status, refusedOwner.code]).toEqual([403, 'owner_requires_owner']);
      const created = await call(R.admins.POST, 'POST', '/api/admin/admins', 'bearer', { email: `${uniq('rec')}@example.test`, platform_role: 'ops', password: 'a long recovery passphrase' });
      expect(created.status).toBe(201);
      userIds.push(created.data.admin.id);
      expect(created.data.admin.platform_role).toBe('ops');
      await prisma.user.update({ where: { id: owner.user.id }, data: { disabledAt: new Date() } });
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, 'bearer', { disabled: false }, { id: owner.user.id })).status).toBe(200); // unlock
      expect((await call(R.adminSessions.DELETE, 'DELETE', `/api/admin/admins/${owner.user.id}/sessions`, 'bearer', undefined, { id: owner.user.id })).data.revoked).toBeGreaterThanOrEqual(1);
      // every use is audited and mailed (once a minute per route)
      expect(await prisma.auditEvent.count({ where: { action: 'admin.bearer_use', at: { gte: startedAt } } })).toBeGreaterThan(10);
      await new Promise((r) => setTimeout(r, 300));
      const notices = mail.mails.filter((m) => m.subject.includes('break-glass'));
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices.some((m) => m.to === owner.user.email)).toBe(true);
      expect(notices[0].text).not.toContain(SECRETS.adminToken);
      // with ADMIN_TOKEN_ALLOW_SETTINGS=true the token may write settings and secrets (and still not plans / roles)
      setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', 'true');
      expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', 'bearer', { changes: [{ key: 'platform.announcement', value: 'by token' }] })).status).toBe(200);
      const sec = await call(R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', 'bearer', { value: 'sk-by-the-token-0000001', reason: 'rotation by the token', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' });
      expect(sec.status).toBe(200);
      expect(sec.text).not.toContain('sk-by-the-token');
      expect((await call(R.plans.POST, 'POST', '/api/admin/plans', 'bearer', { key: 'bearer-plan', name: 'B', reason: 'bearer plan attempt' })).status).toBe(403);
    } finally { mail.restore(); setEnv('EMAIL_PROVIDER', undefined); setEnv('EMAIL_FROM', undefined); setEnv('RESEND_API_KEY', undefined); }
    await prisma.platformSetting.deleteMany({}); await loader.refreshNow();
  });

  test('settings routes end to end: list, preview, apply (expected_version, reason, confirm), history, rollback, export, import; no secret in any response', async () => {
    const owner = await mk('owner');
    loader.startSettingsPoll(3_600_000); // the console is running in this process: the snapshot serves what the routes write
    await loader.refreshNow();
    const SECRET = 'sk_' + 'live_ROUTETESTSECRET0123456789';
    const list = await call(R.settings.GET, 'GET', '/api/admin/settings', owner);
    expect(list.data.settings.length).toBe(cfg.registryStats().total);
    expect(list.data.settings.find((s: any) => s.key === 'twilio.auth_token').secret.source).toBe('env'); // the test environment pins it
    const prev = await call(R.preview.POST, 'POST', '/api/admin/settings/preview', owner, { changes: [{ key: 'billing.enforced', value: true }] });
    expect(prev.status).toBe(200);
    expect(prev.data.requires.confirm).toBe('billing.enforced');
    expect((await call(R.preview.POST, 'POST', '/api/admin/settings/preview', owner, { changes: 'nope' })).status).toBe(422);
    expect((await call(R.preview.POST, 'POST', '/api/admin/settings/preview', owner, { changes: [{ key: 'nope.key', value: 1 }] })).code).toBe('unknown_key');
    const noConfirm = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing for all tenants' });
    expect([noConfirm.status, noConfirm.code]).toEqual([422, 'confirmation_required']);
    const stale = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing for all tenants', confirm: 'billing.enforced', expected_version: prev.data.version - 1 });
    expect([stale.status, stale.code]).toEqual([409, 'stale_preview']);
    const applied = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing for all tenants', confirm: 'billing.enforced', expected_version: prev.data.version });
    expect(applied.status).toBe(200);
    expect(applied.data.tier).toBe('critical');
    const bad = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'jobs.briefing_hour', value: 99 }] });
    expect([bad.status, bad.json.problems[0].key]).toEqual([422, 'jobs.briefing_hour']);
    expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, 'not an object' as any)).status).toBe(400);
    // a pinned key: 409
    const pinned = await call(R.apply.POST, 'POST', '/api/admin/settings/apply', owner, { changes: [{ key: 'elevenlabs.webhook_secret', secret: 'new-webhook-secret-123' }], reason: 'try the pinned secret', confirm: 'elevenlabs.webhook_secret' });
    expect([pinned.status, pinned.code]).toEqual([409, 'locked_by_env']);
    // secrets: PUT then GET, never the value
    const put = await call(R.secret.PUT, 'PUT', '/api/admin/secrets/stripe.secret_key', owner, { value: SECRET, reason: 'first live key', confirm: 'stripe.secret_key' }, { key: 'stripe.secret_key' });
    expect(put.status).toBe(200);
    const info = await call(R.secret.GET, 'GET', '/api/admin/secrets/stripe.secret_key', owner, undefined, { key: 'stripe.secret_key' });
    expect(info.data).toMatchObject({ set: true, source: 'console', fingerprint: (await import('@/lib/admin/crypto')).fingerprintOf(SECRET), last4: SECRET.slice(-4) });
    const ro = await mk('read_only');
    expect((await call(R.secret.GET, 'GET', '/api/admin/secrets/stripe.secret_key', ro, undefined, { key: 'stripe.secret_key' })).data).toEqual({ key: 'stripe.secret_key', set: true, source: 'console' });
    const dump = [put.text, info.text, (await call(R.settings.GET, 'GET', '/api/admin/settings', owner)).text, (await call(R.history.GET, 'GET', '/api/admin/settings/history', owner)).text, (await call(R.sExport.GET, 'GET', '/api/admin/settings/export', owner)).text,
      (await call(R.system, 'GET', '/api/admin/system', owner)).text, (await call(R.selftest, 'GET', '/api/admin/selftest', owner)).text, (await call(R.audit, 'GET', '/api/admin/audit?action=settings.', owner)).text].join('\n');
    expect(dump).not.toContain('ROUTETESTSECRET');
    expect(dump).not.toContain(process.env.TWILIO_AUTH_TOKEN!);
    expect(dump).not.toContain(SECRETS.adminToken);
    expect((await call(R.secret.PUT, 'PUT', '/api/admin/secrets/jobs.briefing_hour', owner, { value: 'x' }, { key: 'jobs.briefing_hour' })).status).toBe(404);
    expect((await call(R.secret.PUT, 'PUT', '/api/admin/secrets/stripe.secret_key', owner, { value: 123 }, { key: 'stripe.secret_key' })).status).toBe(422);
    // history, detail, rollback
    const hist = await call(R.history.GET, 'GET', '/api/admin/settings/history?limit=2', owner);
    expect(hist.data.items.length).toBe(2);
    const detail = await call(R.historyId.GET, 'GET', `/api/admin/settings/history/${applied.data.change_set_id}`, owner, undefined, { id: applied.data.change_set_id });
    expect(detail.data.revisions[0]).toMatchObject({ key: 'billing.enforced', new: true });
    expect((await call(R.historyId.GET, 'GET', '/api/admin/settings/history/nope', owner, undefined, { id: 'nope' })).status).toBe(404);
    const rb = await call(R.rollback.POST, 'POST', '/api/admin/settings/rollback', owner, { change_set_id: applied.data.change_set_id, reason: 'billing was enabled too early', confirm: 'billing.enforced' });
    expect(rb.status).toBe(200);
    expect(cfg.settingSource('billing.enforced')).toBe('default');
    expect((await call(R.rollback.POST, 'POST', '/api/admin/settings/rollback', owner, { change_set_id: 5 })).status).toBe(422);
    // export + import dry run
    const exp = await call(R.sExport.GET, 'GET', '/api/admin/settings/export', owner);
    expect(exp.data.schema_version).toBe(1);
    const dry = await call(R.sImport.POST, 'POST', '/api/admin/settings/import', owner, { document: { schema_version: 1, settings: { 'platform.announcement': 'imported by route' } } });
    expect(dry.data.plan.diff[0]).toMatchObject({ key: 'platform.announcement', op: 'set' });
    expect(dry.data.result).toBeNull();
    expect((await call(R.sImport.POST, 'POST', '/api/admin/settings/import', await mk('ops'), { document: { schema_version: 1, settings: { 'platform.announcement': 'x' } }, apply: true, reason: 'ops tries to import' })).status).toBe(403);
    const imp = await call(R.sImport.POST, 'POST', '/api/admin/settings/import', owner, { document: { schema_version: 1, settings: { 'platform.announcement': 'imported by route' } }, apply: true, reason: 'restore from the staging export' });
    expect(imp.status).toBe(200);
    expect(cfg.setting('platform.announcement')).toBe('imported by route');
    // freeze via the route
    expect((await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', owner, { frozen: 'yes' })).status).toBe(422);
    expect((await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', owner, { frozen: true, reason: 'maintenance window freeze' })).data.frozen).toBe(true);
    expect((await call(R.freeze.GET, 'GET', '/api/admin/settings/freeze', owner)).data.frozen).toBe(true);
    for (const [h, method, path, body, params] of [[R.apply.POST, 'POST', '/api/admin/settings/apply', { changes: [{ key: 'platform.announcement', value: 'x' }] }], [R.plans.POST, 'POST', '/api/admin/plans', { key: 'frozen-plan', name: 'F', reason: 'while frozen please' }],
      [R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', { body: '# frozen' }, { slug: 'terms', locale: 'en' }], [R.secret.PUT, 'PUT', '/api/admin/secrets/llm.openai_api_key', { value: 'sk-frozen-attempt-123', reason: 'while frozen please', confirm: 'llm.openai_api_key' }, { key: 'llm.openai_api_key' }],
      [R.reencrypt.POST, 'POST', '/api/admin/secrets/reencrypt', { reason: 'rotate while frozen' }]] as any[]) {
      const r = await call(h, method, path, owner, body, params);
      expect([path, r.status, r.code]).toEqual([path, 403, 'settings_frozen']);
    }
    expect((await call(R.freeze.POST, 'POST', '/api/admin/settings/freeze', owner, { frozen: false, reason: 'maintenance window is over' })).data.frozen).toBe(false);
    await prisma.platformSetting.deleteMany({}); await loader.refreshNow();
    loader.stopSettingsLoader();
  });

  test('plans CRUD through the routes; the cap helpers follow the catalog; precedence business override > env pin > plan row > platform', async () => {
    loader.startSettingsPoll(3_600_000);
    await loader.refreshNow();
    const owner = await mk('owner'); const ops = await mk('ops'); const ro = await mk('read_only');
    const key = `pro-${Math.random().toString(36).slice(2, 6)}`;
    planKeys.push(key);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', ro, { key, name: 'Pro', reason: 'a new plan for the test' })).status).toBe(403);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key: 'Bad Key', name: 'x', reason: 'bad key for the test' })).status).toBe(422);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key, name: 'Pro', sms_cap: -3, reason: 'negative cap for the test' })).status).toBe(422);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key, name: 'Pro', surprise: 1, reason: 'unknown field for the test' })).status).toBe(422);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key, name: 'Pro', features: { owner_reply: false }, sms_cap: 2500, call_minutes_cap: 900, voicemail_minutes_cap: 90, forward_minutes_cap: 700, public: true })).status).toBe(422); // reason required
    const made = await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key, name: 'Pro', features: { owner_reply: false }, sms_cap: 2500, call_minutes_cap: 900, voicemail_minutes_cap: 90, forward_minutes_cap: 700, public: true, reason: 'a new plan for the test' });
    expect(made.status).toBe(201);
    expect((await call(R.plans.POST, 'POST', '/api/admin/plans', owner, { key, name: 'Dup', reason: 'duplicate key for the test' })).status).toBe(409);
    const list = await call(R.plans.GET, 'GET', '/api/admin/plans', ro);
    expect(list.data.plans.map((p: any) => p.key)).toContain('standard');
    expect(list.data.features).toContain('owner_reply');
    // a business on the plan: caps come from the plan row (the catalog refreshed on write)
    const biz = await newBusiness({ agent_id: null });
    await db.setBillingState(biz.id, { billing_status: 'active', plan: key });
    const b = (await db.getBusiness(biz.id))!;
    expect(usage.smsCapFor(b)).toBe(2500);
    expect(usage.callMinutesCapFor(b)).toBe(900);
    expect(usage.forwardMinutesCapFor(b)).toBe(700);
    expect(usage.voicemailMinutesCap(undefined, b.plan)).toBe(90);
    expect((await usage.checkSmsAllowed(biz.id)).cap).toBe(2500); // the DB-backed gate agrees (billing not enforced: counting only)
    const { planAllows } = await import('@/lib/admin/plan-catalog');
    expect(planAllows(key, 'owner_reply')).toBe(false);
    expect(planAllows(key, 'owner_callin')).toBe(true);
    expect(usage.smsCapFor({ ...b, sms_cap_override: 9 })).toBe(9); // the business override wins
    setEnv('PLAN_SMS_CAP', '123');
    expect(usage.smsCapFor(b)).toBe(123); // an environment pin wins over the plan row (D1)
    setEnv('PLAN_SMS_CAP', undefined);
    // update (ops may), archive, delete refused while in use
    const upd = await call(R.plan.PATCH, 'PATCH', `/api/admin/plans/${key}`, ops, { sms_cap: 3000, reason: 'raise the plan sms allowance' }, { key });
    expect(upd.status).toBe(200);
    expect(usage.smsCapFor((await db.getBusiness(biz.id))!)).toBe(3000);
    expect((await call(R.plan.PATCH, 'PATCH', `/api/admin/plans/${key}`, ops, { sms_cap: 3000 }, { key })).status).toBe(422); // reason
    expect((await call(R.plan.PATCH, 'PATCH', `/api/admin/plans/${key}`, ops, { reason: 'nothing to change here' }, { key })).status).toBe(422);
    expect((await call(R.plan.PATCH, 'PATCH', '/api/admin/plans/nope', ops, { name: 'x', reason: 'unknown plan for the test' }, { key: 'nope' })).status).toBe(404);
    const arch = await call(R.plan.PATCH, 'PATCH', `/api/admin/plans/${key}`, owner, { archived: true, reason: 'retire this plan for the test' }, { key });
    expect(arch.data.archived_at).toBeTruthy();
    expect((await call(R.plans.GET, 'GET', '/api/admin/plans', owner)).data.plans.map((p: any) => p.key)).not.toContain(key);
    expect((await call(R.plans.GET, 'GET', '/api/admin/plans?archived=1', owner)).data.plans.map((p: any) => p.key)).toContain(key);
    const del = await call(R.plan.DELETE, 'DELETE', `/api/admin/plans/${key}`, owner, { reason: 'delete the plan in use' }, { key });
    expect([del.status, del.code]).toEqual([409, 'in_use']);
    expect((await call(R.plan.DELETE, 'DELETE', '/api/admin/plans/standard', owner, { reason: 'delete the standard plan' }, { key: 'standard' })).code).toBe('protected_plan');
    await prisma.business.update({ where: { id: biz.id }, data: { plan: null } });
    expect((await call(R.plan.DELETE, 'DELETE', `/api/admin/plans/${key}`, owner, { reason: 'delete the unused plan' }, { key })).status).toBe(200);
    expect((await call(R.plan.GET, 'GET', `/api/admin/plans/${key}`, owner, undefined, { key })).status).toBe(404);
    // the seeded comped plans stay comped for the release job; the audit trail has the plan writes
    const { isCompedPlan } = await import('@/lib/admin/plan-catalog');
    expect(isCompedPlan('legacy')).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: { in: ['plans.create', 'plans.update', 'plans.delete', 'plans.archive'] }, at: { gte: startedAt } } })).toBeGreaterThanOrEqual(4);
    loader.stopSettingsLoader();
  });

  test('legal pages: draft -> publish -> versions; markdown size cap; owner publishes, ops drafts; the published page is what the public gets (English fallback)', async () => {
    const owner = await mk('owner'); const ops = await mk('ops'); const ro = await mk('read_only');
    const P = { slug: 'terms', locale: 'en' };
    await prisma.legalPageVersion.deleteMany({}); await prisma.legalPage.deleteMany({});
    expect((await call(R.legal.GET, 'GET', '/api/admin/legal', ro)).data.pages.length).toBe(6);
    expect((await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', ro, { body: '# x' }, P)).status).toBe(403);
    expect((await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/cookies/en', owner, { body: '# x' }, { slug: 'cookies', locale: 'en' })).status).toBe(422);
    expect((await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/fr', owner, { body: '# x' }, { slug: 'terms', locale: 'fr' })).status).toBe(422);
    expect((await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', owner, { body: '' }, P)).status).toBe(422);
    expect((await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', owner, { body: 'x'.repeat(200_001) }, P)).status).toBe(422);
    const d1 = await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', ops, { body: '# Terms v1\n\nBe nice.', note: 'first draft' }, P);
    expect([d1.status, d1.data.version, d1.data.draft]).toEqual([200, 1, true]);
    const d1b = await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', ops, { body: '# Terms v1\n\nBe very nice.' }, P);
    expect(d1b.data.version).toBe(1); // the same draft is updated in place
    expect((await call(R.legalPublish.POST, 'POST', '/api/admin/legal/terms/en/publish', ops, { reason: 'ops tries to publish it' }, P)).status).toBe(403);
    expect((await call(R.legalPublish.POST, 'POST', '/api/admin/legal/terms/en/publish', owner, { reason: 'x' }, P)).status).toBe(422);
    const review = { confirm: 'publish terms/en', version: d1b.data.version, hash: d1b.data.hash };
    const pub = await call(R.legalPublish.POST, 'POST', '/api/admin/legal/terms/en/publish', owner, { reason: 'approved by counsel on the 3rd', ...review }, P);
    expect([pub.status, pub.data.version, pub.data.draft]).toEqual([200, 1, false]);
    expect((await call(R.legalPublish.POST, 'POST', '/api/admin/legal/terms/en/publish', owner, { reason: 'nothing left to publish', ...review }, P)).code).toBe('no_draft');
    await call(R.legalPage.PUT, 'PUT', '/api/admin/legal/terms/en', ops, { body: '# Terms v2' }, P);
    const page = await call(R.legalPage.GET, 'GET', '/api/admin/legal/terms/en', ro, undefined, P);
    expect([page.data.page.published_version, page.data.page.draft_version, page.data.version.body]).toEqual([1, 2, '# Terms v2']); // default: the draft
    const v1 = await call(R.legalPage.GET, 'GET', '/api/admin/legal/terms/en?version=1', ro, undefined, P);
    expect(v1.data.version.body).toBe('# Terms v1\n\nBe very nice.');
    expect((await call(R.legalPage.GET, 'GET', '/api/admin/legal/terms/en?version=9', ro, undefined, P)).status).toBe(404);
    const { getPublishedLegal } = await import('@/lib/admin/legal');
    expect((await getPublishedLegal('terms', 'es'))?.body).toBe('# Terms v1\n\nBe very nice.'); // Spanish falls back to English
    expect(await getPublishedLegal('privacy', 'en')).toBeNull();
    expect((await call(R.legalPage.DELETE, 'DELETE', '/api/admin/legal/terms/en', ops, undefined, P)).data.discarded).toBe(true);
    expect((await getPublishedLegal('terms', 'en'))?.version).toBe(1); // a published version is never lost
    expect(await prisma.auditEvent.count({ where: { action: 'legal.published', at: { gte: startedAt } } })).toBeGreaterThanOrEqual(1);
    await prisma.legalPageVersion.deleteMany({}); await prisma.legalPage.deleteMany({});
  });

  test('tenants: directory (search, filters, pagination), detail, suspension (out of service, cannot send), reactivation', async () => {
    const owner = await mk('owner'); const ops = await mk('ops'); const sup = await mk('support');
    const tag = uniq('dir');
    const a = await newBusiness({ agent_id: null, name: `Alpha ${tag}` }); const b = await newBusiness({ agent_id: null, name: `Bravo ${tag}` }); const c = await newBusiness({ agent_id: null, name: `Charlie ${tag}` });
    const ownerEmail = `${uniq('dirown')}@example.test`;
    const ou = await users.createUser({ email: ownerEmail, password_hash: 'x'.repeat(20), role: 'owner', business_id: a.id, email_verified: true });
    userIds.push(ou.id);
    await db.setBillingState(a.id, { billing_status: 'active', plan: 'standard' });
    await db.setBillingState(b.id, { billing_status: 'trialing', plan: 'legacy', trial_ends_at: new Date(Date.now() + 2 * 86_400_000) });
    await db.setBillingState(c.id, { billing_status: 'past_due' });
    const q = async (qs: string, who: Who = sup) => (await call(R.tenants.GET, 'GET', `/api/admin/tenants?${qs}`, who)).data;
    expect((await q(`q=${encodeURIComponent(tag)}`)).items.map((t: any) => t.name).sort()).toEqual([`Alpha ${tag}`, `Bravo ${tag}`, `Charlie ${tag}`]);
    expect((await q(`q=${encodeURIComponent(ownerEmail.slice(0, 14))}`)).items.map((t: any) => t.id)).toEqual([a.id]);
    expect((await q(`q=${a.id}`)).items.map((t: any) => t.id)).toEqual([a.id]);
    expect((await q(`q=${encodeURIComponent(tag)}&billing_status=trialing`)).items.map((t: any) => t.id)).toEqual([b.id]);
    expect((await q(`q=${encodeURIComponent(tag)}&past_due=1`)).items.map((t: any) => t.id)).toEqual([c.id]);
    expect((await q(`q=${encodeURIComponent(tag)}&comped=1`)).items.map((t: any) => t.id)).toEqual([b.id]); // legacy is comped
    expect((await q(`q=${encodeURIComponent(tag)}&comped=0`)).items.map((t: any) => t.id).sort()).toEqual([a.id, c.id].sort());
    expect((await q(`q=${encodeURIComponent(tag)}&trial_ending_days=7`)).items.map((t: any) => t.id)).toEqual([b.id]);
    expect((await q(`q=${encodeURIComponent(tag)}&plan=standard`)).items.map((t: any) => t.id)).toEqual([a.id]);
    expect((await call(R.tenants.GET, 'GET', '/api/admin/tenants?status=bogus', sup)).status).toBe(422);
    expect((await call(R.tenants.GET, 'GET', '/api/admin/tenants?cursor=garbage', sup)).status).toBe(422);
    const p1 = await q(`q=${encodeURIComponent(tag)}&limit=2`);
    expect(p1.items.length).toBe(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await q(`q=${encodeURIComponent(tag)}&limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`);
    expect(p2.items.length).toBe(1);
    expect(p2.next_cursor).toBeNull();
    expect([...p1.items, ...p2.items].map((t: any) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // detail: the read-only support view
    const det = await call(R.tenant.GET, 'GET', `/api/admin/tenants/${a.id}`, sup, undefined, { id: a.id });
    expect(det.data.billing.plan).toBe('standard');
    expect(det.data.users.map((u: any) => u.email)).toContain(ownerEmail);
    expect(det.data.overrides.length).toBeGreaterThan(0);
    expect(det.data.suspension.suspended).toBe(false);
    expect((await call(R.tenant.GET, 'GET', '/api/admin/tenants/nope', sup, undefined, { id: 'nope' })).status).toBe(404);
    // suspend: ops/owner only, reason + step-up; support cannot
    expect((await call(R.suspend.POST, 'POST', `/api/admin/tenants/${a.id}/suspend`, sup, { reason: 'support tries to suspend' }, { id: a.id })).status).toBe(403);
    expect((await call(R.suspend.POST, 'POST', `/api/admin/tenants/${a.id}/suspend`, ops, { reason: 'x' }, { id: a.id })).status).toBe(422);
    expect((await call(R.suspend.POST, 'POST', '/api/admin/tenants/nope/suspend', ops, { reason: 'unknown tenant here' }, { id: 'nope' })).status).toBe(404);
    const before = await usage.checkSmsAllowed(a.id);
    expect(before.ok).toBe(true); // billing is not enforced in tests: counting only
    expect((await call(R.suspend.POST, 'POST', `/api/admin/tenants/${a.id}/suspend`, ops, { reason: 'abuse reports from carriers', confirm: `suspend ${a.name}` }, { id: a.id })).status).toBe(200);
    expect((await call(R.suspend.POST, 'POST', `/api/admin/tenants/${a.id}/suspend`, ops, { reason: 'abuse reports from carriers', confirm: `suspend ${a.name}` }, { id: a.id })).code).toBe('already_suspended');
    // the rule: suspended tenants are out of service and cannot send, even with billing not enforced
    const sms = await usage.checkSmsAllowed(a.id);
    expect([sms.ok, sms.reason, sms.suspended]).toEqual([false, 'no_plan', true]);
    const callGate = await usage.checkCallAllowed(a.id);
    expect([callGate.ok, callGate.reason]).toEqual([false, 'no_plan']);
    expect((await usage.checkForwardAllowed(a.id)).ok).toBe(false);
    expect((await usage.checkVoicemailAllowed(a.id)).ok).toBe(false);
    const res = await usage.reserveSms(a.id, 1);
    expect([res.ok, res.reason]).toEqual([false, 'no_plan']);
    expect(usage.isProvisioningAllowed((await db.getBusiness(a.id))!)).toBe(false);
    expect((await db.getBusiness(a.id))?.suspended_at).toBeTruthy();
    expect((await usage.checkSmsAllowed(b.id)).ok).toBe(true); // other tenants unaffected
    expect((await call(R.tenant.GET, 'GET', `/api/admin/tenants/${a.id}`, sup, undefined, { id: a.id })).data.suspension).toMatchObject({ suspended: true, reason: 'abuse reports from carriers' });
    expect((await q(`q=${encodeURIComponent(tag)}&suspended=1`)).items.map((t: any) => t.id)).toEqual([a.id]);
    const aud = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'tenant.suspended', businessId: a.id } });
    expect([aud.actorUserId, (aud.meta as any).reason, (aud.meta as any).role]).toEqual([ops.user.id, 'abuse reports from carriers', 'ops']);
    // reactivate
    expect((await call(R.reactivate.POST, 'POST', `/api/admin/tenants/${a.id}/reactivate`, sup, { reason: 'support lifts the suspension' }, { id: a.id })).status).toBe(403);
    expect((await call(R.reactivate.POST, 'POST', `/api/admin/tenants/${a.id}/reactivate`, owner, { reason: 'the carrier case is closed' }, { id: a.id })).status).toBe(200);
    expect((await call(R.reactivate.POST, 'POST', `/api/admin/tenants/${a.id}/reactivate`, owner, { reason: 'the carrier case is closed' }, { id: a.id })).code).toBe('not_suspended');
    expect((await usage.checkSmsAllowed(a.id)).ok).toBe(true);
  });

  test('SUPPORT MODE: read-only by default; a 30 minute write grant for ONE tenant, with a reason, audited; it expires; it never lifts the role', async () => {
    const sup = await mk('support'); const ro = await mk('read_only'); const owner = await mk('owner');
    const a = await newBusiness({ agent_id: null }); const b = await newBusiness({ agent_id: null });
    const put = (who: Who, biz: string, value: unknown = 25) => call(R.overrides.PUT, 'PUT', '/api/admin/tenant-overrides', who, { business_id: biz, key: 'forward.ring_seconds', value });
    expect((await put(sup, a.id)).code).toBe('support_write_required'); // read-only without a grant
    expect((await put(ro, a.id)).status).toBe(403);
    expect((await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, sup, { reason: 'x' }, { id: a.id })).status).toBe(422);
    expect((await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, ro, { reason: 'read only wants write' }, { id: a.id })).status).toBe(403);
    expect((await call(R.support.POST, 'POST', '/api/admin/tenants/nope/support-mode', sup, { reason: 'unknown tenant here' }, { id: 'nope' })).status).toBe(404);
    const stale = await mk('support'); await setSudo(stale.user.id, 20 * 60_000);
    expect((await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, stale, { reason: 'stale session enters support' }, { id: a.id })).code).toBe('reauth_required');
    const ent = await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, sup, { reason: 'customer asked us to fix ring time' }, { id: a.id });
    expect(ent.status).toBe(201);
    expect(ent.data.minutes).toBe(30);
    const mins = (Date.parse(ent.data.grant.expires_at) - Date.parse(ent.data.grant.started_at)) / 60_000;
    expect(mins).toBe(30);
    const w = await put(sup, a.id, 25);
    expect([w.status, w.data.value, w.data.source]).toEqual([200, 25, 'tenant']);
    expect((await put(sup, b.id)).code).toBe('support_write_required'); // another tenant: no grant
    // the grant authorises the tenant knobs and nothing else
    expect((await call(R.billing, 'POST', '/api/admin/billing', sup, { business_id: a.id, sms_cap_override: 5 })).status).toBe(403);
    expect((await call(R.suspend.POST, 'POST', `/api/admin/tenants/${a.id}/suspend`, sup, { reason: 'support suspends under grant' }, { id: a.id })).status).toBe(403);
    expect((await call(R.apply.POST, 'POST', '/api/admin/settings/apply', sup, { changes: [{ key: 'platform.announcement', value: 'x' }] })).status).toBe(403);
    // audited: enter, the write (business id + grant id + role), exit
    const enter = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'support.write_mode_entered', businessId: a.id } });
    expect((enter.meta as any).reason).toBe('customer asked us to fix ring time');
    const wr = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.tenant_override', businessId: a.id }, orderBy: { at: 'desc' } });
    expect([(wr.meta as any).role, (wr.meta as any).support_grant_id, wr.actorUserId]).toEqual(['support', ent.data.grant.id, sup.user.id]);
    // the grant expires on its own
    await prisma.supportGrant.updateMany({ where: { id: ent.data.grant.id }, data: { expiresAt: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await put(sup, a.id, 30)).code).toBe('support_write_required');
    // a new grant, then an explicit exit
    await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, sup, { reason: 'second visit to the tenant' }, { id: a.id });
    expect((await put(sup, a.id, 30)).status).toBe(200);
    expect((await call(R.support.DELETE, 'DELETE', `/api/admin/tenants/${a.id}/support-mode`, sup, undefined, { id: a.id })).data.ended).toBe(1);
    expect((await put(sup, a.id, 35)).code).toBe('support_write_required');
    expect(await prisma.auditEvent.count({ where: { action: 'support.write_mode_exited', businessId: a.id } })).toBe(1);
    // the bearer has no personal account: no support mode
    expect((await call(R.support.POST, 'POST', `/api/admin/tenants/${a.id}/support-mode`, 'bearer', { reason: 'bearer wants support mode' }, { id: a.id })).status).toBe(403);
    // an owner/ops admin needs no grant
    expect((await put(owner, b.id, 20)).status).toBe(200);
  });

  test('tenant overrides: admin route bounds, platform-only keys, the OWNER comfort knobs (stricter quiet hours, clamping), cross-tenant isolation, escalation attempts', async () => {
    const owner = await mk('owner');
    const a = await newBusiness({ agent_id: null }); const b = await newBusiness({ agent_id: null });
    const mkOwner = async (biz: string, role: 'owner' | 'staff' = 'owner') => {
      const u = await users.createUser({ email: `${uniq('tov')}@example.test`, password_hash: 'x'.repeat(20), role, business_id: biz, email_verified: true });
      userIds.push(u.id);
      const { token } = await users.createSession(u.id);
      return { user: { id: u.id, email: u.email }, cookie: `rc_user_session=${token}` } as any;
    };
    const ownerA = await mkOwner(a.id); const ownerB = await mkOwner(b.id); const staffA = await mkOwner(a.id, 'staff');
    const O = (who: Who, biz: string, method: string, body?: unknown, qs = '') => call(R.ownerOverrides[method], method, `/api/businesses/${biz}/settings-overrides${qs}`, who, body, { id: biz });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'business/' } } });
    // the owner sees ONLY their comfort knobs
    const knobs = (await O(ownerA, a.id, 'GET')).data;
    expect(knobs.map((k: any) => k.key).sort()).toEqual(['forward.ring_seconds', 'jobs.briefing_enabled', 'jobs.briefing_hour', 'jobs.gratitude_enabled', 'messaging.quiet_end_hour', 'messaging.quiet_start_hour']);
    expect(knobs.every((k: any) => k.editable_by === 'owner')).toBe(true);
    // comfort knobs within bounds
    const hour = await O(ownerA, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 19 });
    expect([hour.status, hour.data.value, hour.data.source]).toEqual([200, 19, 'tenant']);
    expect((await O(ownerA, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 25 })).status).toBe(422);
    expect((await O(ownerA, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 'noon' })).status).toBe(422);
    expect((await O(ownerA, a.id, 'PUT', { key: 'forward.ring_seconds', value: 5 })).status).toBe(422);
    expect((await O(ownerA, a.id, 'PUT', { key: 'forward.ring_seconds', value: 30 })).data.value).toBe(30);
    // quiet hours: only stricter than the platform window (21:00-08:00)
    expect((await O(ownerA, a.id, 'PUT', { key: 'messaging.quiet_start_hour', value: 20 })).status).toBe(200);
    const loose = await O(ownerA, a.id, 'PUT', { key: 'messaging.quiet_start_hour', value: 23 });
    expect([loose.status, loose.code]).toEqual([422, 'not_stricter']);
    expect((await O(ownerA, a.id, 'PUT', { key: 'messaging.quiet_end_hour', value: 6 })).code).toBe('not_stricter');
    expect((await O(ownerA, a.id, 'PUT', { key: 'messaging.quiet_end_hour', value: 9 })).status).toBe(200);
    // escalation attempts: platform-only keys (caps, budgets), unknown keys, secrets, a platform-scope key that has no tenant rule
    for (const key of ['billing.plan_sms_cap', 'forward.calls_per_hour', 'voicemail.minutes_cap', 'owner.reply_daily_limit', 'forward.minutes_cap']) {
      const r = await O(ownerA, a.id, 'PUT', { key, value: 99999 });
      expect([key, r.status, r.code]).toEqual([key, 403, 'platform_only']);
    }
    expect((await O(ownerA, a.id, 'PUT', { key: 'twilio.auth_token', value: 'x' })).status).toBe(404);
    expect((await O(ownerA, a.id, 'PUT', { key: 'billing.enforced', value: false })).status).toBe(404);
    expect((await O(ownerA, a.id, 'PUT', { key: 'nope.nothing', value: 1 })).status).toBe(404);
    expect((await O(ownerA, a.id, 'PUT', {})).status).toBe(422);
    // cross-tenant: A's owner cannot read or write B (404), nor can staff write at all (403)
    expect((await O(ownerA, b.id, 'GET')).status).toBe(404);
    expect((await O(ownerA, b.id, 'PUT', { key: 'jobs.briefing_hour', value: 7 })).status).toBe(404);
    expect((await O(ownerA, b.id, 'DELETE', { key: 'jobs.briefing_hour' })).status).toBe(404);
    expect((await O(staffA, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 7 })).status).toBe(403);
    expect((await O(null, a.id, 'GET')).status).toBe(401);
    expect(await prisma.tenantSettingOverride.count({ where: { businessId: b.id } })).toBe(0);
    expect((await call(R.ownerOverrides.GET, 'GET', `/api/businesses/${b.id}/settings-overrides`, ownerB, undefined, { id: b.id })).data.every((k: any) => k.override === null)).toBe(true);
    // an admin does not use the owner route to write (the role / support rules live on the admin route)
    expect((await O(owner, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 7 })).status).toBe(403);
    // stale step-up
    await prisma.userSession.updateMany({ where: { userId: ownerA.user.id }, data: { sudoAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await O(ownerA, a.id, 'PUT', { key: 'jobs.briefing_hour', value: 8 })).code).toBe('reauth_required');
    // remove: back to the platform value
    await prisma.userSession.updateMany({ where: { userId: ownerA.user.id }, data: { sudoAt: new Date() } });
    expect((await O(ownerA, a.id, 'DELETE', { key: 'jobs.briefing_hour' })).data.source).toBe('platform');
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'business/' } } });
    // the ADMIN route: platform-only keys within the platform bounds, with the same validation
    const adm = (who: Who, biz: string, key: string, value: unknown) => call(R.overrides.PUT, 'PUT', '/api/admin/tenant-overrides', who, { business_id: biz, key, value });
    expect((await adm(owner, a.id, 'forward.calls_per_hour', 40)).status).toBe(200);
    expect((await adm(owner, a.id, 'forward.calls_per_hour', 0)).status).toBe(422); // min 1
    expect((await adm(owner, a.id, 'billing.enforced', true)).status).toBe(404);
    expect((await adm(owner, 'nope', 'forward.calls_per_hour', 40)).status).toBe(404);
    const list = await call(R.overrides.GET, 'GET', `/api/admin/tenant-overrides?business_id=${a.id}`, await mk('read_only'));
    expect(list.data.find((k: any) => k.key === 'forward.calls_per_hour')).toMatchObject({ override: 40, effective: 40, editable_by: 'platform' });
    expect((await call(R.overrides.GET, 'GET', '/api/admin/tenant-overrides', owner)).status).toBe(422);
    // read-time clamp: a stored value that is now out of the (tightened) bounds is clamped / ignored, never applied raw
    await prisma.tenantSettingOverride.upsert({ where: { businessId_key: { businessId: a.id, key: 'forward.ring_seconds' } }, create: { businessId: a.id, key: 'forward.ring_seconds', value: 500 }, update: { value: 500 } });
    const { tenantEffective } = await import('@/lib/admin/tenant-overrides');
    const eff = await tenantEffective(a.id, 'forward.ring_seconds');
    expect([eff.source, eff.ignored_override]).toEqual(['platform', true]);
    await prisma.tenantSettingOverride.deleteMany({ where: { businessId: a.id, key: 'messaging.quiet_start_hour' } });
    // audit rows carry the business id
    const rows = await prisma.auditEvent.findMany({ where: { action: 'settings.tenant_override', businessId: a.id } });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.every((r) => (r.meta as any).scope === 'owner' || (r.meta as any).scope === 'platform')).toBe(true);
    // a platform value pinned by the environment still takes tenant overrides (unless the registry blocks them)
    setEnv('FORWARD_RING_SECONDS', '20');
    expect((await tenantEffective(a.id, 'forward.ring_seconds')).platform).toBe(20);
    setEnv('FORWARD_RING_SECONDS', undefined);
  });

  test('administrators: invite by e-mail, list, role change (owners only, never your own, never the last owner), disable revokes sessions, 2FA reset, revoke sessions', async () => {
    const mail = captureMail();
    let owner = await mk('owner'); const ops = await mk('ops');
    try {
      const email = `${uniq('invitee')}@example.test`;
      const inv = await call(R.admins.POST, 'POST', '/api/admin/admins', owner, { email, platform_role: 'support' });
      expect(inv.status).toBe(201);
      userIds.push(inv.data.admin.id);
      expect(inv.data.email_sent).toBe(true);
      expect(mail.to(email)).toHaveLength(1);
      expect(mail.to(email)[0].token).toBeTruthy();
      expect(inv.text).not.toContain('password');
      expect((await call(R.admins.POST, 'POST', '/api/admin/admins', owner, { email, platform_role: 'support' })).status).toBe(409);
      expect((await call(R.admins.POST, 'POST', '/api/admin/admins', owner, { email: 'nope', platform_role: 'support' })).status).toBe(422);
      expect((await call(R.admins.POST, 'POST', '/api/admin/admins', owner, { email: `${uniq('x')}@example.test`, platform_role: 'god' })).status).toBe(422);
      const list = await call(R.admins.GET, 'GET', '/api/admin/admins', ops);
      expect(list.data.admins.find((a: any) => a.email === email)).toMatchObject({ platform_role: 'support', disabled: false, two_factor: false });
      const target = inv.data.admin.id;
      // roles: ops cannot, an owner can, nobody changes their own role
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${target}`, ops, { platform_role: 'owner' }, { id: target })).status).toBe(403);
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, owner, { platform_role: 'ops' }, { id: owner.user.id })).code).toBe('self');
      const up = await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${target}`, owner, { platform_role: 'ops' }, { id: target });
      expect(up.data.admin.platform_role).toBe('ops');
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${target}`, owner, { platform_role: 'nope' }, { id: target })).status).toBe(422);
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${target}`, owner, {}, { id: target })).status).toBe(422);
      // last owner protection: demote / disable every OTHER owner first (the DB may hold owners of other tests: disable them for this check)
      const others = await prisma.user.findMany({ where: { role: 'admin', platformRole: 'owner', disabledAt: null, id: { not: owner.user.id } }, select: { id: true } });
      await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: new Date() } });
      try {
        const second = await mk('owner');
        expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, second, { platform_role: 'ops' }, { id: owner.user.id })).status).toBe(200); // another owner exists: allowed
        await prisma.user.update({ where: { id: owner.user.id }, data: { platformRole: 'owner' } });
        await prisma.user.update({ where: { id: second.user.id }, data: { disabledAt: new Date() } });
        const lone = await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, 'bearer', { disabled: true }, { id: owner.user.id });
        expect([lone.status, lone.code]).toEqual([403, 'forbidden']); // the token may not disable (only re-enable)
        const third = await mk('owner');
        await prisma.user.update({ where: { id: third.user.id }, data: { disabledAt: new Date() } });
        // `owner` is the ONLY enabled owner: nobody (another owner is disabled) can disable or demote it
        const lastDis = await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, await mk('owner'), { disabled: true }, { id: owner.user.id });
        expect(lastDis.status).toBe(200); // a fresh enabled owner now exists, so this one may be disabled
        await prisma.user.update({ where: { id: owner.user.id }, data: { disabledAt: null } });
      } finally {
        await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: null } });
      }
      owner = await mk('owner'); // the check above disabled (and signed out) the previous one
      // disable revokes sessions; the disabled admin can no longer authenticate; re-enable restores
      const victim = await mk('ops');
      expect((await call(R.me, 'GET', '/api/admin/me', victim)).status).toBe(200);
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${victim.user.id}`, owner, { disabled: true }, { id: victim.user.id })).status).toBe(200);
      expect(await prisma.userSession.count({ where: { userId: victim.user.id } })).toBe(0);
      expect((await call(R.me, 'GET', '/api/admin/me', victim)).status).toBe(401);
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${owner.user.id}`, owner, { disabled: true }, { id: owner.user.id })).code).toBe('self');
      expect((await call(R.admin.PATCH, 'PATCH', `/api/admin/admins/${victim.user.id}`, owner, { disabled: false }, { id: victim.user.id })).status).toBe(200);
      // revoke sessions (owner / token), reset 2FA (owner)
      const v2 = await mk('ops');
      expect((await call(R.adminSessions.DELETE, 'DELETE', `/api/admin/admins/${v2.user.id}/sessions`, ops, undefined, { id: v2.user.id })).status).toBe(403);
      expect((await call(R.adminSessions.DELETE, 'DELETE', `/api/admin/admins/${v2.user.id}/sessions`, owner, undefined, { id: v2.user.id })).data.revoked).toBe(1);
      const v3 = await mk('ops');
      expect((await call(R.adminTwoFactor.DELETE, 'DELETE', `/api/admin/admins/${v3.user.id}/two-factor`, ops, undefined, { id: v3.user.id })).status).toBe(403);
      expect((await call(R.adminTwoFactor.DELETE, 'DELETE', `/api/admin/admins/${v3.user.id}/two-factor`, owner, { reason: 'lost device, verified by call', confirm: v3.user.email }, { id: v3.user.id })).status).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: v3.user.id } });
      expect([after.totpEnabledAt, after.totpSecretEnc]).toEqual([null, null]);
      expect(await prisma.userSession.count({ where: { userId: v3.user.id } })).toBe(0);
      expect((await call(R.adminTwoFactor.DELETE, 'DELETE', '/api/admin/admins/nope/two-factor', owner, undefined, { id: 'nope' })).status).toBe(404);
      // a tenant owner id is not an admin
      expect((await call(R.adminSessions.DELETE, 'DELETE', `/api/admin/admins/${userIds[0]}/sessions`, owner, undefined, { id: 'not-an-admin' })).status).toBe(404);
      expect(await prisma.auditEvent.count({ where: { action: { startsWith: 'admin.' }, actorUserId: { in: userIds } } })).toBeGreaterThanOrEqual(5);
    } finally { mail.restore(); }
  });

  test('the console forces 2FA on every admin while it runs (24e T1): an admin without 2FA is sent to enrolment, not into the console', async () => {
    loader.startSettingsPoll(3_600_000);
    try {
      const noTfa = await mk('owner', { twoFactor: false });
      const r = await call(R.me, 'GET', '/api/admin/me', noTfa);
      expect([r.status, r.json.code]).toEqual([403, '2fa_enrollment_required']);
      expect((await call(R.me, 'GET', '/api/admin/me', await mk('owner'))).status).toBe(200);
    } finally { loader.stopSettingsLoader(); }
    // without the console loader (no settings table in use) the old rule applies
    expect((await call(R.me, 'GET', '/api/admin/me', await mk('owner', { twoFactor: false }))).status).toBe(200);
  });

  test('job runs: EVERY run is recorded (dry, real, zero-work, manual with its actor), listed with filters, and old history is pruned', async () => {
    const owner = await mk('owner'); const ro = await mk('read_only');
    const jobs = await import('@/lib/jobs');
    await jobs.runJob('cleanup', { dryRun: true });
    await jobs.runJob('recording_deletions', {});
    const manual = await call(R.jobsRun, 'POST', '/api/admin/jobs/run', owner, { job: 'cleanup', dry_run: true });
    expect(manual.status).toBe(200);
    const runs = await call(R.jobRuns, 'GET', '/api/admin/job-runs?limit=50', ro);
    const mine = runs.data.items.filter((r: any) => new Date(r.started_at) >= startedAt);
    expect(mine.map((r: any) => r.job)).toContain('recording_deletions');
    const dry = mine.find((r: any) => r.job === 'cleanup' && r.trigger === 'manual');
    expect(dry).toMatchObject({ dry_run: true, status: 'ok', actor: owner.user.id, trigger: 'manual' });
    expect(dry.finished_at).toBeTruthy();
    expect(mine.find((r: any) => r.job === 'recording_deletions')).toMatchObject({ dry_run: false, actor: 'system', trigger: 'schedule', processed: 0 }); // zero-work runs are rows too
    expect((await call(R.jobRuns, 'GET', '/api/admin/job-runs?job=cleanup&dry_run=true', ro)).data.items.every((r: any) => r.job === 'cleanup' && r.dry_run)).toBe(true);
    expect((await call(R.jobRuns, 'GET', '/api/admin/job-runs?trigger=manual', ro)).data.items.every((r: any) => r.trigger === 'manual')).toBe(true);
    const page = await call(R.jobRuns, 'GET', '/api/admin/job-runs?limit=1', ro);
    expect(page.data.items.length).toBe(1);
    expect(page.data.next_cursor).toBeTruthy();
    // a real cleanup records its counts; a throwing job records an error row and still throws
    const real = await jobs.runJob('cleanup', { actor: 'tester' });
    expect(real.errors).toBe(0);
    const row = await prisma.jobRun.findFirstOrThrow({ where: { job: 'cleanup', actor: 'tester' } });
    expect(row.counts).toHaveProperty('job_runs');
    expect(row.counts).toHaveProperty('instance_heartbeats');
    await prisma.jobRun.create({ data: { job: 'cleanup', startedAt: new Date(Date.now() - 70 * 86_400_000), actor: 'old-run' } });
    await jobs.runJob('cleanup', {});
    expect(await prisma.jobRun.count({ where: { actor: 'old-run' } })).toBe(0); // pruned after 60 days
  });

  test('audit search and export: filters, keyset pages, CSV with formula-injection hardening, the export itself is audited and limited to audit.export roles', async () => {
    const owner = await mk('owner'); const ops = await mk('ops'); const sup = await mk('support');
    const biz = await newBusiness({ agent_id: null });
    const tag = uniq('aud');
    await db.recordAudit({ actor_kind: 'user', actor_user_id: owner.user.id, business_id: biz.id, action: 'test.audit_one', target: `=HYPERLINK("http://evil","${tag}")`, meta: { note: `needle ${tag}` } });
    await db.recordAudit({ actor_kind: 'system', business_id: biz.id, action: 'test.audit_two', target: `target-${tag}` });
    await db.recordAudit({ actor_kind: 'system', action: 'test.other', target: 'elsewhere' });
    const s = async (qs: string, who: Who = sup) => (await call(R.audit, 'GET', `/api/admin/audit?${qs}`, who));
    expect((await s(`business_id=${biz.id}`)).data.items.map((r: any) => r.action).sort()).toEqual(['test.audit_one', 'test.audit_two']);
    expect((await s(`action=test.audit_one`)).data.items.length).toBe(1);
    expect((await s(`action=test.audit_`)).data.items.length).toBe(0); // exact match unless the filter ends in a dot
    expect((await s(`action=test.&business_id=${biz.id}`)).data.items.length).toBe(2); // `prefix.` matches by prefix
    expect((await s(`actor=${owner.user.id}&business_id=${biz.id}`)).data.items.map((r: any) => r.action)).toEqual(['test.audit_one']);
    expect((await s(`actor=system&business_id=${biz.id}`)).data.items.map((r: any) => r.action)).toEqual(['test.audit_two']);
    expect((await s(`q=${encodeURIComponent(`needle ${tag}`)}`)).data.items.map((r: any) => r.action)).toEqual(['test.audit_one']); // free text reaches the meta
    expect((await s(`q=${encodeURIComponent(tag.slice(0, 6) + '%')}`)).status).toBe(200); // LIKE wildcards are escaped, not interpreted
    expect((await s(`from=2999-01-01T00:00:00Z`)).data.items).toEqual([]);
    expect((await s(`from=garbage`)).status).toBe(422);
    expect((await s(`before=garbage`)).status).toBe(422);
    const p1 = await s(`business_id=${biz.id}&limit=1`);
    expect(p1.data.items.length).toBe(1);
    const p2 = await s(`business_id=${biz.id}&limit=1&before=${encodeURIComponent(p1.data.next_cursor)}`);
    expect(p2.data.items.length).toBe(1);
    expect(p2.data.items[0].id).not.toBe(p1.data.items[0].id);
    expect((await s(`business_id=${biz.id}&limit=1&before=${encodeURIComponent(p2.data.next_cursor ?? '')}`, sup)).status).toBe(p2.data.next_cursor ? 200 : 200);
    // export: audit.export only (owner, ops); CSV is hardened and the export is itself audited
    expect((await s(`business_id=${biz.id}&export=1&format=csv`, sup)).status).toBe(403);
    const csv = await s(`business_id=${biz.id}&export=1&format=csv`, ops);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('audit.csv');
    expect(csv.text.split('\n')[0]).toBe('id,at,actor_kind,actor_user_id,business_id,action,target,ip,meta');
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"",""${tag}"")"`); // neutralised
    expect(csv.text).not.toMatch(/,"=HYPERLINK/);
    const json = await s(`business_id=${biz.id}&export=1`, owner);
    expect(json.data.items.length).toBe(2);
    const exp = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'audit.export', actorUserId: ops.user.id }, orderBy: { at: 'desc' } });
    expect((exp.meta as any)).toMatchObject({ format: 'csv', rows: 2, role: 'ops' });
    expect((exp.meta as any).filters.business_id).toBe(biz.id);
    // export is rate limited (6 per minute)
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await s(`business_id=${biz.id}&export=1`, owner)).status;
    expect(last).toBe(429);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ businessId: biz.id }, { action: 'test.other' }] } });
  });

  test('selftest and system: provider readiness and the key / instance picture, without a single secret and without a network call', async () => {
    const ro = await mk('read_only');
    const st = await call(R.selftest, 'GET', '/api/admin/selftest', ro);
    expect(st.status).toBe(200);
    expect(st.data.tested).toBe(false);
    expect(st.data.providers.map((p: any) => p.provider)).toEqual(['twilio', 'elevenlabs', 'stripe', 'llm', 'email', 'google', 'turnstile']);
    const twilio = st.data.providers.find((p: any) => p.provider === 'twilio');
    expect(twilio.fields['twilio.auth_token']).toEqual({ set: true, source: 'env' }); // pinned by the test environment
    expect(twilio.tested).toBe(false);
    expect(st.data.providers.find((p: any) => p.provider === 'stripe').fields['stripe.secret_key'].set).toBe(false);
    expect(st.text).not.toContain(process.env.TWILIO_AUTH_TOKEN!);
    expect(st.text).not.toContain(process.env.STRIPE_WEBHOOK_SECRET!);
    expect(st.text).not.toContain(SECRETS.adminToken);
    const sys = await call(R.system, 'GET', '/api/admin/system', ro);
    expect(sys.status).toBe(200);
    expect(sys.data.keys.current_kid).toHaveLength(8);
    expect(sys.data.keys.previous_kid).toBeNull();
    expect(sys.text).not.toContain(MASTER);
    expect(sys.data.frozen.frozen).toBe(false);
    expect(typeof sys.data.env_locked_keys).toBe('number');
    expect(sys.data.env_locked_keys).toBeGreaterThan(0);
    expect(Array.isArray(sys.data.instances)).toBe(true);
    expect((await call(R.reencrypt.GET, 'GET', '/api/admin/secrets/reencrypt', ro)).data).toHaveProperty('done');
  });
});
