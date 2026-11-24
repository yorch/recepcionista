/**
 * Apply / reject / revert an owner knowledge change with its side effects, in ONE place shared by the SMS confirmation
 * (sms.ts) and the dashboard buttons: audit row, the agent prompt rebuilt from the validated knowledge base (buildSystemPrompt wraps
 * every owner-supplied value as untrusted data), and the ElevenLabs agent re-synced (best effort).
 */
import {
  applyKbChange, getBusiness, getKbChange, getKnowledgeBase, recordAudit, rejectKbChange, revertKbChange, upsertKnowledgeBase,
  type KbChangeResult,
} from '@/lib/db';
import { buildSystemPrompt } from '@/lib/kb';
import { syncAgent, hasElevenLabs } from '@/lib/voice/elevenlabs';
import { logger } from '@/lib/log';
import type { AuditActorKind, OwnerKbChange, OwnerKbSource } from '@/lib/types';

const log = logger('owner-kb');

export interface ChangeActor {
  actor_kind: AuditActorKind;
  actor_user_id?: string | null;
  /** Where the decision came from: 'sms' (the owner's text reply) or 'dashboard'. */
  via: 'sms' | 'dashboard' | 'voice';
  ip?: string | null;
}

export type OwnerAuditAction = 'proposed' | 'applied' | 'rejected' | 'reverted' | 'expired' | 'stale' | 'revert_conflict' | 'refused' | 'locked' | 'tool_refused' | 'session' | 'undo_requested';

export async function auditOwnerKb(action: OwnerAuditAction, businessId: string, actor: ChangeActor, change: Pick<OwnerKbChange, 'id' | 'summary' | 'source'> | null, meta: Record<string, unknown> = {}): Promise<void> {
  await recordAudit({
    actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id ?? null, business_id: businessId, action: `owner_kb.${action}`,
    target: change ? `owner_kb_change:${change.id}` : `business:${businessId}`, ip: actor.ip ?? null,
    meta: { via: actor.via, ...(change ? { source: change.source satisfies OwnerKbSource, summary: change.summary.slice(0, 200) } : {}), ...meta },
  });
}

/** Rebuild the stored system prompt from the (validated) knowledge base and push it to the voice agent. Never throws. */
export async function resyncAfterKbChange(businessId: string): Promise<{ prompt: boolean; agent: 'synced' | 'skipped' | 'failed' }> {
  try {
    const business = await getBusiness(businessId);
    const kb = await getKnowledgeBase(businessId);
    if (!business || !kb) return { prompt: false, agent: 'skipped' };
    const fresh = await upsertKnowledgeBase(businessId, { system_prompt: buildSystemPrompt(business, { services: kb.services, faqs: kb.faqs, pricing_notes: kb.pricing_notes }) });
    if (!hasElevenLabs() || !business.agent_id) return { prompt: true, agent: 'skipped' };
    try {
      const res = await syncAgent({ business, kb: fresh });
      return { prompt: true, agent: res.mock ? 'failed' : 'synced' };
    } catch (err) {
      log.warn('agent_resync_failed', { business: businessId, err });
      return { prompt: true, agent: 'failed' };
    }
  } catch (err) {
    log.error('resync_failed', { business: businessId, err });
    return { prompt: false, agent: 'failed' };
  }
}

export type OwnerApplyResult =
  | KbChangeResult
  | { ok: false; reason: 'stale' };

/**
 * proposed -> applied. Refuses (and cancels the proposal) when a field the change touches was edited after it was proposed: a patch holds
 * whole lists, so applying it over newer edits would silently undo them. Edits to OTHER fields (including the rebuilt prompt after another
 * applied change) do not make it stale.
 */
export async function applyOwnerChange(businessId: string, changeId: string, actor: ChangeActor): Promise<OwnerApplyResult> {
  const change = await getKbChange(businessId, changeId);
  if (!change) return { ok: false, reason: 'not_found' };
  // The stale check is per touched field and runs inside the apply transaction (applyKbChange compares the change's `base`).
  const res = await applyKbChange(businessId, changeId);
  if (!res.ok && res.reason === 'stale') {
    await auditOwnerKb('stale', businessId, actor, change); // a business field (hours / closures / area) was edited after the proposal
    return { ok: false, reason: 'stale' };
  }
  if (res.ok && res.changed) {
    await auditOwnerKb('applied', businessId, actor, res.change);
    const sync = await resyncAfterKbChange(businessId);
    log.info('applied', { business: businessId, change: changeId, via: actor.via, agent: sync.agent });
  }
  return res;
}

export async function rejectOwnerChange(businessId: string, changeId: string, actor: ChangeActor): Promise<KbChangeResult> {
  const res = await rejectKbChange(businessId, changeId);
  if (res.ok && res.changed) await auditOwnerKb('rejected', businessId, actor, res.change);
  return res;
}

export async function revertOwnerChange(businessId: string, changeId: string, actor: ChangeActor): Promise<KbChangeResult> {
  const res = await revertKbChange(businessId, changeId);
  if (res.ok && res.changed) {
    await auditOwnerKb('reverted', businessId, actor, res.change);
    await resyncAfterKbChange(businessId);
  } else if (!res.ok && res.reason === 'changed_since') {
    const change = await getKbChange(businessId, changeId);
    await auditOwnerKb('revert_conflict', businessId, actor, change, { fields: res.conflicts ?? [] });
  }
  return res;
}
