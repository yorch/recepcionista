/**
 * The only path to an outbound message: send -> log.
 * Logging lives here so "texts sent" on the dashboard is truthful in mock mode
 * too, and so every route reports the same provider status.
 */
import { logSms } from '@/lib/db';
import { normalizePhone, sendSms } from '@/lib/providers/twilio';
import type { SendSmsResult } from '@/lib/providers/twilio';
import type { SmsLog } from '@/lib/types';

export interface SendAndLogInput {
  business_id: string;
  to: string;
  body: string;
  kind: SmsLog['kind'];
}

export interface SendAndLogOutput {
  sms: SmsLog;
  result: SendSmsResult;
}

/** Status from the provider is already one of sent|mock|failed — pass it through. */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogOutput> {
  const to = normalizePhone(input.to);
  const result = await sendSms(to, input.body);

  if (result.status === 'failed') {
    console.warn(`[sms] failed -> ${to}: ${result.error ?? 'unknown error'}`);
  }

  const sms = await logSms({
    business_id: input.business_id,
    to_phone: to,
    body: input.body,
    kind: input.kind,
    provider_id: result.id || null,
    status: mapStatus(result.status),
  });

  return { sms, result };
}

function mapStatus(status: SendSmsResult['status']): SmsLog['status'] {
  if (status === 'sent') return 'sent';
  if (status === 'mock') return 'mock';
  return 'failed';
}
