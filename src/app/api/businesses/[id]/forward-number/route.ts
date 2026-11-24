import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { adoptOwnerPhoneAsForwardNumber, clearForwardNumber, ForwardNumberRejectedError, getBusiness, recordAudit } from '@/lib/db';
import { callModeView, type CallModeView } from '@/lib/voice/call-mode';
import { actorOf, announceCallHandlingChange } from '@/lib/voice/call-handling-changes';
import { vetForwardNumber } from '@/lib/voice/forward-vet';

export const dynamic = 'force-dynamic';

/**
 * PUT { use_owner_phone: true }: forward to the already VERIFIED owner phone (no second text). Any other number goes through
 * verify/start + verify/confirm. The owner phone must ALSO pass the forward-number rules (a Caribbean or premium number can be an
 * alert phone but is never a forward target), and setting it needs a recent proof of identity.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ use_owner_phone?: unknown }>(req).catch(() => ({} as { use_owner_phone?: unknown }));
    if (body.use_owner_phone !== true) return fail('use_owner_phone: true is required (other numbers must be verified by text)', 422);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    if (!business.owner_phone_e164 || !business.owner_phone_verified_at) return fail('verify your owner phone first', 422);
    const check = await vetForwardNumber(business, business.owner_phone_e164);
    if (!check.ok) return fail(check.error, 422);
    const denied = requireRecentAuth(auth);
    if (denied) return denied;

    let change;
    try {
      change = await adoptOwnerPhoneAsForwardNumber(id);
    } catch (err) {
      if (err instanceof ForwardNumberRejectedError) return fail(err.message, 422);
      throw err;
    }
    if (!change) return fail('verify your owner phone first', 422);
    const actor = actorOf(auth);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.forward_number_set', target: `business:${id}`, ip: clientKey(req),
      meta: { source: 'owner_phone', last4: (change.after.forward_number_e164 ?? '').slice(-4) },
    });
    const fresh = (await getBusiness(id)) ?? business;
    await announceCallHandlingChange({ business: fresh, actor, ip: clientKey(req), change, reason: 'forward_number_set_owner_phone' });
    return ok<CallModeView>(callModeView(fresh, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}

/** DELETE: forget the forward number (a 'forward' mode goes back to 'ai', audited and announced). Removing never needs the password. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const change = await clearForwardNumber(id);
    if (!change) return fail('business not found', 404);
    const actor = actorOf(auth);
    await recordAudit({ actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.forward_number_removed', target: `business:${id}`, ip: clientKey(req) });
    const business = await getBusiness(id);
    if (business) await announceCallHandlingChange({ business, actor, ip: clientKey(req), change, reason: 'forward_number_removed' });
    return ok<CallModeView>(callModeView(business!, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
