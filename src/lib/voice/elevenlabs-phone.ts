/**
 * ElevenLabs phone-number shapes, ISOLATED in this one module (docs/runbook.md section 8, docs/known-limitations.md).
 *
 * Every tenant owns its own AI line: the Twilio number the platform bought for it is IMPORTED into ElevenLabs
 * (`POST /v1/convai/phone-numbers`, provider twilio) and bound to that tenant's agent. ElevenLabs then owns the number's Twilio Voice URL
 * (the app only sees the conversation-initiation webhook, /api/voice/initiation).
 *
 * PROVIDER SHAPES (UNVERIFIED against a live account when written; taken from the public ElevenLabs API reference; nothing else in the
 * code base may hard-code them, so a change at the provider is a one-file fix, and the call sites degrade to an honest error):
 *
 *   POST   /v1/convai/phone-numbers
 *          { provider: "twilio", phone_number: "+1305...", label: string, sid: <Twilio ACCOUNT sid>, token: <Twilio auth token>,
 *            supports_inbound: true, supports_outbound: false }
 *          -> 200 { phone_number_id: "phnum_..." }
 *   GET    /v1/convai/phone-numbers
 *          -> 200 [ { phone_number_id, phone_number, label, provider, assigned_agent?: { agent_id } | null } ]   (read tolerantly)
 *   GET    /v1/convai/phone-numbers/{id}                -> 200 { ...same fields... } | 404
 *   PATCH  /v1/convai/phone-numbers/{id}   { agent_id: string | null }   (bind / detach the agent)
 *   DELETE /v1/convai/phone-numbers/{id}                -> 200 | 404 (already gone = success)
 *   POST   /v1/convai/twilio/register-call
 *          { agent_id, from_number, to_number, direction: "inbound", conversation_initiation_client_data?: { dynamic_variables } }
 *          -> 200 TwiML text (a <Connect><Stream> document) to hand back to Twilio from a Voice URL
 *
 * Rules enforced here (never by the callers):
 *  - the Twilio token is sent to the provider ONLY in the import body; it is never logged, returned, audited or put in an error message;
 *  - an import is IDEMPOTENT: the account's list is read first and a number already imported for this E.164 is ADOPTED (never imported twice);
 *  - a phone-number id that another business owns is never adopted, rebound or deleted (`isOwnedElsewhere` is injected by the caller);
 *  - every function returns a result, never throws, and every error text is short and free of secrets.
 */
import { logger } from '@/lib/log';

const log = logger('elevenlabs/phone');

export const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';
const TIMEOUT_MS = 15_000;

export interface PhoneDeps { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }

export type PhoneResult<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number; retryable: boolean };

export interface RemoteNumber { phone_number_id: string; phone_number: string | null; agent_id: string | null }

const apiKeyOf = (env: NodeJS.ProcessEnv): string => (env.ELEVENLABS_API_KEY ?? '').trim();
const hdrs = (key: string): Record<string, string> => ({ 'content-type': 'application/json', 'xi-api-key': key });
const fail = (error: string, status?: number): { ok: false; error: string; status?: number; retryable: boolean } => ({
  ok: false, error, ...(status !== undefined ? { status } : {}), retryable: status === undefined || status === 429 || status >= 500,
});
const errName = (err: unknown): string => (err as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'network error';

/** Read a number out of whatever shape the provider answers (field names are unverified: accept the plausible ones). */
export function parseRemoteNumber(raw: unknown): RemoteNumber | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.phone_number_id === 'string' ? r.phone_number_id : typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  const assigned = r.assigned_agent as { agent_id?: unknown } | null | undefined;
  const agent = typeof assigned?.agent_id === 'string' ? assigned.agent_id : typeof r.agent_id === 'string' ? r.agent_id : null;
  return { phone_number_id: id, phone_number: typeof r.phone_number === 'string' ? r.phone_number : null, agent_id: agent };
}

/** All numbers imported into the workspace. */
export async function listRemoteNumbers(deps: PhoneDeps = {}): Promise<PhoneResult<{ numbers: RemoteNumber[] }>> {
  const env = deps.env ?? process.env;
  const key = apiKeyOf(env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${ELEVENLABS_API}/convai/phone-numbers`, { headers: hdrs(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return fail(`list phone numbers ${res.status}`, res.status);
    const json = (await res.json().catch(() => null)) as unknown;
    const rows = Array.isArray(json) ? json : Array.isArray((json as { phone_numbers?: unknown })?.phone_numbers) ? (json as { phone_numbers: unknown[] }).phone_numbers : null;
    if (!rows) return fail('list phone numbers: unreadable answer', 502);
    return { ok: true, numbers: rows.map(parseRemoteNumber).filter((n): n is RemoteNumber => n !== null) };
  } catch (err) {
    return fail(`list phone numbers: ${errName(err)}`);
  }
}

export async function getRemoteNumber(phoneNumberId: string, deps: PhoneDeps = {}): Promise<PhoneResult<{ number: RemoteNumber | null }>> {
  const key = apiKeyOf(deps.env ?? process.env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${ELEVENLABS_API}/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, { headers: hdrs(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { ok: true, number: null };
    if (!res.ok) return fail(`get phone number ${res.status}`, res.status);
    return { ok: true, number: parseRemoteNumber(await res.json().catch(() => null)) };
  } catch (err) {
    return fail(`get phone number: ${errName(err)}`);
  }
}

/**
 * Import one Twilio number into ElevenLabs. Adopts an existing import of the same E.164 (idempotent). The Twilio credentials come from the
 * environment (the SAME account that bought the number) and go to the provider only in this body.
 */
export async function importTwilioNumber(
  input: { phone: string; label: string; isOwnedElsewhere?: (phoneNumberId: string) => Promise<boolean> },
  deps: PhoneDeps = {},
): Promise<PhoneResult<{ phone_number_id: string; adopted: boolean }>> {
  const env = deps.env ?? process.env;
  const key = apiKeyOf(env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  const twilioSid = (env.TWILIO_ACCOUNT_SID ?? '').trim();
  const twilioToken = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  if (!twilioSid || !twilioToken) return fail('Twilio credentials are not configured: the number cannot be imported');
  if (!/^\+[1-9]\d{6,14}$/.test(input.phone)) return fail('not an E.164 number');
  const doFetch = deps.fetchImpl ?? fetch;
  const existing = await listRemoteNumbers(deps);
  if (!existing.ok) return existing;
  const hit = existing.numbers.find((n) => n.phone_number === input.phone);
  if (hit) {
    if (input.isOwnedElsewhere && (await input.isOwnedElsewhere(hit.phone_number_id).catch(() => true))) {
      return fail('that number is already imported for another account; it was not touched', 409);
    }
    log.info('import.adopted', { phone_number_id: hit.phone_number_id });
    return { ok: true, phone_number_id: hit.phone_number_id, adopted: true };
  }
  try {
    const res = await doFetch(`${ELEVENLABS_API}/convai/phone-numbers`, {
      method: 'POST', headers: hdrs(key), signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ provider: 'twilio', phone_number: input.phone, label: input.label.slice(0, 80), sid: twilioSid, token: twilioToken, supports_inbound: true, supports_outbound: false }),
    });
    if (!res.ok) { log.warn('import.failed', { status: res.status }); return fail(`import phone number ${res.status}`, res.status); }
    const json = (await res.json().catch(() => null)) as { phone_number_id?: unknown } | null;
    const id = typeof json?.phone_number_id === 'string' ? json.phone_number_id.trim() : '';
    if (!id) return fail('import phone number: the provider returned no phone_number_id', 502);
    log.info('import.ok', { phone_number_id: id });
    return { ok: true, phone_number_id: id, adopted: false };
  } catch (err) {
    // The answer may have been lost AFTER the provider created it: the next try adopts it through the list above.
    log.error('import.error', { error: errName(err) });
    return fail(`import phone number: ${errName(err)}`);
  }
}

/** Bind (agent id) or detach (null) an imported number. */
export async function setNumberAgent(phoneNumberId: string, agentId: string | null, deps: PhoneDeps = {}): Promise<PhoneResult<{ bound: true }>> {
  const key = apiKeyOf(deps.env ?? process.env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${ELEVENLABS_API}/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, {
      method: 'PATCH', headers: hdrs(key), body: JSON.stringify({ agent_id: agentId }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { log.warn('bind.failed', { phone_number_id: phoneNumberId, status: res.status }); return fail(`bind phone number ${res.status}`, res.status); }
    return { ok: true, bound: true };
  } catch (err) {
    return fail(`bind phone number: ${errName(err)}`);
  }
}

/** Delete an imported number (404 = already gone = success). Detaches the agent first (a bound number can keep an agent alive). */
export async function deleteRemoteNumber(phoneNumberId: string, deps: PhoneDeps = {}): Promise<PhoneResult<{ already_deleted: boolean }>> {
  const key = apiKeyOf(deps.env ?? process.env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  try {
    await setNumberAgent(phoneNumberId, null, deps); // best-effort: the delete below is what matters
    const res = await (deps.fetchImpl ?? fetch)(`${ELEVENLABS_API}/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`, { method: 'DELETE', headers: hdrs(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { ok: true, already_deleted: true };
    if (!res.ok) { log.warn('delete.failed', { phone_number_id: phoneNumberId, status: res.status }); return fail(`delete phone number ${res.status}`, res.status); }
    return { ok: true, already_deleted: false };
  } catch (err) {
    return fail(`delete phone number: ${errName(err)}`);
  }
}

/**
 * Webhook-mode AI answer: ask ElevenLabs for the TwiML that connects a Twilio call to the agent (register-call). The text is returned
 * verbatim ONLY when it looks like a TwiML document; anything else is an error and the caller falls back to an honest voicemail.
 */
export async function registerTwilioCall(
  input: { agentId: string; from: string; to: string; dynamicVariables?: Record<string, string>; configOverride?: Record<string, unknown> },
  deps: PhoneDeps = {},
): Promise<PhoneResult<{ twiml: string }>> {
  const key = apiKeyOf(deps.env ?? process.env);
  if (!key) return fail('ELEVENLABS_API_KEY is not set');
  if (!input.agentId || input.agentId.startsWith('mock_')) return fail('no real agent');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${ELEVENLABS_API}/convai/twilio/register-call`, {
      method: 'POST', headers: hdrs(key), signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        agent_id: input.agentId, from_number: input.from, to_number: input.to, direction: 'inbound',
        ...(input.dynamicVariables || input.configOverride ? { conversation_initiation_client_data: { ...(input.dynamicVariables ? { dynamic_variables: input.dynamicVariables } : {}), ...(input.configOverride ? { conversation_config_override: input.configOverride } : {}) } } : {}),
      }),
    });
    if (!res.ok) return fail(`register call ${res.status}`, res.status);
    const text = (await res.text().catch(() => '')).trim();
    if (!/^(<\?xml[^>]*>\s*)?<Response[\s>]/.test(text) || !text.endsWith('</Response>')) return fail('register call: the answer is not TwiML', 502);
    return { ok: true, twiml: text };
  } catch (err) {
    return fail(`register call: ${errName(err)}`);
  }
}
