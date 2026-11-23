/**
 * Business-timezone date helpers for dashboard pages. Everything here takes the business's IANA zone
 * (tzOf(business)); nothing reads the server's local zone, which is UTC in the container.
 */
import { partsInTz } from '@/lib/time';

/** "Monday, November 23" for the instant, in `tz`. */
export function longDate(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(new Date(at));
}

/** "Mon, Nov 23" for a YYYY-MM-DD key (a calendar date, not an instant: zone-independent). */
export function dateKeyLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

/** Spanish-first greeting by the business's local hour. */
export function greetingFor(at: Date, tz: string): string {
  const { hour } = partsInTz(at, tz);
  return hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';
}
