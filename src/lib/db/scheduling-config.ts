/**
 * Scheduling configuration (slot grid, lead time, horizon, buffer, crews), the editable time zone and crew-aware helpers.
 * Defaults equal the previous hard-coded behaviour (see DEFAULT_SCHEDULING), so a business that never touches them behaves exactly as before.
 * This file holds storage + validation only; Phase 2 wires the values into scheduler.ts / availability / booking validation.
 */
import { prisma } from './client';
import { toBusiness } from './index';
import { schedulingOf, validateSchedulingPatch, validateTimeZone, type SchedulingConfig } from '@/lib/business-config';
import { bookingInterval, MAX_DURATION_MIN } from '@/lib/availability';
import { firstFreeCrew, type CrewBusy } from '@/lib/crews';
import { logger } from '@/lib/log';
import type { Business, ID } from '@/lib/types';

const log = logger('db.scheduling');

export async function getSchedulingConfig(businessId: ID): Promise<SchedulingConfig | null> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  return row ? schedulingOf(toBusiness(row)) : null;
}

export type SetSchedulingResult =
  | { ok: true; config: SchedulingConfig; business: Business }
  | { ok: false; reason: 'invalid' | 'not_found' | 'crew_in_use'; error?: string };

/**
 * Change any subset of the scheduling configuration (validated; unknown keys refused). Lowering `crews` is refused ('crew_in_use') while a
 * non-cancelled booking that has not ended yet sits on a crew above the new count: move it first (never silently dropped or re-assigned).
 */
export async function setSchedulingConfig(businessId: ID, patch: unknown, now: Date = new Date()): Promise<SetSchedulingResult> {
  const v = validateSchedulingPatch(patch);
  if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
  const p = v.value;
  if (Object.keys(p).length === 0) {
    const row = await prisma.business.findUnique({ where: { id: businessId } });
    return row ? { ok: true, config: schedulingOf(toBusiness(row)), business: toBusiness(row) } : { ok: false, reason: 'not_found' };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`; // same lock createBooking takes: no booking lands between the check and the update
    const cur = await tx.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!cur) return { ok: false, reason: 'not_found' } as const;
    if (p.crews !== undefined) {
      const stuck = await tx.booking.count({
        where: { businessId, status: { not: 'cancelled' }, crew: { gt: p.crews }, scheduledAt: { gte: new Date(now.getTime() - MAX_DURATION_MIN * 60_000) } },
      });
      if (stuck > 0) return { ok: false, reason: 'crew_in_use', error: `${stuck} upcoming booking(s) are assigned to a crew above ${p.crews}` } as const;
    }
    const row = await tx.business.update({
      where: { id: businessId },
      data: {
        ...(p.slot_minutes !== undefined ? { slotMinutes: p.slot_minutes } : {}),
        ...(p.min_lead_minutes !== undefined ? { minLeadMinutes: p.min_lead_minutes } : {}),
        ...(p.horizon_days !== undefined ? { horizonDays: p.horizon_days } : {}),
        ...(p.buffer_minutes !== undefined ? { bufferMinutes: p.buffer_minutes } : {}),
        ...(p.crews !== undefined ? { crews: p.crews } : {}),
      },
    });
    log.info('scheduling.set', { business: businessId, fields: Object.keys(p) });
    return { ok: true, config: schedulingOf(toBusiness(row)), business: toBusiness(row) } as const;
  });
}

export type SetTimeZoneResult = { ok: true; timezone: string } | { ok: false; reason: 'invalid' | 'not_found'; error?: string };

/**
 * Change the business time zone (IANA names only). Existing bookings are absolute instants and do not move; only how hours, slots and texts
 * are expressed changes. The `closed_dates` and `hours` are wall-clock values in the NEW zone from now on (the owner should re-check them).
 */
export async function setBusinessTimeZone(businessId: ID, timezone: unknown): Promise<SetTimeZoneResult> {
  const v = validateTimeZone(timezone);
  if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
  const res = await prisma.business.updateMany({ where: { id: businessId }, data: { timezone: v.value } });
  if (res.count !== 1) return { ok: false, reason: 'not_found' };
  log.info('timezone.set', { business: businessId, timezone: v.value });
  return { ok: true, timezone: v.value };
}

/** Non-cancelled bookings (with their crew) that intersect [fromMs, toMs): the input of crew-aware slot maths (see crews.hasFreeCrew). One ranged query. */
export async function listBlockingIntervalsByCrew(businessId: ID, fromMs: number, toMs: number): Promise<CrewBusy[]> {
  const rows = await prisma.booking.findMany({
    where: { businessId, status: { not: 'cancelled' }, scheduledAt: { gte: new Date(fromMs - MAX_DURATION_MIN * 60_000), lt: new Date(toMs) } },
    select: { scheduledAt: true, durationMinutes: true, crew: true },
  });
  return rows
    .map((b) => ({ crew: b.crew, ...bookingInterval({ scheduled_at: b.scheduledAt.toISOString(), duration_minutes: b.durationMinutes }) }))
    .filter((iv) => iv.end > fromMs && iv.start < toMs);
}

/**
 * The first crew (1..crews) that is free for [startMs, endMs), or null when every crew is busy. Read-only (createBooking does the same inside its
 * transaction and is the authority); `ignoreBookingId` leaves one booking out (checking a move of that booking), `preferred` is tried first.
 */
export async function firstFreeCrewFor(
  businessId: ID, startMs: number, endMs: number, opts: { ignoreBookingId?: ID; preferred?: number | null } = {},
): Promise<number | null> {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { crews: true } });
  if (!biz) return null;
  const busy = (await listBlockingIntervalsByCrewExcluding(businessId, startMs, endMs, opts.ignoreBookingId));
  return firstFreeCrew(biz.crews, { start: startMs, end: endMs }, busy, opts.preferred ?? null);
}

async function listBlockingIntervalsByCrewExcluding(businessId: ID, fromMs: number, toMs: number, ignoreId?: ID): Promise<CrewBusy[]> {
  const rows = await prisma.booking.findMany({
    where: {
      businessId, status: { not: 'cancelled' }, ...(ignoreId ? { id: { not: ignoreId } } : {}),
      scheduledAt: { gte: new Date(fromMs - MAX_DURATION_MIN * 60_000), lt: new Date(toMs) },
    },
    select: { scheduledAt: true, durationMinutes: true, crew: true },
  });
  return rows.map((b) => ({ crew: b.crew, ...bookingInterval({ scheduled_at: b.scheduledAt.toISOString(), duration_minutes: b.durationMinutes }) }));
}
