/**
 * Readiness probe for the container orchestrator and the reverse proxy.
 *
 * Docker's HEALTHCHECK marks the container unhealthy when this returns 503, and
 * Traefik stops routing to it — so this reports whether the process can *serve*,
 * not merely whether it is alive. That means the database has to answer: every
 * page in the dashboard reads through Prisma, so a 200 without a reachable
 * Postgres would be a lie the proxy happily routes traffic to.
 *
 * In production an LLM key is REQUIRED (owner decision): without OPENAI_API_KEY or ANTHROPIC_API_KEY this answers 503 `llm_not_configured`, so the
 * container never becomes healthy and a deploy without the key fails loudly instead of silently degrading to templates (website import, call
 * summaries, briefings).
 *
 * Deliberately unauthenticated and cheap: one `SELECT 1`, no counts, no joins.
 * Kept out of the `(dashboard)` auth surface on purpose — a probe that needs
 * credentials cannot be called by a probe.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/log';
import { llmRequiredProblem } from '@/lib/providers/llm-required';
import { smsSenderProblem } from '@/lib/messaging/sender-config';
import { loaderStatus, settingsHealth } from '@/lib/admin/loader';

const log = logger('health');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEOUT_MS = 2_000;

/** Reject rather than hang: a wedged pool would otherwise stall the probe past Docker's timeout. */
async function ping(): Promise<void> {
  await Promise.race([
    prisma.$queryRaw`SELECT 1`,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`db ping exceeded ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    ),
  ]);
}

export async function GET() {
  const startedAt = Date.now();
  try {
    await ping();
    // Console settings (24e T12): 503 until the first load succeeded (when console rows exist) and while the secret canary cannot be decrypted. Nothing else is revealed.
    const loaded = loaderStatus();
    const sh = loaded.loaded ? loaded : settingsHealth((await prisma.platformSetting.count({ where: { key: { not: '_canary' } } })) > 0);
    if (!sh.ok) {
      log.error(sh.error ?? 'settings_not_ready', { loaded: sh.loaded, canary: sh.canary, last_error: sh.last_error });
      return NextResponse.json({ ok: false, db: 'up', error: sh.error, detail: sh.detail }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const llm = llmRequiredProblem();
    if (llm) {
      log.error('llm_not_configured', { note: llm });
      return NextResponse.json({ ok: false, db: 'up', error: 'llm_not_configured', detail: llm }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    // A deployment that still sends customer texts from unregistered tenant numbers (no Messaging Service): still ready (200), but the warning is visible to whoever reads the probe.
    const sms = smsSenderProblem();
    return NextResponse.json(
      { ok: true, db: 'up', latency_ms: Date.now() - startedAt, ...(sms ? { warnings: [{ code: 'sms_a2p_registration_required', detail: sms }] } : {}) },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // 503, not 500: this is "not ready yet", which is a state the orchestrator
    // is expected to retry, not a bug in the request.
    log.error('unreachable', { err: error, timeout_ms: TIMEOUT_MS });
    return NextResponse.json(
      { ok: false, db: 'down', error },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
