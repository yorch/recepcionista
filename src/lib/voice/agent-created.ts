/**
 * What a voice agent that was CREATED by a re-sync (the old one was gone at the provider: 404) needs on top of the prompt: the phone number
 * binding and the post-call webhook (summaries, transcripts, metering) that provisioning gives every agent. Shared by the admin resync
 * endpoint and the automatic resync (vertical change, owner KB change, the agent-dirty drain). Never throws; returns what failed.
 */
import { bindPhoneNumber } from '@/lib/voice/elevenlabs';
import { ensurePostCallWebhook, registerPostCallWebhookOnAgent } from '@/lib/voice/postcall';
import { logger } from '@/lib/log';

const log = logger('voice/agent-created');

export async function finishCreatedAgent(agentId: string, businessId: string): Promise<string[]> {
  const notes: string[] = [];
  try { await bindPhoneNumber(agentId); } catch { notes.push('phone binding failed'); }
  try {
    const hook = await ensurePostCallWebhook({ allowCreate: false });
    if (hook.webhook_id) await registerPostCallWebhookOnAgent(agentId, hook.webhook_id); else notes.push('post-call webhook unavailable');
  } catch { notes.push('post-call webhook registration failed'); }
  log.warn('agent.created_by_resync', { business: businessId, agent: agentId, notes, action: notes.length ? 'finish binding / webhook in the runbook' : 'check the previous agent is gone at the provider' });
  return notes;
}
