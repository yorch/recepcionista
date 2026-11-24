/**
 * Applying a change of vertical to a business that already has a knowledge base. SERVER ONLY (database + voice provider).
 *
 * Nothing the owner entered is touched: services, FAQs and pricing notes stay exactly as they are. Only what is DERIVED from the vertical is
 * rebuilt: the stored system prompt (always generated from the business + its services/FAQs, never hand-edited) and the call script, and the
 * script only when it is still the generated one for the previous vertical (an owner-edited script is kept). Then the voice agent is re-synced
 * so the next call already uses the new emergency rules. Never throws: the vertical itself is already saved by the time this runs; when the
 * rebuild or the sync fails the business is flagged and retried by the `reconcile` job (voice/agent-resync.ts) and the caller shows a warning.
 */
import { getBusiness, getKnowledgeBase, upsertKnowledgeBase, withLease } from '@/lib/db';
import { buildCallScript, buildSystemPrompt } from '@/lib/kb';
import { hasElevenLabs, syncAgent } from '@/lib/voice/elevenlabs';
import { markAgentDirty } from '@/lib/voice/agent-resync';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('verticals');

export interface VerticalChangeOutcome {
  /** The stored system prompt was rebuilt for the new vertical. */
  prompt_rebuilt: boolean;
  /** The call script was regenerated (false when the owner had edited it, or there is no knowledge base yet). */
  call_script_rebuilt: boolean;
  /** 'skipped': nothing to sync (no agent yet, or no provider key); 'failed': the provider call failed (a retry is queued, see retry_queued). */
  agent: 'synced' | 'skipped' | 'failed';
  /** The prompt rebuild or the agent sync failed: the business is flagged and the `reconcile` job retries with backoff (voice/agent-resync.ts). */
  retry_queued: boolean;
}

export async function applyVerticalChange(before: Business, after: Business): Promise<VerticalChangeOutcome> {
  const out: VerticalChangeOutcome = { prompt_rebuilt: false, call_script_rebuilt: false, agent: 'skipped', retry_queued: false };
  // Serialised per business, and built from the CURRENT business row (not the one this request saw): two quick changes (two tabs) or a
  // concurrent knowledge-base save can no longer leave the prompt of one trade on a business that is now another.
  const lease = await withLease(`vertical-change:${after.id}`, 60_000, async () => {
    try {
      const biz = (await getBusiness(after.id)) ?? after;
      let kb = await getKnowledgeBase(biz.id);
      if (!kb) return; // nothing generated yet: provisioning builds it from the new vertical
      const generatedBefore = !kb.call_script.trim() || kb.call_script === buildCallScript({ services: kb.services }, before);
      kb = await upsertKnowledgeBase(biz.id, {
        system_prompt: buildSystemPrompt(biz, { services: kb.services, faqs: kb.faqs, pricing_notes: kb.pricing_notes }),
        ...(generatedBefore ? { call_script: buildCallScript({ services: kb.services }, biz) } : {}),
      });
      out.prompt_rebuilt = true;
      out.call_script_rebuilt = generatedBefore;
      if (hasElevenLabs() && biz.agent_id) {
        try {
          const res = await syncAgent({ business: biz, kb });
          out.agent = res.mock || res.error ? 'failed' : 'synced';
        } catch (err) {
          log.warn('agent_resync_failed', { business: biz.id, err });
          out.agent = 'failed';
        }
      }
    } catch (err) {
      log.error('apply_failed', { business: after.id, err });
      out.agent = 'failed';
    }
  });
  // Another change is being applied right now: it may have read the business before this one was saved. Rebuild once it is done.
  if (!lease.acquired) out.agent = 'failed';
  // The vertical is already saved: a failed prompt rebuild or agent sync must not leave the live agent on the OLD trade's emergency rules.
  if (out.agent === 'failed') { await markAgentDirty(after.id); out.retry_queued = true; }
  return out;
}
