import { fail } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { findAllowedVoice, fetchPreview } from '@/lib/voice/voices';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/businesses/:id/voice/preview?voice_id=...  Owner+: the provider's sample of an ALLOWED voice, fetched server-side (the provider URL never reaches the browser). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'businesses/voice-preview', 30);
  if (limited) return limited;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const voice = await findAllowedVoice(new URL(req.url).searchParams.get('voice_id'));
    if (!voice) return fail('that voice is not available', 404);
    const sample = await fetchPreview(voice.preview_url);
    if (!sample) return fail('no preview for this voice', 404);
    return new Response(sample.body.slice(), { status: 200, headers: { 'content-type': sample.type, 'content-length': String(sample.body.byteLength), 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
