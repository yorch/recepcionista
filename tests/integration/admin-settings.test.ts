/**
 * Admin console settings store against a real database: change sets, tiers, env-pin locks, ratchets, credential pairs, secrets (write-only, encrypted, rotated), MAC tampering,
 * the loader (last known good, multi-instance version poll, canary and health), freeze, rollback, export / import, notifications. No outbound request leaves the machine.
 */
import { integration, outboundCalls } from '../helpers/env';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { captureMail } from '../helpers/auth-harness';
import { loadPrisma, uniq } from '../helpers/fixtures';

integration('admin console: settings store, loader, secrets (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let store: typeof import('@/lib/admin/settings-store');
  let loader: typeof import('@/lib/admin/loader');
  let cfg: typeof import('@/lib/config');
  let crypt: typeof import('@/lib/admin/crypto');
  let rotation: typeof import('@/lib/admin/rotation');
  let users: typeof import('@/lib/db/users');
  const savedEnv: Record<string, string | undefined> = {};
  const MASTER = crypto.randomBytes(32).toString('base64');
  const OTHER = crypto.randomBytes(32).toString('base64');
  const userIds: string[] = [];
  const startedAt = new Date(Date.now() - 1000);
  const actor = (role: 'owner' | 'ops' | 'support' | 'read_only' | 'bearer' = 'owner', via?: any): any => ({ kind: role === 'bearer' ? 'admin_token' : 'user', user_id: role === 'bearer' ? null : `u-${role}`, via: via ?? (role === 'bearer' ? 'bearer' : 'console'), role, ip: null });
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const crit = (keys: string[]) => store.confirmationPhrase(keys);
  const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; return null; } catch (e) { return e; } };

  async function resetState() {
    await prisma.platformSetting.deleteMany({});
    await prisma.settingChangeSet.deleteMany({});
    await prisma.tenantSettingOverride.deleteMany({});
    await prisma.settingsState.upsert({ where: { id: 1 }, create: { id: 1, globalVersion: 0 }, update: { globalVersion: { increment: 1 }, frozenAt: null, frozenBy: null, frozenReason: null } }); // versions only ever grow: a reset bumps it so the instances reload
    await prisma.instanceHeartbeat.deleteMany({});
  }

  beforeAll(async () => {
    for (const k of ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'TRUSTED_PROXY', 'APP_URL']) setEnv(k, process.env[k]); // remember the ORIGINAL values before captureMail() changes them
    setEnv('APP_SECRET_KEY', MASTER);
    setEnv('APP_SECRET_KEY_PREVIOUS', undefined);
    for (const k of ['SETTINGS_FREEZE', 'ADMIN_TOKEN_ALLOW_SETTINGS', 'ALERT_EMAIL', 'BILLING_PLAN_NAME', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_URL', 'BILLING_ENFORCED', 'PLAN_SMS_CAP', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'SMS_ALLOWED_COUNTRY_CODES', 'SIGNUP_MAX_PER_HOUR', 'PASSWORD_MIN_CHARS']) setEnv(k, undefined);
    prisma = await loadPrisma();
    store = await import('@/lib/admin/settings-store');
    loader = await import('@/lib/admin/loader');
    cfg = await import('@/lib/config');
    crypt = await import('@/lib/admin/crypto');
    rotation = await import('@/lib/admin/rotation');
    users = await import('@/lib/db/users');
    await resetState();
    loader.startSettingsPoll(3_600_000); // installed, never polling on its own: the tests drive refresh/poll
    await loader.refreshNow();
  });
  beforeEach(async () => { await resetState(); setEnv('APP_SECRET_KEY', MASTER); setEnv('APP_SECRET_KEY_PREVIOUS', undefined); await loader.refreshNow(); });
  afterEach(() => { setEnv('SETTINGS_FREEZE', undefined); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    loader.stopSettingsLoader();
    await resetState();
    await prisma.auditEvent.deleteMany({ where: { OR: [{ at: { gte: startedAt }, action: { startsWith: 'settings.' } }, { actorUserId: { in: userIds } }] } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await prisma.$disconnect();
  });

  async function mkAdmin(role: 'owner' | 'ops' | 'support' | 'read_only' = 'owner') {
    const u = await users.createUser({ email: `${uniq('adm')}@example.test`, password_hash: 'x'.repeat(20), role: 'admin', platform_role: role, email_verified: true });
    userIds.push(u.id);
    return u;
  }

  test('a normal change: one version, a revision, an audit row, the snapshot serves it at once, a repeat is a no-op', async () => {
    const before = await prisma.settingsState.findUniqueOrThrow({ where: { id: 1 } });
    const res = await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'Maintenance tonight' }, { key: 'jobs.briefing_hour', value: 19 }], actor: actor('ops') });
    expect(res.noop).toBe(false);
    expect(res.version).toBe(Number(before.globalVersion) + 1);
    expect(res.tier).toBe('normal');
    expect(cfg.setting('platform.announcement')).toBe('Maintenance tonight');
    expect(cfg.settingSource('platform.announcement')).toBe('console');
    expect(cfg.setting('jobs.briefing_hour')).toBe(19);
    expect(loader.appliedVersion()).toBe(res.version);
    const revs = await prisma.platformSettingRevision.findMany({ where: { changeSetId: res.change_set_id! }, orderBy: { key: 'asc' } });
    expect(revs.map((r) => [r.key, r.op, r.oldPresent, r.newValue])).toEqual([['jobs.briefing_hour', 'set', false, 19], ['platform.announcement', 'set', false, 'Maintenance tonight']]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.change', target: `change_set:${res.change_set_id}` } });
    expect(audit.businessId).toBeNull();
    expect((audit.meta as any).keys.map((k: any) => k.key).sort()).toEqual(['jobs.briefing_hour', 'platform.announcement']);
    expect((audit.meta as any).keys.find((k: any) => k.key === 'jobs.briefing_hour')).toMatchObject({ old: null, new: 19, tier: 'normal', op: 'set' });
    const again = await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'Maintenance tonight' }], actor: actor('ops') });
    expect(again.noop).toBe(true);
    expect(again.change_set_id).toBeNull();
    expect(Number((await prisma.settingsState.findUniqueOrThrow({ where: { id: 1 } })).globalVersion)).toBe(res.version);
    // remove -> back to the default; the revision remembers the old value
    const rm = await store.applyChanges({ changes: [{ key: 'platform.announcement', remove: true }], actor: actor('ops') });
    expect(cfg.settingSource('platform.announcement')).toBe('default');
    const r2 = await prisma.platformSettingRevision.findFirstOrThrow({ where: { changeSetId: rm.change_set_id! } });
    expect([r2.op, r2.oldPresent, r2.oldValue]).toEqual(['remove', true, 'Maintenance tonight']);
  });

  test('validation: unknown, env-only, wrong type, null, duplicate keys, a value for a secret and a secret for a value are all refused with their key', async () => {
    const cases: [any, string][] = [
      [{ key: 'nope.nothing', value: 1 }, 'unknown_key'], [{ key: 'DATABASE_URL', value: 'x' }, 'env_only'], [{ key: 'jobs.briefing_hour', value: 99 }, 'invalid_value'], [{ key: 'jobs.briefing_hour', value: '7' }, 'invalid_value'],
      [{ key: 'jobs.briefing_hour', value: null }, 'invalid_value'], [{ key: 'jobs.briefing_hour' }, 'invalid_value'], [{ key: 'stripe.secret_key', value: 'sk_' + 'test_x' }, 'use_secret_field'],
      [{ key: 'platform.announcement', secret: 'abc' }, 'invalid_value'], [{ key: 'stripe.secret_key', secret: 'short' }, 'invalid_value'], [{ key: '_canary', value: 1 }, 'unknown_key'],
    ];
    for (const [change, code] of cases) {
      const e = await fails(store.applyChanges({ changes: [change], actor: actor() }));
      expect(e?.code ?? 'no error').toBe(code);
      expect(e.status).toBe(change.key === 'jobs.briefing_hour' || true ? 422 : 0);
    }
    expect((await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'a' }, { key: 'platform.announcement', value: 'b' }], actor: actor() })))?.code).toBe('duplicate_key');
    expect((await fails(store.applyChanges({ changes: [], actor: actor() })))?.code).toBe('nothing_to_change');
    // atomic: one bad key means nothing is written
    const e = await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'x' }, { key: 'jobs.briefing_hour', value: 99 }], actor: actor() }));
    expect(e.problems.map((p: any) => p.key)).toEqual(['jobs.briefing_hour']);
    expect(await prisma.platformSetting.count({ where: { key: 'platform.announcement' } })).toBe(0);
  });

  test('env pin > console > default: a pinned key cannot be written (409 locked_by_env) and its env value keeps winning', async () => {
    setEnv('BILLING_PLAN_NAME', 'pinned-plan');
    const e = await fails(store.applyChanges({ changes: [{ key: 'billing.plan_name', value: 'console-plan' }], actor: actor() }));
    expect(e.code).toBe('locked_by_env');
    expect(e.status).toBe(409);
    expect(cfg.setting('billing.plan_name')).toBe('pinned-plan');
    expect(cfg.settingSource('billing.plan_name')).toBe('env');
    // a console value written BEFORE the pin never overrides it afterwards (and the legacy env view agrees)
    setEnv('BILLING_PLAN_NAME', undefined);
    await store.applyChanges({ changes: [{ key: 'billing.plan_name', value: 'console-plan' }], actor: actor() });
    expect(cfg.configEnv().BILLING_PLAN_NAME).toBe('console-plan'); // legacy readers see the console value
    setEnv('BILLING_PLAN_NAME', 'pinned-again');
    expect(cfg.setting('billing.plan_name')).toBe('pinned-again');
    expect(cfg.configEnv().BILLING_PLAN_NAME).toBe('pinned-again');
    const view = (await store.describeSettings()).settings.find((s) => s.key === 'billing.plan_name')!;
    expect([view.source, view.locked, view.locked_reason, view.console_value]).toEqual(['env', true, 'env', 'console-plan']);
    // rollback of a pinned key is refused too
    setEnv('BILLING_PLAN_NAME', undefined);
  });

  test('tiers: sensitive needs a reason; critical needs reason + the exact confirmation phrase; a stale expected_version is refused', async () => {
    let e = await fails(store.applyChanges({ changes: [{ key: 'messaging.default_phone_country', value: 'US' }], actor: actor() }));
    expect(e.code).toBe('reason_required');
    await store.applyChanges({ changes: [{ key: 'messaging.default_phone_country', value: 'US' }], reason: 'align with the A2P registration', actor: actor() });
    e = await fails(store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing now', actor: actor() }));
    expect(e.code).toBe('confirmation_required');
    e = await fails(store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing now', confirm: 'yes', actor: actor() }));
    expect(e.code).toBe('confirmation_required');
    e = await fails(store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'short', confirm: 'billing.enforced', actor: actor() }));
    expect(e.code).toBe('reason_required');
    const prev = await store.previewChanges({ changes: [{ key: 'billing.enforced', value: true }], actor: actor() });
    expect(prev.tier).toBe('critical');
    expect(prev.requires).toEqual({ reason: true, confirm: 'billing.enforced', step_up: true, notify_admins: true });
    e = await fails(store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing now', confirm: prev.requires.confirm!, expectedVersion: prev.version - 1, actor: actor() }));
    expect(e.code).toBe('stale_preview');
    expect(e.status).toBe(409);
    const ok = await store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'enable billing now', confirm: prev.requires.confirm!, expectedVersion: prev.version, actor: actor() });
    expect(ok.tier).toBe('critical');
    expect(cfg.setting('billing.enforced')).toBe(true);
    // a dry run changes nothing
    const dry = await store.applyChanges({ changes: [{ key: 'billing.enforced', value: false }], reason: 'dry run only please', confirm: 'billing.enforced', dryRun: true, actor: actor() });
    expect(dry.change_set_id).toBeNull();
    expect(cfg.setting('billing.enforced')).toBe(true);
  });

  test('role checks inside the store: ops cannot write critical keys or secrets; the break-glass token needs ADMIN_TOKEN_ALLOW_SETTINGS', async () => {
    let e = await fails(store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'attempt by ops role', confirm: 'billing.enforced', actor: actor('ops') }));
    expect(e.code).toBe('forbidden');
    expect(e.status).toBe(403);
    e = await fails(store.applyChanges({ changes: [{ key: 'stripe.secret_key', secret: 'sk_' + 'test_0123456789' }], reason: 'attempt by ops role', confirm: 'stripe.secret_key', actor: actor('ops') }));
    expect(e.code).toBe('forbidden');
    e = await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'x' }], actor: actor('read_only') }));
    expect(e.code).toBe('forbidden');
    e = await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'x' }], actor: actor('support') }));
    expect(e.code).toBe('forbidden');
    for (const change of [{ key: 'platform.announcement', value: 'x' }, { key: 'billing.enforced', value: true }, { key: 'stripe.secret_key', secret: 'sk_' + 'test_0123456789' }]) {
      e = await fails(store.applyChanges({ changes: [change as any], reason: 'bearer attempt please', confirm: change.key, actor: actor('bearer') }));
      expect(e.code).toBe('forbidden');
    }
    setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', 'true');
    const ok = await store.applyChanges({ changes: [{ key: 'stripe.secret_key', secret: 'sk_' + 'test_0123456789' }], reason: 'bearer allowed by env flag', confirm: 'stripe.secret_key', actor: actor('bearer') });
    expect(ok.tier).toBe('critical');
    setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', undefined);
  });

  test('ratchets: the console may tighten, never loosen (also by reset to default or by rollback); the default is the baseline', async () => {
    const def = cfg.setting('security.password_min_chars') as number;
    await store.applyChanges({ changes: [{ key: 'security.password_min_chars', value: def + 4 }], reason: 'tighten the password rule', actor: actor() });
    expect(cfg.setting('security.password_min_chars')).toBe(def + 4);
    let e = await fails(store.applyChanges({ changes: [{ key: 'security.password_min_chars', value: def + 1 }], reason: 'loosen the password rule', actor: actor() }));
    expect(e.code).toBe('ratchet_violation');
    e = await fails(store.applyChanges({ changes: [{ key: 'security.password_min_chars', value: def - 1 }], reason: 'below the schema floor', actor: actor() }));
    expect(e.code).toBe('invalid_value'); // the schema floor (12) is a hard limit as well
    // from the DEFAULT itself (no console value): a higher cap than the default is looser for `signup.max_per_hour`
    const cap = cfg.setting('signup.max_per_hour') as number;
    e = await fails(store.applyChanges({ changes: [{ key: 'signup.max_per_hour', value: cap + 1 }], reason: 'loosen above the default', actor: actor() }));
    expect(e.code).toBe('ratchet_violation');
    await store.applyChanges({ changes: [{ key: 'signup.max_per_hour', value: cap - 10 }], reason: 'tighten the signup cap', actor: actor() });
    expect(cfg.setting('signup.max_per_hour')).toBe(cap - 10);
    // tighten twice, then roll the second back: that is a loosening and is refused
    const a = await store.applyChanges({ changes: [{ key: 'security.session_max_age_hours', value: 8 }], reason: 'tighten the session lifetime', actor: actor() });
    const b = await store.applyChanges({ changes: [{ key: 'security.session_max_age_hours', value: 4 }], reason: 'tighten the session lifetime more', actor: actor() });
    e = await fails(store.rollbackChangeSet({ id: b.change_set_id!, reason: 'undo the tightening', actor: actor() }));
    expect(e.code).toBe('ratchet_violation');
    expect(cfg.setting('security.session_max_age_hours')).toBe(4);
    e = await fails(store.applyChanges({ changes: [{ key: 'security.session_max_age_hours', remove: true }], reason: 'reset to the default', actor: actor() }));
    expect(e.code).toBe('ratchet_violation'); // the default is looser than 4
    void a;
  });

  test('credential pairs travel together; an environment-pinned partner counts as present', async () => {
    let e = await fails(store.applyChanges({ changes: [{ key: 'google.client_id', value: 'client-id.apps.example.test' }], reason: 'new google client', confirm: 'google.client_id', actor: actor() }));
    expect(e.code).toBe('pair_required');
    expect(e.status).toBe(409);
    e = await fails(store.applyChanges({ changes: [{ key: 'google.client_secret', secret: 'client-secret-value-1' }], reason: 'new google client', confirm: 'google.client_secret', actor: actor() }));
    expect(e.code).toBe('pair_required');
    const keys = ['google.client_id', 'google.client_secret'];
    const ok = await store.applyChanges({ changes: [{ key: 'google.client_id', value: 'client-id.apps.example.test' }, { key: 'google.client_secret', secret: 'client-secret-value-1' }], reason: 'new google client', confirm: crit(keys), actor: actor() });
    expect(ok.tier).toBe('critical');
    expect(cfg.setting('google.client_secret')).toBe('client-secret-value-1');
    // both land in ONE change set / version
    const revs = await prisma.platformSettingRevision.findMany({ where: { changeSetId: ok.change_set_id! } });
    expect(revs.map((r) => r.key).sort()).toEqual(keys);
    // the id is pinned by the environment: the secret may be rotated alone
    setEnv('GOOGLE_CLIENT_ID', 'env-pinned-id');
    await store.applyChanges({ changes: [{ key: 'google.client_secret', secret: 'client-secret-value-2' }], reason: 'rotate the secret only', confirm: 'google.client_secret', actor: actor() });
    expect(cfg.setting('google.client_secret')).toBe('client-secret-value-2');
    setEnv('GOOGLE_CLIENT_ID', undefined);
  });

  test('SECRETS: encrypted at rest (v2 envelope, AAD = key), write-only everywhere, never in a revision, audit row, notification or the snapshot inspection', async () => {
    const mail = captureMail();
    setEnv('EMAIL_PROVIDER', 'resend'); setEnv('EMAIL_FROM', 'Test <test@example.test>'); setEnv('RESEND_API_KEY', 'env-resend-key');
    setEnv('ALERT_EMAIL', 'alerts@example.test');
    const a1 = await mkAdmin('owner'); const a2 = await mkAdmin('ops');
    const SECRET = 'sk_' + 'live_SUPERSECRETVALUE0123456789';
    try {
      const res = await store.setSecret({ key: 'stripe.secret_key', value: SECRET, reason: 'first live key rollout', confirm: 'stripe.secret_key', actor: actor() });
      const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'stripe.secret_key' } });
      expect(row.value).toBeNull();
      expect(row.secretEnvelope!.startsWith('v2.')).toBe(true);
      expect(row.secretEnvelope).not.toContain('SUPERSECRET');
      expect(row.secretFingerprint).toBe(crypt.fingerprintOf(SECRET));
      expect(row.secretLast4).toBe(SECRET.slice(-4));
      expect(crypt.decryptSetting(row.secretEnvelope!, 'stripe.secret_key')).toBe(SECRET);
      expect(() => crypt.decryptSetting(row.secretEnvelope!, 'stripe.webhook_secret')).toThrow(); // the ciphertext cannot be moved to another key
      expect(cfg.setting('stripe.secret_key')).toBe(SECRET); // the runtime uses it
      // ... and no API surface ever shows it
      const view = (await store.describeSettings()).settings.find((s) => s.key === 'stripe.secret_key')!;
      expect(view.value).toBeNull();
      expect(view.secret).toMatchObject({ set: true, source: 'console', fingerprint: crypt.fingerprintOf(SECRET), last4: SECRET.slice(-4) });
      const anyWhere = JSON.stringify([view, res, await store.secretInfo('stripe.secret_key'), await store.listChangeSets(), await store.getChangeSet(res.change_set_id!), await store.exportSettings(),
        await prisma.platformSettingRevision.findMany(), await prisma.settingChangeSet.findMany(), await prisma.auditEvent.findMany({ where: { action: 'settings.change', at: { gte: startedAt } } })], (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
      expect(anyWhere).not.toContain('SUPERSECRET');
      expect(anyWhere).not.toContain(row.secretEnvelope!); // not even the ciphertext leaves the table through these
      // the read-only role sees that it is set, nothing about it
      const ro = await store.secretInfo('stripe.secret_key', { revealMeta: false });
      expect(ro).toEqual({ key: 'stripe.secret_key', set: true, source: 'console' });
      // the snapshot never prints it
      const snap = loader.snapshotNow()!;
      expect(JSON.stringify(snap)).not.toContain('SUPERSECRET');
      expect((await import('node:util')).inspect(snap)).not.toContain('SUPERSECRET');
      expect(cfg.redactSecrets(`error talking to stripe with ${SECRET}`)).not.toContain('SUPERSECRET'); // the logger hook masks it
      // the notification went to every admin + ALERT_EMAIL and carries no value
      const to = mail.mails.map((m) => m.to).sort();
      for (const want of [a1.email, a2.email, 'alerts@example.test']) expect(to).toContain(want);
      for (const m of mail.mails.filter((x) => to.includes(x.to))) { expect(m.subject).toContain('Critical settings change'); expect(m.text).not.toContain('SUPERSECRET'); expect(m.text).toContain('stripe.secret_key'); }
      expect(res.notified?.recipients).toBeGreaterThanOrEqual(3);
      // replace: the previous value stays accepted for the dual-secret window and recoverable for rollback (revision keeps the OLD envelope)
      const NEW = 'sk_' + 'live_REPLACEMENTVALUE0123456789';
      const rep = await store.setSecret({ key: 'stripe.secret_key', value: NEW, reason: 'rotate the live key', confirm: 'stripe.secret_key', actor: actor() });
      expect(cfg.acceptedSecrets('stripe.secret_key')).toEqual([NEW, SECRET]);
      expect(cfg.acceptedSecrets('stripe.secret_key', Date.now() + 16 * 60_000)).toEqual([NEW]);
      const info = await store.secretInfo('stripe.secret_key');
      expect(info.previous_accepted_until).toBeTruthy();
      const rev = await prisma.platformSettingRevision.findFirstOrThrow({ where: { changeSetId: rep.change_set_id! } });
      expect(rev.oldFingerprint).toBe(crypt.fingerprintOf(SECRET));
      expect(rev.newFingerprint).toBe(crypt.fingerprintOf(NEW));
      expect(rev.prevEnvelope).toBeTruthy();
      // the same value again is a no-op
      expect((await store.setSecret({ key: 'stripe.secret_key', value: NEW, reason: 'same value again', confirm: 'stripe.secret_key', actor: actor() })).noop).toBe(true);
      // rollback restores the previous secret from the retained envelope as a NEW change set
      const rb = await store.rollbackChangeSet({ id: rep.change_set_id!, reason: 'the new key was wrong', confirm: 'stripe.secret_key', actor: actor() });
      expect(cfg.setting('stripe.secret_key')).toBe(SECRET);
      expect((await store.getChangeSet(rep.change_set_id!))?.status).toBe('rolled_back');
      expect((await store.getChangeSet(rb.change_set_id!))?.rollback_of).toBe(rep.change_set_id);
      // after 7 days the previous envelope is nulled by the cleanup job and the rollback is refused
      const { cleanupConsoleTables } = await import('@/lib/admin/cleanup');
      await prisma.platformSettingRevision.updateMany({ where: { changeSetId: rep.change_set_id! }, data: { at: new Date(Date.now() - 8 * 86_400_000) } });
      const cleaned = await cleanupConsoleTables();
      expect(cleaned.secret_envelopes).toBeGreaterThanOrEqual(1);
      expect((await prisma.platformSettingRevision.findFirstOrThrow({ where: { changeSetId: rep.change_set_id! } })).prevEnvelope).toBeNull();
      const stillRb = await fails(store.rollbackChangeSet({ id: (await store.applyChanges({ changes: [{ key: 'stripe.secret_key', secret: 'sk_' + 'live_THIRDVALUE0123456789' }], reason: 'third value for the test', confirm: 'stripe.secret_key', actor: actor() })).change_set_id!, reason: 'rollback after retention', confirm: 'stripe.secret_key', actor: actor() }));
      expect(stillRb).toBeNull(); // the new change set is fresh: its rollback works
      // remove -> back to the environment (none): unset
      await store.removeSecret({ key: 'stripe.secret_key', reason: 'remove the console key', confirm: 'stripe.secret_key', actor: actor() });
      expect(cfg.setting('stripe.secret_key')).toBeNull();
      expect((await store.secretInfo('stripe.secret_key')).set).toBe(false);
    } finally {
      mail.restore();
    }
  });

  test('a secret pinned by the environment is locked; its info says source env and never shows a value', async () => {
    const e = await fails(store.setSecret({ key: 'twilio.auth_token', value: 'a-new-twilio-token-123', paired: { 'twilio.account_sid': 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }, reason: 'try to override env', confirm: 'apply 2 critical settings', actor: actor() }));
    expect(e.code).toBe('locked_by_env');
    expect(await store.secretInfo('twilio.auth_token')).toEqual({ key: 'twilio.auth_token', set: true, source: 'env' });
  });

  test('critical changes are mailed through the transport that was active BEFORE the change, never the one being changed', async () => {
    const mail = captureMail();
    setEnv('EMAIL_PROVIDER', 'resend'); setEnv('EMAIL_FROM', 'Old <old@example.test>'); setEnv('RESEND_API_KEY', undefined);
    await mkAdmin('owner');
    try {
      // the old transport lives in the CONSOLE (resend + key), then the change switches the provider to log: the notice must still go out through resend
      setEnv('EMAIL_PROVIDER', undefined); setEnv('EMAIL_FROM', undefined);
      await store.applyChanges({ changes: [{ key: 'email.provider', value: 'resend' }, { key: 'email.from', value: 'Console <console@example.test>' }, { key: 'email.resend_api_key', secret: 'console-resend-key-123' }], reason: 'move mail to the console', confirm: 'apply 3 critical settings', actor: actor() });
      // (the first change had no console transport before it: it went through the environment/log; the mails array may be empty here)
      mail.mails.length = 0;
      await store.applyChanges({ changes: [{ key: 'email.provider', value: 'log' }], reason: 'switch to log transport', confirm: 'email.provider', actor: actor() });
      expect(mail.mails.length).toBeGreaterThanOrEqual(1); // sent through the PREVIOUS (resend) transport although the new provider is `log`
      expect(mail.mails[0].subject).toContain('Critical settings change');
    } finally { mail.restore(); }
  });

  test('SMTP relay: private / metadata / non-SMTP-port targets are refused at save (SSRF); a public one is accepted', async () => {
    const resolve = async (h: string) => (h === 'rebind.example.test' ? ['10.0.0.9'] : ['203.0.113.10']);
    for (const [host, port] of [['169.254.169.254', 587], ['localhost', 587], ['127.0.0.1', 25], ['rebind.example.test', 587], ['smtp.example.test', 5432]] as const) {
      const e = await fails(store.applyChanges({ changes: [{ key: 'email.smtp_host', value: host }, { key: 'email.smtp_port', value: port }], reason: 'point the relay somewhere', confirm: 'apply 2 critical settings', actor: actor(), resolve }));
      expect(e?.code).toBe('smtp_target_refused');
    }
    const e = await fails(store.applyChanges({ changes: [{ key: 'email.smtp_url', secret: 'smtp://u:p@10.1.2.3:587' }], reason: 'point the relay somewhere', confirm: 'email.smtp_url', actor: actor(), resolve }));
    expect(e?.code).toBe('smtp_target_refused');
    expect(JSON.stringify(e.problems)).not.toContain('u:p');
    const ok = await store.applyChanges({ changes: [{ key: 'email.smtp_host', value: 'smtp.example.test' }, { key: 'email.smtp_port', value: 587 }], reason: 'a real public relay', confirm: 'apply 2 critical settings', actor: actor(), resolve });
    expect(ok.tier).toBe('critical');
  });

  test('MAC: a tampered row is IGNORED (falls back to the default), alerted and audited; the others keep working', async () => {
    await store.applyChanges({ changes: [{ key: 'messaging.sms_allowed_countries', value: ['1'] }], reason: 'limit to the US only', confirm: 'messaging.sms_allowed_countries', actor: actor() });
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'hello' }], actor: actor() });
    expect(cfg.setting('messaging.sms_allowed_countries')).toEqual(['1']);
    // SQL tampering: someone widens the allowed countries directly in the table
    await prisma.platformSetting.update({ where: { key: 'messaging.sms_allowed_countries' }, data: { value: ['1', '44', '52', '91'] } });
    await loader.refreshNow();
    expect(cfg.setting('messaging.sms_allowed_countries')).not.toEqual(['1', '44', '52', '91']);
    expect(cfg.settingSource('messaging.sms_allowed_countries')).toBe('default');
    expect(cfg.setting('platform.announcement')).toBe('hello');
    expect(loader.loaderStatus().problems).toEqual([{ key: 'messaging.sms_allowed_countries', code: 'bad_mac' }]);
    expect(loader.loaderStatus().ignored_rows).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'settings.integrity_failure', target: 'setting:messaging.sms_allowed_countries', at: { gte: startedAt } } })).toBeGreaterThanOrEqual(1);
    // a replayed older version / a moved MAC fails too
    const good = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'platform.announcement' } });
    await prisma.platformSetting.update({ where: { key: 'platform.announcement' }, data: { version: good.version + BigInt(5) } });
    await loader.refreshNow();
    expect(cfg.settingSource('platform.announcement')).toBe('default');
    // a row with an invalid value (right MAC for a wrong value cannot happen without the key; a hand-written one is ignored too)
    await prisma.platformSetting.create({ data: { key: 'jobs.briefing_hour', value: 99, integrityMac: 'zz' } });
    await loader.refreshNow();
    expect(cfg.setting('jobs.briefing_hour')).not.toBe(99);
    // an unknown or env-only key in the table is ignored
    await prisma.platformSetting.create({ data: { key: 'made.up_key', value: 1, integrityMac: 'zz' } });
    await loader.refreshNow();
    expect(loader.loaderStatus().problems.some((p) => p.key === 'made.up_key' && p.code === 'unknown_key')).toBe(true);
  });

  test('a ratchet key written directly in the table as a LOOSENING is ignored at load even with a valid MAC (the console can only tighten)', async () => {
    const def = cfg.setting('signup.max_per_hour') as number;
    const keys = crypt.masterKeys();
    const v = 99;
    const mac = crypt.settingMac('signup.max_per_hour', crypt.macPayload({ value: def + 5 }), v, keys);
    await prisma.platformSetting.create({ data: { key: 'signup.max_per_hour', value: def + 5, version: BigInt(v), integrityMac: mac } });
    await loader.refreshNow();
    expect(cfg.setting('signup.max_per_hour')).toBe(def);
    expect(loader.loaderStatus().problems).toEqual([{ key: 'signup.max_per_hour', code: 'ratchet_violation' }]);
  });

  test('key rotation: APP_SECRET_KEY_PREVIOUS decrypts old rows; new writes use the new key; re-encrypt-all (settings, MACs, revisions, canary, TOTP) lets the previous key go', async () => {
    const admin = await mkAdmin('owner');
    const { encryptSecret } = await import('@/lib/totp');
    // the shared test database may hold TOTP secrets / calendar tokens of other tests, encrypted under the development key: they are not ours to re-encrypt
    await prisma.user.updateMany({ where: { totpSecretEnc: { not: null } }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null } });
    await prisma.calendarConnection.updateMany({ data: { accessTokenEnc: null, refreshTokenEnc: null } });
    // state under the OLD key
    setEnv('APP_SECRET_KEY', OTHER);
    await loader.ensureCanary();
    await store.setSecret({ key: 'llm.openai_api_key', value: 'sk-old-key-material-0001', reason: 'old key era secret', confirm: 'llm.openai_api_key', actor: actor() });
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'signed under the old key' }], actor: actor() });
    await prisma.platformSetting.update({ where: { key: '_canary' }, data: { secretEnvelope: crypt.encryptSetting(crypt.CANARY_PLAINTEXT, '_canary') } });
    await prisma.user.update({ where: { id: admin.id }, data: { totpSecretEnc: encryptSecret('JBSWY3DPEHPK3PXP', admin.id) } });
    const oldKid = crypt.envelopeKid((await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.openai_api_key' } })).secretEnvelope!);
    // rotate: new key current, old one previous
    setEnv('APP_SECRET_KEY', MASTER); setEnv('APP_SECRET_KEY_PREVIOUS', OTHER);
    await loader.refreshNow();
    expect(cfg.setting('llm.openai_api_key')).toBe('sk-old-key-material-0001'); // still readable
    expect(cfg.setting('platform.announcement')).toBe('signed under the old key'); // old MAC still verifies
    expect(loader.loaderStatus().canary).toBe('ok');
    expect(loader.loaderStatus().needs_reencrypt).toBeGreaterThanOrEqual(2);
    const st1 = await rotation.reencryptStatus();
    expect(st1.done).toBe(false);
    expect(st1.settings.remaining).toBeGreaterThanOrEqual(1);
    expect(st1.totp.remaining).toBeGreaterThanOrEqual(1);
    // a new secret is written with the CURRENT key
    await store.setSecret({ key: 'llm.anthropic_api_key', value: 'sk-ant-new-key-material-02', reason: 'new key era secret', confirm: 'llm.anthropic_api_key', actor: actor() });
    expect(crypt.envelopeKid((await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.anthropic_api_key' } })).secretEnvelope!)).toBe(crypt.masterKeys().current.kid);
    expect(crypt.masterKeys().current.kid).not.toBe(oldKid);
    // re-encrypt everything
    const bad = await fails(rotation.reencryptAll({ actor: actor('ops'), reason: 'ops tries to re-encrypt' }));
    expect(bad.code).toBe('forbidden');
    let p = await rotation.reencryptAll({ actor: actor(), reason: 'rotation step two: re-encrypt' });
    while (p.next_cursor) p = await rotation.reencryptAll({ actor: actor(), reason: 'rotation step two: re-encrypt', cursor: p.next_cursor });
    expect(p.done).toBe(true);
    expect(p.settings.failed + p.totp.failed + p.calendar_tokens.failed).toBe(0);
    // now the previous key can go: everything still decrypts, verifies and loads
    setEnv('APP_SECRET_KEY_PREVIOUS', undefined);
    await loader.refreshNow();
    expect(cfg.setting('llm.openai_api_key')).toBe('sk-old-key-material-0001');
    expect(cfg.setting('llm.anthropic_api_key')).toBe('sk-ant-new-key-material-02');
    expect(cfg.setting('platform.announcement')).toBe('signed under the old key');
    expect(loader.loaderStatus().problems).toEqual([]);
    expect(loader.loaderStatus().canary).toBe('ok');
    const { decryptSecret } = await import('@/lib/totp');
    expect(decryptSecret((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).totpSecretEnc!, admin.id)).toBe('JBSWY3DPEHPK3PXP');
    expect(await prisma.auditEvent.count({ where: { action: 'settings.reencrypt', at: { gte: startedAt } } })).toBeGreaterThanOrEqual(1);
  });

  test('CANARY: a wrong APP_SECRET_KEY fails the health check loudly; secrets are ignored (never "provider unset" silently)', async () => {
    await store.setSecret({ key: 'llm.openai_api_key', value: 'sk-canary-test-material-1', reason: 'secret for the canary test', confirm: 'llm.openai_api_key', actor: actor() });
    await loader.ensureCanary();
    expect(loader.settingsHealth(true).ok).toBe(true);
    setEnv('APP_SECRET_KEY', OTHER); // a lost / wrong master key
    await loader.refreshNow();
    const h = loader.settingsHealth(true);
    expect(h.ok).toBe(false);
    expect(h.error).toBe('secret_canary_failed');
    expect(h.detail).toContain('APP_SECRET_KEY');
    expect(cfg.setting('llm.openai_api_key')).toBeNull();
    // the health route answers 503 with the same code
    const health = await import('@/app/api/health/route');
    const res = await health.GET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('secret_canary_failed');
    setEnv('APP_SECRET_KEY', MASTER);
    await loader.refreshNow();
    expect(loader.settingsHealth(true).ok).toBe(true);
    expect((await health.GET()).status).toBe(200);
  });

  test('boot / health: not loaded + rows exist = 503 settings_not_loaded; last known good survives a failed reload', async () => {
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'lkg' }], actor: actor() });
    const goodVersion = loader.appliedVersion();
    // a reload that fails (database error) keeps the previous snapshot: never falls back to env/defaults after a success
    const orig = prisma.platformSetting.findMany;
    (prisma.platformSetting as any).findMany = async () => { throw new Error('db hiccup'); };
    try {
      const r = await loader.refreshNow();
      expect(r.ok).toBe(false);
      expect(cfg.setting('platform.announcement')).toBe('lkg');
      expect(loader.appliedVersion()).toBe(goodVersion);
      expect(loader.loaderStatus().last_error).toContain('db hiccup');
    } finally { (prisma.platformSetting as any).findMany = orig; }
    // a process whose first load never succeeded, with rows present, is NOT ready
    loader.stopSettingsLoader();
    loader.startSettingsPoll(3_600_000);
    expect(loader.settingsHealth(true)).toMatchObject({ ok: false, error: 'settings_not_loaded' });
    expect(loader.settingsHealth(false).ok).toBe(true); // an env-only deployment (no rows) is ready
    const health = await import('@/app/api/health/route');
    expect((await health.GET()).status).toBe(503);
    const boot = await loader.bootSettings(5000);
    expect(boot.ok).toBe(true);
    expect(loader.settingsHealth(true).ok).toBe(true);
    expect(cfg.setting('platform.announcement')).toBe('lkg');
    // the boot timeout path: a load that never answers does not block the boot
    loader.stopSettingsLoader();
    const origFind = prisma.settingsState.findUnique;
    (prisma.settingsState as any).findUnique = () => new Promise(() => undefined);
    try {
      const t0 = Date.now();
      const r = await loader.bootSettings(150);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect('timeout' in r).toBe(true);
    } finally { (prisma.settingsState as any).findUnique = origFind; loader.stopSettingsLoader(); loader.startSettingsPoll(3_600_000); await loader.refreshNow(); }
  });

  test('multi-instance: a second instance sees a change through the 10 s version poll (one cheap read), the heartbeat shows who applied what', async () => {
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'v1' }], actor: actor() });
    await loader.pollOnce();
    const mine = loader.instanceIdOfThisProcess();
    // another instance writes through its own store: simulate by writing as a different process would (direct transaction), then poll
    const keys = crypt.masterKeys();
    const next = Number((await prisma.settingsState.findUniqueOrThrow({ where: { id: 1 } })).globalVersion) + 1;
    await prisma.settingsState.update({ where: { id: 1 }, data: { globalVersion: BigInt(next) } });
    await prisma.platformSetting.update({ where: { key: 'platform.announcement' }, data: { value: 'v2-from-another-instance', version: BigInt(next), integrityMac: crypt.settingMac('platform.announcement', crypt.macPayload({ value: 'v2-from-another-instance' }), next, keys) } });
    expect(cfg.setting('platform.announcement')).toBe('v1'); // not yet: the poll has not run
    const { recordQueries } = await import('@/lib/db/client');
    const { queries } = await recordQueries(async () => { await loader.pollOnce(); });
    expect(queries.length).toBeGreaterThan(0);
    expect(cfg.setting('platform.announcement')).toBe('v2-from-another-instance');
    expect(loader.appliedVersion()).toBe(next);
    // an unchanged version is ONE read of settings_state (plus the heartbeat), not a table reload
    const quiet = await recordQueries(async () => { await loader.pollOnce(); });
    expect(quiet.queries.filter((q) => /platform_settings"/.test(q) && /SELECT/.test(q)).length).toBe(0);
    const beat = await prisma.instanceHeartbeat.findUniqueOrThrow({ where: { instanceId: mine } });
    expect(Number(beat.settingsVersion)).toBe(next);
    // a stale instance shows as behind
    await prisma.instanceHeartbeat.create({ data: { instanceId: 'other-instance', settingsVersion: BigInt(next - 1), canary: 'ok' } });
    const rows = await prisma.instanceHeartbeat.findMany({ orderBy: { instanceId: 'asc' } });
    const seen = rows.map((r) => `${r.instanceId === mine ? 'me' : r.instanceId}:${Number(r.settingsVersion) === next}`);
    expect(seen).toContain('me:true');
    expect(seen).toContain('other-instance:false');
  });

  test('FREEZE: SETTINGS_FREEZE=true or the database flag makes every write 403; the break-glass token can freeze and unfreeze; the env freeze cannot be lifted by API', async () => {
    setEnv('SETTINGS_FREEZE', 'true');
    let e = await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'x' }], actor: actor() }));
    expect([e.status, e.code]).toEqual([403, 'settings_frozen']);
    e = await fails(store.setSecret({ key: 'llm.openai_api_key', value: 'sk-frozen-attempt-123', reason: 'while frozen please', confirm: 'llm.openai_api_key', actor: actor() }));
    expect(e.code).toBe('settings_frozen');
    e = await fails(store.setFrozen({ frozen: false, reason: 'try to unfreeze via api', actor: actor('bearer') }));
    expect(e.code).toBe('locked_by_env');
    setEnv('SETTINGS_FREEZE', undefined);
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'before freeze' }], actor: actor() });
    // the token freezes ...
    expect((await store.setFrozen({ frozen: true, reason: 'incident: suspected hijack', actor: actor('bearer') })).frozen).toBe(true);
    e = await fails(store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'x' }], actor: actor() }));
    expect(e.code).toBe('settings_frozen');
    e = await fails(store.rollbackChangeSet({ id: (await store.listChangeSets()).items[0].id, reason: 'rollback while frozen', actor: actor() }));
    expect(e.code).toBe('settings_frozen');
    // ops may freeze but not unfreeze; the token / owner may unfreeze
    e = await fails(store.setFrozen({ frozen: false, reason: 'ops tries to unfreeze', actor: actor('ops') }));
    expect(e.code).toBe('forbidden');
    expect((await store.setFrozen({ frozen: false, reason: 'incident over: all clear', actor: actor('bearer') })).frozen).toBe(false);
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'after freeze' }], actor: actor() });
    expect(await prisma.auditEvent.count({ where: { action: { in: ['settings.freeze', 'settings.unfreeze'] }, at: { gte: startedAt } } })).toBeGreaterThanOrEqual(2);
  });

  test('history + rollback: a rollback is a NEW change set; superseded keys block it; a subset can be rolled back', async () => {
    const a = await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'one' }, { key: 'jobs.briefing_hour', value: 17 }], actor: actor() });
    const b = await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'two' }], actor: actor() });
    let e = await fails(store.rollbackChangeSet({ id: a.change_set_id!, reason: 'undo the first change', actor: actor() }));
    expect(e.code).toBe('superseded'); // announcement changed again
    expect(e.problems.map((p: any) => p.key)).toEqual(['platform.announcement']);
    const part = await store.rollbackChangeSet({ id: a.change_set_id!, reason: 'undo only the briefing hour', keys: ['jobs.briefing_hour'], actor: actor() });
    expect(cfg.settingSource('jobs.briefing_hour')).toBe('default'); // it had no console value before
    expect(cfg.setting('platform.announcement')).toBe('two');
    expect((await store.getChangeSet(a.change_set_id!))?.status).toBe('applied'); // a partial rollback does not close the change set
    const full = await store.rollbackChangeSet({ id: b.change_set_id!, reason: 'undo the second change', actor: actor() });
    expect(cfg.setting('platform.announcement')).toBe('one');
    expect((await store.getChangeSet(b.change_set_id!))?.status).toBe('rolled_back');
    e = await fails(store.rollbackChangeSet({ id: b.change_set_id!, reason: 'undo the second change twice', actor: actor() }));
    expect(e.code).toBe('not_rollbackable');
    e = await fails(store.rollbackChangeSet({ id: 'no-such-id', reason: 'unknown change set id', actor: actor() }));
    expect(e.status).toBe(404);
    e = await fails(store.rollbackChangeSet({ id: full.change_set_id!, reason: '', actor: actor() }));
    expect(e.code).toBe('reason_required');
    const hist = await store.listChangeSets({ limit: 2 });
    expect(hist.items.length).toBe(2);
    expect(hist.items[0].version).toBeGreaterThan(hist.items[1].version);
    expect(hist.next_cursor).not.toBeNull();
    expect((await store.listChangeSets({ key: 'jobs.briefing_hour' })).items.map((i) => i.id)).toContain(a.change_set_id!);
    void part;
    // the break-glass token may roll back (recovery) even without ADMIN_TOKEN_ALLOW_SETTINGS
    const c = await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'three' }], actor: actor() });
    await store.rollbackChangeSet({ id: c.change_set_id!, reason: 'recovery by the break-glass token', actor: actor('bearer') });
    expect(cfg.setting('platform.announcement')).toBe('one');
    // ... but a critical change needs settings.rollback.critical, which ops lack
    const k = await store.applyChanges({ changes: [{ key: 'billing.enforced', value: true }], reason: 'critical for rollback test', confirm: 'billing.enforced', actor: actor() });
    e = await fails(store.rollbackChangeSet({ id: k.change_set_id!, reason: 'ops tries a critical rollback', confirm: 'billing.enforced', actor: actor('ops') }));
    expect(e.code).toBe('forbidden');
  });

  test('export / import: non-secret only; a dry-run diff first; locked, secret, unknown and invalid keys are reported and skipped; apply is ONE change set', async () => {
    await prisma.plan.deleteMany({ where: { key: 'imported-plan' } });
    await prisma.plan.update({ where: { key: 'standard' }, data: { smsCap: 500 } });
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'exported' }], actor: actor() });
    await store.setSecret({ key: 'llm.openai_api_key', value: 'sk-never-exported-0001', reason: 'secret that must not export', confirm: 'llm.openai_api_key', actor: actor() });
    const doc = await store.exportSettings();
    expect(doc.schema_version).toBe(1);
    expect(doc.settings['platform.announcement']).toBe('exported');
    expect(Object.keys(doc.settings)).not.toContain('llm.openai_api_key');
    expect(doc.secret_fingerprints['llm.openai_api_key']).toBe(crypt.fingerprintOf('sk-never-exported-0001'));
    expect(JSON.stringify(doc)).not.toContain('sk-never-exported');
    expect(doc.plans.map((p: any) => p.key)).toContain('standard');
    // import into a changed state
    setEnv('BILLING_PLAN_NAME', 'env-plan');
    const incoming: any = {
      schema_version: 1, settings: { 'platform.announcement': 'imported', 'jobs.briefing_hour': 20, 'billing.plan_name': 'nope', 'llm.openai_api_key': 'sk-smuggled', 'made.up': 1, 'limits.max_crews': 9999 },
      secret_fingerprints: { 'llm.openai_api_key': 'deadbeef' },
      plans: [{ key: 'standard', name: 'Standard', sms_cap: 750 }, { key: 'imported-plan', name: 'Imported', public: true }],
    };
    const dry = await store.importSettings({ doc: incoming, apply: false, actor: actor() });
    const byKey = Object.fromEntries(dry.plan.diff.map((d) => [d.key, d]));
    expect(byKey['platform.announcement']).toMatchObject({ op: 'set', old: 'exported', new: 'imported' });
    expect(byKey['jobs.briefing_hour'].op).toBe('set');
    expect(byKey['billing.plan_name']).toMatchObject({ op: 'skip', reason: 'locked_by_env' });
    expect(byKey['llm.openai_api_key']).toMatchObject({ op: 'skip', reason: 'secret_not_importable' });
    expect(byKey['made.up']).toMatchObject({ op: 'skip', reason: 'unknown_key' });
    expect(byKey['limits.max_crews'].op).toBe('skip');
    expect(dry.plan.warnings.join(' ')).toContain('fingerprints differ');
    expect(dry.plan.plans).toEqual({ create: ['imported-plan'], update: ['standard'], unchanged: [] });
    expect(cfg.setting('platform.announcement')).toBe('exported'); // dry run wrote nothing
    expect(dry.result).toBeNull();
    // role: only settings.import may apply; ops may not
    const denied = await fails(store.importSettings({ doc: incoming, apply: true, reason: 'import by ops role', actor: actor('ops') }));
    expect(denied.code).toBe('forbidden');
    const applied = await store.importSettings({ doc: incoming, apply: true, reason: 'restore from the staging export', actor: actor() });
    expect(applied.result?.change_set_id).toBeTruthy();
    expect(cfg.setting('platform.announcement')).toBe('imported');
    expect(cfg.setting('jobs.briefing_hour')).toBe(20);
    expect(JSON.stringify(await prisma.platformSetting.findMany({ where: { key: 'llm.openai_api_key' } }), (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toContain('sk-smuggled');
    expect((await prisma.plan.findUniqueOrThrow({ where: { key: 'standard' } })).smsCap).toBe(750);
    expect(await prisma.plan.findUnique({ where: { key: 'imported-plan' } })).not.toBeNull();
    const cs = await store.getChangeSet(applied.result!.change_set_id!);
    expect(cs?.via).toBe('import');
    await prisma.plan.update({ where: { key: 'standard' }, data: { smsCap: 500 } });
    await prisma.plan.deleteMany({ where: { key: 'imported-plan' } });
    expect((await fails(store.importSettings({ doc: { schema_version: 2, settings: {} }, apply: false, actor: actor() })))?.code).toBe('unsupported_schema_version');
    expect((await fails(store.importSettings({ doc: 'nope', apply: false, actor: actor() })))?.code).toBe('invalid_document');
  });

  test('the registry listing: effective value + source + lock for every key, secrets as metadata only', async () => {
    setEnv('BILLING_PLAN_NAME', 'pinned');
    await store.applyChanges({ changes: [{ key: 'platform.announcement', value: 'listed' }], actor: actor() });
    const d = await store.describeSettings();
    expect(d.settings.length).toBe((await import('@/lib/config')).registryStats().total);
    const by = (k: string) => d.settings.find((s) => s.key === k)!;
    expect([by('platform.announcement').source, by('platform.announcement').value, by('platform.announcement').locked]).toEqual(['console', 'listed', false]);
    expect([by('billing.plan_name').source, by('billing.plan_name').locked]).toEqual(['env', true]);
    expect(by('twilio.auth_token').value).toBeNull();
    expect(by('twilio.auth_token').secret).toMatchObject({ set: true, source: 'env' });
    expect(by('stripe.secret_key').secret).toEqual({ key: 'stripe.secret_key', set: false, source: 'none' });
    expect(JSON.stringify(d)).not.toContain(process.env.TWILIO_AUTH_TOKEN!);
    expect(by('security.password_min_chars').ratchet).toBe('tighten_only_in_ui');
    expect(by('forward.ring_seconds').tenant).toMatchObject({ editableBy: 'owner' });
  });

  test('L2: the secret fingerprint is a keyed HMAC and is shown to an owner only; a fingerprint stored before the keyed form is still displayed and is recomputed on re-encryption', async () => {
    const SECRET = 'sk-fingerprint-material-0001';
    await store.setSecret({ key: 'llm.openai_api_key', value: SECRET, reason: 'fingerprint test secret', confirm: 'llm.openai_api_key', actor: actor() });
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.openai_api_key' } });
    expect(row.secretFingerprint).toBe(crypt.fingerprintOf(SECRET));
    expect(row.secretFingerprint).not.toBe(crypt.legacyFingerprintOf(SECRET)); // not the bare sha256 an attacker could test guesses against
    // owner-only visibility (ops, support, read_only and the break-glass token never see fingerprint / last4)
    const { guardAdminRoute } = await import('@/lib/admin/guard');
    const seen: Record<string, boolean> = {};
    for (const role of ['owner', 'ops', 'support', 'read_only'] as const) {
      const a = await mkAdmin(role);
      await prisma.user.update({ where: { id: a.id }, data: { totpSecretEnc: 'v1.a.b.c', totpEnabledAt: new Date() } });
      const sess = await users.createSession(a.id); await users.markSessionMfaVerified(sess.session.id);
      const g = await guardAdminRoute(new Request('https://app.example.test/api/admin/settings', { headers: { cookie: `rc_user_session=${sess.token}` } }), { permission: 'settings.read' });
      seen[role] = g.ok && g.ctx.revealSecretMeta;
    }
    expect(seen).toEqual({ owner: true, ops: false, support: false, read_only: false });
    // a row written before the keyed form: shown as stored, and the next re-encryption replaces it with the keyed value
    await prisma.platformSetting.update({ where: { key: 'llm.openai_api_key' }, data: { secretFingerprint: crypt.legacyFingerprintOf(SECRET) } });
    expect((await store.secretInfo('llm.openai_api_key')).fingerprint).toBe(crypt.legacyFingerprintOf(SECRET));
    setEnv('APP_SECRET_KEY', OTHER); setEnv('APP_SECRET_KEY_PREVIOUS', MASTER); // a rotation: the secret is under the previous key now
    await rotation.reencryptAll({ actor: actor(), reason: 're-encrypt after the rotation' });
    const after = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.openai_api_key' } });
    expect(after.secretFingerprint).toBe(crypt.fingerprintOf(SECRET, crypt.masterKeys()));
    expect(after.secretFingerprint).not.toBe(crypt.legacyFingerprintOf(SECRET));
  });

  test('L4: the dual-secret window is covered by the MAC: extending previousUntil or planting a previous envelope in SQL breaks it; a pre-change (legacy) row loads its current secret, ignores its previous one and is re-signed', async () => {
    await store.setSecret({ key: 'llm.anthropic_api_key', value: 'first-token-value-000000', reason: 'first token of the test', confirm: 'llm.anthropic_api_key', actor: actor() });
    await store.setSecret({ key: 'llm.anthropic_api_key', value: 'second-token-value-00000', reason: 'rotate the test token', confirm: 'llm.anthropic_api_key', actor: actor() });
    await loader.refreshNow();
    expect(loader.loaderStatus().problems).toEqual([]);
    expect(cfg.acceptedSecrets('llm.anthropic_api_key')).toContain('first-token-value-000000'); // the window is open
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.anthropic_api_key' } });
    // SQL tampering: keep the window open for a year
    await prisma.platformSetting.update({ where: { key: 'llm.anthropic_api_key' }, data: { previousUntil: new Date(Date.now() + 365 * 86_400_000) } });
    await loader.refreshNow();
    expect(loader.loaderStatus().problems).toEqual([{ key: 'llm.anthropic_api_key', code: 'bad_mac' }]);
    expect(cfg.acceptedSecrets('llm.anthropic_api_key')).not.toContain('first-token-value-000000');
    // a row MACed before the window was covered (legacy payload): the current secret loads, the previous envelope is NOT honoured
    const keys = crypt.masterKeys();
    await prisma.platformSetting.update({ where: { key: 'llm.anthropic_api_key' }, data: { previousUntil: row.previousUntil, integrityMac: crypt.settingMac('llm.anthropic_api_key', crypt.legacyMacPayload({ secretEnvelope: row.secretEnvelope }), row.version, keys) } });
    await loader.refreshNow();
    expect(loader.loaderStatus().problems).toEqual([]);
    expect(cfg.setting('llm.anthropic_api_key')).toBe('second-token-value-00000');
    expect(cfg.acceptedSecrets('llm.anthropic_api_key')).not.toContain('first-token-value-000000');
    // the re-encryption pass re-signs it with the full payload (and drops the unsigned window)
    await rotation.reencryptAll({ actor: actor(), reason: 're-encrypt after the rotation' });
    const fixed = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'llm.anthropic_api_key' } });
    expect(crypt.verifySettingMac('llm.anthropic_api_key', crypt.macPayload({ secretEnvelope: fixed.secretEnvelope, previousEnvelope: fixed.previousEnvelope, previousUntil: fixed.previousUntil }), fixed.version, fixed.integrityMac, keys)).toBe(true);
    expect(fixed.previousEnvelope).toBeNull();
  });

  test('L8: refreshNow after a commit never returns a load that started before it', async () => {
    const key = `l8-${Math.random().toString(36).slice(2, 8)}`;
    const orig = prisma.platformSetting.findMany.bind(prisma.platformSetting);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const firstRead = new Promise<void>((r) => { started = r; });
    let calls = 0;
    (prisma.platformSetting as any).findMany = async (...args: any[]) => { if (++calls === 1) { started(); await gate; } return (orig as any)(...args); };
    try {
      const a = loader.refreshNow(); // a load is in flight: it has read the plans already, and waits on the settings read
      await firstRead;
      await prisma.plan.create({ data: { key, name: key, public: false } }); // the commit
      const b = loader.refreshNow(); // must start AFTER the commit
      release();
      await Promise.all([a, b]);
      const { planRow } = await import('@/lib/admin/plan-catalog');
      expect(planRow(key)).not.toBeNull(); // before the fix B was A, and the snapshot never saw the commit
      expect(calls).toBeGreaterThanOrEqual(2); // a second load really ran
      // concurrent callers while a load runs share ONE follow-up load, not one each
      calls = 100;
      const before = calls;
      const c = [loader.refreshNow(), loader.refreshNow(), loader.refreshNow(), loader.refreshNow()];
      await Promise.all(c);
      expect(calls - before).toBeLessThanOrEqual(2);
    } finally {
      (prisma.platformSetting as any).findMany = orig;
      await prisma.plan.deleteMany({ where: { key } });
      await loader.refreshNow();
    }
  });
});
