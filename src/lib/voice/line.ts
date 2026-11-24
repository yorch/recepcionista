/**
 * Which kind of phone line a deployment answers on, because it decides what the call handling modes can do:
 *
 *   'native'   the number is imported into ElevenLabs (the documented production setup, docs/runbook.md section 8). ElevenLabs owns
 *              the Voice URL and answers the call itself, so the app only sees the conversation-initiation webhook
 *              (/api/voice/initiation) and can change what the agent SAYS: it can never dial a human. `paused` works (message +
 *              callback capture); `forward` does NOT, and the dashboard says so instead of promising it.
 *   'webhook'  the Twilio number's Voice URL is /api/voice/incoming (a signed form POST answered with TwiML): `paused` records a
 *              voicemail and `forward` dials the verified number. There is no AI conversation on such a line (the route answers
 *              JSON only to the unsigned demo UI), so it is for forwarding / voicemail-only numbers and local demos.
 *
 * VOICE_LINE_KIND=native|webhook forces the answer; unset, a deployment with ELEVENLABS_API_KEY and ELEVENLABS_PHONE_NUMBER_ID is
 * 'native' and everything else (development, tests, demo) is 'webhook'. Pure.
 */
export type LineKind = 'native' | 'webhook';

export function lineKind(env: Record<string, string | undefined> = process.env): LineKind {
  const forced = (env.VOICE_LINE_KIND ?? '').trim().toLowerCase();
  if (forced === 'native' || forced === 'webhook') return forced;
  return env.ELEVENLABS_API_KEY && env.ELEVENLABS_PHONE_NUMBER_ID ? 'native' : 'webhook';
}

/** Can a call be forwarded to a human on this kind of line? */
export const forwardingSupported = (line: LineKind = lineKind()): boolean => line === 'webhook';

/** The honest sentence shown wherever 'forward' would otherwise be offered or claimed on a line that cannot do it. */
export const FORWARD_UNAVAILABLE = 'Forwarding is not available on the AI voice line — callers will hear the paused message';
