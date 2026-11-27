/**
 * Console UI (Agent A): the pure model behind the generated settings forms, the safe markdown renderer, the diff, the overview derivations, the "move to console"
 * classification, maintenance mode in the proxy, the public legal links, and component-level server renders (every field state, role dependent controls, Spanish copy).
 * No database and no browser.
 */
import * as bunTest from 'bun:test';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { AdminProvider, type AdminMe } from '../src/components/admin/provider';
import { SettingsEditor } from '../src/components/admin/settings-form';
import { ConfirmFields, SourceBadge, confirmReady } from '../src/components/admin/ui';
import { ADMIN_NAV } from '../src/components/admin/nav';
import { MarkdownView } from '../src/components/legal/markdown-view';
import { LegalConsentLine } from '../src/components/legal/consent-line';
import { I18nProvider } from '../src/lib/i18n/client';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import { ConfigSnapshot, allSettings, setSnapshotSource } from '../src/lib/config';
import { defaultOf } from '../src/lib/config/registry';
import { defaultContext } from '../src/lib/config/define';
import { PERMISSIONS, type Permission } from '../src/lib/admin/permissions';
import type { SettingView } from '../src/lib/admin/settings-store';
import {
  SETTINGS_PAGE_IDS, editChangesSomething, editFromText, fieldBlock, isProviderCardKey, pageOfKey, ratchetError, sectionsOf, settingsOfPage, stagedToChanges, valueToText, widgetFor,
} from '../src/lib/admin-ui/model';
import { SETTING_TEXT_ES, settingText } from '../src/lib/admin-ui/setting-text';
import { classifyMove } from '../src/lib/admin-ui/move';
import { buildAlerts, summarizeJobs, type RunLite } from '../src/lib/admin-ui/overview';
import { MAX_MARKDOWN_CHARS, parseMarkdown, safeHref } from '../src/lib/markdown';
import { diffLines, diffStats } from '../src/lib/text-diff';
import { maintenanceRefuses } from '../src/lib/maintenance';
import { absoluteLegalUrl, legalFooterLinks, noteLegalPublished } from '../src/lib/legal-footer';
import { verifyEmailTemplate } from '../src/lib/email/templates';
import { helpReply } from '../src/lib/messaging/keywords';
import { isPublicPath } from '../src/lib/auth';
import { proxy } from '../src/proxy';
import { makeT } from '../src/lib/i18n';

const ctx = defaultContext('test');
const defs = allSettings();

function view(key: string, over: Partial<SettingView> = {}): SettingView {
  const def = defs.find((d) => d.key === key)!;
  const dflt = defaultOf(def, ctx);
  return {
    key, env: def.env ?? null, group: def.group, label: def.label, help: def.help, kind: def.kind, class: def.class, tier: def.tier, scope: def.scope, applies: def.applies,
    follow_up: def.followUp ?? null, ratchet: def.ratchet ?? null, tighten_is: def.tightenIs ?? null, paired_with: def.pairedWith ?? [], unit: def.unit ?? null,
    schema: { type: def.schema.type, ...(def.schema.info as object) }, tenant: null, source: 'default', locked: false, locked_reason: null, env_invalid: false,
    value: dflt, default: dflt, console_value: null, version: null, updated_at: null, updated_by: null, secret: null, ...over,
  } as SettingView;
}
const listing = (page: (typeof SETTINGS_PAGE_IDS)[number], patch: Record<string, Partial<SettingView>> = {}, frozen = false) => ({
  version: 7, frozen: { frozen, by_env: false, frozen_at: null, frozen_by: null, reason: null },
  settings: settingsOfPage(page).map((d) => view(d.key, patch[d.key])),
});
const me = (permissions: readonly string[], over: Partial<AdminMe> = {}): AdminMe => ({ role: 'owner', via: 'user', email: 'o@example.test', twoFactor: true, permissions: permissions as Permission[], sudoAt: null, frozen: false, frozenByEnv: false, ...over });
const OWNER = me(PERMISSIONS);
const OPS = me(PERMISSIONS.filter((p) => !['settings.write.critical', 'settings.secrets.write', 'settings.import', 'legal.publish'].includes(p)), { role: 'ops' });
const READ_ONLY = me(['settings.read', 'system.read'], { role: 'read_only' });
const render = (node: React.ReactNode, who: AdminMe = OWNER, locale: 'en' | 'es' = 'en') => renderToStaticMarkup(
  <I18nProvider locale={locale} messages={locale === 'en' ? en : es}><AdminProvider me={who}>{node}</AdminProvider></I18nProvider>,
);

describe('pages are generated from the registry', () => {
  test('every console-editable key is on exactly one settings page or owned by a provider card', () => {
    const seen = new Map<string, string[]>();
    for (const page of SETTINGS_PAGE_IDS) for (const d of settingsOfPage(page)) seen.set(d.key, [...(seen.get(d.key) ?? []), page]);
    for (const [k, pages] of seen) expect({ k, pages: pages.length }).toEqual({ k, pages: 1 });
    const orphans = defs.filter((d) => d.class === 'SETTING_IN_ADMIN' && !seen.has(d.key) && !isProviderCardKey(d)).map((d) => d.key);
    expect(orphans).toEqual([]);
    // a secret or a provider id is never on a plain page
    for (const d of defs) if (d.class !== 'SETTING_IN_ADMIN') expect(pageOfKey(d)).toBeNull();
    for (const page of SETTINGS_PAGE_IDS) expect(settingsOfPage(page).length).toBeGreaterThan(0);
  });
  test('the brief\'s pages hold what they should', () => {
    const keys = (p: (typeof SETTINGS_PAGE_IDS)[number]) => settingsOfPage(p).map((d) => d.key);
    for (const k of ['brand.name', 'brand.support_email', 'brand.company_address', 'legal.terms_url', 'voice.default_assistant_name']) expect(keys('content')).toContain(k);
    for (const k of ['platform.enabled_locales', 'platform.maintenance_mode', 'platform.announcement']) expect(keys('locales')).toContain(k);
    expect(keys('messaging')).toContain('messaging.sms_allowed_countries');
    for (const k of ['jobs.retention_enabled', 'data.retention_default_days']) expect(keys('data')).toContain(k);
    expect(keys('jobs')).toContain('jobs.enabled');
    expect(keys('billing')).toContain('billing.enforced');
    expect(keys('scheduling')).toContain('defaults.slot_minutes');
    for (const k of ['signup.mode', 'security.password_min_chars']) expect(keys('signup')).toContain(k);
    for (const k of ['voice.line_kind', 'forward.ring_seconds']) expect(keys('voice')).toContain(k);
  });
  test('every key the console renders has a Spanish label and help, and no stale entry remains', () => {
    const shown = SETTINGS_PAGE_IDS.flatMap((p) => settingsOfPage(p).map((d) => d.key));
    expect(shown.filter((k) => !(k in SETTING_TEXT_ES))).toEqual([]);
    expect(Object.keys(SETTING_TEXT_ES).filter((k) => !defs.some((d) => d.key === k))).toEqual([]);
    for (const k of shown) { const [l, h] = SETTING_TEXT_ES[k]; expect(l.trim() && h.trim()).toBeTruthy(); }
    const def = defs.find((d) => d.key === 'billing.trial_days')!;
    expect(settingText(def, 'en').label).toBe(def.label);
    expect(settingText(def, 'es').label).not.toBe(def.label);
  });
  test('every registry group on a page and every nav label has a catalog entry in both languages', () => {
    const groups = new Set(SETTINGS_PAGE_IDS.flatMap((p) => sectionsOf(settingsOfPage(p)).map((s) => s.group)));
    for (const g of groups) { expect(`ac.group.${g}` in en).toBe(true); expect(`ac.group.${g}` in es).toBe(true); }
    for (const p of SETTINGS_PAGE_IDS) for (const f of ['title', 'sub']) expect(`ac.page.${p}.${f}` in es).toBe(true);
    const units = new Set(defs.map((d) => d.unit).filter(Boolean));
    for (const u of units) expect(`ac.unit.${u}` in en).toBe(true);
    for (const r of ['lower', 'higher', 'fewer', 'more']) expect(`ac.ratchet.${r}` in es).toBe(true);
    for (const d of defs) { expect(`ac.applies.${d.applies}` in en).toBe(true); if (d.followUp) expect(`ac.follow.${d.followUp}` in es).toBe(true); }
    const hrefs = ADMIN_NAV.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const i of ADMIN_NAV) { expect(i.label in en).toBe(true); expect(i.label in es).toBe(true); if (i.permission) expect(PERMISSIONS).toContain(i.permission); }
  });
});

describe('widgets and text conversion use the registry schema', () => {
  const def = (k: string) => defs.find((d) => d.key === k)!;
  test('widget by kind', () => {
    expect(widgetFor(def('billing.enforced'))).toBe('switch');
    expect(widgetFor(def('billing.trial_days'))).toBe('int');
    expect(widgetFor(def('signup.mode'))).toBe('select');
    expect(widgetFor(def('brand.support_url'))).toBe('url');
    expect(widgetFor(def('platform.enabled_locales'))).toBe('checkboxes');
    expect(widgetFor(def('messaging.sms_allowed_countries'))).toBe('list');
    expect(widgetFor(def('brand.company_address'))).toBe('textarea');
    expect(widgetFor(def('brand.name'))).toBe('text');
  });
  test('integers: bounds come from the schema, text is strict', () => {
    const d = def('billing.trial_days');
    expect(editFromText(d, '14', false)).toEqual({ ok: true, edit: { op: 'set', value: 14, text: '14' } });
    expect(editFromText(d, '91', false).ok).toBe(false);
    expect(editFromText(d, '1.5', false).ok).toBe(false);
    expect(editFromText(d, 'abc', false).ok).toBe(false);
  });
  test('an empty optional field resets it; an empty list is a list', () => {
    expect(editFromText(def('brand.support_url'), '  ', true)).toEqual({ ok: true, edit: { op: 'remove' } });
    expect(editFromText(def('brand.support_url'), 'http://x.test', true).ok).toBe(false); // https only
    expect(editFromText(def('brand.support_url'), 'https://help.example.test', true).ok).toBe(true);
    expect(editFromText(def('platform.alert_recipients'), '', false)).toEqual({ ok: true, edit: { op: 'set', value: [], text: '' } });
    const countries = editFromText(def('messaging.sms_allowed_countries'), '1, 52, 1', false);
    expect(countries.ok && countries.edit.op === 'set' ? countries.edit.value : null).toEqual(['1', '52']);
    expect(editFromText(def('messaging.sms_allowed_countries'), '', false).ok).toBe(false); // at least one entry
    expect(valueToText(def('messaging.sms_allowed_countries'), ['1', '52'])).toBe('1,52');
  });
  test('a staged edit that changes nothing is dropped; a reset needs a console value', () => {
    const v = view('billing.trial_days');
    expect(editChangesSomething(v, { op: 'set', value: 7, text: '7' })).toBe(false);
    expect(editChangesSomething(v, { op: 'set', value: 8, text: '8' })).toBe(true);
    expect(editChangesSomething(v, { op: 'remove' })).toBe(false);
    expect(editChangesSomething({ ...v, console_value: 9, source: 'console' }, { op: 'remove' })).toBe(true);
  });
  test('staged edits become one change set', () => {
    expect(stagedToChanges({ 'billing.trial_days': { op: 'set', value: 9, text: '9' }, 'brand.name': { op: 'remove' } })).toEqual([{ key: 'billing.trial_days', value: 9 }, { key: 'brand.name', remove: true }]);
  });
  test('ratchets are checked before the server says no', () => {
    const d = def('security.password_min_chars');
    const v = view('security.password_min_chars');
    const cur = Number(v.value);
    expect(ratchetError(d, v, { op: 'set', value: cur + 2, text: '' })).toBe(false); // raising is allowed
    expect(ratchetError(d, v, { op: 'set', value: cur - 1, text: '' })).toBe(true);
    expect(ratchetError(def('billing.trial_days'), view('billing.trial_days'), { op: 'set', value: 1, text: '' })).toBe(false);
  });
  test('field block: env pin, role, freeze', () => {
    const d = def('billing.enforced'); // critical
    const open = { locked: false, locked_reason: null } as const;
    expect(fieldBlock(open, d, PERMISSIONS, false)).toBeNull();
    expect(fieldBlock({ locked: true, locked_reason: 'env' }, d, PERMISSIONS, false)).toBe('locked_env');
    expect(fieldBlock({ locked: true, locked_reason: 'env_only' }, d, PERMISSIONS, false)).toBe('locked_env_only');
    expect(fieldBlock(open, d, ['settings.write'], false)).toBe('no_permission'); // ops cannot write a critical key
    expect(fieldBlock(open, def('billing.trial_days'), ['settings.write'], false)).toBeNull();
    expect(fieldBlock(open, def('billing.trial_days'), ['settings.write'], true)).toBe('frozen');
    expect(fieldBlock(open, def('billing.trial_days'), ['settings.read'], false)).toBe('no_permission');
  });
});

describe('the generated settings form', () => {
  test('a page renders every field with its source badge, tier and default', () => {
    const html = render(<SettingsEditor page="billing" listing={listing('billing', { 'billing.trial_days': { source: 'console', console_value: 14, value: 14 } })} reload={() => undefined} />);
    expect(html).toContain('Free trial length');
    expect(html).toContain('Console');
    expect(html).toContain('Default');
    expect(html).toContain('Critical');
    expect(html).toContain('Reset to default');
    expect(html).toContain('Default: 7');
    expect(html).toContain('type="number"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="90"');
    // price copy notes: label wired to its control
    expect(html).toMatch(/<label[^>]*for="f-billing-trial_days"/);
  });
  test('Locked by environment: disabled control, the variable named, no reset', () => {
    const html = render(<SettingsEditor page="billing" listing={listing('billing', { 'billing.trial_days': { source: 'env', locked: true, locked_reason: 'env', value: 21 } })} reload={() => undefined} />);
    expect(html).toContain('Locked by environment');
    expect(html).toContain('BILLING_TRIAL_DAYS');
    const input = /<input[^>]*id="f-billing-trial_days"[^>]*>/.exec(html)![0];
    expect(input).toContain('disabled');
    expect(input).toContain('value="21"');
  });
  test('an env-only security switch and an invalid pin are explained', () => {
    const html = render(<SettingsEditor page="billing" listing={listing('billing', { 'billing.trial_days': { source: 'default', locked: true, locked_reason: 'env', env_invalid: true } })} reload={() => undefined} />);
    expect(html).toContain('is invalid, so the default applies');
  });
  test('roles: ops cannot touch a critical key, read-only touches nothing, the freeze disables all', () => {
    const opsHtml = render(<SettingsEditor page="billing" listing={listing('billing')} reload={() => undefined} />, OPS);
    expect(/<input[^>]*id="f-billing-enforced"[^>]*disabled/.test(opsHtml)).toBe(true);
    expect(/<input[^>]*id="f-billing-trial_days"[^>]*disabled/.test(opsHtml)).toBe(false);
    expect(opsHtml).toContain('Your role cannot change this setting.');
    const ro = render(<SettingsEditor page="billing" listing={listing('billing')} reload={() => undefined} />, READ_ONLY);
    expect(ro.match(/disabled/g)?.length ?? 0).toBeGreaterThan(10);
    expect(/<input[^>]*id="f-billing-trial_days"[^>]*disabled/.test(ro)).toBe(true);
    const frozen = render(<SettingsEditor page="billing" listing={listing('billing', {}, true)} reload={() => undefined} />);
    expect(frozen).toContain('The console is frozen');
    expect(/<input[^>]*id="f-billing-trial_days"[^>]*disabled/.test(frozen)).toBe(true);
  });
  test('the enabled-languages list is checkboxes in a labelled fieldset, and a ratchet states its direction', () => {
    const loc = render(<SettingsEditor page="locales" listing={listing('locales')} reload={() => undefined} />);
    expect(loc).toContain('<fieldset');
    expect(loc).toContain('aria-labelledby="f-platform-enabled_locales-label"');
    expect(loc).toContain('type="checkbox"');
    const sec = render(<SettingsEditor page="signup" listing={listing('signup')} reload={() => undefined} />);
    expect(sec).toContain('can only make this stricter');
  });
  test('Spanish: labels, help, groups and notes are translated', () => {
    const html = render(<SettingsEditor page="billing" listing={listing('billing', { 'billing.trial_days': { source: 'env', locked: true, locked_reason: 'env' } })} reload={() => undefined} />, OWNER, 'es');
    expect(html).toContain('Duración de la prueba gratuita');
    expect(html).toContain('Bloqueado por el entorno');
    expect(html).toContain('Cobro');
    expect(html).not.toContain('Free trial length');
  });
  test('a page with no applicable key says so instead of rendering nothing', () => {
    const html = render(<SettingsEditor page="jobs" listing={{ ...listing('jobs'), settings: [] }} reload={() => undefined} />);
    expect(html).not.toContain('<h2');
  });
});

describe('typed confirmation and reason', () => {
  test('critical needs reason and the exact phrase; sensitive only the reason; normal nothing', () => {
    expect(confirmReady({ reasonRequired: false, reason: '', phrase: null, typed: '' })).toBe(true);
    expect(confirmReady({ reasonRequired: true, reason: 'short', phrase: null, typed: '' })).toBe(false);
    expect(confirmReady({ reasonRequired: true, reason: 'long enough reason', phrase: null, typed: '' })).toBe(true);
    expect(confirmReady({ reasonRequired: true, reason: 'long enough reason', phrase: 'billing.enforced', typed: 'billing.enforced ' })).toBe(true);
    expect(confirmReady({ reasonRequired: true, reason: 'long enough reason', phrase: 'billing.enforced', typed: 'Billing.enforced' })).toBe(false);
  });
  test('the fields are labelled and the phrase is selectable text', () => {
    const html = render(<ConfirmFields reasonRequired phrase="apply 2 critical settings" reason="" onReason={() => undefined} typed="" onTyped={() => undefined} />);
    expect(html).toContain('Reason for this change');
    expect(html).toContain('apply 2 critical settings');
    expect(html).toContain('aria-required="true"');
    expect(html).toMatch(/autoComplete="off"/i);
  });
  test('the source badge says it in words', () => {
    expect(render(<SourceBadge source="env" locked envName="X" />)).toContain('Locked by environment');
    expect(render(<SourceBadge source="console" />)).toContain('Console');
    expect(render(<SourceBadge source="default" />)).toContain('Default');
  });
});

/** The shell uses the app router hooks: mount them with a fixed path (no router exists in a server render). */
async function shell() {
  (bunTest as unknown as { mock: { module: (id: string, factory: () => unknown) => void } }).mock.module('next/navigation', () => ({ usePathname: () => '/admin', useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
  return import('../src/components/admin/shell');
}

describe('the shell', () => {
  test('nav by permission, role badge, the editing banner and the state banners', async () => {
    const { AdminShell } = await shell();
    const owner = render(<AdminShell me={OWNER} maintenance={false}><p>body</p></AdminShell>);
    expect(owner).toContain('You are editing PLATFORM settings');
    expect(owner).toContain('Legal pages');
    expect(owner).toContain('Owner');
    expect(owner).toContain('href="/admin/system"');
    const ro = render(<AdminShell me={READ_ONLY} maintenance={true}><p>body</p></AdminShell>);
    expect(ro).toContain('read only for your role');
    expect(ro).not.toContain('href="/admin/legal"'); // no legal.read
    expect(ro).toContain('Maintenance mode is ON');
    const frozen = render(<AdminShell me={{ ...OWNER, frozen: true }} maintenance={false}><p>x</p></AdminShell>);
    expect(frozen).toContain('The console is frozen');
    expect(render(<AdminShell me={OWNER} maintenance={false}><p>x</p></AdminShell>, OWNER, 'es')).toContain('Está editando la configuración de la PLATAFORMA');
  });
  test('landmarks: one main, a labelled nav, a skip target', async () => {
    const { AdminShell } = await shell();
    const html = render(<AdminShell me={OWNER} maintenance={false}><p>x</p></AdminShell>);
    expect(html.match(/<main/g)?.length).toBe(1);
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Console navigation"');
  });
});

describe('safe markdown', () => {
  const html = (src: string) => renderToStaticMarkup(<MarkdownView source={src} />);
  test('renders the supported subset', () => {
    const out = html('# Title\n\nHello **bold** and *it* and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n---\n\n[site](https://example.com/x?y=1)');
    expect(out).toContain('<h1');
    expect(out).toContain('<strong');
    expect(out).toContain('<ul');
    expect(out).toContain('<ol');
    expect(out).toContain('<blockquote');
    expect(out).toContain('<hr');
    expect(out).toContain('href="https://example.com/x?y=1"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
  test('raw HTML is text, never markup', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>x</b>\n\n<div onclick="x()">hi</div>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<div onclick');
    expect(out).toContain('&lt;script&gt;');
  });
  test('dangerous link targets lose their link', () => {
    expect(html('[click](java\tscript:alert(1))')).not.toMatch(/href="[^"]*:/); // the title split leaves the harmless relative href "java"
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', '//evil.test/x', '/\\evil.test', 'file:///etc/passwd', 'jav&#x61;script:alert(1)', 'http://user:pw@host.test/', 'mailto:', 'ftp://x.test/']) {
      const out = html(`[click](${bad})`);
      expect(out).not.toContain('<a ');
      expect(out).toContain('click');
    }
    expect(html('[x](javascript:alert(1))')).not.toContain('javascript:');
    expect(html('<javascript:alert(1)>')).not.toContain('<a');
  });
  test('safeHref accepts the safe forms only', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('http://example.com/a')).toBe('http://example.com/a');
    expect(safeHref('mailto:help@example.com')).toBe('mailto:help@example.com');
    expect(safeHref('/privacy')).toBe('/privacy');
    expect(safeHref('#section')).toBe('#section');
    expect(safeHref('privacy')).toBe('privacy');
    expect(safeHref('a:b')).toBeNull();
    expect(safeHref('')).toBeNull();
    expect(safeHref('x'.repeat(2001))).toBeNull();
  });
  test('images are not supported and escapes work', () => {
    expect(html('![alt](https://x.test/a.png)')).not.toContain('<img');
    expect(html('\\*not bold\\*')).toContain('*not bold*');
    expect(html('snake_case_name stays')).toContain('snake_case_name');
  });
  test('size and nesting are bounded', () => {
    const big = 'a '.repeat(MAX_MARKDOWN_CHARS);
    expect(() => parseMarkdown(big)).not.toThrow();
    expect(() => parseMarkdown('> '.repeat(500) + 'deep')).not.toThrow();
    expect(() => parseMarkdown('['.repeat(2000) + 'x' + ']('.repeat(2000))).not.toThrow();
    expect(() => parseMarkdown('*'.repeat(5000))).not.toThrow();
  });
});

describe('line diff', () => {
  test('marks added, removed and unchanged lines', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(ops.filter((o) => o.type === 'del').map((o) => o.text)).toEqual(['b']);
    expect(ops.filter((o) => o.type === 'add').map((o) => o.text)).toEqual(['B', 'd']);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines('same', 'same'))).toEqual({ added: 0, removed: 0 });
    expect(diffLines('', 'x').map((o) => o.type)).toEqual(['add']);
  });
  test('a pathological pair does not blow up', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join('\n');
    expect(diffStats(diffLines(a, b))).toEqual({ added: 6000, removed: 6000 });
  });
});

describe('overview derivations', () => {
  const NOW = Date.parse('2026-06-10T12:00:00Z');
  const run = (job: string, minutesAgo: number, status: string, over: Partial<RunLite> = {}): RunLite => ({ job, started_at: new Date(NOW - minutesAgo * 60_000).toISOString(), status, processed: 1, errors: status === 'error' ? 1 : 0, dry_run: false, trigger: 'schedule', error_sample: null, ...over });
  test('the newest run per job and the 24 hour error count', () => {
    const jobs = summarizeJobs([run('retention', 5, 'ok'), run('retention', 60, 'error'), run('retention', 3000, 'error'), run('briefing', 1, 'error', { dry_run: true })], NOW);
    expect(jobs.map((j) => j.job)).toEqual(['briefing', 'retention']);
    const ret = jobs.find((j) => j.job === 'retention')!;
    expect(ret.last.status).toBe('ok');
    expect(ret.errors24h).toBe(1);
    expect(jobs.find((j) => j.job === 'briefing')!.errors24h).toBe(0); // a dry run is not a failure
  });
  test('alerts come only from signals that exist', () => {
    expect(buildAlerts({ providers: null, runs: null, system: null, now: NOW })).toEqual([]);
    const alerts = buildAlerts({
      providers: [{ provider: 'stripe', ready: false, missing: ['a', 'b'] }, { provider: 'twilio', ready: true, missing: [] }],
      runs: [run('cleanup', 10, 'error')],
      system: { frozen: { frozen: true }, loader: { ok: false, canary: 'failed', ignored_rows: 2, needs_reencrypt: true, error: 'secret_canary_failed' }, applied: { instances_alive: 3, instances_current: 2 } },
      now: NOW,
    });
    expect(alerts.map((a) => a.code).sort()).toEqual(['canary_failed', 'frozen', 'job_errors', 'needs_reencrypt', 'provider_not_ready', 'rows_ignored', 'settings_drift']);
    expect(alerts.find((a) => a.code === 'settings_drift')!.count).toBe(1);
  });
});

describe('move to console', () => {
  const pinned = (key: string, value: unknown, over: Partial<SettingView> = {}) => view(key, { source: 'env', locked: true, locked_reason: 'env', value, ...over });
  test('classification', () => {
    const c = classifyMove([
      pinned('billing.trial_days', 14),
      pinned('billing.past_due_grace_days', 5, { console_value: 5 }),
      pinned('billing.plan_sms_cap', 900, { console_value: 700 }),
      pinned('stripe.secret_key', null, { class: 'SECRET', kind: 'secret' }),
      pinned('billing.enforced', true), // critical
      pinned('billing.plan_name', null, { env_invalid: true }),
      view('brand.name'), // not pinned
    ], ['settings.write']);
    expect(c.movable.map((r) => r.key).sort()).toEqual(['billing.plan_sms_cap', 'billing.trial_days']);
    expect(c.movable.find((r) => r.key === 'billing.trial_days')!.preselect).toBe(true);
    expect(c.movable.find((r) => r.key === 'billing.plan_sms_cap')!.preselect).toBe(false);
    expect(c.ready.map((r) => r.key)).toEqual(['billing.past_due_grace_days']);
    expect(c.differs.map((r) => r.key)).toEqual(['billing.plan_sms_cap']);
    expect(c.blocked.map((b) => `${b.key}:${b.why}`).sort()).toEqual(['billing.enforced:permission', 'billing.plan_name:invalid', 'stripe.secret_key:secret']);
  });
});

describe('maintenance mode', () => {
  const base = { enabled: true, method: 'POST', pathname: '/api/businesses/b1/knowledge', bearer: false, userCookie: true };
  test('refuses tenant writes, spares everything the platform still needs', () => {
    expect(maintenanceRefuses(base)).toBe(true);
    expect(maintenanceRefuses({ ...base, method: 'PATCH' })).toBe(true);
    expect(maintenanceRefuses({ ...base, enabled: false })).toBe(false);
    expect(maintenanceRefuses({ ...base, method: 'GET' })).toBe(false);
    expect(maintenanceRefuses({ ...base, pathname: '/api/admin/settings/apply' })).toBe(false);
    expect(maintenanceRefuses({ ...base, pathname: '/api/auth/logout' })).toBe(false);
    expect(maintenanceRefuses({ ...base, pathname: '/api/me/locale' })).toBe(false);
    expect(maintenanceRefuses({ ...base, userCookie: false })).toBe(false); // webhooks and provider callbacks carry no user cookie
    expect(maintenanceRefuses({ ...base, bearer: true })).toBe(false);
    expect(maintenanceRefuses({ ...base, pathname: '/dashboard' })).toBe(false);
  });
});

describe('proxy: console never public, legal pages public, maintenance', () => {
  const saved = { token: process.env.ADMIN_TOKEN };
  beforeEach(() => { process.env.ADMIN_TOKEN = 'proxy-test-admin-token-xyz'; });
  afterEach(() => {
    setSnapshotSource(null);
    if (saved.token === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved.token;
  });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => proxy(new NextRequest(`http://localhost:3000${path}`, init));
  test('/admin and /api/admin are not public paths and need a credential', async () => {
    for (const p of ['/admin', '/admin/settings/voice', '/admin/legal', '/api/admin/settings', '/api/admin/legal/terms/en', '/admin/']) expect(isPublicPath(p)).toBe(false);
    const page = await call('/admin');
    expect(page.status).toBeGreaterThanOrEqual(300);
    expect(page.status).toBeLessThan(400);
    expect(new URL(page.headers.get('location')!, 'http://x').pathname).toBe('/login');
    expect((await call('/api/admin/settings')).status).toBe(401);
  });
  test('the legal pages are public', async () => {
    for (const p of ['/terms', '/privacy', '/sms-terms']) { expect(isPublicPath(p)).toBe(true); expect((await call(p)).headers.get('x-middleware-next')).toBe('1'); }
    expect(isPublicPath('/terms/x')).toBe(false);
  });
  test('maintenance: a tenant write is refused with 503 and Retry-After, the console and webhooks pass', async () => {
    setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'platform.maintenance_mode': true }, secrets: {}, loadedAt: Date.now() }));
    const cookie = { cookie: `rc_user_session=${'a'.repeat(43)}`, origin: 'http://localhost:3000', host: 'localhost:3000' };
    const refused = await call('/api/businesses/b1/knowledge', { method: 'PUT', headers: cookie });
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    expect(((await refused.json()) as { code: string }).code).toBe('maintenance');
    expect((await call('/api/admin/settings/apply', { method: 'POST', headers: cookie })).headers.get('x-middleware-next')).toBe('1');
    expect((await call('/api/voice/incoming', { method: 'POST' })).headers.get('x-middleware-next')).toBe('1');
    expect((await call('/api/businesses/b1/knowledge', { method: 'GET', headers: cookie })).status).not.toBe(503);
    setSnapshotSource(() => new ConfigSnapshot({ version: 2, values: {}, secrets: {}, loadedAt: Date.now() }));
    expect((await call('/api/businesses/b1/knowledge', { method: 'PUT', headers: cookie })).status).not.toBe(503);
  });
});

describe('legal links: URL setting, else the published built-in page, else nothing', () => {
  afterEach(() => { setSnapshotSource(null); noteLegalPublished([]); });
  test('precedence and absolute form', () => {
    expect(legalFooterLinks()).toEqual({ terms: null, privacy: null, sms_terms: null });
    noteLegalPublished(['terms', 'sms_terms']);
    expect(legalFooterLinks()).toEqual({ terms: '/terms', privacy: null, sms_terms: '/sms-terms' });
    setSnapshotSource(() => new ConfigSnapshot({ version: 1, values: { 'legal.terms_url': 'https://legal.example.test/tos' }, secrets: {}, loadedAt: Date.now() }));
    expect(legalFooterLinks().terms).toBe('https://legal.example.test/tos');
    expect(legalFooterLinks().sms_terms).toBe('/sms-terms');
    expect(absoluteLegalUrl('/terms', 'https://app.example.test/')).toBe('https://app.example.test/terms');
    expect(absoluteLegalUrl('https://x.test/t', 'https://app.example.test')).toBe('https://x.test/t');
    expect(absoluteLegalUrl(null, 'https://app.example.test')).toBeNull();
  });
  test('e-mail footers and the SMS help reply carry the links only when they exist', () => {
    const plain = verifyEmailTemplate({ link: 'https://app.example.test/verify?token=t' });
    expect(plain.text).not.toContain('/privacy');
    noteLegalPublished(['privacy', 'terms']);
    const withLinks = verifyEmailTemplate({ link: 'https://app.example.test/verify?token=t' });
    expect(withLinks.text).toContain('Privacy: ');
    expect(withLinks.text).toMatch(/Terms: http:\/\/localhost:3000\/terms|Terms: https?:\/\/[^ \n]+\/terms/);
    expect(withLinks.html).toContain('/privacy');
    expect(helpReply('Acme', '+13055550100')).not.toContain('Terms:');
    expect(helpReply('Acme', '+13055550100', 'https://app.example.test/sms-terms')).toContain('Terms: https://app.example.test/sms-terms');
  });
  test('the signup consent line links only what exists, in both languages', () => {
    const r = (terms: string | null, privacy: string | null, locale: 'en' | 'es' = 'en') => renderToStaticMarkup(<I18nProvider locale={locale} messages={locale === 'en' ? en : es}><LegalConsentLine terms={terms} privacy={privacy} /></I18nProvider>);
    expect(r(null, null)).toBe('');
    expect(r('/terms', '/privacy')).toContain('href="/terms"');
    expect(r('/terms', null)).not.toContain('Privacy');
    expect(r('https://x.test/t', '/privacy')).toContain('rel="noopener noreferrer"');
    expect(r('/terms', '/privacy', 'es')).toContain('Al crear una cuenta acepta');
  });
});

describe('catalog', () => {
  test('server error codes of the console map to both languages', () => {
    const t = makeT('es');
    expect(t('ac.err.stale_preview')).toContain('Revise');
    expect(makeT('en')('ac.err.confirmation_required')).toContain('confirmation phrase');
  });
});
