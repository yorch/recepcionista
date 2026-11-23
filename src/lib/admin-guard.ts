/**
 * Admin-only guard for route handlers (Node side; the proxy is only a cheap pre-filter):
 *
 *   const denied = await guardAdmin(req); if (denied) return denied;
 *
 * Pass `req` so cookie-authenticated state-changing requests get the same-origin (CSRF) check.
 * Routes that tenants may use call authenticate() from src/lib/session.ts instead.
 */
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { authenticate, resolvePrincipal } from '@/lib/session';

export async function guardAdmin(req?: Request): Promise<NextResponse<{ ok: false; error: string }> | null> {
  if (req) {
    const auth = await authenticate(req, { role: 'admin' });
    return auth.ok ? null : auth.response;
  }
  // No request object: no method to CSRF-check (the proxy still does), but the credential is fully validated.
  const res = await resolvePrincipal(new Headers(await headers())).catch(() => null);
  if (!res) return NextResponse.json({ ok: false as const, error: 'service temporarily unavailable' }, { status: 503 });
  if (!res.ok) return NextResponse.json({ ok: false as const, error: res.error }, { status: res.status });
  if (res.principal.kind !== 'admin') return NextResponse.json({ ok: false as const, error: 'forbidden' }, { status: 403 });
  return null;
}
