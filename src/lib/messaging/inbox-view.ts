/**
 * Shapes the dashboard inbox reads (owner and staff of THIS business only; every query is scoped to the business id).
 * The list shows the sender as "...0123"; the detail adds the full number, which both roles may see (they need it to call back).
 */
import { countryForBusiness, countInboundByStatus, getBooking, getInboundMessage, isOptedOut, listInboundMessagesPage, listSmsPage, prisma } from '@/lib/db';
import type { Page } from '@/lib/db/paging';
import type { Business, InboundMessage, InboundStatus, SmsLog } from '@/lib/types';

/** `handled_by` marker of a text that may be an opt-out request (set by messaging/inbox). */
export const POSSIBLE_REVOCATION = 'auto:possible_revocation';

export interface InboxItem {
  id: string;
  from_last4: string;
  body: string;
  received_at: string;
  status: InboundStatus;
  handled_at: string | null;
  booking_id: string | null;
  forwarded: boolean;
  auto_replied: boolean;
  /** The text looks like a request to stop receiving texts (no automatic reply was sent): the owner decides whether to opt the number out. */
  possible_opt_out: boolean;
}

export interface InboxDetail extends InboxItem {
  from_e164: string;
  opted_out: boolean;
  booking: { id: string; service: string; scheduled_at: string; status: string } | null;
  /** The conversation with this number, oldest first: their texts and ours (auto-reply, manual, replies). */
  thread: ThreadEntry[];
}

export interface ThreadEntry {
  direction: 'in' | 'out';
  at: string;
  body: string;
  /** Outbound only: the log status (sent, mock, failed, blocked_*). */
  status?: SmsLog['status'];
  kind?: SmsLog['kind'];
}

export const toInboxItem = (m: InboundMessage): InboxItem => ({
  id: m.id,
  from_last4: m.from_e164.slice(-4),
  body: m.body,
  received_at: m.received_at,
  status: m.status,
  handled_at: m.handled_at,
  booking_id: m.booking_id,
  forwarded: Boolean(m.forwarded_to_owner_at),
  auto_replied: Boolean(m.auto_replied_at),
  possible_opt_out: m.handled_by === POSSIBLE_REVOCATION,
});

export interface InboxPage { items: InboxItem[]; next_cursor: string | null; counts: Record<InboundStatus, number> }

export async function getInboxPage(businessId: string, opts: { status?: InboundStatus; cursor?: string | null; limit?: number }): Promise<InboxPage> {
  const [page, counts]: [Page<InboundMessage>, Record<InboundStatus, number>] = await Promise.all([
    listInboundMessagesPage(businessId, { status: opts.status, cursor: opts.cursor, limit: opts.limit }),
    countInboundByStatus(businessId),
  ]);
  return { items: page.items.map(toInboxItem), next_cursor: page.next_cursor, counts };
}

const THREAD_MAX = 40;
const THREAD_KINDS = ['inbox_autoreply', 'manual', 'owner_inbox_reply'];

export async function getInboxDetail(business: Business, id: string): Promise<InboxDetail | null> {
  const m = await getInboundMessage(business.id, id);
  if (!m) return null;
  const [inbound, outbound, booking, optedOut] = await Promise.all([
    prisma.inboundMessage.findMany({ where: { businessId: business.id, fromE164: m.from_e164 }, orderBy: { receivedAt: 'desc' }, take: THREAD_MAX }),
    prisma.smsLog.findMany({ where: { businessId: business.id, toE164: m.from_e164, kind: { in: THREAD_KINDS } }, orderBy: { createdAt: 'desc' }, take: THREAD_MAX }),
    m.booking_id ? getBooking(m.booking_id) : Promise.resolve(null),
    isOptedOut(business.id, m.from_e164, countryForBusiness(business)),
  ]);
  const thread: ThreadEntry[] = [
    ...inbound.map((r): ThreadEntry => ({ direction: 'in', at: r.receivedAt.toISOString(), body: r.body })),
    ...outbound.map((r): ThreadEntry => ({ direction: 'out', at: r.createdAt.toISOString(), body: r.body, status: r.status as SmsLog['status'], kind: r.kind as SmsLog['kind'] })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(-THREAD_MAX);
  return {
    ...toInboxItem(m),
    from_e164: m.from_e164,
    opted_out: optedOut,
    booking: booking && booking.business_id === business.id && !booking.anonymized_at
      ? { id: booking.id, service: booking.service, scheduled_at: booking.scheduled_at, status: booking.status } : null,
    thread,
  };
}

// ---- message log (the SMS log tab) ----

export interface LogItem {
  id: string;
  direction: 'in' | 'out';
  at: string;
  /** The customer's number as "...0123" (the log never shows the whole number). */
  who_last4: string;
  body: string;
  /** Outbound: the provider/policy status. Inbound: new | handled | ignored. */
  status: string;
  kind?: SmsLog['kind'];
}

const last4Of = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '').slice(-4);

export async function getMessageLog(businessId: string, opts: { direction: 'in' | 'out'; cursor?: string | null; limit?: number }): Promise<{ items: LogItem[]; next_cursor: string | null }> {
  if (opts.direction === 'in') {
    const page = await listInboundMessagesPage(businessId, { cursor: opts.cursor, limit: opts.limit });
    return {
      items: page.items.map((m): LogItem => ({ id: m.id, direction: 'in', at: m.received_at, who_last4: m.from_e164.slice(-4), body: m.body, status: m.status })),
      next_cursor: page.next_cursor,
    };
  }
  const page = await listSmsPage(businessId, { cursor: opts.cursor, limit: opts.limit });
  return {
    items: page.items.map((s): LogItem => ({ id: s.id, direction: 'out', at: s.created_at, who_last4: last4Of(s.to_phone), body: s.body, status: s.status, kind: s.kind })),
    next_cursor: page.next_cursor,
  };
}
