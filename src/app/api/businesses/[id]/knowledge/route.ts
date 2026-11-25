import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, getKnowledgeBase, upsertKnowledgeBase } from '@/lib/db';
import { buildSystemPrompt } from '@/lib/kb';
import { syncPromptAfterEdit, type PromptSyncOutcome } from '@/lib/voice/agent-resync';
import type { FAQ, KnowledgeBase, Service } from '@/lib/types';

interface KnowledgePatch {
  services?: Service[];
  faqs?: FAQ[];
  pricing_notes?: string;
  call_script?: string;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<KnowledgeBase & { agent_sync: PromptSyncOutcome }>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'owner' }); // the knowledge base is the agent's prompt: owner-only
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    const existing = await getKnowledgeBase(id);
    if (!existing) return fail('knowledge base not found — provision the business first', 404);

    const body = await readJson<KnowledgePatch>(req);

    const services = Array.isArray(body.services) ? body.services.slice(0, 20) : existing.services;
    const faqs = Array.isArray(body.faqs) ? body.faqs.slice(0, 15) : existing.faqs;
    const pricing_notes = typeof body.pricing_notes === 'string' ? body.pricing_notes : existing.pricing_notes;
    const call_script = typeof body.call_script === 'string' ? body.call_script : existing.call_script;

    const system_prompt = buildSystemPrompt(business, { services, faqs, pricing_notes });

    const saved = await upsertKnowledgeBase(id, { services, faqs, pricing_notes, call_script, system_prompt });
    // The live agent's prompt is whatever the last sync pushed: push this edit now (a failure is queued for retry and reported).
    const agent_sync = await syncPromptAfterEdit(id);
    return ok<KnowledgeBase & { agent_sync: PromptSyncOutcome }>({ ...saved, agent_sync });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 400);
  }
}
