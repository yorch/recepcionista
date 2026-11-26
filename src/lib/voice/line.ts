/**
 * Which kind of phone line a deployment answers on, because it decides what the call handling modes can do:
 *
 *   'native'   the number is imported into ElevenLabs (the documented production setup, docs/runbook.md section 8). ElevenLabs owns
 *              the Voice URL and answers the call itself, so the app only sees the conversation-initiation webhook
 *              (/api/voice/initiation) and can change what the agent SAYS. It cannot dial a human itself, but with NATIVE_TRANSFER=on the
 *              agent can TRANSFER the call (voice/transfer.ts). `paused` works (message + callback capture); with NATIVE_TRANSFER off
 *              (the default) `forward` does NOT, and the dashboard says so instead of promising it.
 *   'webhook'  the Twilio number's Voice URL is /api/voice/incoming (a signed form POST answered with TwiML): `paused` records a
 *              voicemail and `forward` dials the verified number. There is no AI conversation on such a line (the route answers
 *              JSON only to the unsigned demo UI), so it is for forwarding / voicemail-only numbers and local demos.
 *
 * A tenant that owns an imported number (businesses.elevenlabs_phone_number_id) is 'native' whatever else is set (lineKindFor).
 * VOICE_LINE_KIND=native|webhook forces the answer (except that `webhook` is IGNORED, loudly, when ELEVENLABS_PHONE_NUMBER_ID names a native
 * line: lineKindMismatch); unset, a deployment with ELEVENLABS_API_KEY and ELEVENLABS_PHONE_NUMBER_ID is
 * 'native' and everything else (development, tests, demo) is 'webhook'. Pure.
 */
import { logger } from '@/lib/log';

export type LineKind = 'native' | 'webhook';

const log = logger('voice/line');
let warnedMismatch = false;

export function lineKind(env: Record<string, string | undefined> = process.env): LineKind {
  const forced = (env.VOICE_LINE_KIND ?? '').trim().toLowerCase();
  // A native (ElevenLabs-imported) number is answered by ElevenLabs whatever this variable says: nothing here can dial a human on it. A
  // contradicting VOICE_LINE_KIND=webhook would only make the dashboard promise forwarding that never happens, so the SAFE reading wins.
  if (forced === 'webhook' && nativeLineConfigured(env)) {
    if (!warnedMismatch) { warnedMismatch = true; log.error('line_kind_mismatch', { banner: `!!! ${lineKindMismatch(env)}` }); }
    return 'native';
  }
  if (forced === 'native' || forced === 'webhook') return forced;
  return nativeLineConfigured(env) || tenantLinesDefault(env) ? 'native' : 'webhook';
}

/**
 * Per-tenant imported lines (voice/tenant-line.ts): with ELEVENLABS_API_KEY set and ELEVENLABS_TENANT_LINES not `off`, every purchased number is
 * imported into ElevenLabs, so an unforced deployment is 'native' even without the shared ELEVENLABS_PHONE_NUMBER_ID.
 */
export const tenantLinesDefault = (env: Record<string, string | undefined> = process.env): boolean =>
  Boolean((env.ELEVENLABS_API_KEY ?? '').trim()) && (env.ELEVENLABS_TENANT_LINES ?? '').trim().toLowerCase() !== 'off';

/** The line kind for ONE business: a tenant that owns an imported ElevenLabs number is always native (ElevenLabs answers it). */
export const lineKindFor = (business: { elevenlabs_phone_number_id?: string | null } | null | undefined, env: Record<string, string | undefined> = process.env): LineKind =>
  business?.elevenlabs_phone_number_id ? 'native' : lineKind(env);

/**
 * What answers THIS business's calls RIGHT NOW (call-mode surfaces: is forwarding offered, the dashboard label, setCallMode, resolveCallRoute):
 *  - a tenant that owns an imported number: native (ElevenLabs answers it), whatever the deployment default is;
 *  - otherwise the deployment's kind, EXCEPT the unforced tenant-lines default (ELEVENLABS_API_KEY set, no shared line id): a number that is not imported yet still
 *    has OUR Voice URL (voice/incoming), so it answers on the webhook line and keeps forwarding until `repair-numbers` imports it.
 * `lineKindFor` stays the TARGET (should this number be imported?): provisioning, agent creation and repair use that one.
 */
export const effectiveLineKindFor = (business: { elevenlabs_phone_number_id?: string | null } | null | undefined, env: Record<string, string | undefined> = process.env): LineKind => {
  if (business?.elevenlabs_phone_number_id) return 'native';
  const kind = lineKind(env);
  if (kind === 'native' && (env.VOICE_LINE_KIND ?? '').trim().toLowerCase() !== 'native' && !nativeLineConfigured(env)) return 'webhook';
  return kind;
};

/** Is a native ElevenLabs phone line configured (the API key AND the imported phone number id)? */
export const nativeLineConfigured = (env: Record<string, string | undefined> = process.env): boolean =>
  Boolean((env.ELEVENLABS_API_KEY ?? '').trim() && (env.ELEVENLABS_PHONE_NUMBER_ID ?? '').trim());

/**
 * A human-readable problem when VOICE_LINE_KIND=webhook contradicts a configured native line (ELEVENLABS_PHONE_NUMBER_ID set), else null.
 * `lineKind()` then answers 'native' (callers hear the paused script, nothing is forwarded, and the dashboard says so).
 */
export function lineKindMismatch(env: Record<string, string | undefined> = process.env): string | null {
  const forced = (env.VOICE_LINE_KIND ?? '').trim().toLowerCase();
  return forced === 'webhook' && nativeLineConfigured(env)
    ? 'VOICE_LINE_KIND=webhook, but ELEVENLABS_PHONE_NUMBER_ID is set: that number is answered by ElevenLabs, which can never forward a call here. Treating the line as native (forwarding is NOT available). Unset VOICE_LINE_KIND, or remove the ElevenLabs phone number settings if this deployment really uses a Twilio Voice URL.'
    : null;
}

/**
 * Can a call be forwarded to a human on this kind of line? Always on a 'webhook' line. On the 'native' ElevenLabs line only with
 * NATIVE_TRANSFER=on (the transfer-to-number system tool, voice/transfer.ts; default OFF until the live test in docs/runbook.md section 8)
 * AND, when the business is given, its own `native_transfer_enabled` opt-in.
 */
export const forwardingSupported = (
  line: LineKind = lineKind(), env: Record<string, string | undefined> = process.env, business?: { native_transfer_enabled?: boolean | null } | null,
): boolean => {
  if (line === 'webhook') return true;
  if ((env.NATIVE_TRANSFER ?? '').trim().toLowerCase() !== 'on') return false;
  // Per-business opt-in (Settings > AI line): with the capability on, a business that has NOT enabled it still gets the paused script.
  // `undefined` (a caller that does not know the business) keeps the global answer.
  return business?.native_transfer_enabled === undefined || business?.native_transfer_enabled === null ? true : business.native_transfer_enabled === true;
};

/** The honest sentence shown wherever 'forward' would otherwise be offered or claimed on a line that cannot do it. */
export const FORWARD_UNAVAILABLE = 'Forwarding is not available on the AI voice line — callers will hear the paused message';
