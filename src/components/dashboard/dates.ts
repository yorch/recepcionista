/**
 * Business-timezone date helpers for dashboard pages. Everything here takes the business's IANA zone
 * (tzOf(business)); nothing reads the server's local zone, which is UTC in the container.
 * `locale` selects the language and conventions of the output ('en' default, 'es' for the Spanish dashboard).
 */
import { intlTag, type Locale } from '@/lib/i18n/core';
import { partsInTz } from '@/lib/time';

/** "Monday, November 23" / "lunes, 23 de noviembre" for the instant, in `tz`. */
export function longDate(at: Date | string, tz: string, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(new Date(at));
}

/** "Mon, Nov 23" / "lun, 23 nov" for a YYYY-MM-DD key (a calendar date, not an instant: zone-independent). */
export function dateKeyLabel(dateKey: string, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

/** Greeting by the business's local hour ("Buenos días" in Spanish, "Good morning" in English). */
export function greetingFor(at: Date, tz: string, locale: Locale = 'es'): string {
  const { hour } = partsInTz(at, tz);
  if (locale === 'en') return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';
}

/**
 * "Nov 24, 2026, 3:05 PM UTC" for an instant: a FIXED zone (UTC) and a locale chosen by the request (the same on the server render and
 * in the browser, so no hydration mismatch; `toLocaleString()` used each side's own locale/zone and caused them).
 */
export function utcStamp(iso: string, locale: Locale = 'en'): string {
  return `${new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso))} UTC`;
}

/** "Nov 24, 2026" in UTC (hydration-safe, see utcStamp). */
export function utcDate(iso: string, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}
