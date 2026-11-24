/**
 * Process-level observability: what configuration this server booted with, and
 * every server error Next catches after the fact.
 *
 * Both hooks exist because the rest of the app only logs what it *expects* to
 * happen. A route that throws before it logs anything (bad JSON, Radix/React
 * render error, Prisma connection refused) would otherwise be visible only as a
 * stack trace on stdout with no request attached.
 */
import type { Instrumentation } from 'next';
import { logger, serializeError } from '@/lib/log';
import { ownerPhoneGrandfatherProblem } from '@/lib/messaging/owner';
import { signupAvailability, signupConfigWarning } from '@/lib/signup-config';
import { lineKindMismatch } from '@/lib/voice/line';

const boot = logger('boot');
let booted = false;

/** host:port/db only — the DATABASE_URL password must never reach the logs. */
function dbTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return 'unset';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'unparseable';
  }
}

function providerSummary() {
  const has = (v?: string) => Boolean(v && v.trim());
  const elevenLabsLine = has(process.env.ELEVENLABS_PHONE_NUMBER_ID)
    ? process.env.ELEVENLABS_PHONE_NUMBER_ID?.startsWith('phnum_')
      ? 'voice-line=phnum-id'
      : 'voice-line=WRONG (expected phnum_…)'
    : 'voice-line=unbound';

  return {
    llm: has(process.env.OPENAI_API_KEY)
      ? `openai:${process.env.LLM_MODEL || 'default'}`
      : has(process.env.ANTHROPIC_API_KEY)
        ? `anthropic:${process.env.ANTHROPIC_MODEL || 'default'}`
        : 'none (templates)',
    elevenlabs: has(process.env.ELEVENLABS_API_KEY) ? elevenLabsLine : 'off (scripted calls)',
    twilio: has(process.env.TWILIO_ACCOUNT_SID) &&
      has(process.env.TWILIO_AUTH_TOKEN) &&
      has(process.env.TWILIO_PHONE_NUMBER)
      ? 'live'
      : 'mock (SID/token/phone incomplete)',
    stripe: has(process.env.STRIPE_SECRET_KEY) ? 'live' : 'mock (/pay/[id])',
  };
}

/** Loud, one-time configuration warnings (billing fail-open, owner-phone grandfathering). */
function startupWarnings(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV === 'production') {
    const v = (process.env.BILLING_ENFORCED ?? '').trim();
    if (v === 'false') {
      boot.warn('billing.not_enforced', { banner: '!!! BILLING_ENFORCED=false: texts and calls are NOT capped and plans are not required for existing tenants. Non-admin provisioning still needs an active plan. Do not run like this with open signup.' });
    } else if (v !== 'true') {
      boot.info('billing.enforced_by_default', { note: 'BILLING_ENFORCED is not set to true: production enforces billing by default (set BILLING_ENFORCED=false only to opt out explicitly)' });
    }
  }
  const sw = signupConfigWarning();
  if (sw) boot.warn(signupAvailability().open ? 'signup.without_captcha' : 'signup.disabled', { banner: sw });
  const lm = lineKindMismatch();
  if (lm) boot.error('voice_line_kind_mismatch', { banner: `!!! ${lm}` });
  const og = ownerPhoneGrandfatherProblem();
  if (og) boot.warn('owner_phone_grandfather', { warning: og });
}

export async function register() {
  // Edge runtime gets its own instance of this module; only Node knows about
  // Postgres sockets, so the boot banner is Node-only and logged once.
  if (process.env.NEXT_RUNTIME === 'edge') return;
  if (booted) return;
  booted = true;

  boot.info('start', {
    runtime: process.env.NEXT_RUNTIME || 'nodejs',
    env: process.env.NODE_ENV,
    log_level: process.env.LOG_LEVEL || `(default ${process.env.NODE_ENV === 'production' ? 'info' : 'debug'})`,
    app_url: process.env.APP_URL || 'unset',
    db: dbTarget(),
    ...providerSummary(),
  });

  startupWarnings();

  // Google Calendar: push booking changes to the owner's calendar (a no-op until a business connects one).
  if (process.env.NEXT_PHASE !== 'phase-production-build' && process.env.DATABASE_URL) {
    const { registerGoogleCalendar } = await import('@/lib/integrations/register');
    registerGoogleCalendar();
    if ((process.env.GOOGLE_OAUTH_MOCK ?? '').trim().toLowerCase() === 'true' && process.env.NODE_ENV === 'production') {
      boot.error('google_mock_in_production', { banner: '!!! GOOGLE_OAUTH_MOCK=true is IGNORED in production (mock Google is never enabled there)' });
    }
  }

  // Background jobs (daily briefing, gratitude sweep, cleanup, retention purge): not during `next build`, not in tests.
  // JOBS=on|off (default on in production), JOBS_TICK_SECONDS; see src/lib/jobs.
  if (process.env.NEXT_PHASE !== 'phase-production-build' && process.env.DATABASE_URL) {
    const { startJobRunner } = await import('@/lib/jobs');
    startJobRunner();
  }
}

/**
 * Fires for every error Next captures from a route handler, server component,
 * server action or proxy — the ones the domain code never saw.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String((error as { digest?: unknown }).digest)
      : undefined;

  logger('http').error('request.failed', {
    method: request.method,
    path: request.path,
    route: context.routePath,
    kind: context.routeType,
    router: context.routerKind,
    source: context.renderSource,
    ...(digest ? { digest } : {}),
    ...serializeError(error),
  });
};
