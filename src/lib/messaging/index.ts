/**
 * The only path to an outbound message: render -> send -> log.
 * Keeping logging here means the dashboard's "texts sent" is always truthful,
 * including in mock mode.
 */
import { getBusiness, logSms } from '@/lib/db';
import { sendSms as sendSmsProvider, normalizePhone } from '@/lib/providers/twilio';
import type { SmsLog } from '@/lib/types';

export interface SendAndLogInput {
  business_id: string;
  to: string;
  body: string;
  kind: SmsLog['kind'];
}

export interface SendAndLogResult {
  sms: SmsLog;
  status: 'sent' | 'mock' | 'failed';
  provider_id?: string;
  error?: string;
}

export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogResult> {
  const to = normalizePhone(input.to);
  const result = await sendSmsProvider(to, input.body);

  const sms = logSms({
    business_id: input.business_id,
    to_phone: to,
    body: input.body,
    kind: input.kind,
    provider_id: result.id || null,
    status: result.status,
  });

  if (!input.business_id || !getBusiness(input.business_id)) {
    // The log row is still useful for the demo, but flag the bad reference.
    console.warn(`[sms] unknown business ${input.business_id}`);
  }

  return { sms, status: result.status, provider_id: result.id, error: result.error };
}

export function recentFor(bookingPhone: string, businessId: string, windowMs = 120_000) {
  void bookingPhone;
  void businessId;
  void windowMs;
  return null;
}
