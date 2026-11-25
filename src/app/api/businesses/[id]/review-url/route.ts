import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit, updateBusiness } from '@/lib/db';
import { validateReviewUrl } from '@/lib/business-config';

export const dynamic = 'force-dynamic';

export interface ReviewUrlView { review_url: string | null }

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const b = await getBusiness(id);
    if (!b) return fail('business not found', 404);
    return ok<ReviewUrlView>({ review_url: b.review_url ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/** PUT { review_url: string|null }  The business's Google review link (https, <= 300 chars). null / empty clears it: review requests then send no link. Owner only; audited. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ review_url?: unknown }>(req);
    if (!body || typeof body !== 'object' || !('review_url' in body)) return fail('review_url is required', 422);
    const v = validateReviewUrl(body.review_url);
    if (!v.ok) return fail(v.error, 422);
    const before = await getBusiness(id);
    if (!before) return fail('business not found', 404);
    const updated = await updateBusiness(id, { review_url: v.value });
    if (!updated) return fail('business not found', 404);
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.review_url_changed', target: `business:${id}`, ip: clientKey(req),
      meta: { ...actor.meta, set: v.value !== null, was_set: Boolean(before.review_url) },
    });
    return ok<ReviewUrlView>({ review_url: updated.review_url ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
