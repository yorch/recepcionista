/** Privacy: remove the pushed Google events of erased / purged bookings. Durable: a failed deletion keeps its link and is retried by the job. */
import { prisma } from '@/lib/db/client';
import { deleteEventLink, getCalendarConnectionById } from '@/lib/db/calendar';
import { logger } from '@/lib/log';
import { calPath, gcal } from './api';

const log = logger('gcal.privacy');

async function redactLinks(links: { bookingId: string; connectionId: string; googleEventId: string }[]): Promise<{ deleted: number; pending: number }> {
  let deleted = 0, pending = 0;
  for (const l of links) {
    try {
      const conn = await getCalendarConnectionById(l.connectionId);
      if (!conn || conn.status === 'revoked') { await deleteEventLink(l.bookingId); deleted++; continue; } // nothing reachable to delete
      const res = await gcal(conn.id, 'DELETE', `${calPath(conn.calendar_id)}/events/${encodeURIComponent(l.googleEventId)}`);
      if (res.ok || res.status === 404 || res.status === 410) { await deleteEventLink(l.bookingId); deleted++; } else pending++;
    } catch (err) { pending++; log.warn('redact_failed', { booking: l.bookingId, err }); }
  }
  return { deleted, pending };
}

/** Delete the Google events pushed for these bookings (customer erasure). Call after the erasure commits. Never throws. */
export async function redactCalendarEventsForBookings(bookingIds: string[]): Promise<{ deleted: number; pending: number }> {
  try {
    if (bookingIds.length === 0) return { deleted: 0, pending: 0 };
    const links = await prisma.calendarEventLink.findMany({ where: { bookingId: { in: bookingIds } }, select: { bookingId: true, connectionId: true, googleEventId: true } });
    return await redactLinks(links);
  } catch (err) { log.error('redact_failed', { err }); return { deleted: 0, pending: 0 }; }
}

/** Every link whose booking has been anonymised (retention purge, erasure, anything else): delete its event. Idempotent sweep. */
export async function redactAnonymizedBookingEvents(limit = 200): Promise<{ deleted: number; pending: number }> {
  try {
    const links = await prisma.calendarEventLink.findMany({
      where: { booking: { anonymizedAt: { not: null } } }, take: limit, select: { bookingId: true, connectionId: true, googleEventId: true },
    });
    return await redactLinks(links);
  } catch (err) { log.error('redact_sweep_failed', { err }); return { deleted: 0, pending: 0 }; }
}
