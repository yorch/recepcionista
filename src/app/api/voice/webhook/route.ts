/**
 * Legacy alias of /api/voice/post-call (same auth and handler).
 *
 * Authenticated with the `ElevenLabs-Signature` HMAC (ELEVENLABS_WEBHOOK_SECRET).
 * Accepts the real `{type:'post_call_transcription', data:{...}}` envelope and
 * the legacy flat shape; see processPostCall for correlation rules.
 */

import { ok, fail } from '@/lib/http';
import { verifyElevenLabsSignature } from '@/lib/voice/elevenlabs';
import { parsePostCallBody, processPostCall } from '@/lib/voice/postcall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const verdict = verifyElevenLabsSignature(raw, req.headers.get('elevenlabs-signature'));
    if (!verdict.ok) return fail('unauthorized', 401);

    const outcome = await processPostCall(parsePostCallBody(raw));
    if (outcome.status !== 200) return fail(outcome.error, outcome.status);
    return ok(outcome.body);
  } catch {
    return fail('post-call processing failed', 500);
  }
}

/** Health check so the dashboard can confirm the route is wired. */
export async function GET() {
  return ok({ ready: true, accepts: ['application/json'] });
}
