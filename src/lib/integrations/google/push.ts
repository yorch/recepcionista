/**
 * Booking -> Google event (one event per booking), idempotent:
 *  - deterministic event id derived from the booking id (a retry after a lost response gets 409 and adopts the existing event),
 *  - calendar_event_links (event id + etag + last_pushed_hash): an unchanged booking is not pushed again,
 *  - PATCH with If-Match: when the owner edited the event meanwhile (412) we record `calendar.event_changed_externally` and still
 *    apply the booking's own change; the booking is NEVER changed or cancelled because of what the owner did in Google.
 * The event lives in the OWNER's own calendar and carries the customer's phone/address/notes (documented in docs/integrations/google-calendar.md).
 */
import crypto from 'node:crypto';
import { getBooking, getCall, recordAudit } from '@/lib/db';
import {
  deleteEventLink, getCalendarConnection, getEventLinkByBooking, upsertEventLink,
} from '@/lib/db/calendar';
import { withLease } from '@/lib/db/locks';
import { logger } from '@/lib/log';
import { tzOf } from '@/lib/time';
import type { Booking, CalendarConnection } from '@/lib/types';
import { calPath, gcal } from './api';
import { GoogleApiError, toApiError } from './http';
import { prisma } from '@/lib/db/client';
import { NeedsReauthError } from './tokens';

const log = logger('gcal.push');
export const BOOKING_PROP = 'rc_booking';

export const eventIdFor = (bookingId: string): string => `rc${crypto.createHash('sha256').update(bookingId).digest('hex').slice(0, 40)}`;

const firstName = (full: string): string => full.trim().split(/\s+/)[0] || 'Customer';

export interface EventBody {
  id: string; summary: string; description: string; location?: string; status: 'confirmed' | 'tentative';
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  reminders: { useDefault: true }; transparency: 'opaque';
  extendedProperties: { private: Record<string, string> };
}

export function buildEvent(b: Booking, tz: string, notes: string | null): EventBody {
  const start = new Date(b.scheduled_at);
  const end = new Date(start.getTime() + (b.duration_minutes ?? 60) * 60_000);
  const lines = [
    `Customer: ${b.customer_name}`, `Phone: ${b.customer_phone}`,
    ...(b.address ? [`Address: ${b.address}`] : []),
    ...(notes ? [`Notes: ${notes.slice(0, 500)}`] : []),
    ...(b.status === 'completed' ? ['Status: completed'] : []),
    '', 'Booked by your AI receptionist. Change the booking in the dashboard; moving or deleting this event does not notify the customer.',
  ];
  return {
    id: eventIdFor(b.id), summary: `${b.service} — ${firstName(b.customer_name)}`, description: lines.join('\n'),
    ...(b.address ? { location: b.address } : {}),
    status: b.status === 'pending' ? 'tentative' : 'confirmed',
    start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz },
    reminders: { useDefault: true }, transparency: 'opaque',
    extendedProperties: { private: { [BOOKING_PROP]: b.id } },
  };
}

export const hashEvent = (e: EventBody): string => crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
const usable = (c: CalendarConnection | null): c is CalendarConnection => Boolean(c && (c.status === 'active' || c.status === 'error'));

async function deleteRemote(conn: CalendarConnection, eventId: string): Promise<void> {
  const res = await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(eventId)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw await toApiError(res);
}

async function notes(b: Booking): Promise<string | null> {
  if (!b.call_id) return null;
  const call = await getCall(b.call_id);
  return call && call.business_id === b.business_id ? call.summary ?? null : null;
}

export type PushOutcome = 'created' | 'updated' | 'deleted' | 'unchanged' | 'skipped' | 'retry' | 'externally_deleted';

async function pushLocked(bookingId: string): Promise<PushOutcome> {
  const b = await getBooking(bookingId);
  if (!b) return 'skipped';
  const conn = await getCalendarConnection(b.business_id);
  const link = await getEventLinkByBooking(bookingId);
  if (!usable(conn)) return 'skipped';
  if (link && link.connection_id !== conn.id) { await deleteEventLink(bookingId); }
  const cur = link && link.connection_id === conn.id ? link : null;

  if (b.status === 'cancelled' || b.anonymized_at) {
    if (!cur) return 'skipped';
    await deleteRemote(conn, cur.google_event_id);
    await deleteEventLink(bookingId);
    return 'deleted';
  }
  const biz = await prisma.business.findUnique({ where: { id: b.business_id }, select: { timezone: true } });
  const body = buildEvent(b, tzOf(biz?.timezone), await notes(b));
  const hash = hashEvent(body);
  if (cur && cur.last_pushed_hash === hash) return 'unchanged';
  const path = `${calPath(conn.calendar_id)}/events`;

  if (!cur) {
    const res = await gcal(conn.id, 'POST', path, { query: { sendUpdates: 'none' }, body });
    if (res.status === 409) return adopt(conn, b.id, body, hash);
    if (!res.ok) throw await toApiError(res);
    const ev = (await res.json()) as { id: string; etag?: string };
    await upsertEventLink({ booking_id: b.id, connection_id: conn.id, google_event_id: ev.id, etag: ev.etag ?? null, last_pushed_hash: hash });
    return 'created';
  }

  const { id: _id, ...patch } = body; void _id;
  let res = await gcal(conn.id, 'PATCH', `${path}/${encodeURIComponent(cur.google_event_id)}`, {
    query: { sendUpdates: 'none' }, body: patch, headers: cur.etag ? { 'if-match': cur.etag } : {},
  });
  if (res.status === 412) {
    // The owner edited the event since we last wrote it. Record it, keep the booking authoritative for THIS change.
    await recordAudit({ actor_kind: 'system', business_id: b.business_id, action: 'calendar.event_changed_externally', target: `booking:${b.id}`, meta: { change: 'edited_in_google_before_push' } });
    res = await gcal(conn.id, 'PATCH', `${path}/${encodeURIComponent(cur.google_event_id)}`, { query: { sendUpdates: 'none' }, body: patch });
  }
  if (res.status === 404 || res.status === 410) {
    await deleteEventLink(b.id);
    await recordAudit({ actor_kind: 'system', business_id: b.business_id, action: 'calendar.event_changed_externally', target: `booking:${b.id}`, meta: { change: 'deleted_in_google' } });
    return 'externally_deleted';
  }
  if (!res.ok) throw await toApiError(res);
  const ev = (await res.json()) as { id: string; etag?: string };
  await upsertEventLink({ booking_id: b.id, connection_id: conn.id, google_event_id: ev.id ?? cur.google_event_id, etag: ev.etag ?? null, last_pushed_hash: hash });
  return 'updated';
}

/** Create answered 409: the event (maybe a cancelled tombstone) already exists under our deterministic id: take it over. */
async function adopt(conn: CalendarConnection, bookingId: string, body: EventBody, hash: string): Promise<PushOutcome> {
  const { id, ...patch } = body;
  const res = await gcal(conn.id, 'PATCH', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(id)}`, { query: { sendUpdates: 'none' }, body: patch });
  if (!res.ok) throw await toApiError(res);
  const ev = (await res.json()) as { etag?: string };
  await upsertEventLink({ booking_id: bookingId, connection_id: conn.id, google_event_id: id, etag: ev.etag ?? null, last_pushed_hash: hash });
  return 'updated';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Push the CURRENT state of one booking (serialised per booking). Never throws: failures are logged and retried by the reconcile job. */
export async function pushBooking(bookingId: string): Promise<PushOutcome> {
  try {
    for (let i = 0; i < 6; i++) {
      const r = await withLease(`gcal-push:${bookingId}`, 30_000, () => pushLocked(bookingId));
      if (r.acquired) return r.value;
      await sleep(150 * (i + 1));
    }
    return 'retry';
  } catch (err) {
    if (err instanceof NeedsReauthError) return 'skipped';
    log.warn('push_failed', { booking: bookingId, reason: err instanceof GoogleApiError ? `${err.status} ${err.reason}` : 'error' });
    return 'retry';
  }
}

/** Upcoming bookings of a connection that are missing in Google or stale there (the reconcile job). Bounded. */
export async function reconcileConnection(conn: CalendarConnection, limit = 100, now: Date = new Date()): Promise<{ pushed: number; failed: number }> {
  if (!usable(conn)) return { pushed: 0, failed: 0 };
  const rows = await prisma.booking.findMany({
    where: { businessId: conn.business_id, status: { in: ['pending', 'confirmed'] }, anonymizedAt: null, scheduledAt: { gte: new Date(now.getTime() - 86_400_000) } },
    orderBy: { scheduledAt: 'asc' }, take: limit, select: { id: true },
  });
  let pushed = 0, failed = 0;
  for (const r of rows) {
    const out = await pushBooking(r.id);
    if (out === 'created' || out === 'updated') pushed++;
    else if (out === 'retry') failed++;
  }
  return { pushed, failed };
}

