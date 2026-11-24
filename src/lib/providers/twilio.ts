/**
 * SMS adapter. Real Twilio when credentials exist; otherwise logs to the local
 * sms_log so the dashboard and demo still show a message being "sent".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { insecureDevAllowed } from '@/lib/auth';
import { validateRecipient } from '@/lib/messaging/recipient';
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
    await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
    log.warn('sms.mock', { to: e164, reason: 'TWILIO_* incomplete', chars: body.length });
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

export type ProvisionNumberFailureStage = 'not_configured' | 'search' | 'purchase';

export type ProvisionNumberResult =
  | { ok: true; phone: string; mock: boolean }
  | {
    ok: false;
    stage: ProvisionNumberFailureStage;
    /** Operator-readable reason (never contains credentials). */
    error: string;
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

/**
 * Buy a local number. Never returns a fake number when Twilio is configured or in production (see fakeNumberAllowed):
 * those cases return `{ ok: false }` and the caller must fail the step. If the purchase request itself fails ambiguously
 * (timeout, 5xx) the account is checked for the candidate number first, so a purchase that actually went through is
 * adopted instead of being bought again on retry.
 */
export async function provisionNumber(
  areaCode = '305',
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<ProvisionNumberResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
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
    candidate = list.available_phone_numbers?.[0]?.phone_number;
    if (!search.ok || !candidate) {
      log.warn('number.search_failed', { area_code: areaCode, status: search.status, error: list.message });
      return { ok: false, stage: 'search', error: search.ok ? `no numbers available in area code ${areaCode}` : `number search failed (${search.status})` };
    }
  } catch (err) {
    log.error('number.search_error', { area_code: areaCode, err });
    return { ok: false, stage: 'search', error: 'number search failed (network)' };
  }
  log.debug('number.candidate', { area_code: areaCode, phone: candidate });
  let failure = 'number purchase failed';
  try {
    const buy = await doFetch(`${base}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumber: candidate }),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    const bought = (await buy.json().catch(() => ({}))) as { phone_number?: string; message?: string };
    if (buy.ok && bought.phone_number) {
      log.info('number.bought', { phone: bought.phone_number, area_code: areaCode });
      return { ok: true, phone: bought.phone_number, mock: false };
    }
    failure = `number purchase failed (${buy.status})`;
    log.warn('number.buy_failed', { phone: candidate, status: buy.status, error: bought.message });
    // A 4xx is a definite refusal (nothing was bought); only an ambiguous answer needs the reconciliation below.
    if (buy.status >= 400 && buy.status < 500) return { ok: false, stage: 'purchase', error: failure };
  } catch (err) {
    failure = 'number purchase failed (network)';
    log.error('number.buy_error', { phone: candidate, err });
  }
  // Ambiguous outcome: did Twilio create it anyway? Adopt it rather than leave an orphan that a retry would duplicate.
  try {
    const found = await doFetch(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(candidate)}`, {
      headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (found.ok) {
      const rows = (await found.json().catch(() => null)) as { incoming_phone_numbers?: Array<{ phone_number?: string }> } | null;
      const hit = (rows?.incoming_phone_numbers ?? []).find((n) => n.phone_number === candidate);
      if (hit?.phone_number) {
        log.warn('number.bought_adopted', { phone: hit.phone_number, reason: 'purchase answer was lost but the number exists' });
        return { ok: true, phone: hit.phone_number, mock: false };
      }
    }
  } catch (err) {
    log.error('number.reconcile_error', { phone: candidate, err });
  }
  return { ok: false, stage: 'purchase', error: failure };
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
  /** Refused on purpose (e.g. it is the platform SMS sender number). Not an error to retry. */
  refused?: string;
  error?: string;
}

/**
 * Release (delete) a number this platform bought for a tenant. IDEMPOTENT: a number Twilio no longer lists, or a 404
 * on delete, is success. Mock mode (no TWILIO_* credentials, or a mock-pool number) calls nothing and succeeds.
 * Never releases TWILIO_PHONE_NUMBER (the platform's own SMS sender). The caller must have checked that no other
 * business uses the number. Never throws.
 */
export async function releaseNumber(
  e164: string,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<ReleaseNumberResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const number = (e164 || '').trim();
  if (!/^\+[1-9]\d{6,14}$/.test(number)) return { ok: false, error: 'not an E.164 number' };
  if (env.TWILIO_PHONE_NUMBER && env.TWILIO_PHONE_NUMBER.trim() === number) {
    log.error('number.release_refused', { phone: number, reason: 'TWILIO_PHONE_NUMBER (platform SMS sender)' });
    return { ok: false, refused: 'this is the platform SMS sender number (TWILIO_PHONE_NUMBER)' };
  }
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !env.TWILIO_PHONE_NUMBER || isMockPoolNumber(number)) {
    log.warn('number.release_mock', { phone: number, reason: isMockPoolNumber(number) ? 'mock-pool number' : 'TWILIO_* incomplete' });
    return { ok: true, mock: true };
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
