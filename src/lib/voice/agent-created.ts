/**
 * What a voice agent that was CREATED by a re-sync (the old one was gone at the provider: 404) needs on top of the prompt: the phone number
 * binding and the post-call webhook (summaries, transcripts, metering) that provisioning gives every agent. Shared by the admin resync
 * endpoint and the automatic resync (vertical change, owner KB change, the agent-dirty drain). Never throws; returns what failed.
 */
import { bindPhoneNumber } from '@/lib/voice/elevenlabs';
import { ensureTenantLine, lineApplicable } from '@/lib/voice/tenant-line';
import { lineKindFor } from '@/lib/voice/line';
import { getBusiness } from '@/lib/db';
import { hasTwilio } from '@/lib/providers/twilio';
import { ensurePostCallWebhook, registerPostCallWebhookOnAgent } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';

const log = logger('voice/agent-created');

export async function finishCreatedAgent(agentId: string, businessId: string): Promise<string[]> {
  const notes: string[] = [];
  try {
    const business = await getBusiness(businessId);
    if (business && lineKindFor(business) === 'native' && lineApplicable({ phone: business.phone, agent_id: agentId }).ok && hasTwilio()) {
      // The tenant's own imported number follows its (new) agent; a missing import is made now.
      const line = await ensureTenantLine({ ...business, agent_id: agentId });
      if (!line.ok) notes.push(`phone line: ${line.error}`);
    } else {
      const bound = await bindPhoneNumber(agentId, business);
      if (!bound.ok && business?.phone && lineKindFor(business) === 'native') notes.push(`phone binding skipped (${bound.skipped})`);
    }
  } catch { notes.push('phone binding failed'); }
  try {
    const hook = await ensurePostCallWebhook({ allowCreate: false });
    if (hook.webhook_id) await registerPostCallWebhookOnAgent(agentId, hook.webhook_id); else notes.push('post-call webhook unavailable');
  } catch { notes.push('post-call webhook registration failed'); }
  log.warn('agent.created_by_resync', { business: businessId, agent: agentId, notes, action: notes.length ? 'finish binding / webhook in the runbook' : 'check the previous agent is gone at the provider' });
  return notes;
}
