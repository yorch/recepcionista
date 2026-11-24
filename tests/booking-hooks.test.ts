/** The hook registry and the mock Google calendar are process-wide singletons even if the bundler loads their modules more than once. */
import { expect, test } from 'bun:test';

test('two copies of booking-hooks share one handler registry (the end-to-end run lost every Google push to a per-bundle Map)', async () => {
  const a = await import('../src/lib/booking-hooks');
  const b = (await import(['../src/lib/booking-hooks', 'second-copy'].join('?'))) as typeof a;
  expect(b.onBookingChanged).not.toBe(a.onBookingChanged); // really two module instances
  const seen: string[] = [];
  a.onBookingChanged('t-singleton', ({ bookingId }) => { seen.push(bookingId); });
  await b.emitBookingChanged('bk1', 'created');
  expect(seen).toEqual(['bk1']);
  a.clearBookingHandlers();
});

test('two copies of the mock Google share one calendar', async () => {
  const a = await import('../src/lib/integrations/google/mock');
  const b = (await import(['../src/lib/integrations/google/mock', 'second-copy'].join('?'))) as typeof a;
  const id = a.addMockGoogleEvent('cal-x', { start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z' });
  const res = await b.mockGoogleFetch('https://www.googleapis.com/calendar/v3/calendars/cal-x/events');
  const body = await res.json() as { items: { id: string }[] };
  expect(body.items.map((e) => e.id)).toContain(id);
  expect(b.deleteMockGoogleEvent('cal-x', id)).toBe(true);
  a.resetMockGoogle();
});
