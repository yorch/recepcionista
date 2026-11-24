import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { clearForwardNumber, getBusiness, recordAudit, adoptOwnerPhoneAsForwardNumber } from '@/lib/db';
import { callModeView, type CallModeView } from '@/lib/voice/call-mode';

export const dynamic = 'force-dynamic';

const actor = (p: Awaited<ReturnType<typeof authenticate>> & { ok: true }) => ({
  actor_kind: p.principal.kind === 'user' ? ('user' as const) : ('admin_token' as const),
  actor_user_id: p.principal.user?.id ?? null,
});

/** PUT { use_owner_phone: true }: forward to the already VERIFIED owner phone (no second text). Any other number goes through verify/start + verify/confirm. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ use_owner_phone?: unknown }>(req).catch(() => ({} as { use_owner_phone?: unknown }));
    if (body.use_owner_phone !== true) return fail('use_owner_phone: true is required (other numbers must be verified by text)', 422);
    const state = await adoptOwnerPhoneAsForwardNumber(id);
    if (!state) return fail('verify your owner phone first', 422);
    await recordAudit({
      ...actor(auth), business_id: id, action: 'business.forward_number_set', target: `business:${id}`, ip: clientKey(req),
      meta: { source: 'owner_phone', last4: (state.forward_number_e164 ?? '').slice(-4) },
    });
    const business = await getBusiness(id);
    return ok<CallModeView>(callModeView(business!, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}

/** DELETE: forget the forward number (a 'forward' mode goes back to 'ai'). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const state = await clearForwardNumber(id);
    if (!state) return fail('business not found', 404);
    await recordAudit({ ...actor(auth), business_id: id, action: 'business.forward_number_removed', target: `business:${id}`, ip: clientKey(req) });
    const business = await getBusiness(id);
    return ok<CallModeView>(callModeView(business!, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
