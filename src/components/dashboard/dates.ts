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

/**
 * "Nov 24, 2026, 3:05 PM UTC" for an instant: a FIXED locale and zone, so the server render and the browser agree
 * (`toLocaleString()` uses each side's own locale/zone and caused hydration mismatches).
 */
export function utcStamp(iso: string): string {
  return `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;
}

/** "Nov 24, 2026" in UTC (hydration-safe, see utcStamp). */
export function utcDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}
