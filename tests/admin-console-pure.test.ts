/**
 * Admin console, pure parts (no database): the permission matrix and break-glass rules, envelope v2 (HKDF, kid, AAD, previous key, MAC), fingerprints, the SSRF guard,
 * CSV hardening, plan validation and catalog, tenant-override bounds and quiet-hour rules, the dual-secret window of the config snapshot, the confirmation phrase.
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import {
  PERMISSIONS, PLATFORM_ROLES, SUPPORT_WRITE_SCOPE, adminRoleOf, can, permissionMatrix, roleCan, type AdminLike, type Permission,
} from '../src/lib/admin/permissions';
import {
  CANARY_KEY, SettingsCryptoError, canonicalJson, decryptSetting, encryptSetting, envelopeKid, fingerprintOf, kidOf, last4Of, macPayload, masterKeys, needsReencrypt, settingMac, verifySettingMac,
} from '../src/lib/admin/crypto';
import { assertPublicSmtpTarget, isPrivateAddress, smtpTargetOfUrl } from '../src/lib/admin/ssrf';
import { auditCsv, csvCell } from '../src/lib/admin/audit-search';
import { validatePlanInput } from '../src/lib/admin/plans';
import { allPlanRows, isCompedPlan, planAllows, planRow, setPlanCatalog, type PlanRow } from '../src/lib/admin/plan-catalog';
import { boundsOf, clampTo, effectiveFor, quietHoursSet, quietIsStricter, validateOverride } from '../src/lib/admin/tenant-overrides';
import { auditValue, confirmationPhrase } from '../src/lib/admin/settings-store';
import { statusOfReport } from '../src/lib/admin/job-runs';
import { ConfigSnapshot, acceptedSecrets, setSnapshotSource, settingDef } from '../src/lib/config';
import { smsCapFor, callMinutesCapFor, forwardMinutesCapFor, voicemailMinutesCap } from '../src/lib/db/usage';

const E = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
const MASTER = crypto.randomBytes(32).toString('base64');
const OTHER = crypto.randomBytes(32).toString('base64');
const keysOf = (env: Record<string, string>) => masterKeys(E({ NODE_ENV: 'test', ...env }));
const admin = (role: string | null, via: AdminLike['via'] = 'user'): AdminLike => ({ kind: 'admin', via, user: { platform_role: role } });

describe('permission matrix', () => {
  test('roles map to their set; an admin without a platform role is read_only (fail safe)', () => {
    expect(adminRoleOf(admin('owner'))).toBe('owner');
    expect(adminRoleOf(admin(null))).toBe('read_only');
    expect(adminRoleOf(admin('nonsense'))).toBe('read_only');
    expect(adminRoleOf({ kind: 'admin', via: 'token' })).toBe('bearer');
    expect(adminRoleOf({ kind: 'admin', via: 'cookie' })).toBe('bearer');
    expect(adminRoleOf({ kind: 'admin', via: 'dev' })).toBe('owner');
    expect(adminRoleOf({ kind: 'user' })).toBeNull();
    expect(can({ kind: 'user' }, 'settings.read')).toBe(false);
  });
  test('owner holds everything; read_only holds reads only; no role holds admins.role except the owner', () => {
    for (const p of PERMISSIONS) expect(roleCan('owner', p)).toBe(true);
    const ro = permissionMatrix().read_only;
    expect(ro.every((p) => /\.(read|export)$/.test(p))).toBe(true);
    expect(ro).toContain('settings.read');
    for (const r of PLATFORM_ROLES) expect(roleCan(r, 'admins.role')).toBe(r === 'owner');
  });
  test('ops: no secrets, no critical settings, no import, no admin management', () => {
    for (const p of ['settings.secrets.write', 'settings.write.critical', 'settings.import', 'admins.manage', 'admins.role', 'legal.publish', 'settings.unfreeze'] as Permission[]) expect(roleCan('ops', p)).toBe(false);
    for (const p of ['settings.write', 'plans.write', 'tenants.suspend', 'tenants.billing', 'jobs.run', 'settings.freeze', 'audit.export'] as Permission[]) expect(roleCan('ops', p)).toBe(true);
  });
  test('support: reads and support-enter only; the tenant knobs need an open grant', () => {
    expect(roleCan('support', 'tenants.read')).toBe(true);
    expect(roleCan('support', 'tenants.overrides.write')).toBe(false);
    expect(can(admin('support'), 'tenants.overrides.write')).toBe(false);
    expect(can(admin('support'), 'tenants.overrides.write', { grant: true })).toBe(true);
    expect(can(admin('support'), 'tenants.billing', { grant: true })).toBe(false); // the grant authorises only SUPPORT_WRITE_SCOPE
    expect(can(admin('read_only'), 'tenants.overrides.write', { grant: true })).toBe(false); // a grant never lifts another role
    expect([...SUPPORT_WRITE_SCOPE]).toEqual(['tenants.overrides.write']);
  });
  test('break-glass token: recovery only; settings writes need ADMIN_TOKEN_ALLOW_SETTINGS=true', () => {
    const t = { kind: 'admin', via: 'token' } as AdminLike;
    for (const p of ['settings.read', 'settings.freeze', 'settings.unfreeze', 'settings.rollback', 'settings.rollback.critical', 'admins.recover', 'tenants.billing', 'jobs.run'] as Permission[]) expect(can(t, p, { env: E({}) })).toBe(true);
    for (const p of ['settings.write', 'settings.write.critical', 'settings.secrets.write', 'settings.import', 'plans.write', 'legal.write', 'legal.publish', 'admins.role', 'admins.manage', 'tenants.suspend', 'tenants.overrides.write', 'tenants.support_enter'] as Permission[]) expect(can(t, p, { env: E({}) })).toBe(false);
    for (const p of ['settings.write', 'settings.write.critical', 'settings.secrets.write', 'settings.import'] as Permission[]) expect(can(t, p, { env: E({ ADMIN_TOKEN_ALLOW_SETTINGS: 'true' }) })).toBe(true);
    expect(can(t, 'plans.write', { env: E({ ADMIN_TOKEN_ALLOW_SETTINGS: 'true' }) })).toBe(false); // the flag opens settings and secrets only
    expect(can(t, 'settings.write', { env: E({ ADMIN_TOKEN_ALLOW_SETTINGS: 'false' }) })).toBe(false);
  });
});

describe('envelope v2', () => {
  test('round trip; kid is the first 8 chars of base64url(sha256(derived key)); AAD binds the setting key', () => {
    const k = keysOf({ APP_SECRET_KEY: MASTER });
    const env = encryptSetting('sk_' + 'live_abcdefghij', 'stripe.secret_key', k);
    expect(env.split('.')).toHaveLength(5);
    expect(env.startsWith('v2.')).toBe(true);
    expect(envelopeKid(env)).toBe(k.current.kid);
    expect(k.current.kid).toHaveLength(8);
    expect(decryptSetting(env, 'stripe.secret_key', k)).toBe('sk_' + 'live_abcdefghij');
    expect(() => decryptSetting(env, 'stripe.webhook_secret', k)).toThrow(SettingsCryptoError); // moved to another key
    expect(env).not.toContain('sk_live');
    expect(encryptSetting('same', 'a.b', k)).not.toBe(encryptSetting('same', 'a.b', k)); // fresh IV
  });
  test('a tampered envelope or a different master key never decrypts; the error says nothing about the plaintext', () => {
    const k = keysOf({ APP_SECRET_KEY: MASTER });
    const env = encryptSetting('hunter2-hunter2', 'x.y', k);
    const parts = env.split('.');
    parts[4] = Buffer.from('tampered-ciphertext').toString('base64url');
    expect(() => decryptSetting(parts.join('.'), 'x.y', k)).toThrow(/authentication|envelope/);
    expect(() => decryptSetting('v1.a.b.c', 'x.y', k)).toThrow(SettingsCryptoError);
    expect(() => decryptSetting(env, 'x.y', keysOf({ APP_SECRET_KEY: OTHER }))).toThrow(/APP_SECRET_KEY_PREVIOUS/); // unknown kid -> tells the operator what to do
    try { decryptSetting(env, 'x.y', keysOf({ APP_SECRET_KEY: OTHER })); } catch (e) { expect(String((e as Error).message)).not.toContain('hunter2'); }
  });
  test('rotation: APP_SECRET_KEY_PREVIOUS decrypts old envelopes (and verifies old MACs); new writes use the current key; needsReencrypt says which', () => {
    const oldKeys = keysOf({ APP_SECRET_KEY: OTHER });
    const old = encryptSetting('rotating-secret-value', 'twilio.auth_token', oldKeys);
    const rotated = keysOf({ APP_SECRET_KEY: MASTER, APP_SECRET_KEY_PREVIOUS: OTHER });
    expect(rotated.previous?.kid).toBe(oldKeys.current.kid);
    expect(decryptSetting(old, 'twilio.auth_token', rotated)).toBe('rotating-secret-value');
    expect(needsReencrypt(old, rotated)).toBe(true);
    const fresh = encryptSetting('rotating-secret-value', 'twilio.auth_token', rotated);
    expect(needsReencrypt(fresh, rotated)).toBe(false);
    expect(envelopeKid(fresh)).toBe(rotated.current.kid);
    const mac = settingMac('twilio.auth_token', macPayload({ secretEnvelope: old }), 7, oldKeys);
    expect(verifySettingMac('twilio.auth_token', macPayload({ secretEnvelope: old }), 7, mac, rotated)).toBe(true); // old MAC still valid during the rotation
    expect(verifySettingMac('twilio.auth_token', macPayload({ secretEnvelope: old }), 7, mac, keysOf({ APP_SECRET_KEY: MASTER }))).toBe(false); // previous key removed
    expect(keysOf({ APP_SECRET_KEY: MASTER, APP_SECRET_KEY_PREVIOUS: MASTER }).previous).toBeNull(); // same key twice: nothing to do
    expect(keysOf({ APP_SECRET_KEY: MASTER, APP_SECRET_KEY_PREVIOUS: 'not-32-bytes' }).previous).toBeNull();
  });
  test('MAC covers key, value and version: any change fails it', () => {
    const k = keysOf({ APP_SECRET_KEY: MASTER });
    const p = macPayload({ value: { b: 2, a: 1 } });
    const mac = settingMac('messaging.sms_allowed_countries', p, 3, k);
    expect(verifySettingMac('messaging.sms_allowed_countries', macPayload({ value: { a: 1, b: 2 } }), 3, mac, k)).toBe(true); // key order is irrelevant after a jsonb round trip
    expect(verifySettingMac('messaging.sms_allowed_countries', macPayload({ value: { a: 1, b: 3 } }), 3, mac, k)).toBe(false);
    expect(verifySettingMac('forward.allowed_countries', p, 3, mac, k)).toBe(false);
    expect(verifySettingMac('messaging.sms_allowed_countries', p, 4, mac, k)).toBe(false);
    expect(verifySettingMac('messaging.sms_allowed_countries', p, 3, '', k)).toBe(false);
    expect(verifySettingMac('messaging.sms_allowed_countries', p, 3, 'zz', k)).toBe(false);
    expect(canonicalJson([1, { z: null, a: 'x' }])).toBe('[1,{"a":"x","z":null}]');
    expect(CANARY_KEY).toBe('_canary');
  });
  test('fingerprint is sha256[0..8]; last4 only for long secrets', () => {
    expect(fingerprintOf('abc')).toBe(crypto.createHash('sha256').update('abc').digest('hex').slice(0, 8));
    expect(last4Of('0123456789abcdef')).toBe('cdef');
    expect(last4Of('short-secret')).toBeNull();
    expect(kidOf(Buffer.alloc(32))).toHaveLength(8);
  });
});

describe('SSRF guard (SMTP relay)', () => {
  test('private, loopback, link-local, CGNAT, ULA, metadata and mapped addresses are refused; public ones pass', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fd12::3', 'fe80::1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', 'not-an-ip']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip)).toBe(false);
  });
  test('host and port rules, resolution, and DNS rebinding (a host that now resolves private)', async () => {
    const pub = async () => ['203.0.113.5'];
    await expect(assertPublicSmtpTarget('smtp.example.com', 587, pub)).resolves.toBeUndefined();
    await expect(assertPublicSmtpTarget('smtp.example.com', 5432, pub)).rejects.toThrow(/port/);
    await expect(assertPublicSmtpTarget('localhost', 587, pub)).rejects.toThrow(/public/);
    await expect(assertPublicSmtpTarget('postgres.internal', 587, pub)).rejects.toThrow(/public/);
    await expect(assertPublicSmtpTarget('169.254.169.254', 25, pub)).rejects.toThrow(/public/);
    await expect(assertPublicSmtpTarget('smtp.example.com', 587, async () => ['203.0.113.5', '10.0.0.7'])).rejects.toThrow(/public/); // one private answer is enough to refuse
    await expect(assertPublicSmtpTarget('rebind.example.com', 587, async () => ['127.0.0.1'])).rejects.toThrow(/public/);
    await expect(assertPublicSmtpTarget('nx.example.com', 587, async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/resolve/);
    await expect(assertPublicSmtpTarget('a b', 587, pub)).rejects.toThrow(/invalid/);
    await expect(assertPublicSmtpTarget('smtp.example.com', undefined, pub)).resolves.toBeUndefined();
    expect(smtpTargetOfUrl('smtps://u:p@mail.example.com')).toEqual({ host: 'mail.example.com', port: 465 });
    expect(smtpTargetOfUrl('smtp://u:p@mail.example.com:2525')).toEqual({ host: 'mail.example.com', port: 2525 });
    expect(smtpTargetOfUrl('http://x')).toBeNull();
  });
});

describe('CSV export hardening', () => {
  test('formula injection is neutralised, quotes doubled, objects serialised', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    for (const lead of ['+1', '-1', '@x', '\tx', '\rx']) expect(csvCell(lead).startsWith(`"'`)).toBe(true);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    const csv = auditCsv([{ id: '1', at: '2026-01-01T00:00:00.000Z', actor_kind: 'user', actor_user_id: null, business_id: null, action: 'x.y', target: '=cmd|calc', ip: null, meta: { k: 'v' } }]);
    expect(csv.split('\n')[0]).toBe('id,at,actor_kind,actor_user_id,business_id,action,target,ip,meta');
    expect(csv).toContain(`"'=cmd|calc"`);
  });
});

describe('audit values are redacted by KIND', () => {
  test('secrets never; url credentials stripped; long text and long lists cut; plain values untouched', () => {
    expect(auditValue({ kind: 'secret' }, 'sk_' + 'live_xxxxxxxxxxxxxxxx')).toBe('[secret]');
    expect(auditValue({ kind: 'url' }, 'https://user:pw@example.com/x')).not.toContain('pw');
    expect(auditValue({ kind: 'string' }, 'x'.repeat(400)) as string).toHaveLength(301);
    expect((auditValue({ kind: 'list' }, Array.from({ length: 80 }, (_, i) => String(i))) as unknown[]).length).toBe(51);
    expect(auditValue({ kind: 'int' }, 42)).toBe(42);
    // a key that LOOKS secret is not redacted by name: the value is plain (sanitizeAuditMeta would have mangled `token`-like keys; kind decides here)
    expect(auditValue({ kind: 'string' }, 'tokenised value')).toBe('tokenised value');
  });
  test('confirmation phrase: the key for one, a count for several', () => {
    expect(confirmationPhrase(['billing.enforced'])).toBe('billing.enforced');
    expect(confirmationPhrase(['a.b', 'c.d'])).toBe('apply 2 critical settings');
  });
});

describe('plans: validation, catalog, caps', () => {
  test('validatePlanInput', () => {
    expect(validatePlanInput({ name: 'Pro', sms_cap: 1000, features: { owner_reply: false }, public: true, stripe_price_id: 'price_1ABC2def' }, { partial: false }).ok).toBe(true);
    for (const bad of [{ name: '' }, { name: 'x', sms_cap: -1 }, { name: 'x', sms_cap: 1.5 }, { name: 'x', trial_days: 400 }, { name: 'x', max_locations: 0 }, { name: 'x', features: { nope: true } },
      { name: 'x', features: { owner_reply: 'no' } }, { name: 'x', stripe_price_id: 'prod_1' }, { name: 'x', surprise: 1 }, { name: 'x', public: 'yes' }, 'str', null, []]) {
      expect(validatePlanInput(bad, { partial: false }).ok).toBe(false);
    }
    expect(validatePlanInput({}, { partial: true }).ok).toBe(true);
    expect(validatePlanInput({}, { partial: false }).ok).toBe(false); // name required on create
    const r = validatePlanInput({ name: 'A', is_comped: true, sms_cap: null }, { partial: false });
    expect(r.ok && (r.data as Record<string, unknown>).isComped).toBe(true);
  });
  const row = (o: Partial<PlanRow> & { key: string }): PlanRow => ({
    name: o.key, public: false, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: null, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null,
    forward_minutes_cap: null, max_locations: null, features: {}, sort: 100, archived_at: null, ...o,
  });
  test('catalog: comped, entitlements default to ON, caps precedence is business override > env pin > plan row > platform default', () => {
    expect(isCompedPlan('legacy')).toBe(true);
    expect(isCompedPlan('standard')).toBe(false); // no catalog: the historic list
    setPlanCatalog([row({ key: 'legacy' }), row({ key: 'standard', sms_cap: 500 }), row({ key: 'pro', sms_cap: 2000, call_minutes_cap: 900, voicemail_minutes_cap: 120, forward_minutes_cap: 1200, features: { owner_reply: false }, is_comped: true }), row({ key: 'bare' })]);
    try {
      expect(allPlanRows().map((p) => p.key)).toEqual(['bare', 'legacy', 'pro', 'standard']);
      expect(isCompedPlan('pro')).toBe(true);
      expect(isCompedPlan('legacy')).toBe(false); // the catalog row is authoritative once loaded (an admin may un-comp it)
      expect(isCompedPlan('grandfathered')).toBe(true); // a plan with no row falls back to the historic list
      expect(planAllows('pro', 'owner_reply')).toBe(false);
      expect(planAllows('pro', 'owner_callin')).toBe(true);
      expect(planAllows('ghost', 'owner_reply')).toBe(true);
      expect(planAllows(null, 'owner_reply')).toBe(true);
      expect(planRow('pro')?.sms_cap).toBe(2000);
      const env = E({ NODE_ENV: 'test' });
      expect(smsCapFor({ billing_status: 'active', plan: 'pro' }, env)).toBe(2000);
      expect(smsCapFor({ billing_status: 'active', plan: 'bare' }, env)).toBe(500); // NULL cap: the platform default
      expect(smsCapFor({ billing_status: 'active', plan: 'ghost' }, env)).toBe(500);
      expect(smsCapFor({ billing_status: 'active', plan: 'pro', sms_cap_override: 7 }, env)).toBe(7);
      expect(smsCapFor({ billing_status: 'trialing', plan: 'pro' }, env)).toBe(50); // trial cap still bounds the plan
      expect(smsCapFor({ billing_status: 'active', plan: 'pro' }, E({ NODE_ENV: 'test', PLAN_SMS_CAP: '123' }))).toBe(123); // an env pin of the platform key wins over the plan row (D1)
      expect(callMinutesCapFor({ billing_status: 'active', plan: 'pro' }, env)).toBe(900);
      expect(forwardMinutesCapFor({ billing_status: 'active', plan: 'pro' }, env)).toBe(1200);
      expect(voicemailMinutesCap(env, 'pro')).toBe(120);
      expect(voicemailMinutesCap(env)).toBe(60);
    } finally { setPlanCatalog(null); }
    // with NO catalog the numbers are exactly today's defaults
    expect(smsCapFor({ billing_status: 'active', plan: 'pro' }, E({ NODE_ENV: 'test' }))).toBe(500);
    expect(callMinutesCapFor({ billing_status: 'active' }, E({ NODE_ENV: 'test' }))).toBe(300);
  });
});

describe('tenant overrides: bounds, clamping, quiet hours', () => {
  test('numeric bounds are the tighter of the tenant rule and the schema; clamp is at both ends', () => {
    const ring = settingDef('forward.ring_seconds')!;
    const b = boundsOf(ring);
    expect(b.min).toBeGreaterThanOrEqual(10);
    expect(b.max).toBeLessThanOrEqual(40);
    expect(clampTo(5, b)).toBe(b.min!);
    expect(clampTo(999, b)).toBe(b.max!);
    expect(clampTo(20, b)).toBe(20);
  });
  test('validateOverride: not a tenant key, wrong type, out of bounds', () => {
    const ring = settingDef('forward.ring_seconds');
    expect(validateOverride(settingDef('twilio.auth_token'), 'x').ok).toBe(false);
    expect(validateOverride(undefined, 1).ok).toBe(false);
    expect(validateOverride(ring, 'abc').ok).toBe(false);
    expect(validateOverride(ring, 41).ok).toBe(false); // above the schema / tenant ceiling
    expect(validateOverride(ring, 9).ok).toBe(false);
    // a tenant rule tighter than the platform schema: out_of_bounds with the range
    const tight = { ...ring!, tenant: { ...ring!.tenant!, min: 12, max: 30 } };
    const hi = validateOverride(tight, 35);
    expect(!hi.ok && hi.problem.code).toBe('out_of_bounds');
    expect(!hi.ok && hi.problem.bounds).toEqual({ min: 12, max: 30 });
    expect(validateOverride(tight, 11).ok).toBe(false);
    expect(validateOverride(tight, 30)).toEqual({ ok: true, value: 30 });
    expect(validateOverride(ring, 25)).toEqual({ ok: true, value: 25 });
    expect(validateOverride(settingDef('jobs.briefing_enabled'), true)).toEqual({ ok: true, value: true });
  });
  test('quiet hours: the window may only be extended; start==end is an empty window', () => {
    expect([...quietHoursSet(21, 8)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 21, 22, 23]);
    expect(quietHoursSet(5, 5).size).toBe(0);
    expect(quietIsStricter(20, 9, 21, 8)).toBe(true);
    expect(quietIsStricter(21, 8, 21, 8)).toBe(true);
    expect(quietIsStricter(22, 8, 21, 8)).toBe(false); // starts later: 21:xx is no longer quiet
    expect(quietIsStricter(21, 7, 21, 8)).toBe(false);
    expect(quietIsStricter(0, 23, 21, 8)).toBe(false); // 21..22 would be loud
    expect(quietIsStricter(0, 24 - 1, 22, 6)).toBe(false);
    const start = settingDef('messaging.quiet_start_hour');
    expect(validateOverride(start, 20)).toEqual({ ok: true, value: 20 }); // platform default 21 -> 20 is stricter
    const loosen = validateOverride(start, 23);
    expect(!loosen.ok && loosen.problem.code).toBe('not_stricter');
    const pair = validateOverride(settingDef('messaging.quiet_end_hour'), 6, { 'messaging.quiet_start_hour': 20 });
    expect(!pair.ok && pair.problem.code).toBe('not_stricter'); // 6 ends earlier than the platform 8
  });
  test('read-time clamp and re-validation: a stored out-of-bounds or no-longer-stricter value never takes effect unclamped', () => {
    const ring = settingDef('forward.ring_seconds')!;
    const tight = { ...ring, tenant: { ...ring.tenant!, max: 30 } }; // the platform tightened the bound AFTER the owner stored 35
    const e = effectiveFor(tight, { 'forward.ring_seconds': 35 });
    expect(e.source).toBe('tenant');
    expect(e.clamped).toBe(true);
    expect(e.value).toBe(30);
    expect(effectiveFor(ring, { 'forward.ring_seconds': 500 }).ignored_override).toBe(true); // beyond the schema: ignored, never applied
    expect(effectiveFor(ring, {}).source).toBe('platform');
    expect(effectiveFor(ring, { 'forward.ring_seconds': 'garbage' }).ignored_override).toBe(true);
    const qs = settingDef('messaging.quiet_start_hour')!;
    expect(effectiveFor(qs, { 'messaging.quiet_start_hour': 23 }).ignored_override).toBe(true);
    expect(effectiveFor(qs, { 'messaging.quiet_start_hour': 20 }).value).toBe(20);
  });
});

describe('config snapshot: dual-secret window', () => {
  test('acceptedSecrets: current first, previous only inside its window, never an env pin window', () => {
    const now = Date.now();
    const snap = new ConfigSnapshot({ version: 3, values: {}, secrets: { 'twilio.auth_token': 'new-token-value-123' }, previousSecrets: { 'twilio.auth_token': { value: 'old-token-value-456', until: now + 60_000 } } });
    setSnapshotSource(() => snap);
    const saved = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    try {
      expect(acceptedSecrets('twilio.auth_token', now)).toEqual(['new-token-value-123', 'old-token-value-456']);
      expect(acceptedSecrets('twilio.auth_token', now + 61_000)).toEqual(['new-token-value-123']);
      expect(snap.previousSecret('twilio.auth_token', now + 61_000)).toBeUndefined();
      process.env.TWILIO_AUTH_TOKEN = 'env-pinned-token-789';
      expect(acceptedSecrets('twilio.auth_token', now)).toEqual(['env-pinned-token-789']); // the environment wins, and has no window
      // neither the snapshot nor its inspection ever prints a secret
      expect(JSON.stringify(snap)).not.toContain('token-value');
      expect(String(snap)).not.toContain('token-value');
      expect(Object.keys(snap)).not.toContain('secrets');
    } finally {
      setSnapshotSource(null);
      if (saved === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = saved;
    }
  });
});

describe('job run status', () => {
  test('errors -> error; only refusals and nothing processed -> skipped; otherwise ok (dry runs and zero-work runs are ok)', () => {
    expect(statusOfReport({ dry_run: false, processed: 1, errors: 1 })).toBe('error');
    expect(statusOfReport({ dry_run: false, processed: 0, errors: 0, items: [{ outcome: 'busy' }] })).toBe('skipped');
    expect(statusOfReport({ dry_run: false, processed: 0, errors: 0, items: [{ outcome: 'refused_not_enabled' }] })).toBe('skipped');
    expect(statusOfReport({ dry_run: true, processed: 0, errors: 0, items: [{ outcome: 'would_delete' }] })).toBe('ok');
    expect(statusOfReport({ dry_run: false, processed: 0, errors: 0, items: [] })).toBe('ok');
  });
});

describe('verifiers accept the previous secret inside the 15 minute window (and only then)', () => {
  test('Twilio signature, ElevenLabs HMAC and tool secret', async () => {
    const { verifyTwilioSignature } = await import('../src/lib/providers/twilio');
    const { verifyElevenLabsSignature, verifyToolSecret, TOOL_SECRET_HEADER } = await import('../src/lib/voice/elevenlabs');
    const now = Date.now();
    const snap = (until: number) => new ConfigSnapshot({
      version: 5, values: {},
      secrets: { 'twilio.auth_token': 'twilio-token-NEW-0000', 'elevenlabs.webhook_secret': 'el-webhook-NEW-0000', 'elevenlabs.tool_secret': 'tool-secret-NEW-0000' },
      previousSecrets: { 'twilio.auth_token': { value: 'twilio-token-OLD-1111', until }, 'elevenlabs.webhook_secret': { value: 'el-webhook-OLD-1111', until }, 'elevenlabs.tool_secret': { value: 'tool-secret-OLD-1111', until } },
    });
    const saved = { t: process.env.TWILIO_AUTH_TOKEN, w: process.env.ELEVENLABS_WEBHOOK_SECRET, s: process.env.ELEVENLABS_TOOL_SECRET };
    delete process.env.TWILIO_AUTH_TOKEN; delete process.env.ELEVENLABS_WEBHOOK_SECRET; delete process.env.ELEVENLABS_TOOL_SECRET;
    try {
      // Twilio: sign with the OLD token
      const url = 'https://app.example.test/api/sms/inbound';
      const params = { Body: 'hi', From: '+13055550101' };
      const sign = (token: string) => crypto.createHmac('sha1', token).update(url + Object.keys(params).sort().reduce((a, k) => a + k + (params as Record<string, string>)[k], ''), 'utf8').digest('base64');
      const twReq = (token: string) => new Request(url, { method: 'POST', headers: { 'x-twilio-signature': sign(token) } });
      setSnapshotSource(() => snap(now + 60_000));
      expect(verifyTwilioSignature(twReq('twilio-token-NEW-0000'), params).ok).toBe(true);
      expect(verifyTwilioSignature(twReq('twilio-token-OLD-1111'), params).ok).toBe(true); // inside the window
      expect(verifyTwilioSignature(twReq('twilio-token-ATTACKER'), params).ok).toBe(false);
      // ElevenLabs HMAC and tool secret
      const t = String(Math.floor(now / 1000));
      const body = '{"x":1}';
      const sig = (secret: string) => `t=${t},v0=${crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')}`;
      expect(verifyElevenLabsSignature(body, sig('el-webhook-NEW-0000')).ok).toBe(true);
      expect(verifyElevenLabsSignature(body, sig('el-webhook-OLD-1111')).ok).toBe(true);
      expect(verifyElevenLabsSignature(body, sig('el-webhook-ATTACKER')).ok).toBe(false);
      const tool = (v: string) => new Request('https://app.example.test/api/voice/tools/x', { headers: { [TOOL_SECRET_HEADER]: v } });
      expect(verifyToolSecret(tool('tool-secret-NEW-0000')).ok).toBe(true);
      expect(verifyToolSecret(tool('tool-secret-OLD-1111')).ok).toBe(true);
      expect(verifyToolSecret(tool('nope')).ok).toBe(false);
      // after the window the old secrets stop working
      setSnapshotSource(() => snap(Date.now() - 1));
      expect(verifyTwilioSignature(twReq('twilio-token-OLD-1111'), params).ok).toBe(false);
      expect(verifyElevenLabsSignature(body, sig('el-webhook-OLD-1111')).ok).toBe(false);
      expect(verifyToolSecret(tool('tool-secret-OLD-1111')).ok).toBe(false);
      expect(verifyTwilioSignature(twReq('twilio-token-NEW-0000'), params).ok).toBe(true);
    } finally {
      setSnapshotSource(null);
      if (saved.t !== undefined) process.env.TWILIO_AUTH_TOKEN = saved.t;
      if (saved.w !== undefined) process.env.ELEVENLABS_WEBHOOK_SECRET = saved.w;
      if (saved.s !== undefined) process.env.ELEVENLABS_TOOL_SECRET = saved.s;
    }
  });
});
