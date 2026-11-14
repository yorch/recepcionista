/**
 * Readiness probe for the container orchestrator and the reverse proxy.
 *
 * Docker's HEALTHCHECK marks the container unhealthy when this returns 503, and
 * Traefik stops routing to it — so this reports whether the process can *serve*,
 * not merely whether it is alive. That means the database has to answer: every
 * page in the dashboard reads through Prisma, so a 200 without a reachable
 * Postgres would be a lie the proxy happily routes traffic to.
 *
 * Deliberately unauthenticated and cheap: one `SELECT 1`, no counts, no joins.
 * Kept out of the `(dashboard)` auth surface on purpose — a probe that needs
 * credentials cannot be called by a probe.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/client';

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
    return NextResponse.json(
      { ok: true, db: 'up', latency_ms: Date.now() - startedAt },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // 503, not 500: this is "not ready yet", which is a state the orchestrator
    // is expected to retry, not a bug in the request.
    console.error('[health] database unreachable:', error);
    return NextResponse.json(
      { ok: false, db: 'down', error },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
