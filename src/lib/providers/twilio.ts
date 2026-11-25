/**
 * SMS adapter. Real Twilio when credentials exist; otherwise logs to the local
 * sms_log so the dashboard and demo still show a message being "sent".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { insecureDevAllowed } from '@/lib/auth';
import { mockSmsAllowed, SMS_PROVIDER_NOT_CONFIGURED } from '@/lib/messaging/delivery';
import { validateRecipient } from '@/lib/messaging/recipient';
import { toE164 } from '@/lib/phone';
import { lineKind } from '@/lib/voice/line';
import { logger } from '@/lib/log';

export interface SendSmsResult {
  id: string;
  status: 'sent' | 'mock' | 'failed';
  error?: string;
  /** Which kind of sender sent the text: the tenant's own line, the platform's shared sender, or the Twilio Messaging Service sender pool. */
  sender?: 'tenant' | 'shared' | 'service';
  /**
   * The E.164 that actually sent it, when known: the tenant / shared number, or the pool number Twilio reports in its answer. Absent for a Messaging Service text
   * whose sender Twilio has not chosen yet (the status callback, /api/sms/status, fills it in later).
   */
  from?: string | null;
}

const log = logger('twilio');

export const hasTwilio = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

const MOCK_DELAY_MS = 60;
const TWILIO_TIMEOUT_MS = 15_000;

/**
 * Public origin Twilio signed. Prefer PUBLIC_BASE_URL (behind a proxy the
 * request's own host can differ), then APP_URL, then the request URL.
 */
function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '');
}

/**
 * Validate X-Twilio-Signature (HMAC-SHA1, base64) per Twilio's spec:
 * sign `url + concat(sorted key + value)`. `params` are the decoded
 * application/x-www-form-urlencoded POST fields (empty for GET / JSON).
 *
 * Fails closed unless ALLOW_INSECURE_DEV=true (non-production only). Multi-valued params are not supported by
 * our routes (first value is used by callers).
 */
export function verifyTwilioSignature(
  req: Request,
  params: Record<string, string>,
): { ok: true; skipped?: boolean } | { ok: false; error: string } {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    if (!insecureDevAllowed()) {
      log.error('signature.no_token', { reason: 'TWILIO_AUTH_TOKEN unset (set it, or ALLOW_INSECURE_DEV=true for local dev)' });
      return { ok: false, error: 'webhook verification not configured' };
    }
    log.warn('signature.skipped', { reason: 'TWILIO_AUTH_TOKEN unset (ALLOW_INSECURE_DEV)' });
    return { ok: true, skipped: true };
  }
  const header = req.headers.get('x-twilio-signature');
  if (!header) return { ok: false, error: 'missing signature' };

  const reqUrl = new URL(req.url);
  const base = publicBase();
  const urls = new Set<string>();
  if (base) urls.add(`${base}${reqUrl.pathname}${reqUrl.search}`);
  urls.add(reqUrl.toString());

  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], '');
  const given = Buffer.from(header);
  for (const url of urls) {
    const expected = Buffer.from(createHmac('sha1', token).update(url + data, 'utf8').digest('base64'));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, error: 'invalid signature' };
}

/** Twilio error codes that mean "this From number cannot send": the tenant number is not an SMS-capable number of THIS account. */
const FROM_REJECTED_CODES = new Set([21212, 21606, 21659, 21660]);
/** Errors that mean the Messaging Service itself is unusable (not found / no senders). UNVERIFIED against Twilio's live error list: a send then falls back to the tenant / shared number, loudly. */
const SERVICE_UNUSABLE_CODES = new Set([20404, 21704]);

const MESSAGING_SERVICE_RE = /^MG[0-9a-fA-F]{32}$/;

/**
 * TWILIO_MESSAGING_SERVICE_SID (optional, `MG...`): the Twilio Messaging Service whose sender pool holds the tenant numbers registered under ONE platform A2P 10DLC
 * campaign. When set, customer-facing texts are sent with `MessagingServiceSid` (no From). A value that is not an `MG` sid is ignored (and reported by `smsSenderProblem`).
 */
export function messagingServiceSid(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.TWILIO_MESSAGING_SERVICE_SID ?? '').trim();
  return MESSAGING_SERVICE_RE.test(v) ? v : null;
}

/** TWILIO_MESSAGING_SERVICE_PIN_SENDER=on: ALSO pass the tenant's own number as `From` with the Messaging Service (Twilio accepts a pool member there: UNVERIFIED), so the sender is known and replies route exactly. Default off. */
export const messagingServicePinsSender = (env: NodeJS.ProcessEnv = process.env): boolean => (env.TWILIO_MESSAGING_SERVICE_PIN_SENDER ?? '').trim().toLowerCase() === 'on';

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Where Twilio posts the delivery status of every text we send (null without a public base URL). */
export function smsStatusCallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.PUBLIC_BASE_URL || env.APP_URL || env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? `${base}/api/sms/status` : null;
}

export interface SendSmsOptions {
  anyCountry?: boolean;
  /**
   * The sender (E.164): the TENANT's own Twilio number, so a customer's STOP / reply comes back to the number that routes to the right business.
   * Omitted (or equal to the shared sender): TWILIO_PHONE_NUMBER. If Twilio refuses the number as a sender (not on the account, not SMS capable) the text is
   * retried ONCE from the shared sender, and `result.sender` says which one was used.
   */
  from?: string | null;
  /**
   * A customer-facing text (sendAndLog): with TWILIO_MESSAGING_SERVICE_SID set it goes out through the Messaging Service (`MessagingServiceSid`, no From), whose
   * sender pool holds the tenant numbers registered under the platform's A2P campaign. Without the variable the tenant number (above) is used.
   */
  messagingService?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function sendSms(to: string, body: string, opts: SendSmsOptions = {}): Promise<SendSmsResult> {
  const env = opts.env ?? process.env;
  // Single enforcement point for E.164 + SMS_ALLOWED_COUNTRY_CODES: every text
  // (tools, confirmations, payment links, alerts, routes) ends up here.
  const check = validateRecipient(to, undefined, { anyCountry: opts.anyCountry });
  if (!check.ok) {
    log.warn('sms.recipient_rejected', { reason: check.error });
    return { id: '', status: 'failed', error: check.error };
  }
  const e164 = check.to;
  const hasConfig = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  const shared = (env.TWILIO_PHONE_NUMBER ?? '') as string;
  const ownNumber = opts.from && toE164(opts.from) && !sameE164(shared, opts.from) ? (toE164(opts.from) as string) : null;
  if (!hasConfig) {
    if (!mockSmsAllowed(env)) {
      // Production without a complete Twilio config: nothing is sent, so this is a FAILURE, never a mock "success".
      log.error('sms.not_configured', { to: e164, reason: 'TWILIO_* incomplete in production' });
      return { id: '', status: 'failed', error: SMS_PROVIDER_NOT_CONFIGURED };
    }
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    log.warn('sms.mock', { to: e164, reason: 'TWILIO_* incomplete', chars: body.length });
    // The body (it can hold a verification code or a payment link) is only echoed to the console outside production.
    console.log(`[sms:mock] -> ${e164}\n${body}\n`);
    // The sender a real send would have used is recorded too, so inbound routing is exercised the same way in mock mode.
    return { id: `mock_${Date.now()}`, status: 'mock', sender: ownNumber ? 'tenant' : 'shared', from: ownNumber ?? (toE164(shared) || null) };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const started = Date.now();
    const service = opts.messagingService ? messagingServiceSid(env) : null;
    if (service) {
      const pin = messagingServicePinsSender(env) ? ownNumber : null;
      let pinned = pin;
      let res = await postMessage(e164, { messagingServiceSid: service, ...(pin ? { from: pin } : {}) }, body, env, doFetch);
      // A pinned sender that is not in the pool: send through the service without it (the pool picks one).
      if (!res.ok && pin && FROM_REJECTED_CODES.has(Number(res.json.code))) {
        log.warn('sms.pinned_sender_rejected', { to: e164, from: pin, code: res.json.code });
        pinned = null;
        res = await postMessage(e164, { messagingServiceSid: service }, body, env, doFetch);
      }
      if (res.ok) {
        const reported = typeof res.json.from === 'string' && E164_RE.test(res.json.from) ? res.json.from : null;
        const from = reported ?? pinned;
        log.info('sms.sent', { to: e164, sid: res.json.sid, ms: Date.now() - started, sender: 'service', from_known: Boolean(from) });
        return { id: res.json.sid ?? '', status: 'sent', sender: 'service', from };
      }
      if (!(res.status === 404 || SERVICE_UNUSABLE_CODES.has(Number(res.json.code)))) {
        log.warn('sms.failed', { to: e164, status: res.status, error: res.json.message ?? String(res.status), sender: 'service' });
        return { id: '', status: 'failed', error: res.json.message ?? String(res.status) };
      }
      // The Messaging Service itself is unusable (wrong sid, no senders): never lose the text, fall back to the tenant / shared number and say so loudly.
      log.error('sms.messaging_service_unusable', { to: e164, status: res.status, code: res.json.code ?? null, action: 'falling back to the tenant / shared number; fix TWILIO_MESSAGING_SERVICE_SID' });
    }
    let from = ownNumber ?? shared;
    let res = await postMessage(e164, { from }, body, env, doFetch);
    if (!res.ok && ownNumber && FROM_REJECTED_CODES.has(Number(res.json.code))) {
      // The tenant number cannot send SMS on this account: fall back to the shared sender (replies then route by the recorded sender, see messaging/sender).
      log.warn('sms.tenant_sender_rejected', { to: e164, from: ownNumber, code: res.json.code });
      from = shared;
      res = await postMessage(e164, { from }, body, env, doFetch);
    }
    if (!res.ok) {
      log.warn('sms.failed', { to: e164, status: res.status, error: res.json.message ?? String(res.status) });
      return { id: '', status: 'failed', error: res.json.message ?? String(res.status) };
    }
    const kind = from === shared ? 'shared' : 'tenant';
    log.info('sms.sent', { to: e164, sid: res.json.sid, ms: Date.now() - started, sender: kind });
    return { id: res.json.sid ?? '', status: 'sent', sender: kind, from: toE164(from) };
  } catch (err) {
    log.error('sms.error', { to: e164, err });
    return { id: '', status: 'failed', error: (err as Error).message };
  }
}

type SendFields = { from?: string; messagingServiceSid?: string };

async function postMessage(to: string, sender: SendFields, body: string, env: NodeJS.ProcessEnv, doFetch: typeof fetch): Promise<{ ok: boolean; status: number; json: { sid?: string; message?: string; code?: number; from?: string | null } }> {
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const token = env.TWILIO_AUTH_TOKEN as string;
  const params = new URLSearchParams({ To: to, Body: body });
  if (sender.from) params.set('From', sender.from);
  if (sender.messagingServiceSid) params.set('MessagingServiceSid', sender.messagingServiceSid);
  // Delivery status (and, for a Messaging Service text, the pool number that actually sent it) comes back here: /api/sms/status.
  const callback = smsStatusCallbackUrl(env);
  if (callback) params.set('StatusCallback', callback);
  const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number; from?: string | null };
  return { ok: res.ok, status: res.status, json };
}

/**
 * The webhooks a tenant's Twilio number must carry. SMS is always ours (/api/sms/inbound: STOP/START/HELP, "Reply C", 1-5 ratings,
 * owner YES codes). The Voice URL is ours ONLY on the 'webhook' line (forward / voicemail); on the native ElevenLabs line the number is
 * imported into ElevenLabs, which owns the Voice URL, so it is never touched. `null` when no public base URL is configured.
 */
export function numberWebhooks(env: NodeJS.ProcessEnv = process.env): { SmsUrl: string; SmsMethod: 'POST'; VoiceUrl?: string; VoiceMethod?: 'POST' } | null {
  const base = (env.PUBLIC_BASE_URL || env.APP_URL || env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  const hooks: { SmsUrl: string; SmsMethod: 'POST'; VoiceUrl?: string; VoiceMethod?: 'POST' } = { SmsUrl: `${base}/api/sms/inbound`, SmsMethod: 'POST' };
  if (lineKind(env) === 'webhook') { hooks.VoiceUrl = `${base}/api/voice/incoming`; hooks.VoiceMethod = 'POST'; }
  return hooks;
}

export type NumberWebhookOutcome = 'ok' | 'would_update' | 'updated' | 'not_found' | 'skipped' | 'failed';
export interface NumberWebhookResult { outcome: NumberWebhookOutcome; detail?: string; changed?: string[]; /** The Twilio IncomingPhoneNumber sid (PN...), when the number was found. */ sid?: string }

/**
 * IDEMPOTENT repair of an existing number's webhooks: looks the number up on the account, and updates only the fields that differ
 * (`dryRun` reports `would_update` and changes nothing). Never touches the platform SMS sender, never throws, never logs credentials.
 */
export async function configureNumberWebhooks(
  e164: string,
  opts: { dryRun?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; /** The number is an imported ElevenLabs line: ElevenLabs owns its Voice URL, never write it. */ skipVoiceUrl?: boolean } = {},
): Promise<NumberWebhookResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !env.TWILIO_PHONE_NUMBER) return { outcome: 'skipped', detail: 'Twilio is not configured' };
  if (isMockPoolNumber(e164)) return { outcome: 'skipped', detail: 'mock-pool number: nothing exists at Twilio' };
  if (isPlatformNumber(e164, env)) return { outcome: 'skipped', detail: 'platform SMS sender number: not touched' };
  const want = numberWebhooks(env);
  if (want && opts.skipVoiceUrl) { delete want.VoiceUrl; delete want.VoiceMethod; }
  if (!want) return { outcome: 'skipped', detail: 'no public base URL (PUBLIC_BASE_URL / APP_URL): the webhook addresses are unknown' };
  const auth = { authorization: `Basic ${btoa(`${sid}:${token}`)}` };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers`;
  try {
    const found = await doFetch(`${base}.json?PhoneNumber=${encodeURIComponent(e164)}`, { headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
    if (!found.ok) return { outcome: 'failed', detail: `lookup ${found.status}` };
    const list = (await found.json().catch(() => null)) as { incoming_phone_numbers?: Array<Record<string, unknown>> } | null;
    const hit = (list?.incoming_phone_numbers ?? []).find((n) => n.phone_number === e164 && typeof n.sid === 'string');
    if (!hit) return { outcome: 'not_found', detail: 'the number is not on this Twilio account' };
    const have: Record<string, unknown> = { SmsUrl: hit.sms_url, SmsMethod: hit.sms_method, VoiceUrl: hit.voice_url, VoiceMethod: hit.voice_method };
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(want)) if (typeof v === 'string' && (have[k] ?? '') !== v) patch[k] = v;
    const changed = Object.keys(patch);
    const pnSid = hit.sid as string;
    if (changed.length === 0) return { outcome: 'ok', sid: pnSid };
    if (opts.dryRun) return { outcome: 'would_update', changed, sid: pnSid };
    const res = await doFetch(`${base}/${encodeURIComponent(hit.sid as string)}.json`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(patch),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (!res.ok) { log.warn('number.webhooks_failed', { phone: e164, status: res.status }); return { outcome: 'failed', detail: `update ${res.status}`, changed, sid: pnSid }; }
    log.info('number.webhooks_set', { phone: e164, fields: changed });
    return { outcome: 'updated', changed, sid: pnSid };
  } catch (err) {
    log.error('number.webhooks_error', { phone: e164, err });
    return { outcome: 'failed', detail: (err as Error).message.slice(0, 120) };
  }
}

export type PoolOutcome = 'ok' | 'added' | 'removed' | 'would_add' | 'would_remove' | 'skipped' | 'not_found' | 'failed';
export interface PoolResult { outcome: PoolOutcome; detail?: string }
export interface PoolOptions { dryRun?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; /** The Twilio IncomingPhoneNumber sid (PN...) when the caller already knows it (businesses.twilio_phone_sid). */ phoneSid?: string | null }

/** Why this number must not be touched in the Messaging Service pool (null: it may be). */
function poolSkipReason(e164: string, env: NodeJS.ProcessEnv): string | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) return 'Twilio is not configured';
  if (!messagingServiceSid(env)) return 'TWILIO_MESSAGING_SERVICE_SID is not set';
  if (isMockPoolNumber(e164)) return 'mock-pool number: nothing exists at Twilio';
  if (isPlatformNumber(e164, env)) return 'platform SMS sender number: not touched';
  return null;
}

/**
 * Add the tenant's number to the Messaging Service's SENDER POOL (POST https://messaging.twilio.com/v1/Services/{MG}/PhoneNumbers, PhoneNumberSid=PN...), so its
 * texts are covered by the platform's A2P 10DLC campaign. IDEMPOTENT: the pool is read first (`GET .../PhoneNumbers/{PN}`: 200 = already a member, 404 = not), and a 409 on the
 * add (a racing add, or already a member) counts as success. Never throws; a failure is reported, never fatal (the number stays the tenant's, the repair route retries).
 * The messaging.twilio.com request shapes are UNVERIFIED against a live account (docs/known-limitations.md).
 */
export async function ensureNumberInMessagingService(e164: string, opts: PoolOptions = {}): Promise<PoolResult> {
  const env = opts.env ?? process.env;
  const why = poolSkipReason(e164, env);
  if (why) return { outcome: 'skipped', detail: why };
  const doFetch = opts.fetchImpl ?? fetch;
  const service = messagingServiceSid(env) as string;
  const auth = { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` };
  try {
    const pn = opts.phoneSid && /^PN[0-9a-fA-F]{32}$/.test(opts.phoneSid) ? opts.phoneSid : await lookupIncomingNumberSid(e164, env, doFetch);
    if (!pn) return { outcome: 'not_found', detail: 'the number is not on this Twilio account' };
    const base = `https://messaging.twilio.com/v1/Services/${encodeURIComponent(service)}/PhoneNumbers`;
    const have = await doFetch(`${base}/${encodeURIComponent(pn)}`, { headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
    if (have.ok) return { outcome: 'ok' };
    if (have.status !== 404) return { outcome: 'failed', detail: `pool lookup ${have.status}` };
    if (opts.dryRun) return { outcome: 'would_add' };
    const add = await doFetch(`${base}`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ PhoneNumberSid: pn }),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (add.ok || add.status === 409) { log.info('number.pool_added', { phone: e164, already: add.status === 409 }); return { outcome: add.ok ? 'added' : 'ok' }; }
    log.warn('number.pool_add_failed', { phone: e164, status: add.status });
    return { outcome: 'failed', detail: `pool add ${add.status}` };
  } catch (err) {
    log.error('number.pool_error', { phone: e164, err });
    return { outcome: 'failed', detail: (err as Error).message.slice(0, 120) };
  }
}

/** Remove the number from the Messaging Service pool (before it is released). IDEMPOTENT: not a member (404) is success. Never throws. */
export async function removeNumberFromMessagingService(e164: string, opts: PoolOptions = {}): Promise<PoolResult> {
  const env = opts.env ?? process.env;
  const why = poolSkipReason(e164, env);
  if (why) return { outcome: 'skipped', detail: why };
  const doFetch = opts.fetchImpl ?? fetch;
  const service = messagingServiceSid(env) as string;
  const auth = { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` };
  try {
    const pn = opts.phoneSid && /^PN[0-9a-fA-F]{32}$/.test(opts.phoneSid) ? opts.phoneSid : await lookupIncomingNumberSid(e164, env, doFetch);
    if (!pn) return { outcome: 'ok', detail: 'the number is not on this Twilio account' };
    if (opts.dryRun) return { outcome: 'would_remove' };
    const del = await doFetch(`https://messaging.twilio.com/v1/Services/${encodeURIComponent(service)}/PhoneNumbers/${encodeURIComponent(pn)}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
    if (del.ok || del.status === 404) return { outcome: del.ok ? 'removed' : 'ok' };
    log.warn('number.pool_remove_failed', { phone: e164, status: del.status });
    return { outcome: 'failed', detail: `pool remove ${del.status}` };
  } catch (err) {
    log.error('number.pool_error', { phone: e164, err });
    return { outcome: 'failed', detail: (err as Error).message.slice(0, 120) };
  }
}

async function lookupIncomingNumberSid(e164: string, env: NodeJS.ProcessEnv, doFetch: typeof fetch): Promise<string | null> {
  const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`, {
    headers: { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}` }, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`lookup ${res.status}`);
  const list = (await res.json().catch(() => null)) as { incoming_phone_numbers?: Array<{ sid?: string; phone_number?: string }> } | null;
  return (list?.incoming_phone_numbers ?? []).find((n) => n.phone_number === e164 && typeof n.sid === 'string')?.sid ?? null;
}

export type ProvisionNumberFailureStage = 'not_configured' | 'search' | 'purchase';

/**
 * What provisioning needs from the database to buy a number SAFELY on an account that every tenant shares. Implemented by
 * `createNumberAttemptStore` (src/lib/db/number-attempts.ts); injected so this module stays free of database imports.
 */
export interface NumberAttemptStore {
  id: string;
  isHeld(e164: string): Promise<boolean>;
  claim(e164: string): Promise<boolean>;
  record(e164: string): Promise<void>;
  attempted(e164: string): Promise<boolean>;
  finish(e164: string, outcome: 'bought' | 'refused' | 'unknown'): Promise<void>;
}

export type ProvisionNumberResult =
  | {
    ok: true;
    phone: string;
    mock: boolean;
    /** A real number that THIS call bought (or proved it bought): the only kind a failed save may release again. */
    bought?: boolean;
  }
  | {
    ok: false;
    stage: ProvisionNumberFailureStage;
    /** Operator-readable reason (never contains credentials). */
    error: string;
    /** The candidate the purchase was attempted for, when the outcome could not be settled (operator may need to look). */
    unsettled?: string;
  };

/**
 * May a FAKE number (+1<area>555xxxx, nothing exists at Twilio) be handed to a business? Only in explicit mock mode:
 * outside production AND with no Twilio credentials at all. In production, or whenever Twilio is configured, a failed
 * purchase must fail the provisioning step instead: a fake line would silently take no calls while the business shows 'live'.
 */
export function fakeNumberAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  return env.NODE_ENV !== 'production' && !configured;
}

function mockNumber(areaCode: string): string {
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `+1${areaCode}555${suffix}`;
}

/** Same number, whatever the formatting ("+1 305 777 0100", "13057770100"): compared as E.164, never as raw strings. */
function sameE164(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = toE164(a);
  return x !== null && x === toE164(b);
}

/**
 * Is `number` the platform's own SMS sender? TRUE when TWILIO_PHONE_NUMBER is set and either matches it as E.164 or is
 * itself unparseable (fail closed: with a garbled sender we cannot prove a number is NOT the sender).
 */
export function isPlatformNumber(number: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const platform = (env.TWILIO_PHONE_NUMBER ?? '').trim();
  if (!platform) return false;
  if (toE164(platform) === null) return true;
  return sameE164(platform, number);
}

const RECONCILE_DELAYS_MS = [0, 1_500, 4_000, 8_000];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The FriendlyName a purchase is tagged with: it proves, on the shared account, WHICH attempt bought the number. */
export const attemptFriendlyName = (attemptId: string): string => `recepcionista:${attemptId}`;

/**
 * Buy a local number on the SHARED Twilio account. Never returns a fake number when Twilio is configured or in production
 * (see fakeNumberAllowed): those cases return `{ ok: false }` and the caller must fail the step.
 *
 * Safety on a shared account (docs/review/08 F1): the candidate is skipped when a business already holds it, when it is the
 * platform sender, or when another in-flight attempt reserved it; the attempt is RECORDED before the purchase is sent and
 * the purchase is tagged with a per-attempt FriendlyName. If the purchase answer is ambiguous (timeout, 5xx) the account is
 * checked (with backoff, because Twilio's listing can lag) and a number is adopted ONLY when it is on the account, held by
 * no business, not the platform sender, recorded as this attempt's candidate AND tagged with this attempt's FriendlyName.
 * Without an attempt store there is no proof, so nothing is ever adopted.
 */
export async function provisionNumber(
  areaCode = '305',
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; attempts?: NumberAttemptStore; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ProvisionNumberResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts;
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const configured = Boolean(sid && token && env.TWILIO_PHONE_NUMBER);
  if (!configured) {
    if (fakeNumberAllowed(env)) {
      const phone = mockNumber(areaCode);
      log.warn('number.mock', { phone, area_code: areaCode, reason: 'TWILIO_* incomplete (mock mode, not production)' });
      return { ok: true, phone, mock: true };
    }
    log.error('number.not_configured', { area_code: areaCode, reason: 'TWILIO_* incomplete in production: refusing to issue a fake number' });
    return { ok: false, stage: 'not_configured', error: 'phone provider is not configured' };
  }
  const auth = { authorization: `Basic ${btoa(`${sid}:${token}`)}` };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  let candidate: string | undefined;
  try {
    const search = await doFetch(
      `${base}/AvailablePhoneNumbers/US/Local.json?AreaCode=${encodeURIComponent(areaCode)}&SmsEnabled=true&VoiceEnabled=true`,
      { headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) },
    );
    const list = (await search.json().catch(() => ({}))) as { available_phone_numbers?: Array<{ phone_number?: string }>; message?: string };
    const offered = (list.available_phone_numbers ?? []).map((n) => n.phone_number).filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (!search.ok || offered.length === 0) {
      log.warn('number.search_failed', { area_code: areaCode, status: search.status, error: list.message });
      return { ok: false, stage: 'search', error: search.ok ? `no numbers available in area code ${areaCode}` : `number search failed (${search.status})` };
    }
    // First offered number that is safe to try: not the platform sender, not held by a business, not reserved by another attempt.
    let skippedAll = 0;
    for (const n of offered.slice(0, 10)) {
      if (isPlatformNumber(n, env)) { skippedAll++; continue; }
      if (attempts) {
        if (await attempts.isHeld(n)) { skippedAll++; log.warn('number.candidate_held', { phone: n }); continue; }
        if (!(await attempts.claim(n))) { skippedAll++; log.warn('number.candidate_reserved', { phone: n }); continue; }
      }
      candidate = n;
      break;
    }
    if (!candidate) {
      log.warn('number.no_free_candidate', { area_code: areaCode, offered: offered.length, skipped: skippedAll });
      return { ok: false, stage: 'search', error: `no unreserved numbers available in area code ${areaCode}, try again` };
    }
  } catch (err) {
    log.error('number.search_error', { area_code: areaCode, err });
    return { ok: false, stage: 'search', error: 'number search failed (network)' };
  }
  log.debug('number.candidate', { area_code: areaCode, phone: candidate });
  // Written BEFORE the purchase is sent: if we crash or time out mid-purchase this row says what we were buying.
  if (attempts) {
    try {
      await attempts.record(candidate);
    } catch (err) {
      log.error('number.attempt_record_failed', { phone: candidate, err });
      await attempts.finish(candidate, 'refused').catch(() => undefined);
      return { ok: false, stage: 'purchase', error: 'number purchase not started (could not record the attempt)' };
    }
  }
  const friendlyName = attempts ? attemptFriendlyName(attempts.id) : undefined;
  const hooks = numberWebhooks(env);
  if (!hooks) log.error('number.webhooks_unset', { reason: 'no public base URL (PUBLIC_BASE_URL / APP_URL): the number is bought without SMS/Voice URLs; run POST /api/admin/repair-numbers' });
  let failure = 'number purchase failed';
  try {
    const buy = await doFetch(`${base}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      // The webhooks are set AT purchase: a number without them cannot take STOP / "Reply C" / ratings / owner YES replies (and, on the
      // webhook line, calls). With no public base URL they are skipped (loudly) and `POST /api/admin/repair-numbers` fixes them later.
      body: new URLSearchParams({ PhoneNumber: candidate, ...(friendlyName ? { FriendlyName: friendlyName } : {}), ...(hooks ?? {}) }),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    const bought = (await buy.json().catch(() => ({}))) as { phone_number?: string; message?: string };
    if (buy.ok && bought.phone_number) {
      log.info('number.bought', { phone: bought.phone_number, area_code: areaCode });
      await attempts?.finish(candidate, 'bought').catch(() => undefined);
      return { ok: true, phone: bought.phone_number, mock: false, bought: true };
    }
    failure = `number purchase failed (${buy.status})`;
    log.warn('number.buy_failed', { phone: candidate, status: buy.status, error: bought.message });
    // A 4xx is a definite refusal (nothing was bought); only an ambiguous answer needs the reconciliation below.
    if (buy.status >= 400 && buy.status < 500) {
      await attempts?.finish(candidate, 'refused').catch(() => undefined);
      return { ok: false, stage: 'purchase', error: failure };
    }
  } catch (err) {
    failure = 'number purchase failed (network)';
    log.error('number.buy_error', { phone: candidate, err });
  }
  // Ambiguous outcome: did Twilio create it anyway? Adopt it ONLY with proof it was this attempt's purchase.
  if (!attempts) {
    log.error('number.unsettled', { phone: candidate, reason: 'no attempt store: nothing can be proven, so nothing is adopted' });
    return { ok: false, stage: 'purchase', error: failure, unsettled: candidate };
  }
  for (const delay of RECONCILE_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const found = await doFetch(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(candidate)}`, {
        headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
      if (!found.ok) continue;
      const rows = (await found.json().catch(() => null)) as { incoming_phone_numbers?: Array<{ phone_number?: string; friendly_name?: string; sid?: string }> } | null;
      const hit = (rows?.incoming_phone_numbers ?? []).find((n) => n.phone_number === candidate);
      if (!hit?.phone_number) continue; // not listed (yet): the listing can lag the purchase
      const ours = hit.friendly_name === friendlyName
        && (await attempts.attempted(candidate))
        && !isPlatformNumber(candidate, env)
        && !(await attempts.isHeld(candidate));
      if (!ours) {
        // It exists, but nothing proves this attempt bought it (another tenant's purchase, or a number that is in use): hands off.
        log.error('number.adopt_refused', { phone: candidate, attempt: attempts.id, reason: 'listed on the account but not proven to be this attempt\'s purchase' });
        await attempts.finish(candidate, 'unknown').catch(() => undefined);
        return { ok: false, stage: 'purchase', error: `${failure}; the number is on the account but was not bought by this request, so it was not adopted` };
      }
      log.warn('number.bought_adopted', { phone: hit.phone_number, attempt: attempts.id, reason: 'purchase answer was lost but the number carries this attempt\'s tag' });
      await attempts.finish(candidate, 'bought').catch(() => undefined);
      return { ok: true, phone: hit.phone_number, mock: false, bought: true };
    } catch (err) {
      log.error('number.reconcile_error', { phone: candidate, err });
    }
  }
  log.error('number.unsettled', { phone: candidate, attempt: attempts.id, reason: 'purchase answer lost and the number is not (yet) listed: it may exist; check the Twilio console' });
  await attempts.finish(candidate, 'unknown').catch(() => undefined);
  return { ok: false, stage: 'purchase', error: failure, unsettled: candidate };
}

/** Numbers issued by the mock pool (+1<area>555xxxx): nothing exists at Twilio for them. */
export const isMockPoolNumber = (e164: string): boolean => /^\+1\d{3}555\d{4}$/.test(e164);

export interface ReleaseNumberResult {
  ok: boolean;
  /** Nothing was called: no Twilio credentials, or a mock-pool number. Counts as success. */
  mock?: boolean;
  /** The number was already gone at Twilio (nothing matched / 404). Counts as success. */
  already_released?: boolean;
  /** Twilio incoming-phone-number sid that was deleted. */
  sid?: string;
  /** Refused on purpose (e.g. it is the platform SMS sender number, or another business holds it). Not an error to retry. */
  refused?: string;
  error?: string;
}

/** Default holder check: does a business OTHER than `callerBusinessId` hold this number? (dynamic import keeps this module free of the database at load) */
async function heldByOtherBusiness(e164: string, callerBusinessId: string | null | undefined): Promise<boolean> {
  const { numberHeldByBusiness } = await import('@/lib/db/number-attempts');
  return numberHeldByBusiness(e164, callerBusinessId ?? null);
}

/**
 * Release (delete) a number this platform bought for a tenant. IDEMPOTENT: a number Twilio no longer lists, or a 404
 * on delete, is success. Never throws.
 *
 * Refuses (never calls Twilio) when:
 *  - it is TWILIO_PHONE_NUMBER (the platform's SMS sender), compared as E.164, or that variable is set but unparseable;
 *  - ANOTHER business than `callerBusinessId` holds the number in our database (the Twilio account is shared: a number
 *    that is listed there is not necessarily this caller's; docs/review/08 F1). If that check itself fails, it refuses.
 * Mock-pool numbers (+1<area>555xxxx) succeed without a call. With NO Twilio variables at all (explicit mock mode, not
 * production) a number is "released" without a call; with PARTIAL credentials, or in production, it is an error and the
 * caller must keep its database reference (a real paid number would otherwise be orphaned).
 */
export async function releaseNumber(
  e164: string,
  deps: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    /** The business releasing it (its own row is not a conflict). Omit when no business is releasing: any holder blocks. */
    callerBusinessId?: string | null;
    /** Test seam for the holder check. */
    heldByOther?: (e164: string, callerBusinessId: string | null | undefined) => Promise<boolean>;
  } = {},
): Promise<ReleaseNumberResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const number = (e164 || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(number)) return { ok: false, error: 'not an E.164 number' };
  if (isPlatformNumber(number, env)) {
    log.error('number.release_refused', { phone: number, reason: 'TWILIO_PHONE_NUMBER (platform SMS sender) or unparseable sender' });
    return { ok: false, refused: 'this is the platform SMS sender number (TWILIO_PHONE_NUMBER)' };
  }
  if (isMockPoolNumber(number)) {
    log.warn('number.release_mock', { phone: number, reason: 'mock-pool number' });
    return { ok: true, mock: true };
  }
  try {
    if (await (deps.heldByOther ?? heldByOtherBusiness)(number, deps.callerBusinessId)) {
      log.error('number.release_refused', { phone: number, reason: 'another business holds this number' });
      return { ok: false, refused: 'another business holds this number; it is kept at the provider' };
    }
  } catch (err) {
    log.error('number.release_refused', { phone: number, reason: 'could not verify that no other business holds it', err });
    return { ok: false, refused: 'could not verify that no other business holds this number; nothing was deleted' };
  }
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !env.TWILIO_PHONE_NUMBER) {
    const none = !sid && !token && !env.TWILIO_PHONE_NUMBER;
    if (none && env.NODE_ENV !== 'production') {
      log.warn('number.release_mock', { phone: number, reason: 'no TWILIO_* at all (mock mode, not production)' });
      return { ok: true, mock: true };
    }
    log.error('number.release_unconfigured', { phone: number, reason: 'TWILIO_* incomplete: cannot release a real number; fix the configuration and retry' });
    return { ok: false, error: 'Twilio credentials are incomplete (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER); the number was NOT released and the database reference is kept' };
  }
  const auth = { authorization: `Basic ${btoa(`${sid}:${token}`)}` };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers`;
  try {
    const found = await doFetch(`${base}.json?PhoneNumber=${encodeURIComponent(number)}`, { headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
    if (found.status === 404) return { ok: true, already_released: true };
    if (!found.ok) return { ok: false, error: `lookup ${found.status}` };
    const list = (await found.json().catch(() => null)) as { incoming_phone_numbers?: Array<{ sid?: string; phone_number?: string }> } | null;
    const hit = (list?.incoming_phone_numbers ?? []).find((n) => n.phone_number === number && typeof n.sid === 'string');
    if (!hit?.sid) return { ok: true, already_released: true };
    // Leave the Messaging Service sender pool first (a no-op without TWILIO_MESSAGING_SERVICE_SID). A failure is not fatal: deleting the number removes it from the pool too.
    const pool = await removeNumberFromMessagingService(number, { env, fetchImpl: doFetch, phoneSid: hit.sid });
    if (pool.outcome === 'failed') log.warn('number.release_pool_remove_failed', { phone: number, detail: pool.detail });
    const del = await doFetch(`${base}/${encodeURIComponent(hit.sid)}.json`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) });
    if (del.status === 404) return { ok: true, already_released: true };
    if (!del.ok) {
      log.warn('number.release_failed', { phone: number, status: del.status });
      return { ok: false, error: `delete ${del.status}` };
    }
    log.info('number.released', { phone: number, sid: hit.sid });
    return { ok: true, sid: hit.sid };
  } catch (err) {
    log.error('number.release_error', { phone: number, err });
    return { ok: false, error: (err as Error).message };
  }
}

export function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return raw;
}
