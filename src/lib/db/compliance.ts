/**
 * Compliance helpers: SMS opt-out (STOP), data retention and customer erasure.
 * Phone numbers are matched on their last 10 digits (`phoneKey`), the same normalisation the
 * rest of the app uses, so "+1 (305) 555-0142" and "3055550142" are the same person.
 */
import { prisma } from './client';
import { phoneKey } from '@/lib/format';
import { logger } from '@/lib/log';
import type { SmsOptOut } from '@/lib/types';

const log = logger('db.compliance');

/** Placeholders written into NOT NULL booking columns when PII is removed. */
export const REDACTED_NAME = '[redacted]';
export const REDACTED_PHONE = '';

function toOptOut(row: { id: string; businessId: string; phoneKey: string; optedOutAt: Date; source: string }): SmsOptOut {
  return {
    id: row.id,
    business_id: row.businessId,
    phone_key: row.phoneKey,
    opted_out_at: row.optedOutAt.toISOString(),
    source: row.source,
  };
}

/** True when this number has opted out of texts from this business. Unparseable numbers return false. */
export async function isOptedOut(businessId: string, phone: string | null | undefined): Promise<boolean> {
  const key = phoneKey(phone);
  if (!key) return false;
  const row = await prisma.smsOptOut.findUnique({
    where: { businessId_phoneKey: { businessId, phoneKey: key } },
    select: { id: true },
  });
  return row !== null;
}

/** Record a STOP. Idempotent: the first opt-out time and source are kept. */
export async function recordOptOut(businessId: string, phone: string, source = 'stop_keyword'): Promise<SmsOptOut> {
  const key = phoneKey(phone);
  if (!key) throw new Error('recordOptOut: invalid phone');
  const row = await prisma.smsOptOut.upsert({
    where: { businessId_phoneKey: { businessId, phoneKey: key } },
    update: {},
    create: { businessId, phoneKey: key, source },
  });
  log.info('sms.opt_out', { business: businessId, source });
  return toOptOut(row);
}

/** Record a START / explicit re-opt-in by removing the suppression. Returns true if a row was removed. */
export async function recordOptIn(businessId: string, phone: string): Promise<boolean> {
  const key = phoneKey(phone);
  if (!key) throw new Error('recordOptIn: invalid phone');
  const res = await prisma.smsOptOut.deleteMany({ where: { businessId, phoneKey: key } });
  if (res.count > 0) log.info('sms.opt_in', { business: businessId });
  return res.count > 0;
}

export interface PurgeCounts {
  calls: number;
  sms_logs: number;
  briefings: number;
  bookings_anonymized: number;
}

/**
 * Enforce each business's `retention_days`, atomically:
 *  - calls (and so transcripts, summaries, recording URLs), sms_log rows and briefings older
 *    than the window are DELETED;
 *  - bookings whose scheduled_at is older than the window keep their financial fields
 *    (price, deposit, status, times, service) but lose customer name/phone/address
 *    (`anonymized_at` is set; name becomes '[redacted]', phone '').
 * `sms_opt_outs` are never purged: forgetting a STOP would re-enable texting that person.
 * Idempotent; run it from a daily job. Does not delete provider-side recordings.
 */
export async function purgeExpiredData(now: Date = new Date()): Promise<PurgeCounts> {
  // Cutoff per business, evaluated in UTC (timestamp columns hold UTC wall time).
  const [bookings, calls, sms, briefings] = await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "bookings" bk
         SET "customer_name" = ${REDACTED_NAME}, "customer_phone" = ${REDACTED_PHONE}, "address" = NULL,
             "anonymized_at" = (${now}::timestamptz AT TIME ZONE 'UTC')
        FROM "businesses" b
       WHERE bk."business_id" = b."id" AND bk."anonymized_at" IS NULL
         AND bk."scheduled_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`,
    prisma.$executeRaw`
      DELETE FROM "calls" c USING "businesses" b
       WHERE c."business_id" = b."id"
         AND c."started_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`,
    prisma.$executeRaw`
      DELETE FROM "sms_log" s USING "businesses" b
       WHERE s."business_id" = b."id"
         AND s."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`,
    prisma.$executeRaw`
      DELETE FROM "briefings" br USING "businesses" b
       WHERE br."business_id" = b."id"
         AND br."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`,
  ]);
  const counts: PurgeCounts = { calls, sms_logs: sms, briefings, bookings_anonymized: bookings };
  log.info('retention.purged', { ...counts });
  return counts;
}

export interface EraseCounts {
  calls: number;
  sms_logs: number;
  bookings_anonymized: number;
}

/**
 * Right-to-erasure for one customer of one business, matched on the phone's last 10 digits:
 * deletes their calls (transcripts, recordings URLs) and SMS log rows, and anonymises their
 * bookings (also those created from their calls) while keeping financial fields.
 * The SMS opt-out row, if any, is deliberately kept. Throws on a phone with fewer than 7 digits
 * so a typo cannot match broadly. Atomic.
 */
export async function eraseCustomerData(businessId: string, phone: string): Promise<EraseCounts> {
  const key = phoneKey(phone);
  if (!key || key.length < 7) throw new Error('eraseCustomerData: phone must have at least 7 digits');
  // [^0-9] (not \D) so the tagged template needs no escapes.
  const [bookings, sms, calls] = await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "bookings"
         SET "customer_name" = ${REDACTED_NAME}, "customer_phone" = ${REDACTED_PHONE}, "address" = NULL,
             "anonymized_at" = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE "business_id" = ${businessId} AND "anonymized_at" IS NULL
         AND (right(regexp_replace("customer_phone", '[^0-9]', '', 'g'), 10) = ${key}
              OR "call_id" IN (SELECT "id" FROM "calls" WHERE "business_id" = ${businessId}
                                 AND right(regexp_replace(coalesce("caller_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}))`,
    prisma.$executeRaw`
      DELETE FROM "sms_log"
       WHERE "business_id" = ${businessId}
         AND right(regexp_replace("to_phone", '[^0-9]', '', 'g'), 10) = ${key}`,
    prisma.$executeRaw`
      DELETE FROM "calls"
       WHERE "business_id" = ${businessId}
         AND right(regexp_replace(coalesce("caller_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}`,
  ]);
  const counts: EraseCounts = { calls, sms_logs: sms, bookings_anonymized: bookings };
  log.info('customer.erased', { business: businessId, ...counts });
  return counts;
}
