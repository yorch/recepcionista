/**
 * Is the credential behind an OPEN live stream still allowed to watch THIS call's business? Re-run every minute by GET /api/calls/:id/live.
 * Not just "does the session still resolve": a member removed from business A who also belongs to business B keeps a valid session, which
 * now resolves to B, so the check must be against the business of the call and the staff role of the principal resolved NOW.
 */
import { hasRole, requireBusinessAccess, resolvePrincipal } from '@/lib/session';

export async function mayStillViewCall(headers: Headers, callBusinessId: string): Promise<boolean> {
  try {
    const r = await resolvePrincipal(headers);
    if (!r.ok) return false;
    requireBusinessAccess(r.principal, callBusinessId);
    return hasRole(r.principal, 'staff');
  } catch { return false; }
}
