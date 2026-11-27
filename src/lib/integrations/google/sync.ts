/**
 * Google -> busy blocks. Incremental sync with a syncToken (410 => full resync), singleEvents=true (recurring series arrive as
 * instances, so DST and exceptions are Google's problem), `fields` limits the response so titles/descriptions/attendees never
 * reach this server at all. Only TIMES are stored (calendar_busy_blocks). Our own pushed booking events are never blocks.
 *
 * Sync-token encoding in calendar_connections.sync_token: `fs:<ms of the last FULL sync>:<google token>` (full resync daily so the
 * rolling window [now-1d, now+HORIZON] is refreshed: events beyond timeMax of an old sync would otherwise never appear).
 */
import { claimEvent } from '@/lib/db';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/db';
import {
  deleteBusyBlock, deleteEventLink, getCalendarConnectionById, listEventLinksForConnection, replaceBusyBlocksIf,
  setCalendarConnectionStatus, touchEventLink, updateCalendarSyncState, upsertBusyBlock, type BusyBlockInput,
} from '@/lib/db/calendar';
import { withLease } from '@/lib/db/locks';
import { logger } from '@/lib/log';
import { tzOf, zonedTimeToUtc } from '@/lib/time';
import type { CalendarConnection } from '@/lib/types';
import { calPath, gcal } from './api';
import { GoogleApiError, toApiError } from './http';
import { markNeedsReauth, NeedsReauthError } from './tokens';
import { BOOKING_PROP } from './push';
import { planAllows } from '@/lib/admin/plan-catalog';

const log = logger('gcal.sync');
export const HORIZON_DAYS = 180;
export const PAST_DAYS = 1;
export const FULL_RESYNC_EVERY_MS = 24 * 3600_000;
export const SYNC_LEASE_MS = 3 * 60_000;
export const MAX_PAGES = 40;
/** Consecutive failed syncs after which the connection is declared needs_reauth. */
export const FAILURES_BEFORE_REAUTH = 10;
const FIELDS = 'items(id,status,etag,start,end,transparency,eventType,attendees(self,responseStatus),extendedProperties/private),nextPageToken,nextSyncToken';

export interface GEvent {
  id: string; status?: string; etag?: string; eventType?: string; transparency?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

export const encodeToken = (token: string, fullAt: number): string => `fs:${fullAt}:${token}`;
export function decodeToken(raw: string | null): { token: string; fullAt: number } | null {
  const m = /^fs:(\d+):([\s\S]+)$/.exec(raw ?? '');
  return m ? { token: m[2], fullAt: Number(m[1]) } : null;
}

export type Mapped = { kind: 'drop' } | { kind: 'block'; block: BusyBlockInput };

/** Pure: a Google event -> a busy block (or drop). All-day events are whole LOCAL days of the business zone; end.date is exclusive. */
export function mapEvent(ev: GEvent, tz: string, now: Date): Mapped {
  if (ev.status === 'cancelled' || !ev.start) return { kind: 'drop' };
  if (ev.eventType === 'workingLocation' || ev.eventType === 'birthday') return { kind: 'drop' };
  if (ev.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return { kind: 'drop' };
  let starts: Date, ends: Date, allDay = false;
  if (ev.start.date) {
    allDay = true;
    starts = zonedTimeToUtc(ev.start.date, '00:00', tz);
    ends = ev.end?.date ? zonedTimeToUtc(ev.end.date, '00:00', tz) : zonedTimeToUtc(ev.start.date, '23:59', tz);
    if (ends <= starts) ends = new Date(starts.getTime() + 24 * 3600_000);
  } else if (ev.start.dateTime) {
    starts = new Date(ev.start.dateTime);
    ends = ev.end?.dateTime ? new Date(ev.end.dateTime) : new Date(starts.getTime() + 3600_000);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) return { kind: 'drop' };
    if (ends <= starts) ends = new Date(starts.getTime() + 60_000);
  } else return { kind: 'drop' };
  if (ends.getTime() <= now.getTime() - PAST_DAYS * 86_400_000 || starts.getTime() >= now.getTime() + HORIZON_DAYS * 86_400_000) return { kind: 'drop' };
  return { kind: 'block', block: { google_event_id: ev.id, starts_at: starts, ends_at: ends, all_day: allDay, transparency: ev.transparency === 'transparent' ? 'transparent' : 'opaque' } };
}

/**
 * An event we created for a booking OF THIS BUSINESS: a link row of this connection, or our private marker naming one of this
 * business's bookings. A marker naming another business's booking (two businesses sharing one Google calendar) is a normal busy
 * event for this one: the other business really sold that slot.
 */
const isOurs = (ev: GEvent, links: Map<string, unknown>, ownBookings: Set<string>): boolean => {
  if (links.has(ev.id)) return true;
  const id = ev.extendedProperties?.private?.[BOOKING_PROP];
  return id !== undefined && ownBookings.has(id);
};

/** Which of the page's marker booking ids belong to this connection's business (one batched lookup per page). */
async function ownBookingIds(conn: CalendarConnection, events: GEvent[], links: Map<string, unknown>): Promise<Set<string>> {
  const ids = [...new Set(events.filter((e) => !links.has(e.id)).map((e) => e.extendedProperties?.private?.[BOOKING_PROP]).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.booking.findMany({ where: { id: { in: ids }, businessId: conn.business_id }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** An owner changed a linked event in Google: record it (never touches the booking). Deduped by etag. */
async function noteExternalChange(conn: CalendarConnection, ev: GEvent, link: { booking_id: string; etag: string | null } | undefined): Promise<void> {
  if (!link) return;
  const booking = await prisma.booking.findUnique({ where: { id: link.booking_id }, select: { scheduledAt: true, durationMinutes: true, status: true } });
  if (!booking) return;
  if (ev.status === 'cancelled') {
    await deleteEventLink(link.booking_id);
    if (booking.status === 'cancelled' || booking.status === 'completed') return; // we deleted it / it is done: not an owner edit
    await recordAudit({ actor_kind: 'system', business_id: conn.business_id, action: 'calendar.event_changed_externally', target: `booking:${link.booking_id}`, meta: { change: 'deleted_in_google' } });
    return;
  }
  if (!ev.start?.dateTime || link.etag === ev.etag) return;
  const s = new Date(ev.start.dateTime).getTime();
  const e = ev.end?.dateTime ? new Date(ev.end.dateTime).getTime() : s;
  const sameTime = Math.abs(s - booking.scheduledAt.getTime()) < 60_000 && Math.abs(e - (booking.scheduledAt.getTime() + booking.durationMinutes * 60_000)) < 60_000;
  await touchEventLink(link.booking_id, { etag: ev.etag ?? null });
  if (sameTime || booking.status === 'cancelled') return;
  await recordAudit({
    actor_kind: 'system', business_id: conn.business_id, action: 'calendar.event_changed_externally', target: `booking:${link.booking_id}`,
    meta: { change: 'time_changed_in_google', booking_at: booking.scheduledAt.toISOString(), event_at: new Date(s).toISOString() },
  });
}

async function listPage(connId: string, calendarId: string, query: Record<string, string>): Promise<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }> {
  const res = await gcal(connId, 'GET', `${calPath(calendarId)}/events`, { query: { singleEvents: 'true', maxResults: '250', fields: FIELDS, ...query } });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
}

async function runSync(conn: CalendarConnection, tz: string, now: Date): Promise<{ mode: 'full' | 'incremental'; changed: number }> {
  const links = new Map((await listEventLinksForConnection(conn.id, 5000)).map((l) => [l.google_event_id, l]));
  const stored = decodeToken(conn.sync_token);
  const doFull = !stored || now.getTime() - stored.fullAt >= FULL_RESYNC_EVERY_MS;

  if (!doFull) {
    try {
      let changed = 0, pageToken: string | undefined, next: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await listPage(conn.id, conn.calendar_id, { syncToken: stored.token, ...(pageToken ? { pageToken } : {}) });
        const own = await ownBookingIds(conn, page.items ?? [], links);
        for (const ev of page.items ?? []) {
          if (isOurs(ev, links, own)) { await noteExternalChange(conn, ev, links.get(ev.id)); await deleteBusyBlock(conn.id, ev.id); continue; }
          const m = mapEvent(ev, tz, now);
          if (m.kind === 'block') await upsertBusyBlock(conn.id, m.block, prisma, { expectCalendarId: conn.calendar_id }); else await deleteBusyBlock(conn.id, ev.id);
          changed++;
        }
        pageToken = page.nextPageToken;
        if (!pageToken) { next = page.nextSyncToken; break; }
      }
      if (!next) throw new GoogleApiError(502, 'no_sync_token');
      await updateCalendarSyncState(conn.id, { sync_token: encodeToken(next, stored.fullAt) }, { expectCalendarId: conn.calendar_id });
      return { mode: 'incremental', changed };
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 410)) throw err;
      log.info('sync_token_gone', { connection: conn.id });
      // fall through to a full resync
    }
  }

  const blocks: BusyBlockInput[] = [];
  let pageToken: string | undefined, next: string | undefined;
  const timeMin = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + HORIZON_DAYS * 86_400_000).toISOString();
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await listPage(conn.id, conn.calendar_id, { timeMin, timeMax, ...(pageToken ? { pageToken } : {}) });
    const own = await ownBookingIds(conn, page.items ?? [], links);
    for (const ev of page.items ?? []) {
      if (isOurs(ev, links, own)) { await noteExternalChange(conn, ev, links.get(ev.id)); continue; }
      const m = mapEvent(ev, tz, now);
      if (m.kind === 'block') blocks.push(m.block);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) { next = page.nextSyncToken; break; }
  }
  if (!next) throw new GoogleApiError(502, 'no_sync_token'); // incomplete listing: keep the old blocks
  // Conditional on the calendar this listing came from: if the owner switched calendars (or disconnected) while we were listing, the
  // blocks and the token belong to the OLD calendar and are discarded (the switch already queued a fresh full sync).
  const applied = await replaceBusyBlocksIf(conn.id, blocks, { expectCalendarId: conn.calendar_id });
  if (!applied.applied) { log.info('sync_discarded', { connection: conn.id }); return { mode: 'full', changed: 0 }; }
  await updateCalendarSyncState(conn.id, { sync_token: encodeToken(next, now.getTime()) }, { expectCalendarId: conn.calendar_id });
  return { mode: 'full', changed: blocks.length };
}

export const failureCount = (lastError: string | null): number => Number(/^\[(\d+)\]/.exec(lastError ?? '')?.[1] ?? 0);

export type SyncOutcome = { outcome: 'synced'; mode: 'full' | 'incremental'; changed: number } | { outcome: 'skipped' | 'busy' | 'needs_reauth' | 'failed'; reason?: string };

/** Sync one connection under its lease. Coalescing: a request that finds the lease held leaves a dirty marker and the holder re-runs once. */
export async function syncConnection(connectionId: string, opts: { now?: Date } = {}): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const res = await withLease(`gcal-sync:${connectionId}`, SYNC_LEASE_MS, async () => {
    let last: SyncOutcome = { outcome: 'skipped' };
    for (let round = 0; round < 3; round++) {
      await prisma.processedEvent.deleteMany({ where: { source: 'gcal-dirty', id: connectionId } });
      last = await syncOnce(connectionId, now);
      const dirty = await prisma.processedEvent.count({ where: { source: 'gcal-dirty', id: connectionId } });
      if (!dirty || last.outcome !== 'synced') break;
    }
    return last;
  });
  if (!res.acquired) {
    await claimEvent('gcal-dirty', connectionId, 1000).catch(() => false); // leaves a marker; the holder re-runs
    return { outcome: 'busy' };
  }
  return res.value;
}

async function syncOnce(connectionId: string, now: Date): Promise<SyncOutcome> {
  const conn = await getCalendarConnectionById(connectionId);
  if (!conn || (conn.status !== 'active' && conn.status !== 'error')) return { outcome: 'skipped', reason: conn?.status ?? 'missing' };
  const biz = await prisma.business.findUnique({ where: { id: conn.business_id }, select: { timezone: true, plan: true } });
  if (biz && !planAllows(biz.plan, 'calendar_sync')) return { outcome: 'skipped', reason: 'plan' }; // the plan does not include calendar sync (admin console plans)
  const tz = tzOf(biz?.timezone);
  try {
    const r = await runSync(conn, tz, now);
    if (conn.status === 'error') await setCalendarConnectionStatus(conn.id, 'active', null); // no-op when revoked meanwhile
    await updateCalendarSyncState(conn.id, { last_sync_at: now, last_error: null }, { expectCalendarId: conn.calendar_id });
    return { outcome: 'synced', ...r };
  } catch (err) {
    if (err instanceof NeedsReauthError) return { outcome: 'needs_reauth' };
    const reason = err instanceof GoogleApiError ? `${err.status} ${err.reason}` : 'network_error';
    if (err instanceof GoogleApiError && (err.status === 403 || err.status === 404) && /forbidden|notFound|insufficient|accessNotConfigured|NOT_FOUND|PERMISSION/i.test(err.reason)) {
      await markNeedsReauth(conn.id, `calendar_${err.status}`); // calendar gone / permission withdrawn (from active AND error: stale blocks must stop gating bookings)
      return { outcome: 'needs_reauth', reason };
    }
    const n = failureCount(conn.last_error) + 1;
    log.warn('sync_failed', { connection: conn.id, failures: n, reason });
    await setCalendarConnectionStatus(conn.id, 'error', `[${n}] ${reason}`);
    if (n === 1) await recordAudit({ actor_kind: 'system', business_id: conn.business_id, action: 'calendar.sync_failed', target: `calendar:${conn.id}`, meta: { reason } });
    if (n >= FAILURES_BEFORE_REAUTH) { await markNeedsRetry(conn.id, reason); }
    return { outcome: 'failed', reason };
  }
}

async function markNeedsRetry(id: string, reason: string): Promise<void> {
  await markNeedsReauth(id, `sync_failing: ${reason}`); // transitions from 'active' and from 'error'
}
