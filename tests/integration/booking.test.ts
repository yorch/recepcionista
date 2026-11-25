/**
 * Booking integrity against a real Postgres: availability, duration-aware overlap, cancellation,
 * opening hours, DST, offset-less times and concurrent writers.
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test tests/integration
 */
import { integration } from '../helpers/env';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  ALL_WEEK, cleanup, futureDateKey, loadDb, loadPrisma, newBusiness, nextUsDstDay, phone, uniq, wall,
} from '../helpers/fixtures';
import { addDaysToDateKey, localDateKey } from '../../src/lib/time';
import type { Booking } from '../../src/lib/types';

integration('booking (postgres)', () => {
  let db: Awaited<ReturnType<typeof loadDb>>;
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let sched: typeof import('../../src/lib/scheduler');

  beforeAll(async () => {
    db = await loadDb();
    prisma = await loadPrisma();
    sched = await import('@/lib/scheduler');
  });
  afterAll(cleanup);

  const input = (business_id: string, scheduled_at: string, extra: Partial<Booking> = {}) => ({
    business_id, customer_name: 'Ana Pérez', customer_phone: phone(), service: 'AC repair',
    scheduled_at, ...extra,
  });
  const reject = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return (e as { reason?: string }).reason ?? `other:${String(e)}`; }
    return 'accepted';
  };
  // Tuesday is open in every hours config used below.
  const TUE = () => futureDateKey(2);

  test('availability lists the grid, createBooking books it, and the slot disappears', async () => {
    const b = await newBusiness();
    const day = TUE();
    const before = await sched.slotsForDate(b, day, 60);
    expect(before.map((s) => s.available)).toEqual(Array(10).fill(true)); // 08:00..17:00 starts, 1h jobs
    expect(before[0].start).toBe(utcAt(day, '08:00')); // grid starts at opening, in the business zone

    const bk = await db.createBooking(input(b.id, before[2].start));
    expect(bk.status).toBe('confirmed');
    expect(bk.scheduled_at).toBe(before[2].start);
    const after = await sched.slotsForDate(b, day, 60);
    expect(after.filter((s) => !s.available).map((s) => s.start)).toEqual([before[2].start]);
  });

  test('overlap is duration-aware; back-to-back is fine', async () => {
    const b = await newBusiness();
    const day = TUE();
    const at = (hhmm: string) => utcAt(day, hhmm);

    await db.createBooking(input(b.id, at('10:00'), { duration_minutes: 90 })); // 10:00-11:30
    expect(await reject(db.createBooking(input(b.id, at('11:00'))))).toBe('slot_taken');
    expect(await reject(db.createBooking(input(b.id, at('09:30'), { duration_minutes: 60 })))).toBe('slot_taken'); // ends 10:30
    expect(await reject(db.createBooking(input(b.id, at('09:00'), { duration_minutes: 120 })))).toBe('slot_taken');
    expect(await reject(db.createBooking(input(b.id, at('10:00'))))).toBe('slot_taken');
    // exactly adjacent on both sides
    expect(await reject(db.createBooking(input(b.id, at('11:30'))))).toBe('accepted');
    expect(await reject(db.createBooking(input(b.id, at('09:00'), { duration_minutes: 60 })))).toBe('accepted');
    // the availability grid honours the same rule for a 2h job
    const slots = await sched.slotsForDate(b, day, 120);
    const free = slots.filter((s) => s.available).map((s) => s.start);
    expect(free).not.toContain(at('08:00')); // 08:00-10:00 hits 09:00 booking
    expect(free).toContain(at('13:00'));
  });

  test('a cancelled booking frees its slot', async () => {
    const b = await newBusiness();
    const slot = utcAt(TUE(), '14:00');
    const first = await db.createBooking(input(b.id, slot));
    expect(await reject(db.createBooking(input(b.id, slot)))).toBe('slot_taken');
    await db.updateBooking(first.id, { status: 'cancelled' });
    expect((await db.createBooking(input(b.id, slot))).status).toBe('confirmed');
    // and a cancelled booking never blocks the grid
    const second = (await db.listBookings(b.id)).find((x) => x.status === 'confirmed')!;
    await db.updateBooking(second.id, { status: 'cancelled' });
    const grid = await sched.slotsForDate(b, TUE(), 60);
    expect(grid.every((s) => s.available)).toBe(true);
  });

  test('opening hours: start at close, overrun, before open, closed day and past are rejected', async () => {
    const hours = { ...ALL_WEEK, sunday: null } as unknown as typeof ALL_WEEK;
    const b = await newBusiness({ hours });
    const day = TUE();
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '18:00'))))).toBe('after_close');
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '17:30'))))).toBe('after_close'); // 60 min runs past 18:00
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '17:00'), { duration_minutes: 90 })))).toBe('after_close');
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '19:30'))))).toBe('after_close');
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '07:00'))))).toBe('before_open');
    expect(await reject(db.createBooking(input(b.id, utcAt(futureDateKey(0), '10:00'))))).toBe('closed_day');
    expect(await reject(db.createBooking(input(b.id, utcAt(day, '17:00'))))).toBe('accepted'); // ends exactly at close

    const yesterday = addDaysToDateKey(localDateKey(new Date(), 'America/New_York'), -1);
    expect(await reject(db.createBooking(input(b.id, utcAt(yesterday, '10:00'))))).toBe('past');
    expect(await reject(db.createBooking(input(b.id, new Date(Date.now() - 60_000).toISOString())))).toBe('past');
    expect(await reject(db.createBooking(input(b.id, 'not-a-date')))).toBe('invalid_time');
    expect(await reject(db.createBooking({ ...input(b.id, utcAt(day, '10:00')), business_id: '00000000-0000-0000-0000-000000000000' }))).toBe('business_not_found');
    expect(await prisma.booking.count({ where: { businessId: b.id } })).toBe(1);
  });

  test('DST spring-forward: the missing hour is skipped in the grid and wall times use the right offset', async () => {
    const day = nextUsDstDay('spring'); // a Sunday, 02:00 EST -> 03:00 EDT
    const b = await newBusiness({ hours: { ...ALL_WEEK, sunday: { open: '01:00', close: '04:00' } } as unknown as typeof ALL_WEEK });
    const slots = await sched.slotsForDate(b, day, 60, new Date(`${day}T00:00:00Z`).getTime() - 3 * 86_400_000); // clock injected: the DST day is months away, past the booking window
    // 01:00 EST = 06:00Z, 03:00 EDT = 07:00Z, closes 04:00 EDT = 08:00Z -> two real hours.
    expect(slots.map((s) => s.start)).toEqual([
      `${day}T06:00:00.000Z`, `${day}T07:00:00.000Z`,
    ]);
    // Business-day boundaries: the day before is EST (UTC-5), the DST day's 09:00 is EDT (UTC-4).
    const full = await newBusiness();
    const parsed = (await import('@/lib/time')).parseScheduledAt(wall(day, '09:00'), 'America/New_York');
    expect(parsed.ok && parsed.date.toISOString()).toBe(`${day}T13:00:00.000Z`);
    const before = (await import('@/lib/time')).parseScheduledAt(wall(addDaysToDateKey(day, -1), '09:00'), 'America/New_York');
    expect(before.ok && before.date.toISOString()).toBe(`${addDaysToDateKey(day, -1)}T14:00:00.000Z`);
    const FAR = { ownerInitiated: true }; // the DST day is months away: past the booking window an AI booking obeys
    const bk = await db.createBooking(input(full.id, `${day}T13:00:00.000Z`), FAR);
    expect(bk.scheduled_at).toBe(`${day}T13:00:00.000Z`);
    expect(await reject(db.createBooking(input(full.id, `${day}T12:30:00.000Z`), FAR))).toBe('slot_taken');
  });

  test('DST fall-back: the repeated hour yields five real hours and both 01:30s are bookable', async () => {
    const day = nextUsDstDay('fall'); // a Sunday, 02:00 EDT -> 01:00 EST
    const b = await newBusiness({ hours: { ...ALL_WEEK, sunday: { open: '00:00', close: '04:00' } } as unknown as typeof ALL_WEEK });
    const slots = await sched.slotsForDate(b, day, 60, new Date(`${day}T00:00:00Z`).getTime() - 3 * 86_400_000); // clock injected: the DST day is months away, past the booking window
    // 00:00 EDT = 04:00Z ... 04:00 EST = 09:00Z -> 5 hourly slots.
    expect(slots.map((s) => s.start)).toEqual(
      [4, 5, 6, 7, 8].map((h) => `${day}T0${h}:00:00.000Z`),
    );
    const FAR = { ownerInitiated: true }; // months ahead: past the booking window an AI booking obeys
    const eDT = await db.createBooking(input(b.id, `${day}T01:30:00-04:00`), FAR);
    const eST = await db.createBooking(input(b.id, `${day}T01:30:00-05:00`), FAR);
    expect(eDT.scheduled_at).toBe(`${day}T05:30:00.000Z`);
    expect(eST.scheduled_at).toBe(`${day}T06:30:00.000Z`);
    // an hour-long job at 01:30 EDT overlaps neither neighbour exactly but blocks 02:00 EDT-equivalent 05:45Z
    expect(await reject(db.createBooking(input(b.id, `${day}T05:45:00.000Z`), FAR))).toBe('slot_taken');
    // the offset-less 09:00 on the DST day is EST (UTC-5)
    const parsed = (await import('@/lib/time')).parseScheduledAt(wall(day, '09:00'), 'America/New_York');
    expect(parsed.ok && parsed.date.toISOString()).toBe(`${day}T14:00:00.000Z`);
  });

  test('exactly one of 20 concurrent bookings for the same slot wins (advisory lock)', async () => {
    const b = await newBusiness();
    const slot = utcAt(TUE(), '10:00');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => db.createBooking(input(b.id, slot, { customer_name: `Racer ${i}` }))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won.length).toBe(1);
    expect(lost.length).toBe(19);
    expect(lost.every((r) => (r.reason as { reason?: string }).reason === 'slot_taken')).toBe(true);
    expect(await prisma.booking.count({ where: { businessId: b.id } })).toBe(1);
  });

  test('concurrent overlapping (offset) bookings: no two rows ever overlap', async () => {
    const b = await newBusiness();
    const day = TUE();
    // 12 jobs of 90 min starting every 30 min: many mutually-overlapping candidates.
    const starts = Array.from({ length: 12 }, (_, i) => utcAt(day, `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`));
    await Promise.allSettled(starts.map((s) => db.createBooking(input(b.id, s, { duration_minutes: 90 }))));
    const rows = await prisma.booking.findMany({ where: { businessId: b.id }, orderBy: { scheduledAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < rows.length; i++) {
      const prevEnd = rows[i - 1].scheduledAt.getTime() + rows[i - 1].durationMinutes * 60_000;
      expect(rows[i].scheduledAt.getTime()).toBeGreaterThanOrEqual(prevEnd);
    }
  });

  test('the exclusion constraint is a real backstop when the advisory lock is bypassed', async () => {
    const b = await newBusiness();
    const slot = new Date(utcAt(TUE(), '11:00'));
    const row = (extra: Record<string, unknown> = {}) => ({
      businessId: b.id, customerName: 'Raw', customerPhone: phone(), service: 'x', scheduledAt: slot, durationMinutes: 60, ...extra,
    });
    await prisma.booking.create({ data: row() });
    let message = '';
    try { await prisma.booking.create({ data: row({ scheduledAt: new Date(slot.getTime() + 30 * 60_000) }) }); } catch (e) { message = String(e); }
    expect(message).toMatch(/23P01|bookings_no_overlap|exclusion/i);
    // cancelled rows are outside the constraint
    await prisma.booking.create({ data: row({ status: 'cancelled' }) });
  });

  test('offset-less scheduled_at through the voice tool is read as business-zone wall time', async () => {
    const tools = await import('@/lib/voice/tools');
    const ny = await newBusiness();
    const la = await newBusiness({ timezone: 'America/Los_Angeles' });
    const dayNy = TUE();
    const dayLa = futureDateKey(2, 'America/Los_Angeles');

    const a = await tools.createBooking({ business_id: ny.id, conversation_id: uniq('conv'), customer_name: 'N', customer_phone: phone(), service: 'AC repair', scheduled_at: wall(dayNy, '10:00') });
    expect(a.ok).toBe(true);
    const c = await tools.createBooking({ business_id: la.id, conversation_id: uniq('conv'), customer_name: 'L', customer_phone: phone(), service: 'AC repair', scheduled_at: wall(dayLa, '10:00') });
    expect(c.ok).toBe(true);
    const nyRow = (await db.listBookings(ny.id))[0];
    const laRow = (await db.listBookings(la.id))[0];
    // 10:00 wall time: NY is UTC-4/-5, LA is UTC-7/-8 -> the instants differ by 3h for the same wall clock.
    expect(new Date(nyRow.scheduled_at).getUTCHours()).toBeOneOf([14, 15]);
    expect(new Date(laRow.scheduled_at).getUTCHours()).toBeOneOf([17, 18]);
    // an explicit offset wins over the zone
    const e = await tools.createBooking({ business_id: ny.id, conversation_id: uniq('conv'), customer_name: 'N', customer_phone: phone(), service: 'AC repair', scheduled_at: `${dayNy}T13:00:00Z` });
    expect(e.ok).toBe(true);
    expect((await db.listBookings(ny.id)).map((x) => x.scheduled_at)).toContain(`${dayNy}T13:00:00.000Z`);
    // garbage is refused with a re-ask, not booked
    const bad = await tools.createBooking({ business_id: ny.id, conversation_id: uniq('conv'), customer_name: 'N', customer_phone: phone(), service: 'AC repair', scheduled_at: 'tomorrow at ten' });
    expect(bad.ok).toBe(false);
  });
});

function offsetFor(dateKey: string): string {
  // Offset (as +/-hh:mm) of America/New_York at noon that day, via the app's own zone maths.
  const noon = new Date(`${dateKey}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(noon);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  return name.replace('GMT', '') || 'Z';
}

/** UTC ISO for a New York wall-clock time (computed independently of the app's own time module). */
function utcAt(dateKey: string, hhmm: string): string {
  return new Date(`${dateKey}T${hhmm}:00${offsetFor(dateKey)}`).toISOString();
}
