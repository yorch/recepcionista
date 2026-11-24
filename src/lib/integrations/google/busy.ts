/**
 * Calendar busy time as the scheduler sees it. Imports only the db client (no '@/lib/db' index) so db/index.ts can use it inside
 * the booking transaction without an import cycle.
 *
 * Trust rules: blocks count only while the connection is healthy ('active', or 'error' = Google briefly unreachable: the last known
 * blocks stay in force; staleness tolerance is documented in docs/integrations/google-calendar.md). 'needs_reauth' / 'revoked'
 * connections are IGNORED (fail open: a broken link must never make the receptionist refuse every booking) and the dashboard warns.
 * The per-business "block on busy events" switch defaults to ON.
 */
import type { DbClient } from '@/lib/db/client';
import { prisma } from '@/lib/db/client';

export const HEALTHY = ['active', 'error'] as const;
export const SETTINGS_ACTION = 'calendar.settings_changed';

/**
 * The switch is the `calendar_connections.block_on_busy` column (it used to be derived from the latest `calendar.settings_changed` audit
 * event; the integration-gaps migration moved and backfilled it). No connection = the default (on). Every change is still audited.
 */
export async function getBlockOnBusy(businessId: string, db: DbClient = prisma): Promise<boolean> {
  const conn = await db.calendarConnection.findUnique({ where: { businessId_provider: { businessId, provider: 'google' } }, select: { blockOnBusy: true } });
  return conn?.blockOnBusy ?? true;
}

async function effective(businessId: string, db: DbClient): Promise<{ id: string } | null> {
  const conn = await db.calendarConnection.findUnique({ where: { businessId_provider: { businessId, provider: 'google' } }, select: { id: true, status: true, blockOnBusy: true } });
  if (!conn || !(HEALTHY as readonly string[]).includes(conn.status)) return null;
  return conn.blockOnBusy ? { id: conn.id } : null;
}

/** Busy [start,end) ms intervals of the owner's calendar intersecting the range (opaque events only). Empty when not applicable. */
export async function calendarBusyIntervals(businessId: string, fromMs: number, toMs: number, db: DbClient = prisma): Promise<{ start: number; end: number }[]> {
  const conn = await effective(businessId, db);
  if (!conn) return [];
  const rows = await db.calendarBusyBlock.findMany({
    where: { connectionId: conn.id, transparency: 'opaque', startsAt: { lt: new Date(toMs) }, endsAt: { gt: new Date(fromMs) } },
    select: { startsAt: true, endsAt: true }, take: 5000,
  });
  return rows.map((r) => ({ start: r.startsAt.getTime(), end: r.endsAt.getTime() }));
}

/** Does [startMs, endMs) overlap a busy block? Used INSIDE the booking transaction (pass the tx client). */
export async function calendarBusyConflict(db: DbClient, businessId: string, startMs: number, endMs: number): Promise<boolean> {
  return (await calendarBusyIntervals(businessId, startMs, endMs, db)).some((b) => b.start < endMs && startMs < b.end);
}
