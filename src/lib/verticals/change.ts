/**
 * Applying a change of vertical to a business that already has a knowledge base. SERVER ONLY (database + voice provider).
 *
 * Nothing the owner entered is touched: services, FAQs and pricing notes stay exactly as they are. Only what is DERIVED from the vertical is
 * rebuilt: the stored system prompt (always generated from the business + its services/FAQs, never hand-edited) and the call script, and the
 * script only when it is still the generated one for the previous vertical (an owner-edited script is kept). Then the voice agent is re-synced
 * so the next call already uses the new emergency rules. Never throws: the vertical itself is already saved by the time this runs.
 */
import { getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { buildCallScript, buildSystemPrompt } from '@/lib/kb';
import { hasElevenLabs, syncAgent } from '@/lib/voice/elevenlabs';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('verticals');

export interface VerticalChangeOutcome {
  /** The stored system prompt was rebuilt for the new vertical. */
  prompt_rebuilt: boolean;
  /** The call script was regenerated (false when the owner had edited it, or there is no knowledge base yet). */
  call_script_rebuilt: boolean;
  /** 'skipped': nothing to sync (no agent yet, or no provider key); 'failed': the provider call failed (the next sync applies it). */
  agent: 'synced' | 'skipped' | 'failed';
}

export async function applyVerticalChange(before: Business, after: Business): Promise<VerticalChangeOutcome> {
  const out: VerticalChangeOutcome = { prompt_rebuilt: false, call_script_rebuilt: false, agent: 'skipped' };
  try {
    let kb = await getKnowledgeBase(after.id);
    if (!kb) return out; // nothing generated yet: provisioning builds it from the new vertical
    const generatedBefore = !kb.call_script.trim() || kb.call_script === buildCallScript({ services: kb.services }, before);
    kb = await upsertKnowledgeBase(after.id, {
      system_prompt: buildSystemPrompt(after, { services: kb.services, faqs: kb.faqs, pricing_notes: kb.pricing_notes }),
      ...(generatedBefore ? { call_script: buildCallScript({ services: kb.services }, after) } : {}),
    });
    out.prompt_rebuilt = true;
    out.call_script_rebuilt = generatedBefore;
    if (hasElevenLabs() && after.agent_id) {
      try {
        const res = await syncAgent({ business: after, kb });
        out.agent = res.mock || res.error ? 'failed' : 'synced';
      } catch (err) {
        log.warn('agent_resync_failed', { business: after.id, err });
        out.agent = 'failed';
      }
    }
  } catch (err) {
    log.error('apply_failed', { business: after.id, err });
  }
  return out;
}
