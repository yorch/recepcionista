/**
 * SMS adapter. Real Twilio when credentials exist; otherwise logs to the local
 * sms_log so the dashboard and demo still show a message being "sent".
 */
import { logger } from '@/lib/log';

export interface SendSmsResult { id: string; status: 'sent' | 'mock' | 'failed'; error?: string }

const log = logger('twilio');

export const hasTwilio = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

const MOCK_DELAY_MS = 60;

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const e164 = normalizePhone(to);
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
      { headers: auth },
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

export function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return raw;
}
