/**
 * Operations views (agent D), no database: the pure model (failure classes, acknowledgement rule, job tables kept in sync with the runner), the maintenance helper,
 * the impact registry, the candidate environment, the build-time config removal, and server renders of the operations components in English and Spanish.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminProvider, type AdminMe } from '../src/components/admin/provider';
import { OpsTabs, OPS_TABS } from '../src/components/admin/ops-ui';
import { ReportTables } from '../src/components/admin/ops-jobs';
import { MetaView, auditQuery, type AuditRow } from '../src/components/admin/ops-audit';
import { alertLine } from '../src/components/admin/ops-alerts';
import { ImpactPanel } from '../src/components/admin/ops-impact';
import { ADMIN_NAV } from '../src/components/admin/nav';
import { I18nProvider } from '../src/lib/i18n/client';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import { makeT } from '../src/lib/i18n';
import { ConfigSnapshot, allSettings, setSnapshotSource, settingDef } from '../src/lib/config';
import { PERMISSIONS, type Permission } from '../src/lib/admin/permissions';
import { JOB_NAMES } from '../src/lib/jobs/schedule';
import {
  ALERT_HREF, ALERT_KINDS, CRITICAL_OPS_JOBS, JOB_CONTROL, OPS_JOB_NAMES, PER_BUSINESS_JOBS, SEVERITY_RANK, STUCK_CLAIM_MINUTES, classifySmsFailure, eventSourceKind, isAcknowledged,
  type AlertView, type ImpactView,
} from '../src/lib/admin/ops-model';
import { IMPACT_KEYS, hasImpact, withEnv } from '../src/lib/admin/impact';
import { monthlyCents } from '../src/lib/admin/usage-overview';
import { MAINTENANCE_MESSAGE, maintenanceActive, maintenanceState, refuseIfMaintenance } from '../src/lib/admin/maintenance';
import { maintenanceRefuses } from '../src/lib/maintenance';
import { BUILD_TIME_ENV } from '../src/lib/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const me = (permissions: readonly string[]): AdminMe => ({ role: 'owner', via: 'user', email: 'o@example.test', twoFactor: true, permissions: permissions as Permission[], sudoAt: null, frozen: false, frozenByEnv: false });
const render = (node: React.ReactNode, who: AdminMe = me(PERMISSIONS), locale: 'en' | 'es' = 'en') => renderToStaticMarkup(
  <I18nProvider locale={locale} messages={locale === 'en' ? en : es}><AdminProvider me={who}>{node}</AdminProvider></I18nProvider>,
);

afterEach(() => setSnapshotSource(null));

describe('model', () => {
  test('SMS failure classes cover the codes Twilio documents for undelivered texts', () => {
    expect(classifySmsFailure('30007')).toBe('carrier');
    expect(classifySmsFailure('30034')).toBe('registration');
    expect(classifySmsFailure('30006')).toBe('number');
    expect(classifySmsFailure('21610')).toBe('optout');
    expect(classifySmsFailure('30008')).toBe('transient');
    expect(classifySmsFailure('30002')).toBe('account');
    expect(classifySmsFailure(null)).toBe('unknown');
    expect(classifySmsFailure('99999')).toBe('unknown');
    for (const c of ['number', 'optout', 'carrier', 'registration', 'account', 'transient', 'unknown']) {
      expect(en[`ao.sms.guide.${c}` as keyof typeof en]).toBeTruthy();
      expect(es[`ao.sms.class.${c}` as keyof typeof es]).toBeTruthy();
    }
  });
  test('event sources are classified', () => {
    expect(eventSourceKind('stripe')).toBe('webhook');
    expect(eventSourceKind('elevenlabs-postcall')).toBe('webhook');
    expect(eventSourceKind('job-state')).toBe('job');
    expect(eventSourceKind('something-new')).toBe('internal');
    expect(STUCK_CLAIM_MINUTES).toBeGreaterThan(0);
  });
  test('an acknowledgement silences an alert until it expires or the problem grows', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const ack = { until: '2026-01-02T12:00:00Z', count: 5 };
    expect(isAcknowledged(ack, now, 5)).toBe(true);
    expect(isAcknowledged(ack, now, 3)).toBe(true);
    expect(isAcknowledged(ack, now, 6)).toBe(false); // it grew
    expect(isAcknowledged({ until: '2026-01-01T11:59:59Z', count: 5 }, now, 5)).toBe(false); // expired
    expect(isAcknowledged(null, now, 1)).toBe(false);
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.warning);
  });
  test('the client job tables match the runner and the run route', () => {
    expect([...OPS_JOB_NAMES]).toEqual([...JOB_NAMES]);
    expect(Object.keys(JOB_CONTROL).sort()).toEqual([...JOB_NAMES].sort());
    for (const c of Object.values(JOB_CONTROL)) if (c) expect(settingDef(c.key)).toBeTruthy();
    const route = read('src/app/api/admin/jobs/run/route.ts');
    const critical = /CRITICAL_JOBS: readonly string\[\] = \[([^\]]+)\]/.exec(route)?.[1].replace(/['\s]/g, '').split(',').sort();
    expect(critical).toEqual([...CRITICAL_OPS_JOBS].sort());
    for (const j of PER_BUSINESS_JOBS) expect(route).toContain(j); // the route accepts business_id for exactly these jobs
    for (const j of JOB_NAMES) { expect(en[`ao.job.${j}.name` as keyof typeof en]).toBeTruthy(); expect(es[`ao.job.${j}.desc` as keyof typeof es]).toBeTruthy(); expect(en[`ao.job.${j}.schedule` as keyof typeof en]).toBeTruthy(); }
  });
  test('every alert kind has a page, a title, a line and help in both languages', () => {
    for (const k of ALERT_KINDS) {
      expect(ALERT_HREF[k].startsWith('/admin')).toBe(true);
      for (const part of ['title', 'line', 'help']) { expect(en[`ao.alert.${k}.${part}` as keyof typeof en]).toBeTruthy(); expect(es[`ao.alert.${k}.${part}` as keyof typeof es]).toBeTruthy(); }
    }
  });
  test('monthly equivalent of a price', () => {
    expect(monthlyCents({ amount_cents: 14900, currency: 'USD', interval: 'month', interval_count: 1 })).toBe(14900);
    expect(monthlyCents({ amount_cents: 149000, currency: 'USD', interval: 'year', interval_count: 1 })).toBe(12417);
    expect(monthlyCents({ amount_cents: 30000, currency: 'USD', interval: 'month', interval_count: 3 })).toBe(10000);
  });
});

describe('impact previews: registry and candidate environment', () => {
  test('every key with an impact is a registry key (and the ids have sentences in both languages)', () => {
    for (const [key, id] of Object.entries(IMPACT_KEYS)) {
      expect(settingDef(key)).toBeTruthy();
      expect(hasImpact(key)).toBe(true);
      expect(en[`ao.impact.${id}` as keyof typeof en]).toBeTruthy();
      expect(es[`ao.impact.${id}` as keyof typeof es]).toBeTruthy();
    }
    expect(hasImpact('platform.announcement')).toBe(false);
    expect(allSettings().length).toBeGreaterThan(100);
  });
  test('withEnv layers a hypothetical value without touching the base', () => {
    const base = { A: '1', B: '2' } as unknown as NodeJS.ProcessEnv;
    const cand = withEnv(base, { A: '9', C: '3' });
    expect([cand.A, cand.B, cand.C]).toEqual(['9', '2', '3']);
    expect('C' in cand).toBe(true);
    expect(base.A).toBe('1');
    expect(base.C).toBeUndefined();
  });
});

describe('maintenance helper', () => {
  const on = () => setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'platform.maintenance_mode': true, 'platform.announcement': 'Back at 3pm' }, secrets: {} }));
  test('off by default: nothing is refused', () => {
    expect(maintenanceActive()).toBe(false);
    expect(refuseIfMaintenance()).toBeNull();
    expect(maintenanceState().enabled).toBe(false);
  });
  test('on: a 503 with Retry-After and a clear message; the state carries the announcement', async () => {
    on();
    expect(maintenanceActive()).toBe(true);
    const res = refuseIfMaintenance();
    expect(res?.status).toBe(503);
    expect(res?.headers.get('retry-after')).toBe('300');
    const body = await res?.json();
    expect(body).toMatchObject({ ok: false, code: 'maintenance', message: MAINTENANCE_MESSAGE });
    expect(maintenanceState()).toMatchObject({ enabled: true, announcement: 'Back at 3pm', retry_after: 300 });
  });
  test('webhooks, the console, sign-in and the Bearer are never refused; tenant writes with a user cookie are', () => {
    const base = { enabled: true, method: 'POST', bearer: false, userCookie: true } as const;
    expect(maintenanceRefuses({ ...base, pathname: '/api/businesses/x/settings' })).toBe(true);
    for (const p of ['/api/voice/incoming', '/api/sms/inbound', '/api/sms/status', '/api/billing/webhook', '/api/payments/webhook', '/api/voice/post-call', '/api/admin/settings/apply', '/api/auth/login']) {
      expect(maintenanceRefuses({ ...base, pathname: p, userCookie: p.startsWith('/api/admin') || p.startsWith('/api/auth') })).toBe(false);
      expect(maintenanceRefuses({ ...base, pathname: p, userCookie: false })).toBe(false); // a webhook carries no user cookie
    }
    expect(maintenanceRefuses({ ...base, pathname: '/api/businesses/x/settings', bearer: true })).toBe(false);
    expect(maintenanceRefuses({ ...base, pathname: '/api/businesses/x/settings', method: 'GET' })).toBe(false);
  });
  test('the signup route and the webhook routes honour the policy in source', () => {
    expect(read('src/app/api/auth/signup/route.ts')).toContain('refuseIfMaintenance()');
    for (const f of ['src/app/api/voice/incoming/route.ts', 'src/app/api/sms/inbound/route.ts', 'src/app/api/sms/status/route.ts', 'src/app/api/billing/webhook/route.ts', 'src/app/api/payments/webhook/route.ts']) {
      if (existsSync(join(ROOT, f))) expect(read(f)).not.toContain('refuseIfMaintenance'); // provider webhooks are never dropped
    }
  });
});

describe('Phase 6: build-time config is gone', () => {
  test('no build-time names, no NEXT_PUBLIC build args, site-config and CSP read the snapshot', () => {
    expect([...BUILD_TIME_ENV]).toEqual([]);
    expect(read('src/lib/csp.ts')).not.toMatch(/process\.env\.NEXT_PUBLIC/);
    expect(read('Dockerfile')).not.toMatch(/^ARG NEXT_PUBLIC/m);
    expect(read('compose.production.yaml')).not.toMatch(/NEXT_PUBLIC_\w+:\s*\$\{/);
  });
  test('the Turnstile site key and the price copy resolve from a console snapshot at request time', async () => {
    const { planPriceDisplay, planPriceDisplayAnnual } = await import('../src/app/site-config');
    const { turnstileConfigured } = await import('../src/lib/csp');
    const saved = { a: process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY, b: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, c: process.env.TURNSTILE_SECRET_KEY };
    delete process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY; delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
    try {
      expect(turnstileConfigured()).toBe(false);
      setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'billing.price_display_en': '$99/month', 'billing.price_display_es': '$99/mes', 'billing.price_display_annual_en': '$990/year', 'signup.turnstile_site_key': '1x00000000000000000000AA' }, secrets: {} }));
      expect(planPriceDisplay('en')).toBe('$99/month');
      expect(planPriceDisplay('es')).toBe('$99/mes');
      expect(planPriceDisplayAnnual('es')).toBe('$990/year'); // Spanish falls back to the English annual text
      expect(turnstileConfigured()).toBe(true); // the CSP opens challenges.cloudflare.com from the console value
      process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY = '$149/month'; // an environment pin wins over the console
      expect(planPriceDisplay('en')).toBe('$149/month');
    } finally {
      for (const [k, v] of [['NEXT_PUBLIC_PLAN_PRICE_DISPLAY', saved.a], ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', saved.b], ['TURNSTILE_SECRET_KEY', saved.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('navigation and pages', () => {
  test('one nav entry; every tab has a page that guards its permission', () => {
    expect(ADMIN_NAV.some((i) => i.href === '/admin/operations')).toBe(true);
    for (const tab of OPS_TABS) {
      const dir = tab.href.replace('/admin/', 'src/app/admin/');
      expect(existsSync(join(ROOT, dir, 'page.tsx'))).toBe(true);
      expect(read(`${dir}/page.tsx`)).toContain(`requireAdminPage('${tab.permission}')`);
      expect(en[tab.label]).toBeTruthy();
      expect(PERMISSIONS).toContain(tab.permission);
    }
  });
  test('the tabs show only what the role may read', () => {
    const all = render(<OpsTabs />);
    for (const t of OPS_TABS) expect(all).toContain(t.href);
    const some = render(<OpsTabs />, me(['jobs.read', 'audit.read']));
    expect(some).toContain('/admin/operations/jobs');
    expect(some).toContain('/admin/operations/audit');
    expect(some).not.toContain('/admin/operations/usage');
    expect(some).not.toContain('/admin/operations/alerts');
    expect(render(<OpsTabs />, me([]), 'es')).not.toContain('href=');
  });
});

describe('components', () => {
  const alert = (kind: AlertView['kind'], detail: AlertView['detail'] = {}, over: Partial<AlertView> = {}): AlertView => ({ id: kind, kind, severity: 'warning', count: 3, subject: null, since: null, detail, href: ALERT_HREF[kind], acknowledged: null, ...over });
  test('every alert sentence interpolates fully in both languages', () => {
    for (const locale of ['en', 'es'] as const) {
      const t = makeT(locale);
      for (const k of ALERT_KINDS) {
        const line = alertLine(t, alert(k, { top_code: '30007', job: 'cleanup', outcome: 'auth_failed', instances_behind: 1, instances_alive: 2, pending: 4 }, { subject: k === 'job_errors' ? 'cleanup' : k === 'provider_unhealthy' ? 'twilio' : null }));
        expect(line).not.toMatch(/\{[a-z_]+\}/);
        expect(line.length).toBeGreaterThan(10);
      }
    }
  });
  test('report tables: counts, outcomes, business links, truncation note', () => {
    const html = render(<ReportTables counts={{ would_release: 2, errors: 0 }} items={[{ business_id: 'abcdef12-0000', outcome: 'would_release' }, { business_id: null, outcome: 'error', detail: 'x' }]} total={50} caption="Report" />);
    expect(html).toContain('would release');
    expect(html).toContain('/admin/tenants/abcdef12-0000');
    expect(html).toContain('Showing 2 of 50 rows.');
    expect(render(<ReportTables items={[]} caption="r" />, me(PERMISSIONS), 'es')).toContain('No hay negocios en este informe.');
  });
  test('audit meta: a settings change renders as a before / after table, secrets as fingerprints; other rows as key / value', () => {
    const row = (action: string, meta: unknown): AuditRow => ({ id: '1', at: '2026-01-01T00:00:00Z', actor_kind: 'user', actor_user_id: 'u1', actor_email: 'a@example.test', business_id: null, business_name: null, action, target: '', ip: '203.0.113.9', meta });
    const diff = render(<MetaView row={row('settings.change', { reason: 'cap', keys: [{ key: 'billing.plan_sms_cap', old: 500, new: 300 }, { key: 'stripe.secret_key', old_fp: 'ab12cd34', new_fp: 'ef56ab78' }] })} />);
    expect(diff).toContain('billing.plan_sms_cap');
    expect(diff).toContain('#ab12cd34');
    expect(diff).toContain('#ef56ab78');
    expect(diff).toContain('Before');
    expect(diff).toContain('203.0.113.9');
    const plain = render(<MetaView row={row('jobs.manual_run', { processed: 3, errors: 0 })} />, me(PERMISSIONS), 'es');
    expect(plain).toContain('processed');
    expect(plain).not.toContain('Antes');
  });
  test('audit query: only set filters, dates as ISO, export flags appended', () => {
    const q = new URLSearchParams(auditQuery({ actor: 'system', action: 'settings.', business_id: '', from: '2026-01-01T10:00', to: '', q: ' x ' }, { export: '1', format: 'csv' }));
    expect(q.get('actor')).toBe('system');
    expect(q.get('action')).toBe('settings.');
    expect(q.has('business_id')).toBe(false);
    expect(q.get('from')).toBe(new Date('2026-01-01T10:00').toISOString());
    expect(q.get('q')).toBe('x');
    expect(q.get('export')).toBe('1');
  });
  test('the impact panel states each impact in the viewer language and renders nothing without impacts', () => {
    const impacts: ImpactView[] = [
      { key: 'billing.plan_sms_cap', id: 'tenants_over_sms_cap', count: 14, total: 90, rows: [{ label: 'Acme HVAC', value: 301 }], facts: {} },
      { key: 'jobs.retention_enabled', id: 'retention_purge', count: 1240, total: 9, rows: [], facts: { calls: 1000, texts: 200, briefings: 30, bookings_anonymized: 10, tenants: 9 } },
      { key: 'messaging.sms_allowed_countries', id: 'owner_phones_invalid', count: 3, total: 40, rows: [], facts: { countries_before: '1,52', countries_after: '1' } },
    ];
    const en1 = render(<ImpactPanel impacts={impacts} />);
    expect(en1).toContain('puts 14 of 90 tenants');
    expect(en1).toContain('Acme HVAC');
    expect(en1).toContain('1000 calls');
    expect(en1).toContain('3 of 40 owner phones');
    expect(render(<ImpactPanel impacts={impacts} />, me(PERMISSIONS), 'es')).toContain('14 de 90 negocios');
    expect(render(<ImpactPanel impacts={[]} />)).toBe('');
    expect(render(<ImpactPanel impacts={undefined} />)).toBe('');
  });
  test('the change review renders the impact panel from the preview', () => {
    expect(read('src/components/admin/change-review.tsx')).toContain('<ImpactPanel');
    expect(read('src/app/api/admin/settings/preview/route.ts')).toContain('impactsFor(');
  });
});
