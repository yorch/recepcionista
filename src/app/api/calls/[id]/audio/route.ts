import { clientKey } from '@/lib/auth';
import { getCall, recordAudit } from '@/lib/db';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { callHasRecording, fetchConversationAudio } from '@/lib/voice/recording-audio';
import { fail } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PER_USER_PER_MINUTE = 30;
const PER_BUSINESS_PER_MINUTE = 90;

/**
 * GET /api/calls/:id/audio   Staff+, tenant-scoped (another business's call is a 404, like a missing one).
 * Streams the call recording from the voice provider through this server (the provider URL and key never reach the browser), ONLY when the
 * recording disclosure was given (consent_status = 'disclosed') and the call has a provider conversation. Range requests are honoured (seeking).
 * Rate limited per person and per business, `private, no-store`, one audit row per listen (`call.recording_played`; a seek is not logged again).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const call = await getCall(id);
    requireBusinessAccess(auth.principal, call?.business_id);
    if (!call || !callHasRecording(call)) return fail('no recording for this call', 404);

    const who = auth.principal.user?.id ?? `admin:${auth.principal.kind === 'admin' ? auth.principal.via : 'user'}`;
    const mine = await rateLimit(`recording-proxy:user:${who}`, PER_USER_PER_MINUTE, 60_000);
    const theirs = await rateLimit(`recording-proxy:business:${call.business_id}`, PER_BUSINESS_PER_MINUTE, 60_000);
    const limited = !mine.allowed ? mine : !theirs.allowed ? theirs : null;
    if (limited) return Response.json({ ok: false, error: 'too many playback requests; try again in a moment' }, { status: 429, headers: { 'retry-after': String(limited.retryAfterS), 'cache-control': 'no-store' } });

    const range = req.headers.get('range');
    const audio = await fetchConversationAudio(call.conversation_id as string, range);
    if (!audio.ok) return fail(audio.error, audio.status);

    if (!range || /^bytes=0-/.test(range)) {
      const actor = auditActorOf(auth.principal);
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: call.business_id,
        action: 'call.recording_played', target: `call:${call.id}`, ip: clientKey(req), meta: actor.meta,
      });
    }
    return audio.response;
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
