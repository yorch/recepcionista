/**
 * The only path to an outbound message: send -> log.
 * Logging lives here so "texts sent" on the dashboard is truthful in mock mode
 * too, and so every route reports the same provider status.
 */
import { countryForBusiness, getBusiness, isOptedOut, logSms, recordSms, releaseSmsReservation, reserveSms } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { tzOf } from '@/lib/time';
import { decide, smsSegments, withStopFooter } from '@/lib/messaging/policy';
import { isOwnerNumber, ownerAlertStatus } from '@/lib/messaging/owner';
import { forwardVerificationText, ownerVerificationText, type VerifyPurpose } from '@/lib/messaging/owner-verify';
import { smsDelivered } from '@/lib/messaging/delivery';
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
  /** Longest text INCLUDING the STOP footer (default 300). Owner-typed texts raise it so their words are never cut. */
  max_chars?: number;
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

/**
 * Count sent SMS SEGMENTS against the plan (pass `smsSegments(text)`; one segment by default); a metering failure must
 * never turn a delivered text into an error.
 */
export async function meterSms(businessId: string, segments = 1): Promise<void> {
  try {
    await recordSms(businessId, Math.max(1, Math.floor(segments)));
  } catch (err) {
    log.warn('usage.record_failed', { business: businessId, err });
  }
}

/**
 * The provider ACCEPTED the text but writing the sms_log row failed. The text is out (and the plan counter was charged): callers that must not
 * treat that as "not sent" (owner voice replies) catch this and carry the provider result on.
 */
export class SentNotLoggedError extends Error {
  constructor(readonly result: SendSmsResult, readonly cause: unknown) {
    super(`sms sent (${result.status}) but not logged: ${(cause as Error | undefined)?.message ?? 'unknown'}`);
    this.name = 'SentNotLoggedError';
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

  // The exact text that goes out (with the STOP footer): its segment count is what is metered and what the cap is checked against.
  const text = decision.footer ? withStopFooter(input.body, input.max_chars ?? 300) : input.body;
  const segments = Math.max(1, smsSegments(text));

  // Plan cap: customer-facing texts stop at the cap (a text that would not fit in what is left is blocked). The segments are
  // RESERVED atomically before sending (concurrent sends can never overshoot the cap) and refunded if the send fails.
  // Owner alerts are exempt from blocking (but are still counted, after sending; see voice/owner-alert for their own budget).
  const ownerClass = decision.consent_basis === 'owner_alert';
  let reservation: { period_start: string } | null = null;
  if (!ownerClass) {
    const reserved = await reserveSms(input.business_id, segments, new Date());
    if (!reserved.ok) {
      log.warn('send.over_cap', { business: input.business_id, reason: reserved.reason, used: reserved.used, cap: reserved.cap, segments });
      return blockedResult('blocked_cap', decision.consent_basis);
    }
    reservation = { period_start: reserved.period_start as string };
  }
  const refund = async () => { if (reservation) await releaseSmsReservation(input.business_id, segments, reservation.period_start); };

  // The country allow-list does not apply to the owner's verified number (proven by possession).
  let result: SendSmsResult;
  try {
    result = await sendSms(e164 ?? to, text, { anyCountry: ownerClass });
  } catch (err) {
    await refund();
    throw err;
  }

  // An undelivered text (provider failure, or a mock in production) burns no plan quota: the reservation is refunded.
  if (!smsDelivered(result.status)) {
    await refund();
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
    if (!reservation) await meterSms(input.business_id, segments); // owner alerts: counted after the send
  }

  let sms: SmsLog;
  try {
    sms = await logSms({
      business_id: input.business_id,
      to_phone: to,
      body: text,
      kind: input.kind,
      booking_id: input.booking_id ?? null,
      provider_id: result.id || null,
      status: mapStatus(result.status),
      consent_basis: decision.consent_basis,
    }, { country });
  } catch (err) {
    if (!smsDelivered(result.status)) throw err; // nothing went out: an ordinary failure
    log.error('send.log_failed_after_send', { business: input.business_id, kind: input.kind, err });
    throw new SentNotLoggedError(result, err);
  }

  log.debug('send.logged', { sms: sms.id, status: sms.status });
  return { sms, result };
}

/**
 * The owner-phone verification code. Not subject to the plan cap (a blocked code would lock an owner out of
 * verifying) but counted; the destination country allow-list DOES apply (the number is not yet proven).
 * The recipient must be a number that has not opted out of this business's texts.
 */
export async function sendOwnerVerificationCode(
  businessId: string, phoneE164: string, code: string, purpose: VerifyPurpose = 'owner-phone',
): Promise<SendAndLogOutput> {
  const business = await getBusiness(businessId);
  const country = countryForBusiness(business);
  if (await isOptedOut(businessId, phoneE164, country)) {
    const sms = await logSms({
      business_id: businessId, to_phone: phoneE164, body: '[verification code withheld]', kind: 'other',
      booking_id: null, provider_id: null, status: 'blocked_opt_out', consent_basis: 'owner_verification',
    }, { country });
    return { sms, result: { id: '', status: 'failed', error: 'blocked_opt_out' }, blocked: 'blocked_opt_out' };
  }
  const verificationText = purpose === 'forward-number' ? forwardVerificationText(code) : ownerVerificationText(code); // fixed template: nothing tenant-controlled
  const result = await sendSms(phoneE164, verificationText);
  if (smsDelivered(result.status)) await meterSms(businessId, smsSegments(verificationText));
  const sms = await logSms({
    business_id: businessId, to_phone: phoneE164,
    // The code itself is not retained in the log.
    body: purpose === 'forward-number' ? '[forward number verification code]' : '[owner verification code]', kind: 'other', booking_id: null,
    provider_id: result.id || null, status: mapStatus(result.status), consent_basis: 'owner_verification',
  }, { country });
  return { sms, result };
}

function mapStatus(status: SendSmsResult['status']): SmsLog['status'] {
  if (status === 'sent') return 'sent';
  if (status === 'mock') return 'mock';
  return 'failed';
}
