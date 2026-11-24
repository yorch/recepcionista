import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, hasRole, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit, setCallMode } from '@/lib/db';
import { callModeView, isCallMode, type CallModeView } from '@/lib/voice/call-mode';
import { announceCallHandlingChange, actorOf } from '@/lib/voice/call-handling-changes';
import { FORWARD_UNAVAILABLE } from '@/lib/voice/line';
import type { CallMode } from '@/lib/types';

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

/**
 * PATCH { mode?: 'ai' | 'paused' | 'forward', forward_during_hours?: boolean }. Owner only.
 *  - `mode` may be omitted to change ONLY the hours flag (the dashboard never re-sends a mode it merely remembers).
 *  - 'forward' needs a verified, allowed forward number AND a line that can forward (not the native ElevenLabs line).
 *  - Switching INTO paused or forward, and changing forward_during_hours, need a recent proof of identity (password, the 2FA code or, for the
 *    break-glass admin cookie session, the admin token: 403 `reauth_required`); switching back to 'ai' never does. Every transition is audited and the owners are told by email and text (call-handling-changes.ts).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'mode' && k !== 'forward_during_hours') return fail(`field "${k}" cannot be updated here`, 422);
    if (body.mode === undefined && body.forward_during_hours === undefined) return fail('mode or forward_during_hours is required', 422);
    if (body.mode !== undefined && !isCallMode(body.mode)) return fail('mode must be "ai", "paused" or "forward"', 422);
    if (body.forward_during_hours !== undefined && typeof body.forward_during_hours !== 'boolean') return fail('forward_during_hours must be true or false', 422);
    const mode = body.mode as CallMode | undefined;

    const current = await getBusiness(id);
    if (!current) return fail('business not found', 404);
    // Step-up: switching INTO paused / forward, and ANY change of forward_during_hours (it widens or narrows when the owner's phone rings,
    // so a stale session must not flip it even when the mode is merely re-sent). Switching back to 'ai' never needs it.
    const intoNonAi = Boolean(mode && mode !== 'ai' && mode !== (current.call_mode ?? 'ai'));
    const hoursChanged = body.forward_during_hours !== undefined && body.forward_during_hours !== (current.forward_during_hours ?? false);
    if (intoNonAi || hoursChanged) {
      const denied = requireRecentAuth(auth);
      if (denied) return denied;
    }

    const result = await setCallMode(id, mode, { forward_during_hours: body.forward_during_hours as boolean | undefined });
    if (!result.ok) {
      if (result.reason === 'not_found') return fail('business not found', 404);
      return result.reason === 'forward_unsupported'
        ? fail(FORWARD_UNAVAILABLE, 422)
        : fail('verify a forwarding number before switching to forwarding', 422);
    }
    const actor = actorOf(auth);
    const fresh = (await getBusiness(id)) ?? current;
    await announceCallHandlingChange({ business: fresh, actor, ip: clientKey(req), change: result, reason: 'mode_changed' });
    if (result.before.forward_during_hours !== result.after.forward_during_hours) {
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.forward_hours_changed',
        target: `business:${id}`, ip: clientKey(req), meta: { ...actor.meta, forward_during_hours: result.after.forward_during_hours },
      });
    }
    return ok<CallModeView>(callModeView(fresh, { full: true }));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
