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

export interface SendSmsResult { id: string; status: 'sent' | 'mock' | 'failed'; error?: string }

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

export async function sendSms(to: string, body: string, opts: { anyCountry?: boolean } = {}): Promise<SendSmsResult> {
  // Single enforcement point for E.164 + SMS_ALLOWED_COUNTRY_CODES: every text
  // (tools, confirmations, payment links, alerts, routes) ends up here.
  const check = validateRecipient(to, undefined, { anyCountry: opts.anyCountry });
  if (!check.ok) {
    log.warn('sms.recipient_rejected', { reason: check.error });
    return { id: '', status: 'failed', error: check.error };
  }
  const e164 = check.to;
  if (!hasTwilio()) {
    if (!mockSmsAllowed()) {
      // Production without a complete Twilio config: nothing is sent, so this is a FAILURE, never a mock "success".
      log.error('sms.not_configured', { to: e164, reason: 'TWILIO_* incomplete in production' });
      return { id: '', status: 'failed', error: SMS_PROVIDER_NOT_CONFIGURED };
    }
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    log.warn('sms.mock', { to: e164, reason: 'TWILIO_* incomplete', chars: body.length });
    // The body (it can hold a verification code or a payment link) is only echoed to the console outside production.
    console.log(`[sms:mock] -> ${e164}\n${body}\n`);
    return { id: `mock_${Date.now()}`, status: 'mock' };
  }
  try {
    const started = Date.now();
    const sid = process.env.TWILIO_ACCOUNT_SID as string;
    const token = process.env.TWILIO_AUTH_TOKEN as string;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: e164,
          From: process.env.TWILIO_PHONE_NUMBER as string,
          Body: body,
        }),
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      log.warn('sms.failed', { to: e164, status: res.status, error: json.message ?? String(res.status) });
      return { id: '', status: 'failed', error: json.message ?? String(res.status) };
    }
    log.info('sms.sent', { to: e164, sid: json.sid, ms: Date.now() - started });
    return { id: json.sid, status: 'sent' };
  } catch (err) {
    log.error('sms.error', { to: e164, err });
    return { id: '', status: 'failed', error: (err as Error).message };
  }
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
