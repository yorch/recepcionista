/**
 * The only path to an outbound message: send -> log.
 * Logging lives here so "texts sent" on the dashboard is truthful in mock mode
 * too, and so every route reports the same provider status.
 */
import { getBusiness, isOptedOut, logSms } from '@/lib/db';
import { phoneKey } from '@/lib/format';
import { tzOf } from '@/lib/time';
import { decide, withStopFooter } from '@/lib/messaging/policy';
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
  /** Why this text is allowed (see messaging/policy). Required for gratitude / review_request. */
  consent_basis?: string | null;
  /** Test seam. */
  now?: Date;
}

export interface SendAndLogOutput {
  sms: SmsLog;
  result: SendSmsResult;
  /** Set when compliance policy skipped the send; the skip is logged in sms_log with this status. */
  blocked?: 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent';
}

/** Status from the provider is already one of sent|mock|failed — pass it through. */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogOutput> {
  const to = normalizePhone(input.to);
  const started = Date.now();

  const business = await getBusiness(input.business_id);
  const ownerKey = phoneKey(business?.owner_phone);
  const decision = decide({
    kind: input.kind,
    isOwnerRecipient: Boolean(ownerKey) && ownerKey === phoneKey(to),
    optedOut: await isOptedOut(input.business_id, to),
    consentBasis: input.consent_basis,
    timezone: tzOf(business),
    now: input.now ?? new Date(),
  });

  if (!decision.allow) {
    log.info('send.blocked', { business: input.business_id, kind: input.kind, reason: decision.reason });
    const sms = await logSms({
      business_id: input.business_id,
      to_phone: to,
      body: input.body,
      kind: input.kind,
      booking_id: input.booking_id ?? null,
      provider_id: null,
      status: decision.reason,
      consent_basis: input.consent_basis ?? null,
    });
    return { sms, result: { id: '', status: 'failed', error: decision.reason }, blocked: decision.reason };
  }

  const text = decision.footer ? withStopFooter(input.body) : input.body;
  const result = await sendSms(to, text);

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
    body: text,
    kind: input.kind,
    booking_id: input.booking_id ?? null,
    provider_id: result.id || null,
    status: mapStatus(result.status),
    consent_basis: decision.consent_basis,
  });

  log.debug('send.logged', { sms: sms.id, status: sms.status });
  return { sms, result };
}

function mapStatus(status: SendSmsResult['status']): SmsLog['status'] {
  if (status === 'sent') return 'sent';
  if (status === 'mock') return 'mock';
  return 'failed';
}
