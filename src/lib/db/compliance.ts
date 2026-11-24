/**
 * Compliance helpers: SMS opt-out (STOP), data retention and customer erasure.
 * Phone numbers are matched on their last 10 digits (`phoneKey`), the same normalisation the
 * rest of the app uses, so "+1 (305) 555-0142" and "3055550142" are the same person.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { phoneKey } from '@/lib/format';
import { defaultPhoneCountry, phoneCountry, toE164 } from '@/lib/phone';
import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js/min';
import { logger } from '@/lib/log';
import { removeBriefingAudio } from '@/lib/briefing/audio-files';
import { enqueueRecordingDeletions } from './recording-deletions';
import type { SmsOptOut } from '@/lib/types';

const log = logger('db.compliance');

// ---------------------------------------------------------------------------------------------
// Phone identity. E.164 is THE identity; the legacy last-10-digit `phone_key` only bridges rows written before the
// E.164 columns existed (e164 IS NULL). Their country is unknown (only the last 10 digits survive), so they FAIL SAFE:
// they suppress every number that shares those digits, whatever its country (see optOutWhere). Rows with an E.164
// match exactly, so +44 and +1 never share an identity.
// ---------------------------------------------------------------------------------------------

/** The country assumed for numbers typed without '+' for this business: its own phone's country, else DEFAULT_PHONE_COUNTRY. */
export function countryForBusiness(b: { phone_e164?: string | null } | null | undefined): string {
  return phoneCountry(b?.phone_e164) ?? defaultPhoneCountry();
}

export interface PhoneIdent {
  /** Valid E.164 or null (unparseable input). */
  e164: string | null;
  /** Value for `sms_opt_outs.phone_key`: last 10 digits for +1 numbers, the full E.164 for every other country. */
  key: string | null;
  /** True for +1 (US/Canada) numbers: the only ones the legacy phone_key fallback may serve. */
  nanp: boolean;
}

export function phoneIdent(raw: string | null | undefined, country?: string): PhoneIdent {
  const e164 = toE164(raw, country);
  if (!e164) return { e164: null, key: phoneKey(raw), nanp: false };
  const nanp = e164.startsWith('+1');
  return { e164, key: nanp ? e164.slice(-10) : e164, nanp };
}

/**
 * SQL: does the raw text column `col` hold a US/Canada-shaped legacy number whose last 10 digits are `key`?
 * (10 digits, or 11 starting with 1, and no '+' prefix other than '+1'.) Only meaningful on rows whose e164
 * column is NULL.
 */
function legacyNanpMatch(col: 'caller_phone' | 'customer_phone' | 'to_phone', key: string): Prisma.Sql {
  const c = Prisma.raw(`"${col}"`);
  return Prisma.sql`(right(regexp_replace(coalesce(${c}, ''), '[^0-9]', '', 'g'), 10) = ${key}
    AND regexp_replace(coalesce(${c}, ''), '[^0-9]', '', 'g') ~ '^1?[0-9]{10}$'
    AND (coalesce(${c}, '') !~ '^[[:space:]]*[+]' OR coalesce(${c}, '') ~ '^[[:space:]]*[+][[:space:]]*1'))`;
}

/** SQL predicate "this row belongs to this E.164 customer" for a table with a raw phone column and an e164 column. */
function rowMatches(col: 'caller_phone' | 'customer_phone' | 'to_phone', e164Col: 'caller_e164' | 'phone_e164' | 'to_e164', id: PhoneIdent): Prisma.Sql {
  const e = Prisma.raw(`"${e164Col}"`);
  if (!id.e164) return Prisma.sql`FALSE`;
  if (!id.nanp) return Prisma.sql`(${e} = ${id.e164})`;
  return Prisma.sql`(${e} = ${id.e164} OR (${e} IS NULL AND ${legacyNanpMatch(col, id.e164.slice(-10))}))`;
}

/** Does free text (an SMS body, a briefing narration) mention this number? Parsed with libphonenumber, never by digit suffix. */
function textMentions(text: string, e164: string, country: string): boolean {
  if (text.includes(e164)) return true;
  try {
    return findPhoneNumbersInText(text, country as CountryCode).some((m) => m.number.number === e164);
  } catch {
    return false;
  }
}

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

/** Legacy `phone_key` of an E.164 number: its last 10 digits (what the pre-E.164 code stored, whatever the country). */
const legacyKeyOf = (e164: string): string => e164.replace(/\D/g, '').slice(-10);

/**
 * Legacy rows (`phone_e164 IS NULL`) hold only the last 10 digits of whatever number sent STOP: their country is
 * UNKNOWN (+52 55 1234 5678 and a +1 551 number share `5512345678`). FAIL SAFE: they suppress every country whose
 * last 10 digits match, exactly like the pre-E.164 code did, until a corrective pass (or a fresh STOP) proves the country.
 * Over-suppression of a stranger's number beats texting someone who opted out.
 */
function optOutWhere(businessId: string, id: PhoneIdent): Prisma.SmsOptOutWhereInput | null {
  if (id.e164) {
    return { businessId, OR: [{ phoneE164: id.e164 }, { phoneE164: null, phoneKey: legacyKeyOf(id.e164) }] };
  }
  // Unparseable number: it cannot be proven different from a legacy row with the same digits, so (fail safe) match those.
  return id.key ? { businessId, phoneE164: null, phoneKey: id.key } : null;
}

/** Rows that are provably THIS number (exact E.164): the only rows a non-US START may remove or a non-US STOP may reuse. */
const exactOptOutWhere = (businessId: string, id: PhoneIdent): Prisma.SmsOptOutWhereInput | null =>
  id.e164 ? { businessId, phoneE164: id.e164 } : null;

/** True when this number has opted out of texts from this business. Unparseable numbers match only legacy rows with the same digits. */
export async function isOptedOut(businessId: string, phone: string | null | undefined, country?: string): Promise<boolean> {
  const where = optOutWhere(businessId, phoneIdent(phone, country));
  if (!where) return false;
  return (await prisma.smsOptOut.findFirst({ where, select: { id: true } })) !== null;
}

/** Record a STOP. Idempotent: the first opt-out time and source are kept; a legacy US/CA row gains its E.164. */
export async function recordOptOut(businessId: string, phone: string, source = 'stop_keyword', country?: string): Promise<SmsOptOut> {
  const id = phoneIdent(phone, country);
  const where = id.nanp ? optOutWhere(businessId, id) : exactOptOutWhere(businessId, id) ?? optOutWhere(businessId, id);
  if (!where || !id.key) throw new Error('recordOptOut: invalid phone');
  let row = await prisma.smsOptOut.findFirst({ where, orderBy: { optedOutAt: 'asc' } });
  if (row) {
    // Never rewrite a legacy row on behalf of a non-US number: the row may be someone else's (the same last 10 digits).
    if (!row.phoneE164 && id.e164 && id.nanp) row = await prisma.smsOptOut.update({ where: { id: row.id }, data: { phoneE164: id.e164 } });
  } else {
    try {
      row = await prisma.smsOptOut.create({ data: { businessId, phoneKey: id.key, phoneE164: id.e164, source } });
    } catch (err) {
      // Lost a race with a concurrent STOP (unique business+key): the winner's row is the opt-out.
      row = await prisma.smsOptOut.findFirst({ where });
      if (!row) throw err;
    }
  }
  log.info('sms.opt_out', { business: businessId, source });
  return toOptOut(row);
}

/** Record a START / explicit re-opt-in by removing the suppression. Returns true if a row was removed. */
export async function recordOptIn(businessId: string, phone: string, country?: string): Promise<boolean> {
  const id = phoneIdent(phone, country);
  // START removes only rows that are provably this number: a +52 START must never delete a legacy row that may be a US customer's STOP.
  const where = id.nanp ? optOutWhere(businessId, id) : exactOptOutWhere(businessId, id) ?? optOutWhere(businessId, id);
  if (!where) throw new Error('recordOptIn: invalid phone');
  const res = await prisma.smsOptOut.deleteMany({ where });
  if (res.count > 0) log.info('sms.opt_in', { business: businessId });
  return res.count > 0;
}

/**
 * Mark the owner phone as verified (the owner proved possession by entering an SMS code): stores the number in both
 * forms and sets `owner_phone_verified_at`. The ONLY writer of that timestamp besides billing/admin tooling; the
 * generic `updateBusiness` clears it whenever the number changes. Returns the verification time, or null when the
 * business does not exist.
 */
export async function setOwnerPhoneVerified(businessId: string, phoneE164: string, at: Date = new Date()): Promise<Date | null> {
  const res = await prisma.business.updateMany({
    where: { id: businessId },
    data: { ownerPhone: phoneE164, ownerPhoneE164: phoneE164, ownerPhoneVerifiedAt: at },
  });
  if (res.count === 0) return null;
  log.info('owner_phone.verified', { business: businessId });
  return at;
}

export interface FollowupConsentResult {
  /** The booking that was updated, or null when nothing was (no booking, already consented). */
  booking_id: string | null;
  granted: boolean;
}

/**
 * The customer themselves texted a positive keyword (YES / Y / SI / START) to the business number: record follow-up
 * consent on their MOST RECENT booking (matched on E.164) that has none yet. Consent is never fabricated for older
 * bookings and is never requested proactively. Never overrides a STOP: an opted-out number gets nothing.
 */
export async function recordFollowupConsentFromReply(
  businessId: string, phone: string, source: string, country: string = defaultPhoneCountry(),
): Promise<FollowupConsentResult> {
  const id = phoneIdent(phone, country);
  if (!id.e164 || (await isOptedOut(businessId, phone, country))) return { booking_id: null, granted: false };
  const or: Prisma.BookingWhereInput[] = [{ phoneE164: id.e164 }];
  if (id.nanp) or.push({ phoneE164: null, customerPhone: { not: '' } });
  const candidates = await prisma.booking.findMany({
    where: { businessId, anonymizedAt: null, status: { not: 'cancelled' }, OR: or },
    orderBy: { createdAt: 'desc' },
    take: id.nanp ? 50 : 1,
  });
  // Legacy rows (no E.164) match only when both are US/Canada-shaped with the same last ten digits.
  const latest = candidates.find((b) => (b.phoneE164 ? b.phoneE164 === id.e164 : legacyNanpPhone(b.customerPhone, id.e164 as string)));
  if (!latest || latest.followupConsentAt) return { booking_id: latest?.id ?? null, granted: false };
  await prisma.booking.update({ where: { id: latest.id }, data: { followupConsentAt: new Date(), followupConsentSource: source } });
  log.info('followup_consent.recorded', { business: businessId, source });
  return { booking_id: latest.id, granted: true };
}

/** JS twin of `legacyNanpMatch`: is the raw legacy number a US/Canada-shaped spelling of this +1 number? */
export function legacyNanpPhone(raw: string | null | undefined, e164: string): boolean {
  if (!e164.startsWith('+1') || !raw) return false;
  const d = raw.replace(/\D/g, '');
  if (!/^1?\d{10}$/.test(d) || d.slice(-10) !== e164.slice(-10)) return false;
  return !/^\s*\+/.test(raw) || /^\s*\+\s*1/.test(raw);
}

/**
 * Try the provider-side deletion of recordings that are ALREADY queued (`enqueueRecordingDeletions`, written in the same transaction
 * as the call-row DELETE). Whatever fails stays queued and is retried with backoff by the jobs runner; nothing is lost. Dynamic import:
 * voice code imports this layer. Never throws.
 */
async function drainQueuedRecordings(ids: string[]): Promise<{ deleted: number; pending: number }> {
  if (ids.length === 0) return { deleted: 0, pending: 0 };
  try {
    const res = await (await import('@/lib/voice/recording-deletion')).drainRecordingDeletions({ ids });
    return { deleted: res.deleted, pending: res.pending_of_requested };
  } catch (err) {
    log.warn('recordings.delete_failed', { error: (err as Error).message });
    return { deleted: 0, pending: ids.length };
  }
}

export interface PurgeCounts {
  calls: number;
  /** Live-transcript rows (call_transcript_events) of the purged calls. */
  transcript_events: number;
  sms_logs: number;
  briefings: number;
  bookings_anonymized: number;
  /** Briefing audio files removed from disk (0 on a dry run). */
  audio_files?: number;
  /** Provider-side voicemail recordings (Twilio) deleted along with the purged calls (0 on a dry run). */
  recordings?: number;
  /** Recordings queued for provider-side deletion that are NOT confirmed deleted yet (retried by the jobs runner; never lost). */
  recordings_pending?: number;
}

/**
 * What a purge would delete right now, without deleting anything (the startup log line and the admin
 * dry-run endpoint use it). Same cutoffs as `purgeExpiredData`.
 */
export async function previewExpiredData(now: Date = new Date()): Promise<PurgeCounts> {
  const one = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  const [bookings, calls, sms, briefings, events] = await Promise.all([
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
    one(prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "call_transcript_events" e JOIN "calls" c ON c."id" = e."call_id" JOIN "businesses" b ON c."business_id" = b."id"
       WHERE c."started_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`),
  ]);
  return { calls, transcript_events: events, sms_logs: sms, briefings, bookings_anonymized: bookings };
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
 * Voicemail recordings (Twilio-hosted, referenced by a deleted call's `recording_url`) are deleted at the provider too, best effort.
 */
export async function purgeExpiredData(now: Date = new Date(), opts: { dryRun?: boolean } = {}): Promise<PurgeCounts> {
  if (opts.dryRun) return previewExpiredData(now);
  // Cutoff per business, evaluated in UTC (timestamp columns hold UTC wall time).
  const { bookings, calls, sms, briefingRows, queued, events } = await prisma.$transaction(async (tx) => {
    const bookings = await tx.$executeRaw`
      UPDATE "bookings" bk
         SET "customer_name" = ${REDACTED_NAME}, "customer_phone" = ${REDACTED_PHONE}, "phone_e164" = NULL, "address" = NULL,
             "anonymized_at" = (${now}::timestamptz AT TIME ZONE 'UTC')
        FROM "businesses" b
       WHERE bk."business_id" = b."id" AND bk."anonymized_at" IS NULL
         AND bk."scheduled_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`;
    // Live-transcript rows go with their call (FK cascade); deleted first only so they can be counted.
    const events = await tx.$executeRaw`
      DELETE FROM "call_transcript_events" e USING "calls" c, "businesses" b
       WHERE e."call_id" = c."id" AND c."business_id" = b."id"
         AND c."started_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`;
    const calls = await tx.$queryRaw<{ recording_url: string | null; business_id: string; conversation_id: string | null }[]>`
      DELETE FROM "calls" c USING "businesses" b
       WHERE c."business_id" = b."id"
         AND c."started_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")
      RETURNING c."recording_url", c."business_id", c."conversation_id"`;
    // Durable record of every provider-side recording BEFORE the rows that referenced them are gone (same transaction).
    const queued = await enqueueRecordingDeletions(tx, calls.map((c) => ({ url: c.recording_url, businessId: c.business_id, conversationId: c.conversation_id })));
    const sms = await tx.$executeRaw`
      DELETE FROM "sms_log" s USING "businesses" b
       WHERE s."business_id" = b."id"
         AND s."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")`;
    const briefingRows = await tx.$queryRaw<{ audio_url: string | null }[]>`
      DELETE FROM "briefings" br USING "businesses" b
       WHERE br."business_id" = b."id"
         AND br."created_at" < (${now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b."retention_days")
      RETURNING br."audio_url"`;
    return { bookings, calls, sms, briefingRows, queued, events };
  });
  const audio = removeBriefingAudio(briefingRows.map((r) => r.audio_url));
  const rec = await drainQueuedRecordings(queued);
  if (bookings > 0) await redactCalendarEvents(null); // sweep: Google events of every anonymised booking
  const counts: PurgeCounts = {
    calls: calls.length, transcript_events: events, sms_logs: sms, briefings: briefingRows.length, bookings_anonymized: bookings, audio_files: audio,
    recordings: rec.deleted, recordings_pending: rec.pending,
  };
  log.info('retention.purged', { ...counts });
  return counts;
}

/** Calendar privacy hook (dynamic import: the integration depends on this layer, not the other way round). `null` = sweep all anonymised bookings. */
async function redactCalendarEvents(bookingIds: string[] | null): Promise<void> {
  try {
    const m = await import('@/lib/integrations/google/privacy');
    if (bookingIds === null) await m.redactAnonymizedBookingEvents(); else await m.redactCalendarEventsForBookings(bookingIds);
  } catch (err) { log.warn('calendar_redaction_failed', { err }); }
}

export interface EraseCounts {
  calls: number;
  /** Live-transcript rows of the erased calls. */
  transcript_events: number;
  /** Provider-side voicemail recordings deleted with the calls. */
  recordings?: number;
  /** Recordings queued for provider-side deletion that are not confirmed deleted yet: the erasure is NOT complete at the provider until this drains (retried automatically). */
  recordings_pending?: number;
  /** 'pending' while any recording's provider-side deletion is not confirmed yet (the erasure is then not complete at the provider); otherwise 'complete'. */
  recording_deletion?: 'complete' | 'pending';
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
 * Locate a customer's records, matched on the customer's E.164 number (legacy rows without an E.164 match on the last
 * 10 digits only when both numbers are US/Canada-shaped; free text is parsed with libphonenumber, so a +44 number
 * that merely ends in the same ten digits as a +1 number is NOT the same customer):
 *  - calls from the number; bookings with the number OR created from those calls;
 *  - sms_log rows sent to the number, linked to those bookings (owner alerts carry booking_id), whose BODY
 *    mentions the number (owner alerts quote "Phone: ..."), or owner alerts quoting a customer name;
 *  - briefings whose narration mentions the number / a customer name, or that cover a local day on which one of
 *    the customer's calls or bookings happened (the narration and stats summarise them).
 */
export async function locateCustomerRecords(db: Reader, businessId: string, id: PhoneIdent, country: string = defaultPhoneCountry()): Promise<CustomerRecords> {
  const e164 = id.e164;
  if (!e164) return { callIds: [], bookingIds: [], smsIds: [], briefingIds: [] };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const digits = e164.slice(1);
  const nationalDigits = id.nanp ? e164.slice(2) : digits; // text prefilter: the number's own digits
  const callIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "calls" WHERE "business_id" = ${businessId}
       AND ${rowMatches('caller_phone', 'caller_e164', id)}`);
  const bookingIds = ids(await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bookings" WHERE "business_id" = ${businessId}
       AND (${rowMatches('customer_phone', 'phone_e164', id)}
            OR "call_id" = ANY(${callIds}::text[]))`);
  const names = (await db.$queryRaw<{ name: string }[]>`
    SELECT DISTINCT n AS name FROM (
      SELECT "customer_name" AS n FROM "bookings" WHERE "id" = ANY(${bookingIds}::text[]) AND "anonymized_at" IS NULL
      UNION SELECT "caller_name" FROM "calls" WHERE "id" = ANY(${callIds}::text[])
    ) t WHERE n IS NOT NULL AND char_length(n) >= ${MIN_NAME_LEN}`).map((r) => r.name);
  const namePatterns = names.map((n) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const likeDigits = `%${nationalDigits}%`;
  const smsRows = await db.$queryRaw<{ id: string; body: string; matched: boolean }[]>`
    SELECT "id", "body",
           (${rowMatches('to_phone', 'to_e164', id)} OR "booking_id" = ANY(${bookingIds}::text[])
            OR ("kind" = 'owner_alert' AND "body" ILIKE ANY(${namePatterns}::text[]))) AS matched
      FROM "sms_log" WHERE "business_id" = ${businessId}
       AND (${rowMatches('to_phone', 'to_e164', id)}
            OR "booking_id" = ANY(${bookingIds}::text[])
            OR regexp_replace("body", '[^0-9]', '', 'g') LIKE ${likeDigits}
            OR ("kind" = 'owner_alert' AND "body" ILIKE ANY(${namePatterns}::text[])))`;
  const smsIds = smsRows.filter((r) => r.matched || textMentions(r.body, e164, country)).map((r) => r.id);
  const briefingRows = await db.$queryRaw<{ id: string; transcript: string; by_day: boolean }[]>`
    SELECT br."id", br."transcript",
           (br."transcript" ILIKE ANY(${namePatterns}::text[])
            OR br."date" IN (
                 SELECT to_char((c."started_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "calls" c WHERE c."id" = ANY(${callIds}::text[])
                 UNION
                 SELECT to_char((k."scheduled_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[])
                 UNION
                 SELECT to_char((k."created_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[]))) AS by_day
      FROM "briefings" br JOIN "businesses" b ON b."id" = br."business_id"
     WHERE br."business_id" = ${businessId}
       AND (regexp_replace(br."transcript", '[^0-9]', '', 'g') LIKE ${likeDigits}
            OR br."transcript" ILIKE ANY(${namePatterns}::text[])
            OR br."date" IN (
                 SELECT to_char((c."started_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "calls" c WHERE c."id" = ANY(${callIds}::text[])
                 UNION
                 SELECT to_char((k."scheduled_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[])
                 UNION
                 SELECT to_char((k."created_at" AT TIME ZONE 'UTC') AT TIME ZONE b."timezone", 'YYYY-MM-DD')
                   FROM "bookings" k WHERE k."id" = ANY(${bookingIds}::text[])))`;
  const briefingIds = briefingRows.filter((r) => r.by_day || textMentions(r.transcript, e164, country)).map((r) => r.id);
  return { callIds, bookingIds, smsIds, briefingIds };
}

/**
 * Right-to-erasure for one customer of one business, matched on the customer's E.164 number (see
 * `locateCustomerRecords`; erasing a +44 number never touches a +1 number with the same last ten digits, nor vice versa):
 * deletes their calls (transcripts, recordings URLs), every SMS log row about them (texts to them AND owner alerts
 * quoting them), the briefings that summarise their days (with the audio files on disk), and anonymises their
 * bookings (also those created from their calls) while keeping financial fields.
 * The SMS opt-out row, if any, is deliberately kept. Throws on a phone that is not a valid number
 * so a typo cannot match broadly. Atomic (files are removed after the commit).
 */
export async function eraseCustomerData(businessId: string, phone: string, country: string = defaultPhoneCountry()): Promise<EraseCounts> {
  const id = phoneIdent(phone, country);
  if (!id.e164) throw new Error('eraseCustomerData: phone must be a valid number (use +country code for non-US numbers)');
  const { counts, audio, queued, bookingIds } = await prisma.$transaction(async (tx) => {
    // Locate FIRST: anonymising the bookings would erase the very phone numbers/names the matching relies on.
    const rec = await locateCustomerRecords(tx, businessId, id, country);
    const bookings = await tx.$executeRaw`
      UPDATE "bookings"
         SET "customer_name" = ${REDACTED_NAME}, "customer_phone" = ${REDACTED_PHONE}, "phone_e164" = NULL, "address" = NULL,
             "anonymized_at" = (clock_timestamp() AT TIME ZONE 'UTC')
       WHERE "business_id" = ${businessId} AND "anonymized_at" IS NULL AND "id" = ANY(${rec.bookingIds}::text[])`;
    const sms = await tx.$executeRaw`
      DELETE FROM "sms_log" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.smsIds}::text[])`;
    const briefings = await tx.$queryRaw<{ audio_url: string | null }[]>`
      DELETE FROM "briefings" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.briefingIds}::text[])
      RETURNING "audio_url"`;
    const events = await tx.$executeRaw`
      DELETE FROM "call_transcript_events" WHERE "call_id" = ANY(${rec.callIds}::text[])
         AND "call_id" IN (SELECT "id" FROM "calls" WHERE "business_id" = ${businessId})`;
    const calls = await tx.$queryRaw<{ recording_url: string | null; conversation_id: string | null }[]>`
      DELETE FROM "calls" WHERE "business_id" = ${businessId} AND "id" = ANY(${rec.callIds}::text[]) RETURNING "recording_url", "conversation_id"`;
    // Same transaction as the DELETE: the recordings are on the deletion queue before the last reference to them is gone.
    const queued = await enqueueRecordingDeletions(tx, calls.map((c) => ({ url: c.recording_url, businessId, conversationId: c.conversation_id })));
    return {
      counts: { calls: calls.length, transcript_events: events, sms_logs: sms, bookings_anonymized: bookings, briefings: briefings.length },
      audio: briefings.map((r) => r.audio_url),
      queued,
      bookingIds: rec.bookingIds,
    };
  });
  const rec = await drainQueuedRecordings(queued);
  await redactCalendarEvents(bookingIds); // Google events pushed for the erased bookings (never throws; a failure is retried by the calendar job)
  const result: EraseCounts = { ...counts, audio_files: removeBriefingAudio(audio), recordings: rec.deleted, recordings_pending: rec.pending, recording_deletion: rec.pending > 0 ? 'pending' : 'complete' };
  log.info('customer.erased', { business: businessId, ...result });
  return result;
}
