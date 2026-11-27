/**
 * Phase 0 hardening (docs/review/24e section 7): the single public-origin resolver, admin step-up / limits coverage, admin 2FA default,
 * single-sourced KB limits, the build-time price vars and the env documentation. Pure: no database, no clock, no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteBaseUrl, baseUrlHost, baseUrlOrDev, baseUrlOrigin, baseUrlWarnings, configuredBaseUrl } from '../src/lib/base-url';
import { admin2faOptOutIgnored, require2faForAdmins } from '../src/lib/admin-2fa';
import { adminBillingValues } from '../src/lib/billing/admin-audit';
import { EXTRACTION_LIMITS, KB_LIMITS, kbListLimitProblem } from '../src/lib/kb/limits';
import { validateKbPatch } from '../src/lib/kb-patch';
import { generateKnowledgeBase } from '../src/lib/kb';
import { LIMITS as EDITOR_LIMITS } from '../src/components/knowledge/model';
import { numberWebhooks, smsStatusCallbackUrl } from '../src/lib/providers/twilio';
import { returnBaseUrl } from '../src/lib/providers/stripe-billing';
import { appBaseUrl } from '../src/lib/email/templates';
import { webauthnConfig } from '../src/lib/webauthn';
import { redirectUri, webhookUrl } from '../src/lib/integrations/google/config';
import { upgradeInsecureEnabled } from '../src/lib/csp';
import type { Business, ExtractionResult } from '../src/lib/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const E = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

describe('single base-URL resolver', () => {
  test('precedence APP_URL, then PUBLIC_BASE_URL; NEXT_PUBLIC_APP_URL is never a source; slashes and spaces trimmed', () => {
    expect(configuredBaseUrl(E({ APP_URL: 'https://a.test', PUBLIC_BASE_URL: 'https://b.test' }))).toBe('https://a.test');
    expect(configuredBaseUrl(E({ PUBLIC_BASE_URL: ' https://b.test// ' }))).toBe('https://b.test');
    expect(configuredBaseUrl(E({ NEXT_PUBLIC_APP_URL: 'https://c.test' }))).toBe('');
    expect(configuredBaseUrl(E({ APP_URL: '  ', PUBLIC_BASE_URL: 'https://b.test' }))).toBe('https://b.test');
    expect(baseUrlOrDev(E({}))).toBe('http://localhost:3000');
    expect(absoluteBaseUrl(E({ APP_URL: 'app.test' }))).toBeNull();
    expect(absoluteBaseUrl(E({ APP_URL: 'https://a.test/' }))).toBe('https://a.test');
    expect(baseUrlOrigin(E({ APP_URL: 'https://A.test:8443/x' }))).toBe('https://a.test:8443');
    expect(baseUrlOrigin(E({ APP_URL: 'not a url' }))).toBeNull();
    expect(baseUrlHost(E({ APP_URL: 'https://App.Test:8443' }))).toBe('app.test:8443');
    expect(baseUrlHost(E({}))).toBeNull();
  });

  test('warnings: differing origins, and any NEXT_PUBLIC_APP_URL', () => {
    expect(baseUrlWarnings(E({ APP_URL: 'https://a.test', PUBLIC_BASE_URL: 'https://a.test/' }))).toEqual([]);
    expect(baseUrlWarnings(E({}))).toEqual([]);
    const differ = baseUrlWarnings(E({ APP_URL: 'https://a.test', PUBLIC_BASE_URL: 'https://b.test' }));
    expect(differ).toHaveLength(1);
    expect(differ[0]).toContain('APP_URL wins');
    const legacy = baseUrlWarnings(E({ APP_URL: 'https://a.test', NEXT_PUBLIC_APP_URL: 'https://c.test' }));
    expect(legacy[0]).toContain('IGNORED');
    expect(baseUrlWarnings(E({ APP_URL: 'https://a.test', NEXT_PUBLIC_APP_URL: 'https://a.test' }))[0]).toContain('no longer read');
  });

  test('every consumer resolves the SAME origin when APP_URL and PUBLIC_BASE_URL differ (and ignores NEXT_PUBLIC_APP_URL)', () => {
    const env = E({
      APP_URL: 'https://one.example.test', PUBLIC_BASE_URL: 'https://two.example.test', NEXT_PUBLIC_APP_URL: 'https://three.example.test',
      NODE_ENV: 'production', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+15005550006',
    });
    const want = 'https://one.example.test';
    expect(numberWebhooks(env)?.SmsUrl).toBe(`${want}/api/sms/inbound`);
    expect(smsStatusCallbackUrl(env)).toBe(`${want}/api/sms/status`);
    expect(returnBaseUrl(env)).toBe(want);
    expect(appBaseUrl(env)).toBe(want);
    expect(webauthnConfig(env)?.origins).toEqual([want]);
    expect(redirectUri(E({ ...env, GOOGLE_OAUTH_REDIRECT_URI: '' }))).toBe(`${want}/api/integrations/google/callback`);
    expect(webhookUrl(env)).toBe(`${want}/api/integrations/google/webhook`);
    expect(upgradeInsecureEnabled(env)).toBe(true);
    // Only the legacy variable set: nothing is configured (the dev fallbacks / production errors apply).
    const legacyOnly = E({ NEXT_PUBLIC_APP_URL: 'https://three.example.test', NODE_ENV: 'production' });
    expect(numberWebhooks(E({ ...legacyOnly, TWILIO_ACCOUNT_SID: 'ACx' }))).toBeNull();
    expect(() => returnBaseUrl(legacyOnly)).toThrow();
    expect(() => appBaseUrl(legacyOnly)).toThrow();
    expect(upgradeInsecureEnabled(legacyOnly)).toBe(false);
  });

  describe('process.env readers (Twilio signature URL, ElevenLabs/Stripe appUrl, sitemap, CSRF allowlist)', () => {
    const KEYS = ['APP_URL', 'PUBLIC_BASE_URL', 'NEXT_PUBLIC_APP_URL', 'TRUSTED_PROXY'] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) saved[k] = process.env[k];
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    const set = (o: Record<string, string | undefined>) => { for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(o)) if (v !== undefined) process.env[k] = v; };

    test('Twilio signature check uses the resolved origin, not the request host', async () => {
      const { createHmac } = await import('node:crypto');
      const { verifyTwilioSignature } = await import('../src/lib/providers/twilio');
      const sign = (url: string, token: string, params: Record<string, string>) =>
        createHmac('sha1', token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
      set({ APP_URL: 'https://one.example.test', PUBLIC_BASE_URL: 'https://two.example.test' });
      const saveTok = process.env.TWILIO_AUTH_TOKEN; process.env.TWILIO_AUTH_TOKEN = 'tok-phase0';
      try {
        const params = { A: '1' };
        const reqSignedFor = (origin: string) => new Request('http://internal:3000/api/sms/inbound', {
          method: 'POST', headers: { 'x-twilio-signature': sign(`${origin}/api/sms/inbound`, 'tok-phase0', params) },
        });
        expect(verifyTwilioSignature(reqSignedFor('https://one.example.test'), params).ok).toBe(true);
        expect(verifyTwilioSignature(reqSignedFor('https://two.example.test'), params).ok).toBe(false);
        expect(verifyTwilioSignature(reqSignedFor('https://three.example.test'), params).ok).toBe(false);
        set({ PUBLIC_BASE_URL: 'https://two.example.test' }); // APP_URL unset: the fallback is the signing origin
        expect(verifyTwilioSignature(reqSignedFor('https://two.example.test'), params).ok).toBe(true);
      } finally { if (saveTok === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = saveTok; }
    });

    test('ElevenLabs / Stripe appUrl, tool and initiation URLs, sitemap', async () => {
      set({ APP_URL: 'https://one.example.test', PUBLIC_BASE_URL: 'https://two.example.test', NEXT_PUBLIC_APP_URL: 'https://three.example.test' });
      const { appUrl } = await import('../src/lib/providers/stripe');
      const { initiationWebhookUrl } = await import('../src/lib/voice/elevenlabs');
      const { siteUrl } = await import('../src/app/site-config');
      expect(appUrl()).toBe('https://one.example.test');
      expect(initiationWebhookUrl()).toBe('https://one.example.test/api/voice/initiation');
      expect(siteUrl()).toBe('https://one.example.test');
      set({ PUBLIC_BASE_URL: 'https://two.example.test/' });
      expect(appUrl()).toBe('https://two.example.test');
      expect(siteUrl()).toBe('https://two.example.test');
      set({ NEXT_PUBLIC_APP_URL: 'https://three.example.test' });
      expect(appUrl()).toBe('http://localhost:3000');
      expect(siteUrl()).toBe('http://localhost:3000');
    });

    test('CSRF same-origin allowlist accepts exactly the resolved origin (not a second one, not the legacy variable)', async () => {
      const { checkSameOrigin } = await import('../src/lib/auth');
      const h = (origin: string) => new Headers({ origin, host: 'internal:3000' });
      set({ APP_URL: 'https://one.example.test', PUBLIC_BASE_URL: 'https://two.example.test', NEXT_PUBLIC_APP_URL: 'https://three.example.test' });
      expect(checkSameOrigin(h('https://one.example.test'))).toBe(true);
      expect(checkSameOrigin(h('https://two.example.test'))).toBe(false);
      expect(checkSameOrigin(h('https://three.example.test'))).toBe(false);
      set({ PUBLIC_BASE_URL: 'https://two.example.test' });
      expect(checkSameOrigin(h('https://two.example.test'))).toBe(true);
    });
  });

  test('no source file reads the origin variables directly (the resolver is the only reader)', () => {
    const offenders: string[] = [];
    for (const f of walk(join(ROOT, 'src'))) {
      if (!/\.(ts|tsx)$/.test(f) || f.endsWith(join('src', 'lib', 'base-url.ts'))) continue;
      const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      if (/\b(?:process\.)?env\??\.(PUBLIC_BASE_URL|NEXT_PUBLIC_APP_URL|APP_URL)\b/.test(code.replace(/process\.env\.APP_URL \|\| 'unset'/g, ''))) offenders.push(f.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});

describe('admin routes: step-up, rate limit, audit (source-level guard; behaviour in tests/integration/phase0-admin.test.ts)', () => {
  const routes = walk(join(ROOT, 'src/app/api/admin')).filter((f) => f.endsWith('route.ts'));
  test('there are admin routes to guard', () => { expect(routes.length).toBeGreaterThanOrEqual(8); });
  for (const f of routes) {
    const rel = f.slice(ROOT.length + 1);
    const src = readFileSync(f, 'utf8');
    test(`${rel}: rate limited${/export async function (POST|PUT|PATCH|DELETE)/.test(src) ? ' and step-up protected' : ''}`, () => {
      // The console routes go through guardAdminRoute (src/lib/admin/guard.ts: authenticate, permission, rate limit, step-up); the older ones call the pieces directly.
      expect(/limitRequest\(|\brate: /.test(src)).toBe(true);
      if (/export async function (POST|PUT|PATCH|DELETE)/.test(src)) expect(/requireRecentAuth\(|write: true|read-only POST/.test(src)).toBe(true);
    });
  }
  test('internalAuthHeaders (dead, would put the break-glass token on outbound calls) is gone', () => {
    for (const f of walk(join(ROOT, 'src'))) expect(readFileSync(f, 'utf8')).not.toContain('internalAuthHeaders');
  });
  test('billing.admin_override audit values are a sanitized fixed shape (caps, dates, status, plan)', () => {
    const v = adminBillingValues({
      billing_status: 'active', plan: 'x'.repeat(100), trial_ends_at: '2026-01-02T03:04:05+02:00', current_period_end: 'garbage',
      sms_cap_override: 250, call_minutes_cap_override: -5 as unknown as number,
    });
    expect(v).toEqual({
      billing_status: 'active', plan: 'x'.repeat(60), trial_ends_at: '2026-01-02T01:04:05.000Z', current_period_end: null,
      sms_cap_override: 250, call_minutes_cap_override: null,
    });
    expect(adminBillingValues({ billing_status: undefined as never, plan: null, trial_ends_at: null, current_period_end: null, sms_cap_override: null, call_minutes_cap_override: null }).billing_status).toBe('none');
    expect(read('src/app/api/admin/billing/route.ts')).toContain('adminBillingValues(updated)');
  });
});

describe('REQUIRE_2FA_FOR_ADMINS default', () => {
  test('production: always on, the opt-out is ignored (and flagged); elsewhere opt-in', () => {
    expect(require2faForAdmins(E({ NODE_ENV: 'production' }))).toBe(true);
    expect(require2faForAdmins(E({ NODE_ENV: 'production', REQUIRE_2FA_FOR_ADMINS: 'false' }))).toBe(true);
    expect(require2faForAdmins(E({ NODE_ENV: 'production', REQUIRE_2FA_FOR_ADMINS: 'true' }))).toBe(true);
    expect(admin2faOptOutIgnored(E({ NODE_ENV: 'production', REQUIRE_2FA_FOR_ADMINS: 'false' }))).toBe(true);
    expect(admin2faOptOutIgnored(E({ NODE_ENV: 'production' }))).toBe(false);
    expect(admin2faOptOutIgnored(E({ NODE_ENV: 'development', REQUIRE_2FA_FOR_ADMINS: 'false' }))).toBe(false);
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(require2faForAdmins(E({ NODE_ENV: nodeEnv }))).toBe(false);
      expect(require2faForAdmins(E({ NODE_ENV: nodeEnv, REQUIRE_2FA_FOR_ADMINS: 'false' }))).toBe(false);
      expect(require2faForAdmins(E({ NODE_ENV: nodeEnv, REQUIRE_2FA_FOR_ADMINS: ' TRUE ' }))).toBe(true);
    }
  });
  test('the startup banner reports the base URL and the ignored opt-out', () => {
    const src = read('src/instrumentation.ts');
    expect(src).toContain('baseUrlWarnings()');
    expect(src).toContain('admin2faOptOutIgnored()');
  });
});

describe('knowledge-base limits are single-sourced', () => {
  const biz = { id: 'b1', name: 'Acme Co', phone: '+13055550100', owner_name: 'Jorge', owner_phone: '+13055559999', service_area: ['Miami'], hours: {}, status: 'live', created_at: '2026-01-01T00:00:00Z' } as Business;
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, base_price: 10 }));
  const manyFaqs = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}` }));

  test('constants: saved lists 200/200, extraction draft 20/15 (never confused)', () => {
    expect(KB_LIMITS.services).toBe(200);
    expect(KB_LIMITS.faqs).toBe(200);
    expect(EXTRACTION_LIMITS.services).toBe(20);
    expect(EXTRACTION_LIMITS.faqs).toBe(15);
    expect(EXTRACTION_LIMITS.services).toBeLessThan(KB_LIMITS.services);
  });
  test('kbListLimitProblem: at the limit is fine, one over is an error naming the limit; absent lists are ignored', () => {
    expect(kbListLimitProblem({})).toBeNull();
    expect(kbListLimitProblem({ services: many(KB_LIMITS.services), faqs: manyFaqs(KB_LIMITS.faqs) })).toBeNull();
    expect(kbListLimitProblem({ services: many(KB_LIMITS.services + 1) })).toBe(`services must be a list of at most ${KB_LIMITS.services}`);
    expect(kbListLimitProblem({ faqs: manyFaqs(KB_LIMITS.faqs + 1) })).toBe(`faqs must be a list of at most ${KB_LIMITS.faqs}`);
    expect(kbListLimitProblem({ services: 'nope' })).toBeNull();
  });
  test('the dashboard editor (which could never hold more than 20 / 15) uses the same counts as the server', () => {
    expect(EDITOR_LIMITS.services).toBe(KB_LIMITS.services);
    expect(EDITOR_LIMITS.faqs).toBe(KB_LIMITS.faqs);
    expect(EDITOR_LIMITS.name).toBe(KB_LIMITS.name);
    expect(EDITOR_LIMITS.areas).toBe(KB_LIMITS.areas);
  });
  test('the owner-change patch validator uses the same constants', () => {
    expect(validateKbPatch({ services: many(KB_LIMITS.services) }).ok).toBe(true);
    const over = validateKbPatch({ services: many(KB_LIMITS.services + 1) });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toBe(`services must be a list of at most ${KB_LIMITS.services}`);
    const overFaq = validateKbPatch({ faqs: manyFaqs(KB_LIMITS.faqs + 1) });
    expect(overFaq.ok === false && overFaq.error).toBe(`faqs must be a list of at most ${KB_LIMITS.faqs}`);
  });
  test('the extraction draft keeps EXTRACTION_LIMITS, and the dashboard save path does not cut to them', () => {
    const extraction = { name: 'Acme', services: many(60), faqs: manyFaqs(60), hours: {}, service_area: [], pricing_notes: '', source: 'template' } as unknown as ExtractionResult;
    const kb = generateKnowledgeBase(extraction, biz);
    expect(kb.services).toHaveLength(EXTRACTION_LIMITS.services);
    expect(kb.faqs).toHaveLength(EXTRACTION_LIMITS.faqs);
    const route = read('src/app/api/businesses/[id]/knowledge/route.ts');
    expect(route).toContain('kbListLimitProblem(body)');
    expect(route).not.toMatch(/slice\(0, \d+\)/);
    expect(read('src/lib/kb/index.ts')).not.toMatch(/slice\(0, (20|15)\)/);
    expect(read('src/lib/extraction/index.ts')).not.toMatch(/slice\(0, (20|15)\)/);
  });
});

describe('Phase 6: no build-time NEXT_PUBLIC_* config (Turnstile site key and price copy are runtime settings)', () => {
  const dockerfile = read('Dockerfile');
  const compose = read('compose.production.yaml');
  const envExample = read('.env.example');
  const envDocs = read('docs/env-vars.md');
  const NAMES = ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_PLAN_PRICE_DISPLAY', 'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL', 'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES', 'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL_ES'];
  test('site-config reads the price copy from the config snapshot, never from process.env', () => {
    const site = read('src/app/site-config.ts');
    expect(site).not.toMatch(/process\.env/);
    expect(site).toContain("setting('billing.price_display_es')");
    expect(site).toContain("setting('billing.price_display_annual_es')");
  });
  test('the signup page reads the site key from the snapshot and passes it down as a prop', () => {
    const page = read('src/app/signup/page.tsx');
    expect(page).not.toMatch(/process\.env/);
    expect(page).toContain("setting('signup.turnstile_site_key')");
  });
  test('Dockerfile and compose carry no NEXT_PUBLIC build arg', () => {
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+NEXT_PUBLIC_/m);
    expect(dockerfile).not.toMatch(/^\s+NEXT_PUBLIC_\w+=\$/m);
    expect(compose).not.toMatch(/^\s+NEXT_PUBLIC_[A-Z_]+:\s*\$\{/m);
    expect(compose).not.toMatch(/^\s+args:/m);
  });
  test('deploy.sh does not tell the operator to rebuild for these values', () => {
    expect(read('deploy.sh')).not.toMatch(/Set the site key before building/);
  });
  for (const v of NAMES) {
    test(`${v}: still a runtime alias, in .env.example and docs/env-vars.md`, () => {
      expect(envExample).toMatch(new RegExp(`^#? ?${v}=`, 'm'));
      expect(envDocs).toContain(`\`${v}`);
    });
  }
  test('no src file reads a NEXT_PUBLIC_* name from process.env (Next would inline it at build time)', () => {
    for (const f of walk(join(ROOT, 'src'))) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'); // comments may name them
      expect(code).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    }
  });
});

describe('.env.example documents the operator-settable variables 24a found missing', () => {
  const envExample = read('.env.example');
  for (const v of [
    'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES', 'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL_ES', 'OWNER_REPLY_ENABLED', 'OWNER_REPLY_DAILY_LIMIT', 'OWNER_REPLY_REQUIRE_ATTESTATION',
    'REFUND_RECONCILE_AFTER_HOURS', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_MESSAGING_SERVICE_PIN_SENDER', 'PRISMA_QUERY_EVENTS',
  ]) test(`${v}`, () => { expect(envExample).toMatch(new RegExp(`^#? ?${v}=`, 'm')); });
  test('NEXT_PUBLIC_APP_URL is documented as removed, not as a setting', () => {
    expect(envExample).not.toMatch(/^#? ?NEXT_PUBLIC_APP_URL=/m);
    expect(envExample).toContain('NEXT_PUBLIC_APP_URL is NOT read');
    expect(read('docs/env-vars.md')).toContain('**REMOVED, not read.**');
  });
});
