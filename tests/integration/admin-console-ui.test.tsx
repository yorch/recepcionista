/**
 * Console UI backends against a real database (Agent A): "Move to console" (`adopt`: an environment-pinned value is copied to the console and stays dormant until the
 * variable is deleted, anything else on a pinned key is still locked), the legal pages end to end (draft -> publish -> public page, links, sitemap, 404 when unpublished),
 * the maintenance banner source and the settings listing the forms are generated from. No outbound request leaves the machine.
 */
import { integration, outboundCalls, SECRETS } from '../helpers/env';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { captureMail } from '../helpers/auth-harness';
import { loadPrisma } from '../helpers/fixtures';

integration('admin console UI: move to console, legal pages (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let loader: typeof import('@/lib/admin/loader');
  let cfg: typeof import('@/lib/config');
  let links: typeof import('@/lib/legal-links');
  let legal: typeof import('@/lib/admin/legal');
  let store: typeof import('@/lib/admin/settings-store');
  let R: Record<string, any> = {};
  const savedEnv: Record<string, string | undefined> = {};
  const startedAt = new Date(Date.now() - 1000);
  const MASTER = crypto.randomBytes(32).toString('base64');
  const ORIGIN = 'https://app.example.test';
  const setEnv = (k: string, v: string | undefined) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const bearer = () => ({ authorization: `Bearer ${SECRETS.adminToken}` });
  const post = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown) => {
    const res = await handler(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...bearer() }, body: JSON.stringify(body) }));
    const json = (await res.json()) as any;
    return { status: res.status, json, data: json?.data, code: json?.code };
  };
  const owner: any = { kind: 'admin_token', user_id: null, via: 'bearer', role: 'owner', ip: null };

  /** Server render with async server components (the footer links read the database): wait for everything, then read the markup. */
  async function renderAsync(node: React.ReactNode): Promise<string> {
    const { renderToReadableStream } = await import('react-dom/server');
    const stream = await renderToReadableStream(node as any);
    await stream.allReady;
    return await new Response(stream).text();
  }

  async function reset() {
    await prisma.platformSetting.deleteMany({});
    await prisma.settingChangeSet.deleteMany({});
    await prisma.legalPageVersion.deleteMany({});
    await prisma.legalPage.deleteMany({});
    await prisma.settingsState.upsert({ where: { id: 1 }, create: { id: 1, globalVersion: 0 }, update: { globalVersion: { increment: 1 }, frozenAt: null, frozenBy: null, frozenReason: null } });
    links.resetLegalLinksCache();
  }

  beforeAll(async () => {
    for (const k of ['EMAIL_PROVIDER', 'EMAIL_FROM', 'RESEND_API_KEY', 'TRUSTED_PROXY', 'APP_URL']) setEnv(k, process.env[k]);
    setEnv('APP_SECRET_KEY', MASTER);
    for (const k of ['SETTINGS_FREEZE', 'ALERT_EMAIL', 'BILLING_TRIAL_DAYS', 'BILLING_PLAN_NAME']) setEnv(k, undefined);
    setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', 'true');
    prisma = await loadPrisma();
    loader = await import('@/lib/admin/loader'); cfg = await import('@/lib/config'); links = await import('@/lib/legal-links'); legal = await import('@/lib/admin/legal'); store = await import('@/lib/admin/settings-store');
    R = {
      apply: await import('@/app/api/admin/settings/apply/route'), preview: await import('@/app/api/admin/settings/preview/route'), settings: await import('@/app/api/admin/settings/route'),
    };
    await reset();
    loader.startSettingsPoll(3_600_000);
    await loader.refreshNow();
    captureMail();
  });
  beforeEach(async () => { setEnv('BILLING_TRIAL_DAYS', undefined); setEnv('ADMIN_TOKEN_ALLOW_SETTINGS', 'true'); await reset(); await loader.refreshNow(); });
  afterAll(async () => {
    expect(outboundCalls).toEqual([]);
    loader.stopSettingsLoader();
    await reset();
    await prisma.auditEvent.deleteMany({ where: { at: { gte: startedAt }, action: { in: ['settings.change', 'legal.draft_saved', 'legal.published', 'admin.bearer_use'] } } });
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await prisma.$disconnect();
  });

  test('a pinned key refuses every write, except "adopt" of exactly the pinned value', async () => {
    setEnv('BILLING_TRIAL_DAYS', '21');
    await loader.refreshNow();
    const plain = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'billing.trial_days', value: 21 }], reason: 'copy the value to the console' });
    expect(plain.status).toBe(409);
    expect(plain.code).toBe('locked_by_env');
    const other = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'billing.trial_days', value: 30 }], reason: 'try another value', adopt: true });
    expect(other.status).toBe(409);
    expect(other.code).toBe('locked_by_env');
    const removal = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'billing.trial_days', remove: true }], reason: 'try to remove', adopt: true });
    expect(removal.status).toBe(409);
    expect(await prisma.platformSetting.count({ where: { key: 'billing.trial_days' } })).toBe(0);

    const prev = await post(R.preview.POST, '/api/admin/settings/preview', { changes: [{ key: 'billing.trial_days', value: 21 }], adopt: true });
    expect(prev.status).toBe(200);
    expect(prev.data.changes[0].op).toBe('set');
    expect(prev.data.changes[0].source_before).toBe('env');
    const done = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'billing.trial_days', value: 21 }], reason: 'move trial days to the console', adopt: true, expected_version: prev.data.version });
    expect(done.status).toBe(200);
    expect(done.data.noop).toBe(false);
    expect((await prisma.platformSetting.findUnique({ where: { key: 'billing.trial_days' } }))?.value).toBe(21);
  });

  test('the copied value is dormant while the variable exists and serves once it is deleted', async () => {
    setEnv('BILLING_TRIAL_DAYS', '21');
    await loader.refreshNow();
    await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'billing.trial_days', value: 21 }], reason: 'move trial days to the console', adopt: true });
    await loader.refreshNow();
    expect(cfg.setting('billing.trial_days')).toBe(21);
    expect(cfg.settingSource('billing.trial_days')).toBe('env');
    const listing = (await (await R.settings.GET(new Request(`${ORIGIN}/api/admin/settings`, { headers: bearer() }))).json()).data;
    const view = listing.settings.find((s: any) => s.key === 'billing.trial_days');
    expect(view).toMatchObject({ source: 'env', locked: true, value: 21, console_value: 21, env: 'BILLING_TRIAL_DAYS' });
    setEnv('BILLING_TRIAL_DAYS', undefined);
    await loader.refreshNow();
    expect(cfg.setting('billing.trial_days')).toBe(21);
    expect(cfg.settingSource('billing.trial_days')).toBe('console');
  });

  test('adopt never carries secrets, and an unpinned key needs no adopt', async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_adopt_must_not_copy_0123456789');
    try {
      const r = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'stripe.secret_key', secret: 'sk_test_adopt_must_not_copy_0123456789' }], reason: 'copy the secret', confirm: 'stripe.secret_key', adopt: true });
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.json)).not.toContain('adopt_must_not_copy');
    } finally { setEnv('STRIPE_SECRET_KEY', undefined); }
    const free = await post(R.apply.POST, '/api/admin/settings/apply', { changes: [{ key: 'brand.name', value: 'Acme Voice' }], adopt: true });
    expect(free.status).toBe(200);
    expect(cfg.setting('brand.name')).toBe('Acme Voice');
  });

  test('legal pages: unpublished is not linked, publishing makes the page, the links and the sitemap entry appear', async () => {
    const before = await links.legalLinks();
    expect(before).toEqual({ terms: null, privacy: null, sms_terms: null });
    expect(await legal.getPublishedLegal('terms', 'en')).toBeNull();

    await legal.saveLegalDraft({ slug: 'terms', locale: 'en', body: '# Terms\n\nBe kind. [privacy](/privacy) <script>alert(1)</script>', actor: owner });
    await legal.saveLegalDraft({ slug: 'terms', locale: 'es', body: '# Términos\n\nSea amable.', actor: owner });
    expect(await legal.getPublishedLegal('terms', 'en')).toBeNull(); // a draft is not public
    await legal.publishLegal({ slug: 'terms', locale: 'en', reason: 'first version of the terms', actor: owner });
    links.resetLegalLinksCache();
    expect((await links.legalLinks()).terms).toBe('/terms');
    expect((await links.legalLinks()).privacy).toBeNull();
    const en = await legal.getPublishedLegal('terms', 'en');
    expect(en?.version).toBe(1);
    // Spanish is only a draft: the visitor gets the English page
    expect((await legal.getPublishedLegal('terms', 'es'))?.locale).toBe('en');

    // the public page renders the safe markdown (script text escaped), with its version and date
    const { I18nProvider } = await import('@/lib/i18n/client');
    const { en: enMsgs } = await import('@/lib/i18n/en');
    const { LegalDocument } = await import('@/components/legal/legal-document');
    const html = await renderAsync(<I18nProvider locale="en" messages={enMsgs}>{await LegalDocument({ slug: 'terms' })}</I18nProvider>);
    expect(html).toContain('Be kind.');
    expect(html).toContain('Terms of service');
    expect(html).toContain('Version 1');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    await expect(LegalDocument({ slug: 'privacy' })).rejects.toThrow(); // unpublished: notFound()

    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => new URL(e.url).pathname);
    expect(urls).toContain('/terms');
    expect(urls).not.toContain('/privacy');
  });

  test('an external URL in the console replaces the built-in link; the maintenance switch is readable by the banner', async () => {
    await legal.saveLegalDraft({ slug: 'privacy', locale: 'en', body: 'Privacy text', actor: owner });
    await legal.publishLegal({ slug: 'privacy', locale: 'en', reason: 'first privacy version here', actor: owner });
    links.resetLegalLinksCache();
    expect((await links.legalLinks()).privacy).toBe('/privacy');
    await store.applyChanges({ changes: [{ key: 'legal.privacy_url', value: 'https://legal.example.test/privacy' }, { key: 'platform.maintenance_mode', value: true }, { key: 'platform.announcement', value: 'Planned work <b>tonight</b>' }], reason: 'point to the external page and announce', actor: owner });
    await loader.refreshNow();
    links.resetLegalLinksCache();
    expect((await links.legalLinks()).privacy).toBe('https://legal.example.test/privacy');
    expect(cfg.setting('platform.maintenance_mode')).toBe(true);
    const { PlatformBanner } = await import('@/components/platform-banner');
    const html = await renderAsync(await PlatformBanner());
    expect(html).toContain('maintenance');
    expect(html).toContain('Planned work &lt;b&gt;tonight&lt;/b&gt;'); // plain text, escaped
    expect(html).not.toContain('<b>');
  });
});
