import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit, updateBusiness } from '@/lib/db';
import { REFUND_POLICIES, REFUND_POLICY_TEXT_MAX, type RefundPolicy } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface RefundPolicyView { refund_policy: RefundPolicy; refund_policy_text: string | null }

/** Plain text only: control characters (except newline) are dropped, line endings normalised. React escapes it on every page it is shown. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'g');
export function cleanPolicyText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(CONTROL_CHARS, '').trim();
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const b = await getBusiness(id);
    if (!b) return fail('business not found', 404);
    return ok<RefundPolicyView>({ refund_policy: b.refund_policy ?? 'full_24h', refund_policy_text: b.refund_policy_text ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/** PUT { refund_policy?: 'none'|'full_24h'|'full_48h'|'full_always', refund_policy_text?: string|null (<= 2000 chars) }  Owner only; audited. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const patch: { refund_policy?: RefundPolicy; refund_policy_text?: string | null } = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'refund_policy') {
        if (typeof v !== 'string' || !(REFUND_POLICIES as readonly string[]).includes(v)) return fail(`refund_policy must be one of ${REFUND_POLICIES.join(', ')}`, 422);
        patch.refund_policy = v as RefundPolicy;
      } else if (k === 'refund_policy_text') {
        if (v === null) patch.refund_policy_text = null;
        else if (typeof v !== 'string') return fail('refund_policy_text must be text', 422);
        else if (v.length > REFUND_POLICY_TEXT_MAX) return fail(`refund_policy_text must be at most ${REFUND_POLICY_TEXT_MAX} characters`, 422);
        else patch.refund_policy_text = cleanPolicyText(v) || null;
      } else return fail(`field "${k}" cannot be updated here`, 422);
    }
    if (Object.keys(patch).length === 0) return fail('nothing to update', 422);
    const before = await getBusiness(id);
    if (!before) return fail('business not found', 404);
    const updated = await updateBusiness(id, patch);
    if (!updated) return fail('business not found', 404);
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.refund_policy_changed', target: `business:${id}`, ip: clientKey(req),
      meta: { ...actor.meta, from: before.refund_policy ?? 'full_24h', to: updated.refund_policy ?? 'full_24h', text_changed: 'refund_policy_text' in patch },
    });
    return ok<RefundPolicyView>({ refund_policy: updated.refund_policy ?? 'full_24h', refund_policy_text: updated.refund_policy_text ?? null });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
