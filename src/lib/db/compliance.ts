/**
 * Compliance helpers: SMS opt-out (STOP), data retention and customer erasure.
 * Phone numbers are matched on their last 10 digits (`phoneKey`), the same normalisation the
 * rest of the app uses, so "+1 (305) 555-0142" and "3055550142" are the same person.
 */
import { prisma } from './client';
import { phoneKey } from '@/lib/format';
import { logger } from '@/lib/log';
import { removeBriefingAudio } from '@/lib/briefing/audio-files';
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
  /** Briefing audio files removed from disk (0 on a dry run). */
  audio_files?: number;
}

/**
 * What a purge would delete right now, without deleting anything (the startup log line and the admin
 * dry-run endpoint use it). Same cutoffs as `purgeExpiredData`.
 */
export async function previewExpiredData(now: Date = new Date()): Promise<PurgeCounts> {
  const one = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  const [bookings, calls, sms, briefings] = await Promise.all([
    one(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "bookings" bk JOIN "businesses" b ON bk."business_id" = b."id"
       WHERE bk."anonymized_at" IS NULL
         AND bk."scheduled_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`),
    one(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "calls" c JOIN "businesses" b ON c."business_id" = b."id"
       WHERE c."started_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`),
    one(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "sms_log" s JOIN "businesses" b ON s."business_id" = b."id"
       WHERE s."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`),
    one(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "briefings" br JOIN "businesses" b ON br."business_id" = b."id"
       WHERE br."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`),
  ]);
  return { calls, sms_logs: sms, briefings, bookings_anonymized: bookings };
}

/**
 * Enforce each business's `retention_days`, atomically:
 *  - calls (and so transcripts, summaries, recording URLs), sms_log rows and briefings older
 *    than the window are DELETED, and the audio file of every deleted briefing is removed from disk;
 *  - bookings whose scheduled_at is older than the window keep their financial fields
 *    (price, deposit, status, times, service) but lose customer name/phone/address
 *    (`anonymized_at` is set; name becomes '[redacted]', phone '').
 * `sms_opt_outs` are never purged: forgetting a STOP would re-enable texting that person.
 * Idempotent. With `{ dryRun: true }` nothing is changed and the counts say what WOULD be purged.
 * Does not delete provider-side recordings.
 */
export async function purgeExpiredData(now: Date = new Date(), opts: { dryRun?: boolean } = {}): Promise<PurgeCounts> {
  if (opts.dryRun) return previewExpiredData(now);
  // Cutoff per business, evaluated in UTC (timestamp columns hold UTC wall time).
  const [bookings, calls, sms, briefingRows] = await prisma.$transaction([
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
    prisma.$queryRaw<{ audio_url: string | null }[]>`
      DELETE FROM "briefings" br USING "businesses" b
       WHERE br."business_id" = b."id"
         AND br."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")
      RETURNING br."audio_url"`,
  ]);
  const audio = removeBriefingAudio(briefingRows.map((r) => r.audio_url));
  const counts: PurgeCounts = { calls, sms_logs: sms, briefings: briefingRows.length, bookings_anonymized: bookings, audio_files: audio };
  log.info('retention.purged', { ...counts });
  return counts;
}

export interface EraseCounts {
  calls: number;
  /** Texts to the customer PLUS owner alerts / other texts that mention them (by number, booking or name). */
  sms_logs: number;
  bookings_anonymized: number;
  /** Briefings whose narration/stats cover a day the customer appears in (deleted; the evening note is regenerable). */
  briefings: number;
  audio_files: number;
}

type Reader = Pick<typeof prisma, '$queryRaw'>;

/** Everything stored about one customer of one business (ids), shared by erasure and the access export. */
export interface CustomerRecords {
  callIds: string[];
  bookingIds: string[];
  smsIds: string[];
  briefingIds: string[];
}

/** Names worth matching in free text: long enough not to hit common words. */
const MIN_NAME_LEN = 4;

/**
 * Locate a customer's records, matched on the phone's last 10 digits:
 *  - calls from the number; bookings with the number OR created from those calls;
 *  - sms_log rows sent to the number, linked to those bookings (owner alerts carry booking_id), whose BODY
 *    contains the number's digits (owner alerts quote "Phone: ..."), or owner alerts quoting a customer name;
 *  - briefings whose narration contains the number / a customer name, or that cover a local day on which one of
 *    the customer's calls or bookings happened (the narration and stats summarise them).
 */
export async function locateCustomerRecords(db: Reader, businessId: string, key: string): Promise<CustomerRecords> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const callIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "calls" WHERE "business_id" = ${businessId}
       AND right(regexp_replace(coalesce("caller_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}`);
  const bookingIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bookings" WHERE "business_id" = ${businessId}
       AND (right(regexp_replace("customer_phone", '[^0-9]', '', 'g'), 10) = ${key}
            OR "call_id" = ANY(${callIds}::text[]))`);
  const names = (await db.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT n AS name FROM (
      SELECT "customer_name" AS n FROM "bookings" WHERE "id" = ANY(${bookingIds}::text[]) AND "anonymized_at" IS NULL
      UNION SELECT "caller_name" FROM "calls" WHERE "id" = ANY(${callIds}::text[])
    ) t WHERE n IS NOT NULL AND char_length(n) >= ${MIN_NAME_LEN}`).map((r) => r.name);
  const namePatterns = names.map((n) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const likeKey = `%${key}%`;
  const smsIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "sms_log" WHERE "business_id" = ${businessId}
       AND (right(regexp_replace("to_phone", '[^0-9]', '', 'g'), 10) = ${key}
            OR "booking_id" = ANY(${bookingIds}::text[])
            OR regexp_replace("body", '[^0-9]', '', 'g') LIKE ${likeKey}
            OR ("kind" = 'owner_alert' AND "body" ILIKE ANY(${namePatterns}::text[])))`);
  const briefingIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT br."id" FROM "briefings" br JOIN "businesses" b ON b."id" = br."business_id"
     WHERE br."business_id" = ${businessId}
       AND (regexp_replace(br."transcript", '[^0-9]', '', 'g') LIKE ${likeKey}
            OR br."transcript" ILIKE ANY(${namePatterns}::text[])
            OR br."date" IN (
                 SELECT to_char((c."started_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "calls" c WHERE c."id" = ANY(${callIds}::text[])
                 UNION
                 SELECT to_char((k."scheduled_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[])
                 UNION
                 SELECT to_char((k."created_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[])))`);
  return { callIds, bookingIds, smsIds, briefingIds };
}

/**
 * Right-to-erasure for one customer of one business, matched on the phone's last 10 digits:
 * deletes their calls (transcripts, recordings URLs), every SMS log row about them (texts to them AND owner alerts
 * quoting them), the briefings that summarise their days (with the audio files on disk), and anonymises their
 * bookings (also those created from their calls) while keeping financial fields.
 * The SMS opt-out row, if any, is deliberately kept. Throws on a phone with fewer than 7 digits
 * so a typo cannot match broadly. Atomic (files are removed after the commit).
 */
export async function eraseCustomerData(businessId: string, phone: string): Promise<EraseCounts> {
  const key = phoneKey(phone);
  if (!key || key.length < 7) throw new Error('eraseCustomerData: phone must have at least 7 digits');
  const { counts, audio } = await prisma.$transaction(async (tx) => {
    // Locate FIRST: anonymising the bookings would erase the very phone numbers/names the matching relies on.
    const rec = await locateCustomerRecords(tx, businessId, key);
    const bookings = await tx.$executeRaw`
      UPDATE "bookings"
         SET "customer_name" = ${REDACTED_NAME}, "customer_phone" = ${REDACTED_PHONE}, "address" = NULL,
             "anonymized_at" = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE "business_id" = ${businessId} AND "anonymized_at" IS NULL AND "id" = ANY(${rec.bookingIds}::text[])`;
    const sms = await tx.$executeRaw`
      DELETE FROM "sms_log" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.smsIds}::text[])`;
    const briefings = await tx.$queryRaw<{ audio_url: string | null }[]>`
      DELETE FROM "briefings" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.briefingIds}::text[])
      RETURNING "audio_url"`;
    const calls = await tx.$executeRaw`
      DELETE FROM "calls" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.callIds}::text[])`;
    return {
      counts: { calls, sms_logs: sms, bookings_anonymized: bookings, briefings: briefings.length },
      audio: briefings.map((r) => r.audio_url),
    };
  });
  const result: EraseCounts = { ...counts, audio_files: removeBriefingAudio(audio) };
  log.info('customer.erased', { business: businessId, ...result });
  return result;
}
