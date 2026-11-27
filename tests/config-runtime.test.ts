/**
 * The runtime config module (src/lib/config/index.ts): behaviour-identical to process.env with no snapshot source; precedence env pin >
 * console > default once one is installed; secrets never serialised; shared state on globalThis; the job runner reads config per tick.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import {
  ConfigSnapshot, EMPTY_SNAPSHOT, configEnv, configProblems, redactSecrets, resolveSetting, retiredEnvWarnings, runtimeConfig, setSnapshotSource, setting, settingDef, settingSource,
} from '../src/lib/config';
import type { SettingDef } from '../src/lib/config';
import { scrub } from '../src/lib/log';
import { trialDays } from '../src/lib/providers/stripe-billing';
import { enabledJobs, startJobRunner, stopJobRunner, runnerTick, armedTickSeconds } from '../src/lib/jobs';
import { tickSeconds } from '../src/lib/jobs/schedule';
import { retentionJobEnabled } from '../src/lib/retention-job';
import { nativeTransferEnabled } from '../src/lib/voice/transfer';

const KEYS = ['BILLING_TRIAL_DAYS', 'JOBS', 'JOBS_TICK_SECONDS', 'RETENTION_JOB', 'NATIVE_TRANSFER', 'STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'BILLING_ENFORCED', 'TENANT_RELEASE_JOB'] as const;
const saved: Record<string, string | undefined> = {};
const snap = (values: Record<string, unknown> = {}, secrets: Record<string, string> = {}, version = 1) => new ConfigSnapshot({ version, values, secrets });
const use = (s: ConfigSnapshot | null) => setSnapshotSource(() => s);

beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  setSnapshotSource(null);
  stopJobRunner();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('no snapshot source: identical to process.env', () => {
  test('configEnv() IS process.env (same object, live reads and writes)', () => {
    expect(configEnv()).toBe(process.env);
    process.env.BILLING_TRIAL_DAYS = '12';
    expect(configEnv().BILLING_TRIAL_DAYS).toBe('12');
    expect(trialDays()).toBe(12);
    delete process.env.BILLING_TRIAL_DAYS;
    expect(trialDays()).toBe(7);
  });
  test('an injected env still wins over everything (existing tests rely on it)', () => {
    use(snap({ 'billing.trial_days': 30 }));
    expect(trialDays({ BILLING_TRIAL_DAYS: '3' } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(trialDays({} as unknown as NodeJS.ProcessEnv)).toBe(7); // an explicit empty env is NOT merged with the console
  });
  test('a snapshot source that returns null or throws leaves the environment alone', () => {
    setSnapshotSource(() => null);
    expect(configEnv()).toBe(process.env);
    setSnapshotSource(() => { throw new Error('loader down'); });
    expect(configEnv()).toBe(process.env);
    expect(setting('billing.trial_days')).toBe(7);
  });
  test('runtimeConfig() reports version 0 and resolves defaults', () => {
    const rc = runtimeConfig();
    expect(rc.version).toBe(0);
    expect(rc.get('billing.trial_days')).toBe(7);
    expect(rc.source('billing.trial_days')).toBe('default');
  });
});

describe('precedence: env pin > console > default', () => {
  test('console value applies to every legacy reader when the environment does not pin it', () => {
    use(snap({ 'billing.trial_days': 21, 'jobs.enabled': true, 'jobs.retention_enabled': true, 'voice.native_transfer': true, 'jobs.tick_seconds': 15 }));
    expect(trialDays()).toBe(21);
    expect(configEnv().BILLING_TRIAL_DAYS).toBe('21');
    expect(enabledJobs()).toContain('daily_briefing');
    expect(retentionJobEnabled()).toBe(true); // on_off format: the reader only accepts the exact text "on"
    expect(configEnv().RETENTION_JOB).toBe('on');
    expect(nativeTransferEnabled()).toBe(true);
    expect(tickSeconds()).toBe(15);
    expect(setting('billing.trial_days')).toBe(21);
    expect(settingSource('billing.trial_days')).toBe('console');
  });
  test('an environment pin wins and the key reads as locked (source env)', () => {
    process.env.BILLING_TRIAL_DAYS = '5';
    use(snap({ 'billing.trial_days': 21 }));
    expect(trialDays()).toBe(5);
    expect(setting('billing.trial_days')).toBe(5);
    expect(settingSource('billing.trial_days')).toBe('env');
  });
  test('an EMPTY environment variable does not pin', () => {
    process.env.BILLING_TRIAL_DAYS = '  ';
    use(snap({ 'billing.trial_days': 21 }));
    expect(trialDays()).toBe(21);
    expect(settingSource('billing.trial_days')).toBe('console');
  });
  test('an invalid pin falls back to the default (never to the console) and is reported by name', () => {
    process.env.BILLING_TRIAL_DAYS = 'banana';
    use(snap({ 'billing.trial_days': 21 }));
    const r = resolveSetting(settingDef('billing.trial_days') as SettingDef, process.env, snap({ 'billing.trial_days': 21 }));
    expect(r).toMatchObject({ value: 7, source: 'default', envInvalid: true });
    expect(configProblems().invalid.map((p) => p.name)).toContain('BILLING_TRIAL_DAYS');
    expect(JSON.stringify(configProblems())).not.toContain('banana'); // names only, never values
  });
  test('a console value the schema rejects is ignored (default applies)', () => {
    use(snap({ 'billing.trial_days': 9999 }));
    expect(setting('billing.trial_days')).toBe(7);
  });
  test('the effective view is rebuilt when the snapshot changes (no frozen copies)', () => {
    let cur = snap({ 'billing.trial_days': 10 }, {}, 1);
    setSnapshotSource(() => cur);
    expect(trialDays()).toBe(10);
    cur = snap({ 'billing.trial_days': 11 }, {}, 2);
    expect(trialDays()).toBe(11);
    expect(runtimeConfig().version).toBe(2);
  });
  test('NODE_ENV dependent defaults', () => {
    const def = settingDef('billing.enforced') as SettingDef;
    expect(resolveSetting(def, { NODE_ENV: 'production' }, null).value).toBe(true);
    expect(resolveSetting(def, { NODE_ENV: 'development' }, null).value).toBe(false);
    expect(resolveSetting(def, { NODE_ENV: 'production', BILLING_ENFORCED: 'false' }, null)).toMatchObject({ value: false, source: 'env' });
  });
});

describe('secrets', () => {
  const SECRET = 'sk_live_console_held_secret_value_1234567890';
  test('held in a non-enumerable map; not in JSON, spread, keys or inspect; no toJSON', () => {
    const sn = snap({ 'billing.trial_days': 9 }, { 'stripe.secret_key': SECRET });
    expect(sn.secret('stripe.secret_key')).toBe(SECRET);
    expect(JSON.stringify(sn)).not.toContain(SECRET);
    expect(JSON.stringify({ ...sn })).not.toContain(SECRET);
    expect(Object.keys(sn)).not.toContain('secrets');
    expect(inspect(sn, { depth: 5, showHidden: false })).not.toContain(SECRET);
    expect(inspect(sn)).toContain('1 secrets');
    expect((sn as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
    expect(() => { (sn.values as Record<string, unknown>).x = 1; }).toThrow();
  });
  test('the env view serves a console secret to legacy readers but never lists it', () => {
    use(snap({}, { 'stripe.secret_key': SECRET }));
    expect(configEnv().STRIPE_SECRET_KEY).toBe(SECRET);
    expect(Object.keys(configEnv())).not.toContain('STRIPE_SECRET_KEY');
    expect(JSON.stringify(configEnv())).not.toContain(SECRET);
    expect(setting('stripe.secret_key')).toBe(SECRET);
  });
  test('an environment secret pins over the console secret', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_from_the_environment_000';
    use(snap({}, { 'stripe.secret_key': SECRET }));
    expect(configEnv().STRIPE_SECRET_KEY).toBe('sk_test_from_the_environment_000');
    expect(settingSource('stripe.secret_key')).toBe('env');
  });
  test('the logger hook masks configured secrets (environment and console) inside any string, short values excepted', () => {
    process.env.TWILIO_AUTH_TOKEN = 'abcdef0123456789abcdef0123456789';
    use(snap({}, { 'stripe.secret_key': SECRET }));
    expect(redactSecrets(`auth failed with abcdef0123456789abcdef0123456789 and ${SECRET}`)).toBe('auth failed with «redacted» and «redacted»');
    expect(scrub(`token=${SECRET}`)).not.toContain(SECRET);
    process.env.TWILIO_AUTH_TOKEN = 'short';
    expect(redactSecrets('the word short stays')).toBe('the word short stays');
  });
});

describe('shared state', () => {
  test('the state lives on globalThis under Symbol.for("rc.config") so separate bundles share it', () => {
    use(snap({ 'billing.trial_days': 4 }));
    const st = (globalThis as unknown as Record<symbol, { source: unknown }>)[Symbol.for('rc.config')];
    expect(st).toBeDefined();
    expect(typeof st.source).toBe('function');
    expect(EMPTY_SNAPSHOT.version).toBe(0);
  });
});

describe('deprecated variables (D11)', () => {
  test('retired names that are set produce one warning each; unset ones none', () => {
    const w = retiredEnvWarnings({ OWNER_PHONE_GRANDFATHER: 'true', ELEVENLABS_AGENT_ID: 'agent_x', NEXT_PUBLIC_APP_URL: 'https://x.test', APP_URL: 'https://a.test' });
    expect(w.map((x) => x.name).sort()).toEqual(['ELEVENLABS_AGENT_ID', 'NEXT_PUBLIC_APP_URL', 'OWNER_PHONE_GRANDFATHER']);
    expect(w.every((x) => /DEPRECATED/.test(x.warning))).toBe(true);
    expect(retiredEnvWarnings({})).toEqual([]);
  });
});

describe('job runner reads the configuration on every tick', () => {
  test('starts even when nothing is enabled and re-arms when the tick period changes', async () => {
    process.env.JOBS = 'off';
    expect(startJobRunner()).toBe(false);
    expect(armedTickSeconds()).toBe(60);
    process.env.JOBS_TICK_SECONDS = '30';
    await runnerTick();
    expect(armedTickSeconds()).toBe(30);
    use(snap({ 'jobs.tick_seconds': 20 }));
    delete process.env.JOBS_TICK_SECONDS;
    await runnerTick();
    expect(armedTickSeconds()).toBe(20); // a console change of the tick takes effect without a restart
  });
  test('a console JOBS toggle changes what the next tick would run (no frozen env object)', () => {
    process.env.JOBS = 'off';
    expect(enabledJobs()).toEqual([]);
    delete process.env.JOBS;
    use(snap({ 'jobs.enabled': true }));
    expect(enabledJobs().length).toBeGreaterThan(0);
    use(snap({ 'jobs.enabled': false }));
    expect(enabledJobs()).toEqual([]);
  });
  test('the injected env of a test is honoured and the runner is idempotent', () => {
    const e = { NODE_ENV: 'development', JOBS: 'off' } as unknown as NodeJS.ProcessEnv;
    expect(startJobRunner(e)).toBe(false);
    expect(startJobRunner()).toBe(false);
    stopJobRunner();
    expect(armedTickSeconds()).toBe(0);
  });
});
