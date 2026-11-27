/**
 * Agent C, no database and no browser: the pure helpers of the tenants / plans / administrators pages, the role dependent controls (server render), Spanish copy,
 * the navigation entries, the entitlement helpers and the tenant-knob readers.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminProvider, type AdminMe } from '../src/components/admin/provider';
import { ADMIN_NAV } from '../src/components/admin/nav';
import { queryOf } from '../src/components/admin/tenants-page';
import { bodyOf, draftOf, NUMERIC_FIELDS } from '../src/components/admin/plans-page';
import { isLastOwner } from '../src/components/admin/admins-page';
import { countdown, TenantSupport } from '../src/components/admin/tenant-support';
import { TenantOps } from '../src/components/admin/tenant-ops';
import { TenantOverrides, boundsText } from '../src/components/admin/tenant-overrides';
import { Problems, tenantErrorText, TENANT_ERROR_CODES } from '../src/components/admin/tenant-errors';
import { tenantPhrase, dateInput, endOfDayIso, minutesOf, type TenantDetail, type AdminView } from '../src/components/admin/tenant-api';
import { hourLabel, quietText } from '../src/components/dashboard/comfort-settings';
import { ApiError } from '../src/hooks/use-api';
import { I18nProvider } from '../src/lib/i18n/client';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import { makeT } from '../src/lib/i18n';
import { PERMISSIONS, type Permission } from '../src/lib/admin/permissions';
import { PLAN_FEATURES, planAllows, planAllowsLocation, planPriceId, setPlanCatalog, type PlanRow } from '../src/lib/admin/plan-catalog';
import { knobFrom, knobOrFrom } from '../src/lib/admin/tenant-knobs';
import { briefingSlot, nextBriefingAt, BRIEFING_HOUR } from '../src/lib/jobs/schedule';
import { isQuietHour } from '../src/lib/messaging/policy';
import { detectOwnerCaller } from '../src/lib/voice/owner/detect';
import { transferEnabledFor } from '../src/lib/voice/transfer';
import { resolveDepositAmount } from '../src/lib/payments/deposit';
import { annualAvailable } from '../src/lib/providers/stripe-billing';
import { targetBusinessOf } from '../src/lib/admin/support-gate';

const me = (permissions: readonly string[], over: Partial<AdminMe> = {}): AdminMe => ({ role: 'owner', via: 'user', email: 'o@example.test', twoFactor: true, permissions: permissions as Permission[], sudoAt: null, frozen: false, frozenByEnv: false, ...over });
const render = (node: React.ReactNode, who: AdminMe = me(PERMISSIONS), locale: 'en' | 'es' = 'en') => renderToStaticMarkup(
  <I18nProvider locale={locale} messages={locale === 'en' ? en : es}><AdminProvider me={who}>{node}</AdminProvider></I18nProvider>,
);

const detail = (over: Partial<TenantDetail> = {}): TenantDetail => ({
  id: 'b1', name: 'Acme Plumbing', status: 'live', timezone: 'America/New_York', vertical: 'plumbing', locale_default: 'en', created_at: '2027-01-01T00:00:00.000Z', closed_dates: ['2027-12-25'],
  contact: { phone: '+13055550100', owner_phone: '+13055550101', owner_name: 'Ana', owner_phone_verified: true },
  provider_ids: { agent_id: 'agent_1', elevenlabs_phone_number_id: null, twilio_phone_sid: null, stripe_customer_id: 'cus_1', stripe_subscription_id: null },
  billing: { status: 'canceled', plan: 'standard', plan_comped: false, interval: 'month', trial_ends_at: null, current_period_end: null, past_due_since: null, sms_cap_override: null, call_minutes_cap_override: null },
  call_mode: 'ai', suspension: { suspended: false, suspended_at: null, reason: null, by: null }, users: [], usage: null, overrides: [], support_grants: [], audit: [], platform: { default_vertical: null }, ...over,
});

describe('page helpers', () => {
  test('the directory query carries every filter and the cursor; blank filters send nothing', () => {
    const f = { q: ' acme ', status: 'live', billing_status: 'past_due', plan: 'standard', trial: true, past_due: true, comped: true, suspended: true };
    const u = new URL(`http://x${queryOf(f, 'c~1')}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'acme', status: 'live', billing_status: 'past_due', plan: 'standard', trial_ending_days: '7', past_due: '1', comped: '1', suspended: '1', limit: '25', cursor: 'c~1' });
    expect([...new URL(`http://x${queryOf({ q: '', status: '', billing_status: '', plan: '', trial: false, past_due: false, comped: false, suspended: false })}`).searchParams.keys()]).toEqual(['limit']);
  });
  test('the plan editor turns a draft into the API body: blank caps inherit (null), bad numbers and price ids are reported', () => {
    const d = draftOf(null, PLAN_FEATURES);
    d.key = 'pro'; d.name = ' Pro '; d.nums.sms_cap = '1000'; d.stripe_price_id = 'price_abc12345';
    const ok = bodyOf(d);
    expect(ok.errors).toEqual([]);
    expect(ok.body).toMatchObject({ name: 'Pro', sms_cap: 1000, call_minutes_cap: null, max_locations: null, stripe_price_id: 'price_abc12345', stripe_price_id_annual: null });
    expect((ok.body.features as Record<string, boolean>).owner_callin).toBe(true);
    for (const f of NUMERIC_FIELDS) expect(f in ok.body).toBe(true);
    d.nums.sms_cap = '12x'; d.stripe_price_id = 'prod_nope'; d.sort = '-1';
    expect(bodyOf(d).errors.sort()).toEqual(['sms_cap', 'sort', 'stripe_price_id']);
    // an edit round-trips: a feature switched off stays off
    const back = draftOf({ key: 'x', name: 'X', public: true, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: 3, sms_cap: null, call_minutes_cap: 5, voicemail_minutes_cap: null, forward_minutes_cap: null, max_locations: 2, features: { deposits: false }, sort: 7, archived_at: null, created_at: '', updated_at: '', updated_by: null, businesses: 0 }, PLAN_FEATURES);
    expect(back.features.deposits).toBe(false);
    expect(back.nums.call_minutes_cap).toBe('5');
    expect(back.sort).toBe('7');
  });
  test('last owner protection, countdown, phrases and dates', () => {
    const a = (id: string, role: AdminView['platform_role'], disabled = false): AdminView => ({ id, email: `${id}@x.test`, platform_role: role, disabled, two_factor: true, created_at: '', email_verified: true, sessions: 0 });
    const all = [a('1', 'owner'), a('2', 'ops'), a('3', 'owner', true)];
    expect(isLastOwner(all, all[0])).toBe(true);
    expect(isLastOwner([...all, a('4', 'owner')], all[0])).toBe(false);
    expect(isLastOwner(all, all[1])).toBe(false);
    expect(countdown('2027-01-01T00:30:00Z', Date.parse('2027-01-01T00:00:00Z'))).toBe('30:00');
    expect(countdown('2027-01-01T00:00:05Z', Date.parse('2027-01-01T00:00:00Z'))).toBe('0:05');
    expect(countdown('2027-01-01T00:00:00Z', Date.parse('2027-01-01T00:00:00Z'))).toBeNull();
    expect(tenantPhrase('Suspend', '  Acme Plumbing ')).toBe('suspend acme plumbing');
    expect(dateInput('2027-03-04T10:00:00.000Z')).toBe('2027-03-04');
    expect(endOfDayIso('2027-03-04')).toBe('2027-03-04T23:59:59.000Z');
    expect(endOfDayIso('')).toBeNull();
    expect(minutesOf(90)).toBe(1.5);
    expect(hourLabel(7)).toBe('07:00');
    expect(quietText(21, 8)).toBe('21:00 - 08:00');
  });
  test('the support gate finds the tenant a request touches (path, query, console cookie)', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(targetBusinessOf(new Request(`http://x/api/businesses/${id}/review-url`, { method: 'PUT' }))).toBe(id);
    expect(targetBusinessOf(new Request('http://x/api/businesses/mine', { method: 'POST' }))).toBeNull();
    expect(targetBusinessOf(new Request('http://x/api/knowledge?business_id=b9', { method: 'PUT' }))).toBe('b9');
    expect(targetBusinessOf(new Request('http://x/api/knowledge', { method: 'PUT', headers: { cookie: 'a=1; rc_business=b7' } }))).toBe('b7');
  });
});

describe('role dependent controls and localisation', () => {
  test('an owner sees suspend and the provider operations; a read-only admin sees none of the buttons', () => {
    const owner = render(<TenantOps d={detail()} reload={() => undefined} />);
    expect(owner).toContain('Suspend business');
    expect(owner).toContain('Release provider resources');
    expect(owner).toContain('Clear owner phone verification');
    const ro = render(<TenantOps d={detail()} reload={() => undefined} />, me(['tenants.read', 'plans.read'], { role: 'read_only' }));
    expect(ro).not.toContain('Suspend business');
    expect(ro).not.toContain('Release provider resources');
    expect(ro).not.toContain('Clear owner phone verification');
    expect(ro).toContain('Your role cannot change this.');
    // the typed phrase appears only after the action is opened (closed buttons here): no secret to leak in the markup
    expect(owner).not.toContain('suspend acme plumbing');
  });
  test('a suspended business offers reactivation, not suspension; Spanish copy renders', () => {
    const d = detail({ suspension: { suspended: true, suspended_at: '2027-01-02T00:00:00.000Z', reason: 'fraud review', by: 'u1' } });
    const html = render(<TenantOps d={d} reload={() => undefined} />, me(PERMISSIONS), 'es');
    expect(html).toContain('Reactivar negocio');
    expect(html).not.toContain('Suspender negocio');
    expect(html).toContain('fraud review');
  });
  test('support view is read only by default; write mode is offered to roles that hold it, with a personal account', () => {
    const html = render(<TenantSupport d={detail()} reload={() => undefined} />, me(PERMISSIONS));
    expect(html).toContain('READ-ONLY support view');
    expect(html).toContain('Enter write mode');
    const ro = render(<TenantSupport d={detail()} reload={() => undefined} />, me(['tenants.read'], { role: 'read_only' }));
    expect(ro).not.toContain('Enter write mode');
    expect(ro).toContain('read-only support view only');
    const token = render(<TenantSupport d={detail()} reload={() => undefined} />, me(PERMISSIONS, { role: 'bearer', via: 'token', email: null }));
    expect(token).not.toContain('Enter write mode');
    expect(token).toContain('personal administrator account');
  });
  test('tenant overrides: editable for owner / ops, locked for support without a grant (and unlocked with one), bounds are shown', () => {
    const knob = { key: 'forward.ring_seconds', label: 'Ring seconds', help: 'How long it rings', kind: 'int', unit: 'seconds', editable_by: 'owner', rule: 'within_bounds', bounds: { min: 10, max: 40 }, platform_value: 20, override: null, effective: 20, source: 'platform', ignored_override: false, locked_by_env: false } as never;
    const ownerHtml = render(<TenantOverrides knobs={[knob]} businessId="b1" locale="en" reload={() => undefined} grantOpen={false} />);
    expect(ownerHtml).toContain('Allowed range: 10 to 40');
    expect(ownerHtml).toContain('Save value');
    const sup = me(['tenants.read', 'tenants.support_enter'], { role: 'support' });
    expect(render(<TenantOverrides knobs={[knob]} businessId="b1" locale="en" reload={() => undefined} grantOpen={false} />, sup)).toContain('Enter support write mode');
    expect(render(<TenantOverrides knobs={[knob]} businessId="b1" locale="en" reload={() => undefined} grantOpen />, sup)).toContain('Save value');
    expect(render(<TenantOverrides knobs={[knob]} businessId="b1" locale="es" reload={() => undefined} grantOpen={false} />, me(PERMISSIONS), 'es')).toContain('Rango permitido: 10 a 40');
    const t = makeT('en');
    expect(boundsText({ bounds: { min: null, max: 5 }, rule: 'stricter_than_platform' }, t)).toContain('stricter');
  });
  test('every error code of the routes has English and Spanish text; the fallback is the console map', () => {
    for (const c of TENANT_ERROR_CODES) { expect(`at.err.${c}` in en).toBe(true); expect(`at.err.${c}` in es).toBe(true); }
    const err = new ApiError('x', 409, { code: 'last_owner' });
    expect(tenantErrorText(makeT('es'), err)).toBe(es['at.err.last_owner']);
    expect(tenantErrorText(makeT('en'), new ApiError('x', 403, { code: 'reauth_required' }))).toBe(en['ac.err.reauth_required']);
    expect(render(<Problems error={err} />, me(PERMISSIONS), 'es')).toContain('Debe quedar al menos un propietario activo');
  });
  test('the navigation lists the three pages with the permission that guards each', () => {
    const find = (href: string) => ADMIN_NAV.find((i) => i.href === href);
    expect(find('/admin/tenants')?.permission).toBe('tenants.read');
    expect(find('/admin/plans')?.permission).toBe('plans.read');
    expect(find('/admin/admins')?.permission).toBe('admins.read');
    for (const k of ['at.nav.tenants', 'at.nav.plans', 'at.nav.admins']) { expect(k in en).toBe(true); expect(k in es).toBe(true); }
  });
});

describe('entitlements and tenant knobs (pure)', () => {
  const row = (key: string, over: Partial<PlanRow> = {}): PlanRow => ({ key, name: key, public: true, is_comped: false, stripe_price_id: null, stripe_price_id_annual: null, trial_days: null, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, max_locations: null, features: {}, sort: 1, archived_at: null, ...over });
  test('a plan with no features recorded allows everything; a feature set false is off; locations and prices follow the plan', () => {
    setPlanCatalog([row('standard'), row('lite', { features: { deposits: false, owner_callin: false, multi_location: false }, max_locations: 1, stripe_price_id: 'price_lite0001' }), row('team', { max_locations: 3, stripe_price_id_annual: 'price_team_year' })]);
    try {
      for (const f of PLAN_FEATURES) expect(planAllows('standard', f)).toBe(true);
      expect(planAllows('unknown-plan', 'deposits')).toBe(true);
      expect(planAllows(null, 'deposits')).toBe(true);
      expect(planAllows('lite', 'deposits')).toBe(false);
      expect(planAllows('lite', 'calendar_sync')).toBe(true);
      expect(planAllowsLocation('standard', 50)).toBe(true);
      expect(planAllowsLocation('lite', 1)).toBe(false);
      expect([planAllowsLocation('team', 2), planAllowsLocation('team', 3)]).toEqual([true, false]);
      expect([planPriceId('lite', 'month'), planPriceId('lite', 'year'), planPriceId('team', 'year'), planPriceId(null, 'month')]).toEqual(['price_lite0001', null, 'price_team_year', null]);
      expect(annualAvailable({ STRIPE_SECRET_KEY: 'sk_x' } as never, 'team')).toBe(true);
      expect(annualAvailable({ STRIPE_SECRET_KEY: 'sk_x' } as never, 'lite')).toBe(false);
      const biz = { owner_phone_e164: '+13055550101', owner_phone_verified_at: '2027-01-01', phone_e164: '+13055550199' } as never;
      expect(detectOwnerCaller({ ...(biz as object), plan: 'lite' } as never, '+13055550101', {})).toEqual({ owner: false, reason: 'disabled' });
      expect(detectOwnerCaller({ ...(biz as object), plan: 'standard' } as never, '+13055550101', {}).owner).toBe(true);
      expect(detectOwnerCaller(biz, '+13055550101', {}).owner).toBe(true); // no plan on the object: unchanged behaviour
      expect(transferEnabledFor({ native_transfer_enabled: true, plan: 'standard' }, { NATIVE_TRANSFER: 'on' })).toBe(true);
      const policy = { enabled: true, kind: 'fixed', value_cents: 5000 } as never;
      expect(resolveDepositAmount({ policy, actor: 'owner', requestedCents: 5000 }).ok).toBe(true); // plan not passed: not checked
      expect(resolveDepositAmount({ policy, actor: 'owner', requestedCents: 5000, plan: 'lite' })).toMatchObject({ ok: false, reason: 'disabled' });
    } finally { setPlanCatalog(null); }
  });
  test('without a catalog nothing changes (unit tests, no console database)', () => {
    expect(planAllows('anything', 'owner_callin')).toBe(true);
    expect(planAllowsLocation('anything', 99)).toBe(true);
    expect(planPriceId('anything', 'month')).toBeNull();
  });
  test('tenant knob readers: the override wins inside the bounds, an invalid or looser one is ignored, the caller\'s base is kept otherwise', () => {
    expect(knobOrFrom('forward.ring_seconds', {}, 20)).toBe(20);
    expect(knobOrFrom('forward.ring_seconds', { 'forward.ring_seconds': 30 }, 20)).toBe(30);
    expect(knobOrFrom('forward.ring_seconds', { 'forward.ring_seconds': 500 }, 20)).toBe(20);
    expect(knobOrFrom('jobs.briefing_enabled', { 'jobs.briefing_enabled': false }, true)).toBe(false);
    expect(knobOrFrom('jobs.briefing_enabled', { 'jobs.briefing_enabled': 'no' }, true)).toBe(true);
    expect(knobOrFrom('owner.reply_daily_limit', { 'owner.reply_daily_limit': 3 }, 10)).toBe(3);
    expect(knobOrFrom('not.a.key', { 'not.a.key': 1 }, 7)).toBe(7);
    // quiet hours: 20 to 9 covers the platform window 21 to 8 (accepted); 22 to 7 does not (ignored)
    expect([knobFrom<number>('messaging.quiet_start_hour', { 'messaging.quiet_start_hour': 20, 'messaging.quiet_end_hour': 9 }), knobFrom<number>('messaging.quiet_end_hour', { 'messaging.quiet_start_hour': 20, 'messaging.quiet_end_hour': 9 })]).toEqual([20, 9]);
    expect(knobFrom<number>('messaging.quiet_start_hour', { 'messaging.quiet_start_hour': 22 })).toBe(21);
  });
  test('quiet hours and the briefing slot take the tenant value; without one they are today\'s 9pm-8am and 18:00', () => {
    const ny = (h: number) => new Date(Date.UTC(2027, 0, 15, h + 5, 0));
    expect([isQuietHour(ny(21), 'America/New_York'), isQuietHour(ny(7), 'America/New_York'), isQuietHour(ny(8), 'America/New_York'), isQuietHour(ny(20), 'America/New_York')]).toEqual([true, true, false, false]);
    expect(isQuietHour(ny(20), 'America/New_York', { start: 20, end: 9 })).toBe(true);
    expect(isQuietHour(ny(12), 'America/New_York', { start: 12, end: 12 })).toBe(false); // empty window
    expect(isQuietHour(ny(10), 'America/New_York', { start: 9, end: 11 })).toBe(true); // a window that does not wrap midnight
    const now = new Date(Date.UTC(2027, 0, 15, 23, 30)); // 18:30 in New York
    expect([briefingSlot(now, 'America/New_York').due, briefingSlot(now, 'America/New_York', BRIEFING_HOUR).due, briefingSlot(now, 'America/New_York', 19).due]).toEqual([true, true, false]);
    expect(nextBriefingAt(now, 'America/New_York', 19).toISOString()).toBe('2027-01-16T00:00:00.000Z');
    expect(nextBriefingAt(now, 'America/New_York').toISOString()).toBe('2027-01-16T23:00:00.000Z');
  });
});
