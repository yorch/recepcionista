import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, getKnowledgeBase, recordAudit, updateBusiness } from '@/lib/db';
import { createOrUpdateAgent, hasElevenLabs } from '@/lib/voice/elevenlabs';
import { findAllowedVoice, listAllowedVoices, type VoiceOption } from '@/lib/voice/voices';
import { limitRequest } from '@/lib/ratelimit';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const log = logger('voice-settings');

export interface VoiceSettings {
  /** False without an ElevenLabs key: the picker is disabled. */
  available: boolean;
  voice_id: string | null;
  voice_name: string | null;
  voices: { voice_id: string; name: string; description: string | null; has_preview: boolean }[];
}

const strip = (v: VoiceOption) => ({ voice_id: v.voice_id, name: v.name, description: v.description, has_preview: Boolean(v.preview_url) });

/** GET /api/businesses/:id/voice  Owner+: the chosen voice and the voices that may be chosen (the allowlist). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const available = hasElevenLabs();
    const voices = available ? (await listAllowedVoices()).map(strip) : [];
    return ok({ available, voice_id: business.voice_id ?? null, voice_name: business.voice_name ?? null, voices });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * PUT /api/businesses/:id/voice   { voice_id: string | null }   Owner only (no step-up). `null` returns to the platform default.
 * The id must be in the allowlist (422 `voice_not_allowed` otherwise: whitelist validation, never a free-form id). It is saved on the business
 * (voice_id + voice_name), audited, and the provider agent is re-synced so the next call uses it; `synced:false` says the provider could not
 * be updated now (the choice is saved and is applied at the next sync).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'businesses/voice', 20);
  if (limited) return limited;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'voice_id') return fail(`field "${k}" cannot be updated here`, 422);
    if (!('voice_id' in body)) return fail('voice_id is required (or null for the default)', 422);
    if (!hasElevenLabs()) return fail('voice selection needs an ElevenLabs connection, which this installation does not have', 503);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    let chosen: VoiceOption | null = null;
    if (body.voice_id !== null) {
      chosen = await findAllowedVoice(body.voice_id);
      if (!chosen) return fail('that voice is not available: pick one from the list', 422);
    }
    const updated = await updateBusiness(id, { voice_id: chosen?.voice_id ?? null, voice_name: chosen?.name ?? null });
    if (!updated) return fail('business not found', 404);
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'business.voice_changed',
      target: `business:${id}`, ip: clientKey(req), meta: { ...actor.meta, from: business.voice_id ?? null, to: chosen?.voice_id ?? null },
    });
    let synced = false;
    if (updated.agent_id) {
      try {
        const r = await createOrUpdateAgent({ business: updated, kb: await getKnowledgeBase(id) });
        synced = !r.mock && !r.error;
      } catch (err) {
        log.warn('agent_resync_failed', { business: id, err });
      }
    }
    return ok({ voice_id: updated.voice_id ?? null, voice_name: updated.voice_name ?? null, synced });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
