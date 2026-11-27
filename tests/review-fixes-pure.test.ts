/**
 * Adversarial-review fixes, pure parts (no database): the permission scope of support write mode and the platform routes, SSRF classification of non-canonical IPv6, the pinned
 * SMTP target, SMTP candidate credentials, linear-time markdown, owner on/off switches, cap precedence, plan features in call routing, MAC coverage of the dual-secret window,
 * typed confirmation phrases and the support gate's path matching.
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { PERMISSIONS, SUPPORT_WRITE_ROUTES, SUPPORT_WRITE_SCOPE, can, roleCan, supportMayWriteRoute, type AdminLike } from '../src/lib/admin/permissions';
import { PLATFORM_WRITE_ROUTES, isOpenPath, targetBusinessOf } from '../src/lib/admin/support-gate';
import { assertPublicSmtpTarget, ipv6Groups, isPrivateAddress, resolvePublicSmtpTarget } from '../src/lib/admin/ssrf';
import { parseMarkdown, inlineText } from '../src/lib/markdown';
import { effectiveFor } from '../src/lib/admin/tenant-effective';
import { validateOverride } from '../src/lib/admin/tenant-overrides';
import { callMinutesCapFor, forwardMinutesCapFor, smsCapFor, voicemailMinutesCap } from '../src/lib/db/usage';
import { resolveCallRoute } from '../src/lib/voice/call-mode';
import { setPlanCatalog, type PlanRow } from '../src/lib/admin/plan-catalog';
import { legacyMacPayload, macPayload, masterKeys, settingMac, verifySettingMac } from '../src/lib/admin/crypto';
import { requireConfirmPhrase, requireReason, tenantPhraseOf, TENANT_VERBS } from '../src/lib/admin/confirm';
import { smtpTargetOf } from '../src/lib/admin/provider-tests';
import { ConfigSnapshot, setSnapshotSource, settingDef } from '../src/lib/config';
import { knobFrom, knobOrFrom } from '../src/lib/admin/tenant-knobs';

const admin = (role: string | null, via: AdminLike['via'] = 'user'): AdminLike => ({ kind: 'admin', via, user: { platform_role: role } });
const E = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('H2/H3/L5: permissions and the gate paths', () => {
  test('support write mode authorises ONLY the documented scope; no tenant route is open to it', () => {
    expect([...SUPPORT_WRITE_SCOPE]).toEqual(['tenants.overrides.write']);
    expect(SUPPORT_WRITE_ROUTES).toEqual([]);
    for (const [m, p] of [['POST', '/api/bookings/x/refund'], ['POST', '/api/team/invite'], ['POST', '/api/privacy/erase'], ['PUT', '/api/businesses/abc/forward-number'], ['POST', '/api/sms/send'], ['POST', '/api/payments/create-link']]) {
      expect(supportMayWriteRoute(m, p)).toBe(false);
    }
    // with a grant the support role gains exactly the one permission and nothing else
    for (const perm of PERMISSIONS) expect([perm, can(admin('support'), perm, { grant: true })]).toEqual([perm, roleCan('support', perm) || perm === 'tenants.overrides.write']);
  });
  test('creating a tenant and provisioning are platform actions: owner / ops / bearer only; read_only and support have neither permission', () => {
    expect(PLATFORM_WRITE_ROUTES.map((r) => [r.method, r.permission])).toEqual([['POST', 'tenants.users.create'], ['POST', 'providers.repair'], ['POST', 'settings.write.critical']]);
    expect(roleCan('ops', 'settings.write.critical')).toBe(false); // the demo wipe is an owner action, never granted by a tenant grant
    for (const r of PLATFORM_WRITE_ROUTES.slice(0, 2)) {
      expect(roleCan('read_only', r.permission)).toBe(false);
      expect(roleCan('support', r.permission)).toBe(false);
      for (const ok of ['owner', 'ops', 'bearer'] as const) expect(roleCan(ok, r.permission)).toBe(true);
    }
    const hit = (m: string, p: string) => PLATFORM_WRITE_ROUTES.some((r) => r.method === m && r.re.test(p));
    expect(hit('POST', '/api/businesses')).toBe(true);
    expect(hit('POST', '/api/businesses/abc-123/provision')).toBe(true);
    expect(hit('POST', '/api/businesses/abc-123/provision/extra')).toBe(false);
    expect(hit('POST', '/api/businesses/mine')).toBe(false);
  });
  test('open paths match on segment boundaries: /api/me/locale only, not /api/media or /api/me/anything', () => {
    for (const p of ['/api/me/locale', '/api/admin/settings', '/api/admin', '/api/auth/login', '/api/health', '/api/health/x']) expect([p, isOpenPath(p)]).toEqual([p, true]);
    for (const p of ['/api/media', '/api/me', '/api/me/other', '/api/me/locale/x', '/api/administrator', '/api/authz', '/api/healthz', '/api/healthcheck', '/api/bookings']) expect([p, isOpenPath(p)]).toEqual([p, false]);
  });
  test('the gate names a tenant only from the URL (path or ?business_id=), never from the rc_business cookie', () => {
    const r = (u: string, cookie?: string) => new Request(`http://x${u}`, { method: 'POST', headers: cookie ? { cookie } : {} });
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(targetBusinessOf(r(`/api/businesses/${id}/review-url`))).toBe(id);
    expect(targetBusinessOf(r('/api/bookings?business_id=B1'))).toBe('B1');
    expect(targetBusinessOf(r('/api/team/invite', 'rc_business=A1'))).toBeNull(); // the cookie is a dashboard hint, not a target
    expect(targetBusinessOf(r('/api/businesses/mine'))).toBeNull();
  });
});

describe('M3: SSRF classification works on parsed addresses', () => {
  test('non-canonical spellings of private addresses are private', () => {
    for (const ip of ['::ffff:7f00:1', '0:0:0:0:0:0:0:1', '0::1', '::ffff:a9fe:a9fe', '::127.0.0.1', 'fec0::1', '2002:7f00:1::', '::', '0:0:0:0:0:0:0:0', '::ffff:127.0.0.1', '::FFFF:7F00:0001', '[::1]',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', 'fe80::1%eth0', 'FC00::1', 'ff02::1', '64:ff9b::7f00:1', '2002:0a00:0001::1', '::ffff:0:7f00:1', '0000:0000:0000:0000:0000:ffff:c0a8:0101',
      '::192.168.0.1', '100::1', '169.254.169.254', '0.0.0.0', '100.64.0.1', 'not-an-ip', '']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  });
  test('public addresses stay public (v4, global unicast v6, v4-mapped public, 6to4 of a public v4)', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '2002:0808:0808::1']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });
  test('the groups parser handles every textual form and rejects junk', () => {
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(ipv6Groups('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('1:2:3')).toBeNull();
    expect(ipv6Groups('1.2.3.4')).toBeNull();
  });
  test('resolvePublicSmtpTarget returns THE address to connect to (one lookup), and refuses a mixed answer', async () => {
    let calls = 0;
    const pub = async () => { calls++; return ['8.8.4.4', '8.8.8.8']; };
    await expect(resolvePublicSmtpTarget('smtp.example.com', 587, pub)).resolves.toBe('8.8.4.4');
    expect(calls).toBe(1);
    await expect(resolvePublicSmtpTarget('smtp.example.com', 587, async () => ['8.8.8.8', '::ffff:7f00:1'])).rejects.toMatchObject({ code: 'private_address' });
    await expect(resolvePublicSmtpTarget('8.8.8.8', 587)).resolves.toBe('8.8.8.8'); // an IP literal needs no lookup
    await expect(assertPublicSmtpTarget('mail.example.com', 587, async () => ['0:0:0:0:0:0:0:1'])).rejects.toMatchObject({ code: 'private_address' });
  });
});

describe('M1: an SMTP candidate that names the target never inherits the stored login', () => {
  const stored: Record<string, string> = { 'email.smtp_host': 'stored.example.com', 'email.smtp_port': '587', 'email.smtp_user': 'stored-user', 'email.smtp_pass': 'stored-password', 'email.smtp_url': '', 'email.smtp_secure': '' };
  const getWith = (cand: Record<string, string>) => (key: string): string => (Object.prototype.hasOwnProperty.call(cand, key) ? cand[key] : stored[key] ?? '');
  test('host / port / url in the candidate: stored user and password are NOT used', () => {
    for (const cand of [{ 'email.smtp_host': 'attacker.example' }, { 'email.smtp_port': '2525' }, { 'email.smtp_host': 'a.example', 'email.smtp_port': '25' }] as Record<string, string>[]) {
      const t = smtpTargetOf(getWith(cand) as never, cand);
      expect(t).not.toBeNull();
      expect([t!.user, t!.pass]).toEqual([null, null]);
    }
  });
  test('credentials the candidate carries itself are used; a candidate without a target keeps the stored login (testing a new password against the stored host)', () => {
    const own = { 'email.smtp_host': 'a.example', 'email.smtp_user': 'u2', 'email.smtp_pass': 'p2' };
    const t = smtpTargetOf(getWith(own) as never, own);
    expect([t!.host, t!.user, t!.pass]).toEqual(['a.example', 'u2', 'p2']);
    const pwOnly = { 'email.smtp_pass': 'new-password' };
    const t2 = smtpTargetOf(getWith(pwOnly) as never, pwOnly);
    expect([t2!.host, t2!.user, t2!.pass]).toEqual(['stored.example.com', 'stored-user', 'new-password']);
    expect(smtpTargetOf(getWith({}) as never, {})!.pass).toBe('stored-password'); // no candidate: the stored configuration is tested as stored
  });
  test('a candidate URL carries its own login (the stored one is not merged in)', () => {
    const cand = { 'email.smtp_url': 'smtp://x.example:587' };
    const t = smtpTargetOf(getWith(cand) as never, cand);
    expect([t!.host, t!.user, t!.pass]).toEqual(['x.example', null, null]);
  });
});

describe('M5: markdown parses in linear time on adversarial input', () => {
  const N = 40_000;
  const bounded: [string, string][] = [
    ['unclosed emphasis', '*a '.repeat(N)], ['unclosed strong', '**a '.repeat(N)], ['unclosed underscore', '_a '.repeat(N)], ['open brackets', '['.repeat(N)], ['link openers', '[a]('.repeat(N)],
    ['half links', '[a](b'.repeat(N)], ['angle brackets', '<'.repeat(N)], ['backticks', '`a '.repeat(N)], ['heading with a long run of spaces', `# a${' '.repeat(N * 3)}b`],
    ['heading hashes', `# a ${'# '.repeat(N * 2)}x`], ['thematic break lookalike', `${'- '.repeat(N * 2)}x`], ['quotes', '> '.repeat(N)], ['nested marks', '*a **b _c '.repeat(N / 3)],
    ['escapes', '\\'.repeat(N * 3)], ['mixed', '[*a '.repeat(N)],
  ];
  for (const [name, src] of bounded) {
    test(name, () => {
      const t = performance.now();
      parseMarkdown(src);
      expect(performance.now() - t).toBeLessThan(1500); // was 3 to 23 s; now milliseconds (the bound leaves room for a slow CI machine)
    });
  }
  test('the output is unchanged for ordinary documents (links, emphasis, headings, rules, nesting)', () => {
    const b = parseMarkdown('# Title #\n\nSome **bold** and *italic* with [a link](https://example.com/x_(y)) and `code`.\n\n---\n\n- one\n- two\n\n> quote *em*');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'hr', 'ul', 'quote']);
    const h = b[0] as { t: 'h'; level: number; c: { t: string; v?: string }[] };
    expect([h.level, inlineText(h.c as never)]).toEqual([1, 'Title']);
    const p = b[1] as { t: 'p'; c: { t: string; href?: string }[] };
    expect(p.c.map((x) => x.t)).toEqual(['text', 'strong', 'text', 'em', 'text', 'link', 'text', 'code', 'text']);
    expect(p.c.find((x) => x.t === 'link')!.href).toBe('https://example.com/x_(y)');
    expect(parseMarkdown('####### seven')[0].t).toBe('p');
    expect(parseMarkdown('#')[0].t).toBe('p');
    expect(parseMarkdown('***')[0].t).toBe('hr');
    expect(parseMarkdown('* * *')[0].t).toBe('hr');
    expect(parseMarkdown('**a** and ** b**').length).toBe(1);
    expect((parseMarkdown('a *b* c *d* e')[0] as { c: { t: string }[] }).c.filter((x) => x.t === 'em')).toHaveLength(2);
    expect((parseMarkdown('*a *b* c')[0] as { c: { t: string }[] }).c.some((x) => x.t === 'em')).toBe(true); // an unmatched opener does not stop a later pair
  });
});

describe('M8: an owner can only switch OFF what the platform has on', () => {
  const def = settingDef('jobs.briefing_enabled')!;
  test('effective = platform && override', () => {
    expect(effectiveFor(def, { 'jobs.briefing_enabled': false })).toMatchObject({ value: false, source: 'tenant' });
    expect(effectiveFor(def, { 'jobs.briefing_enabled': true })).toMatchObject({ value: true, source: 'tenant' });
    expect(effectiveFor(def, {})).toMatchObject({ value: true, source: 'platform' });
  });
  test('with the platform OFF a stored `true` is ignored and the write is refused (both owner switches)', () => {
    setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'jobs.briefing_enabled': false, 'jobs.gratitude_enabled': false } }));
    try {
      for (const key of ['jobs.briefing_enabled', 'jobs.gratitude_enabled']) {
        const d = settingDef(key)!;
        expect(effectiveFor(d, { [key]: true })).toMatchObject({ value: false, source: 'platform', ignored_override: true });
        expect(effectiveFor(d, { [key]: false })).toMatchObject({ value: false });
        const v = validateOverride(d, true);
        expect(!v.ok && v.problem.code).toBe('not_stricter');
        expect(validateOverride(d, false)).toEqual({ ok: true, value: false });
      }
      expect(knobFrom<boolean>('jobs.briefing_enabled', { 'jobs.briefing_enabled': true })).toBe(false);
      expect(knobOrFrom('jobs.gratitude_enabled', { 'jobs.gratitude_enabled': true }, false)).toBe(false);
    } finally { setSnapshotSource(null); }
  });
});

describe('M7: tenant cap overrides and their precedence', () => {
  const cat = (rows: Partial<PlanRow>[]) => setPlanCatalog(rows.map((r) => ({ key: 'p', name: 'P', public: false, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: null, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, max_locations: null, features: {}, sort: 1, archived_at: null, ...r })));
  test('column override > tenant override > plan row > platform; a trial is still bounded by the trial cap for the tenant override', () => {
    try {
      cat([{ key: 'gold', sms_cap: 1000, call_minutes_cap: 400, forward_minutes_cap: 700, voicemail_minutes_cap: 80 }]);
      const env = E({ NODE_ENV: 'test' });
      const ov = { 'billing.plan_sms_cap': 2000, 'billing.plan_call_minutes_cap': 900, 'forward.minutes_cap': 1500, 'voicemail.minutes_cap': 120 };
      const active = { billing_status: 'active', plan: 'gold' };
      expect(smsCapFor(active, env)).toBe(1000); // plan
      expect(smsCapFor({ ...active, tenant_overrides: ov }, env)).toBe(2000); // tenant override beats the plan
      expect(smsCapFor({ ...active, tenant_overrides: ov, sms_cap_override: 7 }, env)).toBe(7); // the column beats the tenant override
      expect(callMinutesCapFor({ ...active, tenant_overrides: ov }, env)).toBe(900);
      expect(callMinutesCapFor({ ...active, tenant_overrides: ov, call_minutes_cap_override: 3 }, env)).toBe(3);
      expect(forwardMinutesCapFor({ ...active, tenant_overrides: ov }, env)).toBe(1500);
      expect(voicemailMinutesCap(env, 'gold', ov)).toBe(120);
      expect(voicemailMinutesCap(env, 'gold')).toBe(80);
      // trialing: min(tenant override, trial cap)
      expect(smsCapFor({ billing_status: 'trialing', plan: 'gold', tenant_overrides: ov }, env)).toBe(50);
      expect(smsCapFor({ billing_status: 'trialing', plan: 'gold', tenant_overrides: { 'billing.plan_sms_cap': 10 } }, env)).toBe(10);
      // an out-of-bounds / wrong-type stored value is ignored (read-time validation), the plan applies
      expect(smsCapFor({ ...active, tenant_overrides: { 'billing.plan_sms_cap': 'lots' } }, env)).toBe(1000);
      expect(smsCapFor({ ...active, tenant_overrides: { 'billing.plan_sms_cap': -5 } }, env)).toBe(1000); // fails the registry schema: ignored
    } finally { setPlanCatalog(null); }
  });
});

describe('M10: plan features voicemail / call_forwarding change behaviour', () => {
  const biz = { call_mode: 'forward', forward_number_e164: '+13055550123', forward_number_verified_at: '2026-01-01T00:00:00Z', forward_during_hours: false, owner_phone_e164: '+13055550123', owner_phone_verified_at: '2026-01-01T00:00:00Z', hours: {}, timezone: 'America/New_York', closed_dates: [], phone_e164: '+13055550000' } as never;
  test('a plan without call_forwarding routes a forward-mode business to the AI', () => {
    try {
      setPlanCatalog([{ key: 'basic', name: 'Basic', public: true, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: null, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, max_locations: null, features: { call_forwarding: false }, sort: 1, archived_at: null }]);
      const r = resolveCallRoute({ ...(biz as object), plan: 'basic' } as never, new Date(), 'webhook');
      expect(r).toEqual({ action: 'ai', why: 'forward_not_in_plan' });
      const open = resolveCallRoute({ ...(biz as object), plan: 'other' } as never, new Date(), 'webhook');
      expect(open.action === 'forward' || open.action === 'ai').toBe(true);
      expect((open as { why?: string }).why).not.toBe('forward_not_in_plan');
    } finally { setPlanCatalog(null); }
  });
});

describe('L4: the MAC of a secret row covers the dual-secret window', () => {
  const keys = masterKeys(E({ NODE_ENV: 'test', APP_SECRET_KEY: crypto.randomBytes(32).toString('base64') }));
  test('changing previousEnvelope or previousUntil breaks the MAC; the legacy payload is a different string', () => {
    const until = new Date('2026-12-01T10:00:00Z');
    const row = { secretEnvelope: 'v2.k.i.t.c', previousEnvelope: 'v2.k.i.t.old', previousUntil: until };
    const mac = settingMac('twilio.auth_token', macPayload(row), 5, keys);
    expect(verifySettingMac('twilio.auth_token', macPayload(row), 5, mac, keys)).toBe(true);
    expect(verifySettingMac('twilio.auth_token', macPayload({ ...row, previousUntil: new Date(until.getTime() + 86_400_000) }), 5, mac, keys)).toBe(false); // window extended through SQL
    expect(verifySettingMac('twilio.auth_token', macPayload({ ...row, previousEnvelope: 'v2.k.i.t.planted' }), 5, mac, keys)).toBe(false);
    expect(verifySettingMac('twilio.auth_token', macPayload({ ...row, previousEnvelope: null, previousUntil: null }), 5, mac, keys)).toBe(false);
    expect(verifySettingMac('twilio.auth_token', macPayload({ ...row, previousUntil: until.toISOString() }), 5, mac, keys)).toBe(true); // a Date or its ISO form MAC the same
    expect(macPayload({ secretEnvelope: 'v2.k.i.t.c' })).not.toBe(legacyMacPayload({ secretEnvelope: 'v2.k.i.t.c' }));
    expect(legacyMacPayload({ secretEnvelope: 'v2.k.i.t.c' })).toBe('enc:v2.k.i.t.c'); // what rows written before this change were MACed over
    expect(macPayload({ value: { a: 1 } })).toBe('val:{"a":1}'); // plain rows unchanged
  });
});

describe('L1: typed phrases are checked by the server in the format the console shows', () => {
  test('tenant phrase: verb + business name, either language, case and spacing ignored', () => {
    const accepted = TENANT_VERBS.suspend.map((v) => tenantPhraseOf(v, 'Acme  Plumbing'));
    expect(accepted).toEqual(['suspend acme plumbing', 'suspender acme plumbing']);
    expect(() => requireConfirmPhrase('  SUSPEND   acme plumbing ', accepted)).not.toThrow();
    expect(() => requireConfirmPhrase('suspender Acme Plumbing', accepted)).not.toThrow();
    for (const bad of [undefined, null, '', 'suspend', 'suspend other', 'release acme plumbing', 42]) expect(() => requireConfirmPhrase(bad, accepted)).toThrow(/confirmation phrase/);
    expect(tenantPhraseOf('suspend', 'x'.repeat(300))).toHaveLength(120);
  });
  test('a written reason is required', () => {
    expect(requireReason('  a real reason ')).toBe('a real reason');
    for (const bad of [undefined, '', 'short', '   ', 5, 'x'.repeat(501)]) expect(() => requireReason(bad)).toThrow(/reason/);
  });
});

describe('M2: the break-glass token cannot mint standing owners', () => {
  test('policy inputs: bearer holds admins.recover but not admins.manage / admins.role', () => {
    expect(roleCan('bearer', 'admins.recover')).toBe(true);
    expect(roleCan('bearer', 'admins.manage')).toBe(false);
    expect(roleCan('bearer', 'admins.role')).toBe(false);
  });
});

describe('plan-feature resolution leaves validateOverride alone for numeric knobs', () => {
  test('numeric tenant knobs are unaffected by the owner-switch rule', () => {
    expect(validateOverride(settingDef('forward.ring_seconds'), 25)).toEqual({ ok: true, value: 25 });
  });
});
