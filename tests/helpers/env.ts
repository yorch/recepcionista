/**
 * Integration-test environment. Import this file FIRST in every integration test.
 *
 * - Gate: everything is skipped unless TEST_DATABASE_URL is set.
 * - Safety: the database name must contain "test" or "scratch"; anything else throws
 *   (never run these tests, which create and delete rows, against a real database).
 * - Providers: Twilio/Stripe/ElevenLabs/LLM keys are removed so every provider runs in its
 *   built-in mock mode, and `fetch` is replaced by a guard that records (and refuses) any
 *   outbound request, so a test can assert that nothing tried to leave the machine.
 */
import { afterAll, beforeAll, describe } from 'bun:test';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function dbNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

export function isSafeTestDbName(name: string): boolean {
  return /(test|scratch)/i.test(name);
}

if (TEST_DATABASE_URL && !isSafeTestDbName(dbNameOf(TEST_DATABASE_URL))) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}

/**
 * `describe` when a safe test database is configured, otherwise `describe.skip`.
 * The environment is re-applied in a `beforeAll`: bun loads every test file before running any, and
 * other test files snapshot/restore `process.env` around their tests, which would otherwise erase
 * DATABASE_URL and the secrets set at import time.
 */
export function integration(name: string, fn: () => void): void {
  if (!TEST_DATABASE_URL) return describe.skip(name, fn);
  describe(name, () => {
    beforeAll(applyTestEnv);
    afterAll(restoreFetch);
    fn();
  });
}

/** Secrets the tests sign with. Real values never appear in tests. */
export const SECRETS = {
  stripeWebhook: 'whsec_integration_test_secret',
  elevenlabsWebhook: 'el_whsec_integration_test_secret',
  toolSecret: 'tool-secret-integration-test',
  twilioToken: 'twilio-auth-token-integration-test',
  publicBase: 'https://app.example.test',
  adminToken: 'admin-token-integration-test',
} as const;

/** Outbound requests the code under test attempted (all of them are refused). */
export const outboundCalls: string[] = [];

let originalFetch: typeof fetch | undefined;
function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
}

/** Point the process at the test database, install the secrets and block outbound fetches. */
export function applyTestEnv(): void {
  if (!TEST_DATABASE_URL) return;
  process.env.DATABASE_URL = TEST_DATABASE_URL; // the Prisma client is imported lazily, after this
  for (const k of [
    'TWILIO_ACCOUNT_SID', 'TWILIO_PHONE_NUMBER', 'STRIPE_SECRET_KEY', 'ELEVENLABS_API_KEY',
    'ELEVENLABS_AGENT_ID', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ALLOW_INSECURE_DEV',
    'STRIPE_ALLOW_UNSIGNED', 'DEMO_MODE', 'SMS_ALLOWED_COUNTRY_CODES', 'APP_URL', 'NEXT_PUBLIC_APP_URL',
    'TRUSTED_PROXY',
  ]) delete process.env[k];
  process.env.STRIPE_WEBHOOK_SECRET = SECRETS.stripeWebhook;
  process.env.ELEVENLABS_WEBHOOK_SECRET = SECRETS.elevenlabsWebhook;
  process.env.ELEVENLABS_TOOL_SECRET = SECRETS.toolSecret;
  process.env.TWILIO_AUTH_TOKEN = SECRETS.twilioToken;
  process.env.PUBLIC_BASE_URL = SECRETS.publicBase;
  process.env.ADMIN_TOKEN = SECRETS.adminToken;
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error'; // keep test output readable (LOG_LEVEL=debug to see everything)

  originalFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    outboundCalls.push(url);
    throw new Error(`outbound fetch blocked in integration tests: ${url}`);
  }) as typeof fetch;
}

/** Run `fn` with env overrides (`undefined` deletes the variable), restoring them afterwards. */
export async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
