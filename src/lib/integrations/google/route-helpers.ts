import { NextResponse } from 'next/server';
import { clientKey } from '@/lib/auth';
import { fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId, type Principal, type Role } from '@/lib/session';

export interface Scope { principal: Principal; businessId: string; sessionId: string | null; ip: string; actor: { kind: 'user' | 'admin_token'; user_id: string | null; ip: string } }

/** Authenticate (CSRF for cookies is inside `authenticate`), enforce the role, and pin the request to ONE business (admins pass ?business_id=). */
export async function scoped(req: Request, role: Role): Promise<{ ok: true; s: Scope } | { ok: false; response: NextResponse }> {
  const auth = await authenticate(req, { role });
  if (!auth.ok) return { ok: false, response: auth.response as NextResponse };
  try {
    const businessId = scopeBusinessId(auth.principal, new URL(req.url).searchParams.get('business_id'));
    if (!businessId) return { ok: false, response: fail('business_id is required', 422) };
    requireBusinessAccess(auth.principal, businessId);
    const ip = clientKey(req);
    const user = auth.principal.kind === 'user' ? auth.principal.user : auth.principal.user ?? null;
    return { ok: true, s: { principal: auth.principal, businessId, sessionId: auth.sessionId, ip, actor: { kind: user ? 'user' : 'admin_token', user_id: user?.id ?? null, ip } } };
  } catch (err) {
    return { ok: false, response: authErrorResponse(err) ?? fail(err, 500) };
  }
}
