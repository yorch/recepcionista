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

  // Daily PII retention purge (not during `next build`, not in tests).
  if (process.env.NEXT_PHASE !== 'phase-production-build' && process.env.DATABASE_URL) {
    const { startRetentionJob } = await import('@/lib/retention-job');
    startRetentionJob();
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
