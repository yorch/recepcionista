import { fail, ok, readJson } from '@/lib/http';
import { clientKey } from '@/lib/auth';
import { authenticate, authErrorResponse, auditActorOf, requireBusinessAccess } from '@/lib/session';
import { getBusiness, getKbChange } from '@/lib/db';
import { applyOwnerChange, rejectOwnerChange, revertOwnerChange, type ChangeActor } from '@/lib/voice/owner/apply';
import { publicKbChange, type PublicKbChange } from '@/lib/voice/owner/view';

export const dynamic = 'force-dynamic';

const ACTIONS = ['apply', 'reject', 'undo'] as const;

/**
 * POST /api/businesses/:id/kb-changes/:changeId  { action: 'apply' | 'reject' | 'undo' }   Owner only (the same cookie-session CSRF and
 * origin checks as every owner write; no step-up needed, the owner is already signed in). The change must belong to this business.
 *   apply  proposed -> applied (409 when the knowledge base was edited after it was proposed)
 *   reject proposed -> rejected
 *   undo   applied  -> reverted (409 with `conflicts` when someone edited the same fields since)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; changeId: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id, changeId } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<{ action?: unknown }>(req);
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!(ACTIONS as readonly string[]).includes(action)) return fail('action must be "apply", "reject" or "undo"', 422);
    if (!(await getBusiness(id)) || !(await getKbChange(id, changeId))) return fail('change not found', 404);

    const a = auditActorOf(auth.principal);
    const actor: ChangeActor = { actor_kind: a.actor_kind, actor_user_id: a.actor_user_id, via: 'dashboard', ip: clientKey(req) };
    const res = action === 'apply' ? await applyOwnerChange(id, changeId, actor)
      : action === 'reject' ? await rejectOwnerChange(id, changeId, actor)
        : await revertOwnerChange(id, changeId, actor);
    if (res.ok) return ok<PublicKbChange>(publicKbChange(res.change));
    if (res.reason === 'not_found') return fail('change not found', 404);
    if (res.reason === 'stale') return fail('The knowledge base was edited after this change was proposed, so it was cancelled. Ask for it again.', 409);
    if (res.reason === 'changed_since') return fail(`Not undone: ${(res.conflicts ?? []).join(', ')} was edited since this change.`, 409);
    return fail(`This change is ${res.current ?? 'not in a state that allows that'}.`, 409);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
