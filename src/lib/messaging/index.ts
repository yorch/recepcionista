/**
 * The only path to an outbound message: send -> log.
 * Logging lives here so "texts sent" on the dashboard is truthful in mock mode
 * too, and so every route reports the same provider status.
 */
import { logSms } from '@/lib/db';
import { logger } from '@/lib/log';
import { normalizePhone, sendSms } from '@/lib/providers/twilio';
import type { SendSmsResult } from '@/lib/providers/twilio';
import type { SmsLog } from '@/lib/types';

const log = logger('sms');

export interface SendAndLogInput {
  business_id: string;
  to: string;
  body: string;
  kind: SmsLog['kind'];
  /** Set whenever the message is about a specific job, so dedupe can be exact. */
  booking_id?: string | null;
}

export interface SendAndLogOutput {
  sms: SmsLog;
  result: SendSmsResult;
}

/** Status from the provider is already one of sent|mock|failed — pass it through. */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogOutput> {
  const to = normalizePhone(input.to);
  const started = Date.now();
  const result = await sendSms(to, input.body);

  if (result.status === 'failed') {
    log.warn('send.failed', {
      business: input.business_id,
      kind: input.kind,
      to,
      ms: Date.now() - started,
      error: result.error ?? 'unknown error',
    });
  } else {
    log.info('send', {
      business: input.business_id,
      kind: input.kind,
      to,
      status: result.status,
      booking: input.booking_id ?? null,
      ms: Date.now() - started,
    });
  }

  const sms = await logSms({
    business_id: input.business_id,
    to_phone: to,
    body: input.body,
    kind: input.kind,
    booking_id: input.booking_id ?? null,
    provider_id: result.id || null,
    status: mapStatus(result.status),
  });

  log.debug('send.logged', { sms: sms.id, status: sms.status });
  return { sms, result };
}

function mapStatus(status: SendSmsResult['status']): SmsLog['status'] {
  if (status === 'sent') return 'sent';
  if (status === 'mock') return 'mock';
  return 'failed';
}
