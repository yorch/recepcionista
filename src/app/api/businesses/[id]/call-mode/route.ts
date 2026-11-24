import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, hasRole, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit, setCallMode } from '@/lib/db';
import { callModeView, isCallMode, type CallModeView } from '@/lib/voice/call-mode';

export const dynamic = 'force-dynamic';

/** Staff may read the current mode (so the header toggle shows for everyone); only owners change it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    return ok<CallModeView>(callModeView(business, { full: hasRole(auth.principal, 'owner') }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/** PATCH { mode: 'ai' | 'paused' | 'forward', forward_during_hours?: boolean }. 'forward' needs a verified forward number. Owner only; audited. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'mode' && k !== 'forward_during_hours') return fail(`field "${k}" cannot be updated here`, 422);
    if (!isCallMode(body.mode)) return fail('mode must be "ai", "paused" or "forward"', 422);
    if (body.forward_during_hours !== undefined && typeof body.forward_during_hours !== 'boolean') return fail('forward_during_hours must be true or false', 422);

    const result = await setCallMode(id, body.mode, { forward_during_hours: body.forward_during_hours as boolean | undefined });
    if (!result.ok) {
      return result.reason === 'not_found'
        ? fail('business not found', 404)
        : fail('verify a forwarding number before switching to forwarding', 422);
    }
    await recordAudit({
      actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token',
      actor_user_id: auth.principal.user?.id ?? null,
      business_id: id, action: 'business.call_mode_changed', target: `business:${id}`, ip: clientKey(req),
      meta: { from: result.previous, to: result.state.call_mode, forward_during_hours: result.state.forward_during_hours },
    });
    const business = await getBusiness(id);
    return ok<CallModeView>(callModeView(business!, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
