import { NextResponse } from 'next/server';
import type { ApiResult } from '@/lib/types';

export function ok<T>(data: T, init?: number) {
  return NextResponse.json({ ok: true, data } satisfies ApiResult<T>, { status: init ?? 200 });
}

export function fail(error: unknown, status = 400) {
  // Never echo internal error text (Prisma paths, stack hints) on 5xx.
  const message = status >= 500 && error instanceof Error ? 'internal error' : error instanceof Error ? error.message : String(error);
  if (status >= 500 && error instanceof Error) console.error('[http] 5xx', error);
  return NextResponse.json({ ok: false, error: message } satisfies ApiResult<never>, { status });
}

/**
 * Answer of a webhook route's GET probe: `ready` says whether the route can actually authenticate its caller right now (its secret is
 * configured, or the explicit local-dev opt-in is on), 200 when ready and 503 when not. It never reveals a secret or anything about tenants.
 */
export function readiness(ready: boolean, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: ready, data: { ready, ...extra } }, { status: ready ? 200 : 503 });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error('invalid JSON body');
  }
}
