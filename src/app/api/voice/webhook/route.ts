/**
 * Legacy alias of /api/voice/post-call (same auth and handler).
 *
 * Authenticated with the `ElevenLabs-Signature` HMAC (ELEVENLABS_WEBHOOK_SECRET).
 * Accepts the real `{type:'post_call_transcription', data:{...}}` envelope and
 * the legacy flat shape; see processPostCall for correlation rules.
 */

import { configEnv } from '@/lib/config';
import { ok, fail, readiness } from '@/lib/http';
import { insecureDevAllowed } from '@/lib/auth';
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

/** Readiness probe: 200 only when this route can authenticate ElevenLabs (the webhook secret is set, or the local-dev opt-in is on). */
export async function GET() {
  return readiness(Boolean(configEnv().ELEVENLABS_WEBHOOK_SECRET) || insecureDevAllowed(), { accepts: ['application/json'] });
}
