/**
 * Cursor pagination primitives shared by the list helpers. A page is `{ items, next_cursor }`; `next_cursor` is an opaque
 * string (`<iso>~<id>` for time-ordered lists, the date for briefings) that the next call passes back as `cursor`.
 * Keyset (not offset) paging: stable while rows are inserted, and every page is one indexed range scan.
 */
export interface Page<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  next_cursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
/** Ceiling for the legacy "give me the list" helpers (listCalls/listBookings/listSms): bounded, never unlimited. */
export const MAX_LIST = 1000;

export function clampLimit(raw: unknown, fallback: number = DEFAULT_PAGE_SIZE, max: number = MAX_PAGE_SIZE): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export interface TimeCursor { at: Date; id: string }

export const encodeTimeCursor = (at: Date, id: string): string => `${at.toISOString()}~${id}`;

/** Strict parse of `<iso>~<id>`; null when malformed (callers treat that as "no cursor", never as an error that leaks). */
export function parseTimeCursor(raw: unknown): TimeCursor | null {
  if (typeof raw !== 'string' || raw.length > 120) return null;
  const k = raw.indexOf('~');
  if (k < 1) return null;
  const at = new Date(raw.slice(0, k));
  const id = raw.slice(k + 1);
  if (Number.isNaN(at.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { at, id };
}

/** Build a Page from `limit + 1` fetched rows. */
export function toPage<R, T>(rows: R[], limit: number, map: (r: R) => T, cursorOf: (r: R) => string): Page<T> {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  return { items: slice.map(map), next_cursor: more && slice.length > 0 ? cursorOf(slice[slice.length - 1]) : null };
}
