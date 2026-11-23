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

export async function provisionNumber(areaCode = '305'): Promise<{ phone: string; mock: boolean }> {
  if (!hasTwilio()) {
    const suffix = String(Math.floor(Math.random() * 9000) + 1000);
    const phone = `+1${areaCode}555${suffix}`;
    log.warn('number.mock', { phone, area_code: areaCode, reason: 'TWILIO_* incomplete' });
    return { phone, mock: true };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const token = process.env.TWILIO_AUTH_TOKEN as string;
  const auth = { authorization: `Basic ${btoa(`${sid}:${token}`)}` };
  try {
    const search = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&SmsEnabled=true&VoiceEnabled=true`,
      { headers: auth, signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS) },
    );
    const list = await search.json();
    const candidate = list.available_phone_numbers?.[0]?.phone_number;
    if (!candidate) {
      log.warn('number.search_empty', { area_code: areaCode, status: search.status });
      return provisionNumberFallback(areaCode);
    }
    log.debug('number.candidate', { area_code: areaCode, phone: candidate });
    const buy = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumber: candidate }),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    const bought = await buy.json();
    if (!buy.ok) {
      log.warn('number.buy_failed', { phone: candidate, status: buy.status, error: bought.message });
      return provisionNumberFallback(areaCode);
    }
    log.info('number.bought', { phone: bought.phone_number, area_code: areaCode });
    return { phone: bought.phone_number, mock: false };
  } catch (err) {
    log.error('number.error', { area_code: areaCode, err });
    return provisionNumberFallback(areaCode);
  }
}

function provisionNumberFallback(areaCode: string) {
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  const phone = `+1${areaCode}555${suffix}`;
  log.warn('number.fallback_mock', { phone });
  return { phone, mock: true };
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
