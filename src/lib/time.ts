/**
 * The one time-zone module. Every wall-clock <-> instant conversion goes through
 * here, using the BUSINESS's IANA zone, never the process zone (which is UTC in
 * the container). DST-correct via Intl.DateTimeFormat; no dependencies.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A business's zone (or a zone string), falling back to the default if unset/invalid. */
export function tzOf(source?: { timezone?: string | null } | string | null): string {
  const tz = typeof source === 'string' ? source : source?.timezone;
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function toMs(input: Date | number | string): number {
  return input instanceof Date ? input.getTime() : typeof input === 'number' ? input : new Date(input).getTime();
}

export interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  /** 0 = Sunday ... 6 = Saturday (JS getDay convention) */
  weekday: number;
  /** YYYY-MM-DD in the zone */
  dateKey: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Wall-clock components of an instant in `tz`. */
export function partsInTz(input: Date | number | string, tz: string): ZonedParts {
  const ms = toMs(input);
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  const hour = (out.hour ?? 0) % 24;
  const weekday = new Date(Date.UTC(out.year, out.month - 1, out.day)).getUTCDay();
  return {
    year: out.year, month: out.month, day: out.day,
    hour, minute: out.minute ?? 0, second: out.second ?? 0, weekday,
    dateKey: `${pad(out.year, 4)}-${pad(out.month)}-${pad(out.day)}`,
  };
}

/** UTC offset of `tz` at an instant, in ms (east of UTC positive). */
export function tzOffsetMs(input: Date | number, tz: string): number {
  const ms = toMs(input);
  const p = partsInTz(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function localDateKey(input: Date | number | string, tz: string): string {
  return partsInTz(input, tz).dateKey;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD that is also a real calendar date. */
export function isDateKey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_KEY_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const m = DATE_KEY_RE.exec(dateKey);
  if (!m) throw new RangeError(`bad date key: ${dateKey}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Day of week (0 = Sunday) of a calendar date, independent of any zone. */
export function dayOfWeek(dateKey: string): number {
  const m = DATE_KEY_RE.exec(dateKey);
  if (!m) throw new RangeError(`bad date key: ${dateKey}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export function parseHhmm(hhmm: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return { h, m: mi };
}

/**
 * The instant at which the wall clock in `tz` reads dateKey + hhmm.
 * - Ambiguous (fall-back) times resolve to the earlier instant.
 * - Non-existent (spring-forward) times resolve forward, e.g. 02:30 -> 03:30.
 */
export function zonedTimeToUtc(dateKey: string, hhmm: string | { h: number; m: number }, tz: string, seconds = 0): Date {
  const dm = DATE_KEY_RE.exec(dateKey);
  const hm = typeof hhmm === 'string' ? parseHhmm(hhmm) : hhmm;
  if (!dm || !hm) throw new RangeError(`bad wall time: ${dateKey} ${JSON.stringify(hhmm)}`);
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), hm.h, hm.m, seconds);
  const offsets = new Set([tzOffsetMs(guess - 86_400_000, tz), tzOffsetMs(guess + 86_400_000, tz)]);
  const valid = [...offsets]
    .map((o) => guess - o)
    .filter((cand) => tzOffsetMs(cand, tz) === guess - cand);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Inside a spring-forward gap: use the pre-transition offset so the time moves forward.
  return new Date(guess - tzOffsetMs(guess - 86_400_000, tz));
}

/** UTC bounds [gte, lt) of the local calendar day `dateKey` in `tz` (23/25h on DST days). */
export function dayRange(dateKey: string, tz: string): { gte: Date; lt: Date } {
  return {
    gte: zonedTimeToUtc(dateKey, '00:00', tz),
    lt: zonedTimeToUtc(addDaysToDateKey(dateKey, 1), '00:00', tz),
  };
}

// ------------------------------------------------------------------ parsing

export type ParsedWhen =
  | { ok: true; date: Date; assumedZone: boolean }
  | { ok: false; reason: 'empty' | 'missing_time' | 'unparseable' };

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parse the `scheduled_at` the voice agent sends. A string WITH an offset/Z is an
 * absolute instant. A string WITHOUT one ("2026-11-24T10:00:00") is wall-clock time
 * in the BUSINESS zone — never UTC, never the server zone. Anything else is rejected
 * so the agent re-asks instead of booking a wrong time.
 */
export function parseScheduledAt(raw: unknown, tz: string): ParsedWhen {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, reason: 'empty' };
  if (isDateKey(s)) return { ok: false, reason: 'missing_time' };
  const m = WHEN_RE.exec(s);
  if (!m) return { ok: false, reason: 'unparseable' };
  const dateKey = `${m[1]}-${m[2]}-${m[3]}`;
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] ? Number(m[6]) : 0;
  if (!isDateKey(dateKey) || h > 23 || mi > 59 || sec > 59) return { ok: false, reason: 'unparseable' };

  const off = m[7];
  if (!off) {
    return { ok: true, date: zonedTimeToUtc(dateKey, { h, m: mi }, tz, sec), assumedZone: true };
  }
  let offsetMin = 0;
  if (off.toUpperCase() !== 'Z') {
    const digits = off.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 23 || om > 59) return { ok: false, reason: 'unparseable' };
    offsetMin = (off[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, sec) - offsetMin * 60_000;
  return { ok: true, date: new Date(utc), assumedZone: false };
}

// --------------------------------------------------------------- formatting

export function offsetLabel(input: Date | number, tz: string): string {
  const mins = Math.round(tzOffsetMs(input, tz) / 60_000);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "3:05 PM" / "10 AM" style clock used by the voice agent. */
export function spokenTimeInTz(input: Date | number | string, tz: string): string {
  const { hour, minute } = partsInTz(input, tz);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return minute === 0 ? `${h12} ${ampm}` : `${h12}:${pad(minute)} ${ampm}`;
}

/**
 * One paragraph for the agent's prompt / dynamic variables: current date, time and zone,
 * and the exact format tools expect. (Agent B's prompt builder should include it.)
 */
export function describeNow(
  business?: { timezone?: string | null } | string | null,
  now: Date = new Date(),
): string {
  const tz = tzOf(business);
  const p = partsInTz(now, tz);
  const long = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(now);
  const tomorrow = addDaysToDateKey(p.dateKey, 1);
  return [
    `Current date and time: ${long}, ${spokenTimeInTz(now, tz)} (${tz}, ${offsetLabel(now, tz)}). Today is ${p.dateKey}.`,
    `Everything you say and every time you pass to a tool is in ${tz}.`,
    `For tools, give scheduled_at as local wall-clock time like "${tomorrow}T10:00:00" (no UTC offset needed) and date as "YYYY-MM-DD".`,
    'Work out "tomorrow", "Friday", "next week" from today\'s date above; never guess a date.',
  ].join(' ');
}

/** Same facts as discrete dynamic variables (ElevenLabs `dynamic_variables`). */
export function nowVariables(
  business?: { timezone?: string | null } | string | null,
  now: Date = new Date(),
): { current_date: string; current_time: string; current_weekday: string; timezone: string; current_datetime: string } {
  const tz = tzOf(business);
  const p = partsInTz(now, tz);
  return {
    current_date: p.dateKey,
    current_time: `${pad(p.hour)}:${pad(p.minute)}`,
    current_weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now),
    timezone: tz,
    current_datetime: describeNow(business, now),
  };
}
