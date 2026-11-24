import { clientKey } from '@/lib/auth';
import { getCall, recordAudit } from '@/lib/db';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { fetchVoicemailAudio, hasVoicemail } from '@/lib/voice/voicemail';
import { fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/calls/:id/voicemail   Staff+ (the people who call back), tenant-scoped.
 * Streams the voicemail audio. The recording lives at Twilio behind the ACCOUNT credentials: this route authenticates the caller,
 * checks the call belongs to their business (another tenant's call is a 404, exactly like a missing one), and fetches the audio
 * SERVER-SIDE with those credentials. The Twilio URL and the credentials never reach the browser, and nothing here is cacheable.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const call = await getCall(id);
    requireBusinessAccess(auth.principal, call?.business_id);
    if (!call || !hasVoicemail(call)) return fail('no voicemail for this call', 404);

    const range = req.headers.get('range');
    const audio = await fetchVoicemailAudio(call.recording_url as string, range);
    if (!audio.ok) return fail(audio.error, audio.status);

    // One audit row per listen (a seek is a Range request and is not logged again).
    if (!range || /^bytes=0-/.test(range)) {
      await recordAudit({
        actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token', actor_user_id: auth.principal.user?.id ?? null,
        business_id: call.business_id, action: 'call.voicemail_played', target: `call:${call.id}`, ip: clientKey(req),
      });
    }
    return audio.response;
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
