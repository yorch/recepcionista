/**
 * Second layer of admin auth for route handlers. The proxy already gates
 * /api/**, but a proxy matcher mistake must never expose a handler, so every
 * non-public handler calls this first:
 *
 *   const denied = await guardAdmin(); if (denied) return denied;
 */
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { authConfig, isAuthenticated } from '@/lib/auth';

export async function guardAdmin(): Promise<NextResponse<{ ok: false; error: string }> | null> {
  const h = await headers();
  if (await isAuthenticated(new Request('http://internal.invalid/', { headers: h }))) return null;
  const misconfigured = authConfig().mode === 'misconfigured';
  return NextResponse.json(
    { ok: false as const, error: misconfigured ? 'server auth not configured' : 'unauthorized' },
    { status: misconfigured ? 503 : 401 },
  );
}
