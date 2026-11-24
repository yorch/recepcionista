/** Wires booking changes to the Google push. Started once from instrumentation.ts (Node only). */
import { onBookingChanged } from '@/lib/booking-hooks';
import { logger } from '@/lib/log';
import { googleConfigured } from './google/config';
import { pushBooking } from './google/push';

const log = logger('gcal');
let registered = false;

export function registerGoogleCalendar(): void {
  if (registered) return;
  registered = true;
  // Fire-and-forget: the booking flow (a live phone call) must not wait for Google. pushBooking never throws; the 15-minute reconcile job retries.
  onBookingChanged('google-calendar', ({ bookingId }) => { void pushBooking(bookingId); });
  log.info('registered', { configured: googleConfigured() });
}
