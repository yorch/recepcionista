import { fail, ok } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { confirmContent, getBusiness, getContentConfirmation, getKnowledgeBase } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export interface ContentConfirmationView { state: 'unconfirmed' | 'confirmed' | 'stale'; confirmed_at: string | null }

/** GET: has the owner confirmed the services, prices and service area (staff may read). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const info = await getContentConfirmation(id);
    if (!info) return fail('business not found', 404);
    return ok<ContentConfirmationView>(info);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * POST: the owner confirms the services, prices and service area as they are NOW (a fingerprint is stored, so a later change makes it `stale`).
 * Owner only (same-origin enforced by authenticate), rate limited, audited (`business.content_confirmed`). Refused (422) while there is nothing
 * to confirm: no services, or no service area (the area is never defaulted).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const limited = await limitRequest(req, 'businesses/content-confirmation', 20, 60_000);
    if (limited) return limited;
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const kb = await getKnowledgeBase(id);
    if (!kb || kb.services.length === 0) return fail('Add your services before confirming them.', 422);
    if (!(business.service_area ?? []).some((a) => a.trim())) return fail('Add the cities or counties you serve before confirming.', 422);
    const actor = auditActorOf(auth.principal);
    const info = await confirmContent(id, { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req) });
    if (!info) return fail('business not found', 404);
    return ok<ContentConfirmationView>(info);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
