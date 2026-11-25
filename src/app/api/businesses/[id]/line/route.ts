import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, updateBusiness, recordAudit } from '@/lib/db';
import { validateAssistantName } from '@/lib/business-config';
import { limitRequest } from '@/lib/ratelimit';
import { syncPromptAfterEdit, type PromptSyncOutcome } from '@/lib/voice/agent-resync';
import { assistantNameOf, DEFAULT_ASSISTANT_NAME } from '@/lib/voice/assistant-name';
import { lineKindFor, type LineKind } from '@/lib/voice/line';
import { nativeTransferEnabled } from '@/lib/voice/transfer';
import type { Business } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface LineSettings {
  /** What the owner stored (null = the platform default name). */
  assistant_name: string | null;
  /** The name actually spoken. */
  assistant_name_effective: string;
  default_assistant_name: string;
  native_transfer_enabled: boolean;
  /** The platform capability (NATIVE_TRANSFER=on): without it the switch cannot be turned on. */
  transfer_capability: boolean;
  line_kind: LineKind;
  /** This business's number is imported into the voice provider and has its own line id. */
  own_line: boolean;
  has_number: boolean;
  forward_number_verified: boolean;
}

const view = (b: Business): LineSettings => ({
  assistant_name: b.assistant_name ?? null,
  assistant_name_effective: assistantNameOf(b),
  default_assistant_name: DEFAULT_ASSISTANT_NAME,
  native_transfer_enabled: b.native_transfer_enabled === true,
  transfer_capability: nativeTransferEnabled(),
  line_kind: lineKindFor(b),
  own_line: Boolean(b.elevenlabs_phone_number_id),
  has_number: Boolean(b.phone),
  forward_number_verified: Boolean(b.forward_number_e164 && (b.forward_number_verified_at || (b.owner_phone_verified_at && b.owner_phone_e164 === b.forward_number_e164))),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req); // staff+ may read their own business's line settings (no ids are returned)
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    return ok<LineSettings>(view(business));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * Owner-only (staff cannot): `{ assistant_name?: string | null, native_transfer_enabled?: boolean }`. CSRF same-origin is enforced by authenticate().
 * Turning live transfer ON needs a recent proof of identity (step-up) because it lets the AI hand a caller to a phone number, and is refused
 * while the platform capability (NATIVE_TRANSFER) is off. Both changes are pushed to the live agent now (a failure is queued for retry and reported
 * as `agent_sync`) and audited (the name itself is not copied to the audit row, only that it changed).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const limited = await limitRequest(req, 'businesses/line', 20, 60_000);
    if (limited) return limited;
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const patch: { assistant_name?: string | null; native_transfer_enabled?: boolean } = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'assistant_name') {
        const v = validateAssistantName(value);
        if (!v.ok) return fail(v.error, 422);
        patch.assistant_name = v.value;
      } else if (key === 'native_transfer_enabled') {
        if (typeof value !== 'boolean') return fail('native_transfer_enabled must be true or false', 422);
        patch.native_transfer_enabled = value;
      } else {
        return fail(`field "${key}" cannot be updated here`, 422);
      }
    }
    if (Object.keys(patch).length === 0) return fail('nothing to update', 422);
    const before = await getBusiness(id);
    if (!before) return fail('business not found', 404);
    const turningOn = patch.native_transfer_enabled === true && before.native_transfer_enabled !== true;
    if (turningOn) {
      if (!nativeTransferEnabled()) return fail('live transfer is not available on this platform yet', 409);
      const reauth = requireRecentAuth(auth);
      if (reauth) return reauth as unknown as ReturnType<typeof fail>;
    }
    const nameChanged = patch.assistant_name !== undefined && (patch.assistant_name ?? null) !== (before.assistant_name ?? null);
    const transferChanged = patch.native_transfer_enabled !== undefined && patch.native_transfer_enabled !== (before.native_transfer_enabled === true);
    const updated = await updateBusiness(id, patch as Partial<Business>);
    if (!updated) return fail('business not found', 404);
    const actor = auditActorOf(auth.principal);
    if (nameChanged) await recordAudit({ actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.assistant_name_changed', target: `business:${id}`, ip: clientKey(req), meta: { ...actor.meta, cleared: patch.assistant_name === null } });
    if (transferChanged) await recordAudit({ actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.native_transfer_changed', target: `business:${id}`, ip: clientKey(req), meta: { ...actor.meta, enabled: patch.native_transfer_enabled === true } });
    // The agent's prompt, first message and tool list depend on both fields: push now; a failure is queued (agent-dirty) and reported honestly.
    let agentSync: PromptSyncOutcome | null = null;
    if (nameChanged || transferChanged) agentSync = await syncPromptAfterEdit(id);
    return ok<LineSettings & { agent_sync?: PromptSyncOutcome }>({ ...view(updated), ...(agentSync ? { agent_sync: agentSync } : {}) });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
