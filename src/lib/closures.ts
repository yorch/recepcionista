/**
 * Holiday closures: a bounded list of YYYY-MM-DD dates in the BUSINESS time zone (businesses.closed_dates). Pure helpers.
 * A listed date has no opening window, so no slot, booking, reschedule or "open now" decision can land on it.
 */
import { isDateKey } from './time';

export const MAX_CLOSED_DATES = 366;

/** Sorted, de-duplicated, valid keys; `null` when the input is not a list of at most 366 real calendar dates. */
export function normalizeClosedDates(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CLOSED_DATES) return null;
  const out = new Set<string>();
  for (const d of raw) {
    if (typeof d !== 'string' || !isDateKey(d)) return null;
    out.add(d);
  }
  if (out.size > MAX_CLOSED_DATES) return null;
  return [...out].sort();
}

/** The stored jsonb value as a clean list (anything malformed reads as "no closures": availability must never throw on bad data). */
export function closedDatesOf(raw: unknown): string[] {
  return normalizeClosedDates(raw) ?? [];
}

export const isClosedDate = (closed: readonly string[] | null | undefined, dateKey: string): boolean => Boolean(closed && closed.length && closed.includes(dateKey));
