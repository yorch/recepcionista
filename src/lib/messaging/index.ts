/**
 * The only path to an outbound message: send -> log.
 * Logging lives here so "texts sent" on the dashboard is truthful in mock mode
 * too, and so every route reports the same provider status.
 */
import { checkSmsAllowed, countryForBusiness, getBusiness, isOptedOut, logSms, recordSms } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { tzOf } from '@/lib/time';
import { decide, withStopFooter } from '@/lib/messaging/policy';
import { isOwnerNumber, ownerAlertStatus } from '@/lib/messaging/owner';
import { ownerVerificationText } from '@/lib/messaging/owner-verify';
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

export type BlockedStatus =
  | 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent' | 'blocked_cap' | 'blocked_owner_unverified';

export interface SendAndLogOutput {
  sms: SmsLog;
  result: SendSmsResult;
  /** Set when compliance policy skipped the send; the skip is logged in sms_log with this status. */
  blocked?: BlockedStatus;
}

/** Count a sent text against the plan; a metering failure must never turn a delivered text into an error. */
export async function meterSms(businessId: string, n = 1): Promise<void> {
  try {
    await recordSms(businessId, n);
  } catch (err) {
    log.warn('usage.record_failed', { business: businessId, err });
  }
}

/** Status from the provider is already one of sent|mock|failed — pass it through. */
export async function sendAndLog(input: SendAndLogInput): Promise<SendAndLogOutput> {
  const to = normalizePhone(input.to);
  const started = Date.now();

  const business = await getBusiness(input.business_id);
  const country = countryForBusiness(business);
  const e164 = toE164(to, country);
  const isOwnerRecipient = business ? isOwnerNumber(business, to, country) : false;

  const blockedResult = async (reason: BlockedStatus, basis: string | null): Promise<SendAndLogOutput> => {
    log.info('send.blocked', { business: input.business_id, kind: input.kind, reason });
    const sms = await logSms({
      business_id: input.business_id,
      to_phone: to,
      body: input.body,
      kind: input.kind,
      booking_id: input.booking_id ?? null,
      provider_id: null,
      status: reason,
      consent_basis: basis,
    }, { country });
    return { sms, result: { id: '', status: 'failed', error: reason }, blocked: reason };
  };

  // Owner alerts only ever go to a number the owner proved they control (or, during rollout, a grandfathered one).
  if (input.kind === 'owner_alert' && isOwnerRecipient && business && ownerAlertStatus(business) !== 'ok') {
    return blockedResult('blocked_owner_unverified', input.consent_basis ?? null);
  }

  const decision = decide({
    kind: input.kind,
    isOwnerRecipient,
    optedOut: await isOptedOut(input.business_id, to, country),
    consentBasis: input.consent_basis,
    timezone: tzOf(business),
    now: input.now ?? new Date(),
  });

  if (!decision.allow) return blockedResult(decision.reason, input.consent_basis ?? null);

  // Plan cap: customer-facing texts stop at the cap; owner alerts are exempt from blocking (but are still counted).
  const ownerClass = decision.consent_basis === 'owner_alert';
  if (!ownerClass) {
    const allowed = await checkSmsAllowed(input.business_id);
    if (!allowed.ok) {
      log.warn('send.over_cap', { business: input.business_id, reason: allowed.reason, used: allowed.used, cap: allowed.cap });
      return blockedResult('blocked_cap', decision.consent_basis);
    }
  }

  const text = decision.footer ? withStopFooter(input.body) : input.body;
  // The country allow-list does not apply to the owner's verified number (proven by possession).
  const result = await sendSms(e164 ?? to, text, { anyCountry: ownerClass });

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
    await meterSms(input.business_id);
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
  }, { country });

  log.debug('send.logged', { sms: sms.id, status: sms.status });
  return { sms, result };
}

/**
 * The owner-phone verification code. Not subject to the plan cap (a blocked code would lock an owner out of
 * verifying) but counted; the destination country allow-list DOES apply (the number is not yet proven).
 * The recipient must be a number that has not opted out of this business's texts.
 */
export async function sendOwnerVerificationCode(businessId: string, phoneE164: string, code: string): Promise<SendAndLogOutput> {
  const business = await getBusiness(businessId);
  const country = countryForBusiness(business);
  if (await isOptedOut(businessId, phoneE164, country)) {
    const sms = await logSms({
      business_id: businessId, to_phone: phoneE164, body: '[verification code withheld]', kind: 'other',
      booking_id: null, provider_id: null, status: 'blocked_opt_out', consent_basis: 'owner_verification',
    }, { country });
    return { sms, result: { id: '', status: 'failed', error: 'blocked_opt_out' }, blocked: 'blocked_opt_out' };
  }
  const result = await sendSms(phoneE164, ownerVerificationText(code)); // fixed template: nothing tenant-controlled
  if (result.status !== 'failed') await meterSms(businessId);
  const sms = await logSms({
    business_id: businessId, to_phone: phoneE164,
    // The code itself is not retained in the log.
    body: '[owner verification code]', kind: 'other', booking_id: null,
    provider_id: result.id || null, status: mapStatus(result.status), consent_basis: 'owner_verification',
  }, { country });
  return { sms, result };
}

function mapStatus(status: SendSmsResult['status']): SmsLog['status'] {
  if (status === 'sent') return 'sent';
  if (status === 'mock') return 'mock';
  return 'failed';
}
