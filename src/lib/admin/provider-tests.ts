/**
 * Real connection tests of the platform providers (24e 5.6, Phase 4). Node runtime only.
 *
 *   testProvider(provider, { candidate })   one provider, with an optional CANDIDATE value that is not saved yet (test-before-save)
 *   secretVerifier({ changes })              the `ApplyOptions.verifySecret` hook of the console write routes
 *   liveSelftest({ force })                  `GET /api/admin/selftest?live=1`: every configured provider, cached 5 minutes
 *
 * Rules (24e T3, T4):
 *  - Provider API base URLs are hard-coded constants here. No setting, no candidate value and no redirect can point a test somewhere else (`redirect: 'manual'`).
 *  - The only admin-set host the server connects to is the SMTP relay: it is resolved first, refused when ANY address is private / loopback / link-local / metadata
 *    (`ssrf.ts`) and the connection is then made to the RESOLVED address (no second DNS lookup, so no rebinding window).
 *  - Results are COARSE: `ok | auth_failed | unreachable | misconfigured` plus a few enumerated booleans / counts. A remote error banner, status text or body is never returned,
 *    never logged and never stored; a credential never appears in a result, a log line or an error.
 *  - Every request has a timeout; the route is rate limited (6 / minute).
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import { setting, type SettingKey } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/log';
import { assertPublicSmtpTarget, defaultResolver, isPrivateAddress, smtpTargetOfUrl, SsrfError, type Resolver } from './ssrf';
import { selftest, type ProviderReadiness } from './selftest';
import { SettingsError, type ApplyOptions, type SettingChange } from './settings-store';
import { SECRET_TEST, secretFormatOk } from './provider-meta';

const log = logger('admin/provider-tests');

export const PROVIDER_IDS = ['twilio', 'elevenlabs', 'stripe', 'openai', 'anthropic', 'resend', 'smtp', 'google', 'turnstile'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);

export type TestOutcome = 'ok' | 'auth_failed' | 'unreachable' | 'misconfigured';
export type CheckOutcome = 'ok' | 'failed' | 'not_found' | 'skipped';

export interface ProviderTestResult {
  provider: ProviderId;
  outcome: TestOutcome;
  tested_at: string;
  ms: number;
  /** `remote`: the provider answered a real request. `local`: only the format could be checked (no provider endpoint accepts that secret on its own). */
  scope: 'remote' | 'local';
  /** Sub-checks (enumerated names, enumerated outcomes): never provider text. */
  checks?: Record<string, CheckOutcome>;
  /** Stripe: the mode of the candidate key (true = live). */
  livemode?: boolean | null;
  /** Stripe: the candidate key switches between test and live (null: unknown, no current key). */
  mode_changed?: boolean | null;
  /** Stripe: the candidate key belongs to another account than the current one (null: could not be established). */
  account_changed?: boolean | null;
  /** Stripe: businesses that hold a `stripe_customer_id` of the current account (would be orphaned by a mode / account change). */
  orphaned_businesses?: number;
}

export interface TestDeps {
  fetch?: typeof fetch;
  resolve?: Resolver;
  /** SMTP verify seam: connect to `ip` and report `ok | auth_failed | unreachable`. */
  smtpVerify?: (o: SmtpTarget) => Promise<'ok' | 'auth_failed' | 'unreachable'>;
  now?: () => number;
  timeoutMs?: number;
  /** Count of businesses holding a Stripe customer id (test seam; default: one indexed count). */
  countCustomers?: () => Promise<number>;
}

export interface SmtpTarget { ip: string; host: string; port: number; secure: boolean; user: string | null; pass: string | null; timeoutMs: number }

const TIMEOUT_MS = 8_000;
const MAX_BODY = 256 * 1024;

// ---- test seam --------------------------------------------------------------------------------------------------------------------------------

const DEPS_KEY = Symbol.for('rc.admin.provider-test-deps');
type G = Record<symbol, TestDeps | undefined>;
/** Tests inject a fake `fetch` here (null restores the real one). While nothing is injected, `NODE_ENV=test` runs never reach a provider (see `verificationEnabled`). */
export function setProviderTestDeps(deps: TestDeps | null): void { (globalThis as unknown as G)[DEPS_KEY] = deps ?? undefined; }
const injected = (): TestDeps | undefined => (globalThis as unknown as G)[DEPS_KEY];

/** Console writes verify a new secret against its provider, except under `bun test` without an injected transport (no test may leave the machine). */
export const verificationEnabled = (deps?: TestDeps): boolean => deps?.fetch !== undefined || injected() !== undefined || process.env.NODE_ENV !== 'test';

// ---- http -------------------------------------------------------------------------------------------------------------------------------------

interface Reply { status: number; json: Record<string, unknown> | null }

async function request(url: string, init: RequestInit, deps: TestDeps): Promise<Reply | null> {
  const f = deps.fetch ?? injected()?.fetch ?? fetch;
  try {
    const res = await f(url, { ...init, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(deps.timeoutMs ?? injected()?.timeoutMs ?? TIMEOUT_MS) });
    let json: Record<string, unknown> | null = null;
    try {
      const text = await res.text();
      if (text.length <= MAX_BODY) { const p = JSON.parse(text) as unknown; if (p && typeof p === 'object' && !Array.isArray(p)) json = p as Record<string, unknown>; }
    } catch { /* not JSON: only the status counts */ }
    return { status: res.status, json };
  } catch {
    return null; // network error, timeout or a refused transport: never the message (it can carry the URL)
  }
}

const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const str = (o: unknown, k: string): string | null => (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[k] === 'string' ? (o as Record<string, string>)[k] : null);
const obj = (o: unknown, k: string): Record<string, unknown> | null => { const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : null; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; };

/** The generic reading of a status code: 2xx ok, 401 auth, 403 / 404 / other 4xx misconfigured-or-auth by caller, 429 / 5xx / no answer unreachable. */
function byStatus(r: Reply | null, forbidden: TestOutcome = 'auth_failed'): TestOutcome {
  if (!r) return 'unreachable';
  if (r.status >= 200 && r.status < 300) return 'ok';
  if (r.status === 401) return 'auth_failed';
  if (r.status === 403) return forbidden;
  if (r.status === 429 || r.status >= 500) return 'unreachable';
  return 'misconfigured';
}

// ---- field access -----------------------------------------------------------------------------------------------------------------------------

type Candidate = Record<string, string>;
/** The candidate value of a key when it is in the change set, otherwise the effective (env / console / default) value. */
function reader(candidate: Candidate): (key: SettingKey) => string {
  return (key) => {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) return String(candidate[key] ?? '').trim();
    const v = setting(key);
    return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
  };
}

const TWILIO_SID = /^AC[0-9a-fA-F]{32}$/;
const MG_SID = /^MG[0-9a-fA-F]{32}$/;
const PRICE_ID = /^price_[A-Za-z0-9_]+$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;

// ---- the individual tests ---------------------------------------------------------------------------------------------------------------------

async function testTwilio(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const sid = get('twilio.account_sid'); const token = get('twilio.auth_token'); const mg = get('twilio.messaging_service_sid');
  if (!TWILIO_SID.test(sid) || !token) return { outcome: 'misconfigured' };
  const acc = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: { authorization: basic(sid, token), accept: 'application/json' } }, deps);
  let outcome = byStatus(acc, 'auth_failed');
  if (acc && acc.status === 404) outcome = 'auth_failed'; // an unknown account sid is a credential problem, not a transport one
  if (outcome === 'ok' && str(acc?.json, 'status') !== null && str(acc?.json, 'status') !== 'active') outcome = 'misconfigured'; // suspended / closed
  const checks: Record<string, CheckOutcome> = { account: outcome === 'ok' ? 'ok' : 'failed' };
  if (outcome === 'ok' && mg) {
    if (!MG_SID.test(mg)) checks.messaging_service = 'failed';
    else {
      const r = await request(`https://messaging.twilio.com/v1/Services/${mg}`, { headers: { authorization: basic(sid, token), accept: 'application/json' } }, deps);
      checks.messaging_service = r && r.status === 200 ? 'ok' : r && r.status === 404 ? 'not_found' : 'failed';
    }
    if (checks.messaging_service !== 'ok') outcome = 'misconfigured';
  } else if (outcome === 'ok') checks.messaging_service = 'skipped';
  return { outcome, checks };
}

async function testElevenLabs(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const key = get('elevenlabs.api_key');
  if (!key) return { outcome: 'misconfigured' };
  const r = await request('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key, accept: 'application/json' } }, deps);
  let outcome = byStatus(r);
  // A scoped key that lacks `user_read` is a VALID key: say "misconfigured" (permissions), not "wrong key".
  if (r && r.status === 401 && str(obj(r.json, 'detail'), 'status') === 'missing_permissions') outcome = 'misconfigured';
  return { outcome, checks: { account: outcome === 'ok' ? 'ok' : 'failed' } };
}

async function stripeCall(path: string, key: string, deps: TestDeps): Promise<Reply | null> {
  return request(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }, deps);
}
const stripeModeOfKey = (key: string): boolean | null => (/^(sk|rk)_live_/.test(key) ? true : /^(sk|rk)_test_/.test(key) ? false : null);

async function testStripe(get: ReturnType<typeof reader>, deps: TestDeps, candidateGiven: boolean): Promise<Pick<ProviderTestResult, 'outcome' | 'checks' | 'livemode' | 'mode_changed' | 'account_changed' | 'orphaned_businesses'>> {
  const key = get('stripe.secret_key');
  if (!key || !/^(sk|rk)_(live|test)_\S+$/.test(key)) return { outcome: 'misconfigured' };
  const bal = await stripeCall('balance', key, deps);
  let outcome = byStatus(bal, 'misconfigured'); // 403: a restricted key without the balance permission is valid but cannot be probed
  const livemode = bal && typeof bal.json?.livemode === 'boolean' ? bal.json.livemode as boolean : stripeModeOfKey(key);
  const checks: Record<string, CheckOutcome> = { balance: outcome === 'ok' ? 'ok' : 'failed' };
  const out: Pick<ProviderTestResult, 'outcome' | 'checks' | 'livemode' | 'mode_changed' | 'account_changed' | 'orphaned_businesses'> = { outcome, checks, livemode };
  if (outcome === 'ok') {
    // price ids exist, are recurring and belong to the SAME mode as the key
    for (const [label, k] of [['price_monthly', 'stripe.price_id'], ['price_annual', 'stripe.price_id_annual']] as const) {
      const id = get(k);
      if (!id) { checks[label] = 'skipped'; continue; }
      if (!PRICE_ID.test(id)) { checks[label] = 'failed'; outcome = 'misconfigured'; continue; }
      const r = await stripeCall(`prices/${encodeURIComponent(id)}`, key, deps);
      if (r && r.status === 200) {
        const pl = typeof r.json?.livemode === 'boolean' ? r.json.livemode : null;
        const recurring = obj(r.json, 'recurring') !== null;
        checks[label] = pl !== null && pl !== livemode ? 'failed' : recurring && r.json?.active !== false ? 'ok' : 'failed';
      } else checks[label] = r && r.status === 404 ? 'not_found' : r && (r.status === 401 || r.status === 403) ? 'skipped' : 'failed';
      if (checks[label] === 'failed' || checks[label] === 'not_found') outcome = 'misconfigured';
    }
  }
  out.outcome = outcome;
  // A test / live switch or another account orphans the customer ids stored on businesses: only compare for a CANDIDATE against a CURRENT key.
  if (candidateGiven) {
    const current = String(setting('stripe.secret_key') ?? '').trim();
    if (current && current !== key) {
      out.mode_changed = livemode === null ? null : stripeModeOfKey(current) === null ? null : stripeModeOfKey(current) !== livemode;
      let accountChanged: boolean | null = null;
      if (outcome === 'ok' || outcome === 'misconfigured') {
        const [a, b] = await Promise.all([stripeCall('account', key, deps), stripeCall('account', current, deps)]);
        const ia = a && a.status === 200 ? str(a.json, 'id') : null; const ib = b && b.status === 200 ? str(b.json, 'id') : null;
        if (ia && ib) accountChanged = ia !== ib;
      }
      out.account_changed = accountChanged;
      if (out.mode_changed || accountChanged !== false) out.orphaned_businesses = await (deps.countCustomers ?? defaultCountCustomers)();
    } else if (current) { out.mode_changed = false; out.account_changed = false; out.orphaned_businesses = 0; }
  }
  return out;
}
const defaultCountCustomers = (): Promise<number> => prisma.business.count({ where: { stripeCustomerId: { not: null } } });

async function testOpenAi(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const key = get('llm.openai_api_key');
  if (!key) return { outcome: 'misconfigured' };
  const r = await request('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }, deps);
  const outcome = byStatus(r, 'misconfigured');
  const checks: Record<string, CheckOutcome> = { models: outcome === 'ok' ? 'ok' : 'failed' };
  let out = outcome;
  if (outcome === 'ok') {
    const model = get('llm.openai_model');
    if (model && MODEL.test(model)) {
      const ids = Array.isArray(r?.json?.data) ? (r!.json!.data as unknown[]).map((m) => str(m, 'id')) : [];
      checks.model = ids.length === 0 ? 'skipped' : ids.includes(model) ? 'ok' : 'not_found';
      if (checks.model === 'not_found') out = 'misconfigured';
    } else checks.model = 'failed';
    if (checks.model === 'failed') out = 'misconfigured';
  }
  return { outcome: out, checks };
}

async function testAnthropic(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const key = get('llm.anthropic_api_key');
  if (!key) return { outcome: 'misconfigured' };
  const r = await request('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' } }, deps);
  const outcome = byStatus(r, 'misconfigured');
  const checks: Record<string, CheckOutcome> = { models: outcome === 'ok' ? 'ok' : 'failed' };
  let out = outcome;
  if (outcome === 'ok') {
    const model = get('llm.anthropic_model');
    if (model && MODEL.test(model)) {
      const ids = Array.isArray(r?.json?.data) ? (r!.json!.data as unknown[]).map((m) => str(m, 'id')) : [];
      checks.model = ids.length === 0 ? 'skipped' : ids.includes(model) ? 'ok' : 'not_found';
      if (checks.model === 'not_found') out = 'misconfigured';
    } else { checks.model = 'failed'; out = 'misconfigured'; }
  }
  return { outcome: out, checks };
}

async function testResend(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const key = get('email.resend_api_key');
  if (!key) return { outcome: 'misconfigured' };
  const r = await request('https://api.resend.com/domains', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }, deps);
  // A send-only key cannot list domains (401 `restricted_api_key`): it is a valid key for what the app does (send).
  if (r && r.status === 401 && str(r.json, 'name') === 'restricted_api_key') return { outcome: 'ok', checks: { account: 'ok', from_domain: 'skipped' } };
  const outcome = byStatus(r, 'auth_failed');
  const checks: Record<string, CheckOutcome> = { account: outcome === 'ok' ? 'ok' : 'failed' };
  if (outcome !== 'ok') return { outcome, checks };
  const from = get('email.from'); const m = from.match(/@([A-Za-z0-9.-]+)>?\s*$/);
  const data = Array.isArray(r?.json?.data) ? r!.json!.data as unknown[] : [];
  if (!m || data.length === 0) { checks.from_domain = 'skipped'; return { outcome, checks }; }
  const domain = m[1].toLowerCase();
  const hit = data.find((d) => str(d, 'name')?.toLowerCase() === domain || (domain.endsWith(`.${str(d, 'name')?.toLowerCase()}`)));
  checks.from_domain = !hit ? 'not_found' : str(hit, 'status') === 'verified' ? 'ok' : 'failed';
  return { outcome: checks.from_domain === 'ok' ? 'ok' : 'misconfigured', checks };
}

/** The SMTP target of a candidate: the URL form wins (like the sender), else host / port / user / pass / secure. Credentials stay inside this function. */
export function smtpTargetOf(get: ReturnType<typeof reader>): Omit<SmtpTarget, 'ip' | 'timeoutMs'> | null {
  const url = get('email.smtp_url');
  if (url) {
    const t = smtpTargetOfUrl(url);
    if (!t) return null;
    const u = new URL(url);
    return { host: t.host, port: t.port ?? 587, secure: u.protocol === 'smtps:' || get('email.smtp_secure') === 'true', user: u.username ? decodeURIComponent(u.username) : null, pass: u.password ? decodeURIComponent(u.password) : null };
  }
  const host = get('email.smtp_host');
  if (!host) return null;
  const port = Number(get('email.smtp_port')) || 587;
  return { host, port, secure: get('email.smtp_secure') === 'true' || port === 465, user: get('email.smtp_user') || null, pass: get('email.smtp_pass') || null };
}

async function nodemailerVerify(o: SmtpTarget): Promise<'ok' | 'auth_failed' | 'unreachable'> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: o.ip, port: o.port, secure: o.secure, requireTLS: !o.secure && o.port !== 25 ? true : undefined,
    ...(o.user && o.pass ? { auth: { user: o.user, pass: o.pass } } : {}),
    tls: { servername: net.isIP(o.host) ? undefined : o.host }, // certificate checked against the NAME, connection made to the resolved address
    connectionTimeout: o.timeoutMs, greetingTimeout: o.timeoutMs, socketTimeout: o.timeoutMs,
  } as unknown as import('nodemailer').TransportOptions);
  try {
    await transport.verify();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; responseCode?: number };
    return e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534 ? 'auth_failed' : 'unreachable';
  } finally {
    transport.close();
  }
}

async function testSmtp(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const t = smtpTargetOf(get);
  if (!t) return { outcome: 'misconfigured' };
  const resolve = deps.resolve ?? defaultResolver;
  try {
    await assertPublicSmtpTarget(t.host, t.port, resolve); // refuses a private / loopback / link-local / metadata address, a bad port, an unresolvable name
  } catch (err) {
    if (err instanceof SsrfError) return { outcome: 'misconfigured', checks: { target: 'failed' } };
    throw err;
  }
  // Connect to the address we just validated (pinned): a second lookup could return another one.
  let ip = t.host.replace(/^\[|\]$/g, '');
  if (!net.isIP(ip)) {
    const addrs = await resolve(ip).catch(() => [] as string[]);
    if (addrs.length === 0) return { outcome: 'misconfigured', checks: { target: 'failed' } };
    ip = addrs[0];
    if (addrs.some(isPrivateAddress)) return { outcome: 'misconfigured', checks: { target: 'failed' } }; // the answer changed between the two lookups
  }
  const verify = deps.smtpVerify ?? injected()?.smtpVerify ?? nodemailerVerify;
  const outcome = await verify({ ...t, ip, timeoutMs: Math.min(deps.timeoutMs ?? injected()?.timeoutMs ?? TIMEOUT_MS, 10_000) }).catch(() => 'unreachable' as const);
  return { outcome, checks: { target: 'ok', login: outcome === 'ok' ? 'ok' : 'failed' } };
}

async function testGoogle(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const id = get('google.client_id'); const secret = get('google.client_secret');
  if (!id || !secret) return { outcome: 'misconfigured' };
  // A dry call of the token endpoint with a garbage code: `invalid_client` = wrong id / secret, `invalid_grant` = the client itself is accepted.
  const r = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'rc-connection-test', client_id: id, client_secret: secret, redirect_uri: 'https://localhost/rc-connection-test' }).toString(),
  }, deps);
  if (!r) return { outcome: 'unreachable' };
  const code = str(r.json, 'error');
  if (code === 'invalid_client' || code === 'unauthorized_client') return { outcome: 'auth_failed', checks: { client: 'failed' } };
  if (code === 'invalid_grant' || code === 'redirect_uri_mismatch' || code === 'invalid_request') return { outcome: 'ok', checks: { client: 'ok' } };
  return { outcome: r.status >= 500 || r.status === 429 ? 'unreachable' : 'misconfigured', checks: { client: 'failed' } };
}

async function testTurnstile(get: ReturnType<typeof reader>, deps: TestDeps): Promise<Pick<ProviderTestResult, 'outcome' | 'checks'>> {
  const secret = get('signup.turnstile_secret_key'); const site = get('signup.turnstile_site_key');
  if (!secret) return { outcome: 'misconfigured' };
  // siteverify with a garbage token: a valid secret answers `invalid-input-response`, a wrong one `invalid-input-secret`.
  const r = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ secret, response: 'rc-connection-test' }).toString(),
  }, deps);
  if (!r) return { outcome: 'unreachable' };
  const codes = Array.isArray(r.json?.['error-codes']) ? (r.json!['error-codes'] as unknown[]).map(String) : [];
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) return { outcome: 'auth_failed', checks: { secret: 'failed' } };
  if (r.status >= 500 || r.status === 429) return { outcome: 'unreachable' };
  return { outcome: site ? 'ok' : 'misconfigured', checks: { secret: 'ok', site_key: site ? 'ok' : 'failed' } };
}

// ---- entry points -----------------------------------------------------------------------------------------------------------------------------

/**
 * Test one provider. `candidate` (registry key -> plaintext) is the value(s) about to be saved; anything not in it comes from the effective configuration, so a pair
 * (account sid + auth token) can be tested with the sid already stored. Never throws for a provider failure; never returns provider text.
 */
export async function testProvider(provider: ProviderId, opts: { candidate?: Candidate; deps?: TestDeps } = {}): Promise<ProviderTestResult> {
  const deps = { ...injected(), ...opts.deps };
  const now = deps.now ?? Date.now;
  const started = now();
  const get = reader(opts.candidate ?? {});
  const given = Object.keys(opts.candidate ?? {}).length > 0;
  let body: Partial<ProviderTestResult> & { outcome: TestOutcome };
  try {
    switch (provider) {
      case 'twilio': body = await testTwilio(get, deps); break;
      case 'elevenlabs': body = await testElevenLabs(get, deps); break;
      case 'stripe': body = await testStripe(get, deps, given); break;
      case 'openai': body = await testOpenAi(get, deps); break;
      case 'anthropic': body = await testAnthropic(get, deps); break;
      case 'resend': body = await testResend(get, deps); break;
      case 'smtp': body = await testSmtp(get, deps); break;
      case 'google': body = await testGoogle(get, deps); break;
      case 'turnstile': body = await testTurnstile(get, deps); break;
    }
  } catch (err) {
    log.warn('test.error', { provider, error: (err as Error).name }); // the name only: a message can carry a URL or a credential
    body = { outcome: 'unreachable' };
  }
  return { provider, scope: 'remote', ...body, tested_at: new Date(now()).toISOString(), ms: Math.max(0, now() - started) };
}

/** Registry key -> the provider whose endpoint accepts it. A key that is not here has no remote check (webhook secrets, tool secret): a format check only. */
export const SECRET_PROVIDER: Readonly<Record<string, ProviderId>> = SECRET_TEST;

/** Keys whose change set is tested as a whole (a candidate for the partner ids travels with the secret). */
export function candidateOf(changes: readonly SettingChange[]): Candidate {
  const out: Candidate = {};
  for (const c of changes) {
    if (c.remove) continue;
    if (typeof c.secret === 'string') out[c.key] = c.secret;
    else if (c.value !== undefined && c.value !== null && typeof c.value !== 'object') out[c.key] = String(c.value);
  }
  return out;
}

export { secretFormatOk };

export interface VerifyOptions {
  changes: readonly SettingChange[];
  /** The operator accepted saving although the provider could not be reached. */
  acceptUnreachable?: boolean;
  deps?: TestDeps;
}

/**
 * `ApplyOptions.verifySecret` for the console routes: test-before-save. false = refuse (`422 verification_failed`): the provider rejected the credential or the pair is
 * incomplete. A provider that cannot be reached refuses too, unless the operator explicitly accepted that. Secrets without a remote endpoint pass on format alone.
 * Disabled (always true) under `bun test` unless a transport was injected (`setProviderTestDeps`).
 */
export function secretVerifier(opts: VerifyOptions): (key: string, plaintext: string) => Promise<boolean> {
  const candidate = candidateOf(opts.changes);
  return async (key, plaintext) => {
    if (!verificationEnabled(opts.deps)) return true;
    if (!secretFormatOk(plaintext, key)) return false;
    const provider = SECRET_PROVIDER[key];
    if (!provider) return true;
    const r = await testProvider(provider, { candidate: { ...candidate, [key]: plaintext }, deps: opts.deps });
    return r.outcome === 'ok' || (r.outcome === 'unreachable' && opts.acceptUnreachable === true);
  };
}

/**
 * Stripe guard of the console write routes: switching the key between test and live, or to another account, orphans the `stripe_customer_id`s stored on businesses.
 * Returns the number of businesses that would be orphaned (0 = nothing to acknowledge). The route answers `409 orphan_ack_required` (count in the message) unless
 * the operator sent `acknowledge_orphans: true`.
 */
export async function stripeOrphanRisk(changes: readonly SettingChange[], deps?: TestDeps): Promise<number> {
  const c = changes.find((x) => x.key === 'stripe.secret_key' && typeof x.secret === 'string');
  if (!c || !verificationEnabled(deps)) return 0;
  const r = await testProvider('stripe', { candidate: candidateOf(changes), deps });
  if (r.outcome !== 'ok') return 0; // the verifier refuses it anyway
  return r.mode_changed === true || r.account_changed !== false ? r.orphaned_businesses ?? 0 : 0;
}

// ---- live self-test (cached) ------------------------------------------------------------------------------------------------------------------

export const LIVE_CACHE_MS = 5 * 60_000;
interface Cached { at: number; fp: string; result: ProviderTestResult }
const CACHE_KEY = Symbol.for('rc.admin.provider-test-cache');
const cache = (): Map<string, Cached> => ((globalThis as unknown as Record<symbol, Map<string, Cached> | undefined>)[CACHE_KEY] ??= new Map());
export const clearLiveCache = (): void => cache().clear();

/** Fingerprint of the credentials a provider is tested with (memory only): a changed credential invalidates the cache entry at once. */
function fpOf(provider: ProviderId): string {
  const get = reader({});
  const parts: Record<ProviderId, SettingKey[]> = {
    twilio: ['twilio.account_sid', 'twilio.auth_token', 'twilio.messaging_service_sid'], elevenlabs: ['elevenlabs.api_key'],
    stripe: ['stripe.secret_key', 'stripe.price_id', 'stripe.price_id_annual'], openai: ['llm.openai_api_key', 'llm.openai_model'], anthropic: ['llm.anthropic_api_key', 'llm.anthropic_model'],
    resend: ['email.resend_api_key', 'email.from'], smtp: ['email.smtp_url', 'email.smtp_host', 'email.smtp_port', 'email.smtp_user', 'email.smtp_pass', 'email.smtp_secure'],
    google: ['google.client_id', 'google.client_secret'], turnstile: ['signup.turnstile_secret_key', 'signup.turnstile_site_key'],
  };
  return createHash('sha256').update(parts[provider].map((k) => get(k)).join('\u0000')).digest('hex').slice(0, 16);
}

/** Which providers a card covers right now (only those configured: an unset provider is never called). */
function providersOfCard(card: string): ProviderId[] {
  const get = reader({});
  switch (card) {
    case 'twilio': return get('twilio.account_sid') && get('twilio.auth_token') ? ['twilio'] : [];
    case 'elevenlabs': return get('elevenlabs.api_key') ? ['elevenlabs'] : [];
    case 'stripe': return get('stripe.secret_key') ? ['stripe'] : [];
    case 'llm': return [...(get('llm.openai_api_key') ? ['openai' as const] : []), ...(get('llm.anthropic_api_key') ? ['anthropic' as const] : [])];
    case 'email': { const p = get('email.provider'); return p === 'resend' && get('email.resend_api_key') ? ['resend'] : p === 'smtp' && (get('email.smtp_url') || get('email.smtp_host')) ? ['smtp'] : []; }
    case 'google': return get('google.client_id') && get('google.client_secret') ? ['google'] : [];
    case 'turnstile': return get('signup.turnstile_secret_key') ? ['turnstile'] : [];
    default: return [];
  }
}

export interface LiveReadiness extends Omit<ProviderReadiness, 'tested'> {
  tested: boolean;
  /** The worst result of the provider(s) behind this card; null when nothing is configured (no call was made) or nothing was tested yet. */
  test: ProviderTestResult | null;
}
const RANK: Record<TestOutcome, number> = { ok: 0, unreachable: 1, misconfigured: 2, auth_failed: 3 };

/**
 * Readiness cards with REAL test results. `refresh: true` calls the providers (at most once per 5 minutes per provider and credential set, unless `force`);
 * `refresh: false` only returns what is cached (a role that may not trigger paid or rate-limited calls). An unconfigured provider is never called.
 */
export async function liveSelftest(opts: { refresh: boolean; force?: boolean; deps?: TestDeps }): Promise<{ providers: LiveReadiness[]; ready: boolean; tested: boolean; cached_for_ms: number }> {
  const base = selftest();
  const now = (opts.deps?.now ?? Date.now)();
  const c = cache();
  const providers: LiveReadiness[] = [];
  for (const card of base.providers) {
    const results: ProviderTestResult[] = [];
    for (const p of providersOfCard(card.provider)) {
      const fp = fpOf(p);
      const hit = c.get(p);
      if (hit && hit.fp === fp && (!opts.refresh || (!opts.force && now - hit.at < LIVE_CACHE_MS))) { results.push(hit.result); continue; }
      if (!opts.refresh) continue;
      const result = await testProvider(p, { deps: opts.deps });
      c.set(p, { at: now, fp, result });
      results.push(result);
    }
    const worst = results.sort((a, b) => RANK[b.outcome] - RANK[a.outcome])[0] ?? null;
    providers.push({ ...card, tested: worst !== null, test: worst, ready: card.ready && (worst === null || worst.outcome === 'ok') });
  }
  return { providers, ready: providers.every((p) => p.ready), tested: providers.some((p) => p.tested), cached_for_ms: LIVE_CACHE_MS };
}

/**
 * One call for the console write routes (`PUT /secrets/{key}`, `POST /settings/apply`): the `verifySecret` hook (test-before-save) and the Stripe orphan guard
 * (409 `orphan_ack_required` with the number of businesses, unless the body carries `acknowledge_orphans: true`). Body flags: `acknowledge_orphans`, `accept_unreachable`.
 */
export async function providerWriteChecks(changes: readonly SettingChange[], body: Record<string, unknown>, opts: { dryRun?: boolean; deps?: TestDeps } = {}): Promise<Pick<ApplyOptions, 'verifySecret'>> {
  if (opts.dryRun || !changes.some((c) => typeof c.secret === 'string')) return {};
  if (body.acknowledge_orphans !== true) {
    const n = await stripeOrphanRisk(changes, opts.deps);
    if (n > 0) throw new SettingsError(409, 'orphan_ack_required', `this key switches the Stripe mode or account: ${n} business(es) hold customer ids of the current one and would be orphaned (acknowledge to continue)`);
  }
  return { verifySecret: secretVerifier({ changes, acceptUnreachable: body.accept_unreachable === true, deps: opts.deps }) };
}
