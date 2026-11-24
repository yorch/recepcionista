import { clientKey } from '@/lib/auth';
import { getCall, recordAudit } from '@/lib/db';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { fetchVoicemailAudio, hasVoicemail } from '@/lib/voice/voicemail';
import { fail } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Playback requests (a seek is one) per person and per business per minute. */
const PLAYBACK_PER_USER_PER_MINUTE = 40;
const PLAYBACK_PER_BUSINESS_PER_MINUTE = 120;

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

    // Every playback (and every seek) is a REST call on the account-wide Twilio credentials: bound them per person and per business so
    // one login (or one tenant) cannot use up the account's API concurrency that SMS and every other tenant share.
    const who = auth.principal.user?.id ?? `admin:${auth.principal.kind === 'admin' ? auth.principal.via : 'user'}`;
    const [mine, theirs] = [
      await rateLimit(`voicemail-proxy:user:${who}`, PLAYBACK_PER_USER_PER_MINUTE, 60_000),
      await rateLimit(`voicemail-proxy:business:${call.business_id}`, PLAYBACK_PER_BUSINESS_PER_MINUTE, 60_000),
    ];
    const limited = !mine.allowed ? mine : !theirs.allowed ? theirs : null;
    if (limited) return Response.json({ ok: false, error: 'too many playback requests; try again in a moment' }, { status: 429, headers: { 'retry-after': String(limited.retryAfterS), 'cache-control': 'no-store' } });

    const range = req.headers.get('range');
    const audio = await fetchVoicemailAudio(call.recording_url as string, range);
    if (!audio.ok) return fail(audio.error, audio.status);

    // One audit row per listen (a seek is a Range request and is not logged again).
    if (!range || /^bytes=0-/.test(range)) {
      const actor = auditActorOf(auth.principal);
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id,
        business_id: call.business_id, action: 'call.voicemail_played', target: `call:${call.id}`, ip: clientKey(req), meta: actor.meta,
      });
    }
    return audio.response;
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
