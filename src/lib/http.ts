import { NextResponse } from 'next/server';
import type { ApiResult } from '@/lib/types';

export function ok<T>(data: T, init?: number) {
  return NextResponse.json({ ok: true, data } satisfies ApiResult<T>, { status: init ?? 200 });
}

export function fail(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ ok: false, error: message } satisfies ApiResult<never>, { status });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error('invalid JSON body');
  }
}
