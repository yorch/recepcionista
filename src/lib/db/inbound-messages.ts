/**
 * The owner's inbox of customer texts (table inbound_messages). Every function is tenant-scoped: a row of another business is `not_found`,
 * never visible. Rows are deduped on the Twilio MessageSid (Twilio redelivers webhooks), follow the business's `retention_days`
 * (purgeExpiredData) and are erased with the customer (eraseCustomerData / exportCustomerData match on `from_e164`).
 * STOP/START-class keywords are NOT stored here (they are handled by messaging/inbound.ts); the inbox holds everything else.
 */
import type { InboundMessage as InboundRow } from '@prisma/client';
import { prisma, type DbClient } from './client';
import { clampLimit, encodeTimeCursor, parseTimeCursor, toPage, type Page } from './paging';
import { logger } from '@/lib/log';
import { defaultPhoneCountry, toE164 } from '@/lib/phone';
import { INBOUND_BODY_MAX } from '@/lib/business-config';
import { INBOUND_STATUSES, type ID, type InboundMessage, type InboundStatus } from '@/lib/types';

const log = logger('db.inbound');

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toInboundMessage(row: InboundRow): InboundMessage {
  return {
    id: row.id,
    business_id: row.businessId,
    from_e164: row.fromE164,
    from_phone: row.fromPhone,
    body: row.body,
    twilio_message_sid: row.twilioMessageSid,
    received_at: row.receivedAt.toISOString(),
    status: (INBOUND_STATUSES as readonly string[]).includes(row.status) ? (row.status as InboundStatus) : 'new',
    handled_at: iso(row.handledAt),
    handled_by: row.handledBy ?? null,
    forwarded_to_owner_at: iso(row.forwardedToOwnerAt),
    auto_replied_at: iso(row.autoRepliedAt),
    booking_id: row.bookingId ?? null,
  };
}

export type RecordInboundResult =
  | { ok: true; created: boolean; message: InboundMessage }
  | { ok: false; reason: 'invalid_phone' | 'empty_body' | 'invalid_sid' | 'sid_other_business' | 'business_not_found' };

/**
 * Store a received text. Idempotent on the MessageSid: a redelivery returns the existing row with `created: false` (and never a second
 * row, whatever the race). The body is cut to 1600 chars (Twilio's maximum). `from` is normalised to E.164 (numbers without '+' are read
 * in `country`, default DEFAULT_PHONE_COUNTRY); an unparseable sender is refused (`invalid_phone`) because erasure matches on E.164.
 * A sid that already belongs to ANOTHER business is refused (`sid_other_business`) and nothing is written or returned.
 */
export async function recordInboundMessage(
  input: { business_id: ID; from: string; body: string; twilio_message_sid: string; received_at?: Date; country?: string },
  db: DbClient = prisma,
): Promise<RecordInboundResult> {
  const sid = typeof input.twilio_message_sid === 'string' ? input.twilio_message_sid.trim() : '';
  if (!sid || sid.length > 64) return { ok: false, reason: 'invalid_sid' };
  const e164 = toE164(input.from, input.country ?? defaultPhoneCountry());
  if (!e164) return { ok: false, reason: 'invalid_phone' };
  const body = String(input.body ?? '').slice(0, INBOUND_BODY_MAX);
  if (!body.trim()) return { ok: false, reason: 'empty_body' };

  const existing = await db.inboundMessage.findUnique({ where: { twilioMessageSid: sid } });
  if (existing) return existing.businessId === input.business_id ? { ok: true, created: false, message: toInboundMessage(existing) } : { ok: false, reason: 'sid_other_business' };
  try {
    const row = await db.inboundMessage.create({
      data: {
        businessId: input.business_id, fromE164: e164, fromPhone: String(input.from).trim().slice(0, 64), body, twilioMessageSid: sid,
        receivedAt: input.received_at ?? new Date(),
      },
    });
    log.info('inbound.recorded', { business: input.business_id, id: row.id });
    return { ok: true, created: true, message: toInboundMessage(row) };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') { // lost the race against a concurrent delivery of the same sid
      const again = await db.inboundMessage.findUnique({ where: { twilioMessageSid: sid } });
      if (again) return again.businessId === input.business_id ? { ok: true, created: false, message: toInboundMessage(again) } : { ok: false, reason: 'sid_other_business' };
    }
    if (code === 'P2003') return { ok: false, reason: 'business_not_found' };
    throw err;
  }
}

export async function getInboundMessage(businessId: ID, id: ID): Promise<InboundMessage | null> {
  const row = await prisma.inboundMessage.findFirst({ where: { id, businessId } });
  return row ? toInboundMessage(row) : null;
}

export async function getInboundMessageBySid(sid: string): Promise<InboundMessage | null> {
  const row = await prisma.inboundMessage.findUnique({ where: { twilioMessageSid: sid } });
  return row ? toInboundMessage(row) : null;
}

/** Newest first, keyset paged (see paging.ts). `status` filters ('new' = the unread inbox). */
export async function listInboundMessagesPage(
  businessId: ID, opts: { limit?: number; cursor?: string | null; status?: InboundStatus; fromE164?: string } = {},
): Promise<Page<InboundMessage>> {
  const limit = clampLimit(opts.limit);
  const cur = parseTimeCursor(opts.cursor);
  const rows = await prisma.inboundMessage.findMany({
    where: {
      businessId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.fromE164 ? { fromE164: opts.fromE164 } : {}),
      ...(cur ? { OR: [{ receivedAt: { lt: cur.at } }, { receivedAt: cur.at, id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit, toInboundMessage, (r) => encodeTimeCursor(r.receivedAt, r.id));
}

/** Count of the inbox by status (badge in the dashboard). Missing statuses are 0. */
export async function countInboundByStatus(businessId: ID): Promise<Record<InboundStatus, number>> {
  const groups = await prisma.inboundMessage.groupBy({ by: ['status'], where: { businessId }, _count: { _all: true } });
  const out: Record<InboundStatus, number> = { new: 0, handled: 0, ignored: 0 };
  for (const g of groups) if ((INBOUND_STATUSES as readonly string[]).includes(g.status)) out[g.status as InboundStatus] = g._count._all;
  return out;
}

/**
 * Set the triage status. 'handled' / 'ignored' stamp handled_at (now) and handled_by; 'new' re-opens (clears both).
 * Returns the updated message, or null when it does not exist in this business.
 */
export async function setInboundStatus(businessId: ID, id: ID, status: InboundStatus, by: string | null, now: Date = new Date()): Promise<InboundMessage | null> {
  if (!(INBOUND_STATUSES as readonly string[]).includes(status)) throw new Error('invalid inbound status');
  const res = await prisma.inboundMessage.updateMany({
    where: { id, businessId },
    data: status === 'new' ? { status, handledAt: null, handledBy: null } : { status, handledAt: now, handledBy: by ? by.slice(0, 100) : null },
  });
  return res.count === 1 ? getInboundMessage(businessId, id) : null;
}

/** First stamp wins: returns true only for the call that set `forwarded_to_owner_at` (so the owner is alerted once even if the webhook retries). */
export async function markInboundForwarded(businessId: ID, id: ID, at: Date = new Date()): Promise<boolean> {
  const res = await prisma.inboundMessage.updateMany({ where: { id, businessId, forwardedToOwnerAt: null }, data: { forwardedToOwnerAt: at } });
  return res.count === 1;
}

/** First stamp wins: true only for the call that set `auto_replied_at` (at most one automatic reply per message). */
export async function markInboundAutoReplied(businessId: ID, id: ID, at: Date = new Date()): Promise<boolean> {
  const res = await prisma.inboundMessage.updateMany({ where: { id, businessId, autoRepliedAt: null }, data: { autoRepliedAt: at } });
  return res.count === 1;
}

/** Attach (or detach with null) the booking a text is about. The booking must belong to the same business; false = message or booking not found there. */
export async function linkInboundToBooking(businessId: ID, id: ID, bookingId: ID | null): Promise<boolean> {
  if (bookingId) {
    const b = await prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true } });
    if (!b) return false;
  }
  const res = await prisma.inboundMessage.updateMany({ where: { id, businessId }, data: { bookingId } });
  return res.count === 1;
}

/** The latest message per sender is what the owner replies to: most recent text from this number (E.164), if any. */
export async function latestInboundFrom(businessId: ID, fromE164: string): Promise<InboundMessage | null> {
  const row = await prisma.inboundMessage.findFirst({ where: { businessId, fromE164 }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }] });
  return row ? toInboundMessage(row) : null;
}
