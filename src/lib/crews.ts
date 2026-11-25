/**
 * Crew assignment (pure). A business runs `crews` (1..20) parallel crews; a booking occupies one of them. The database exclusion constraint is
 * per (business, crew), so two jobs may overlap only when they are on different crews. With `crews = 1` (the default) everything behaves as before.
 */
export const MIN_CREWS = 1;
export const MAX_CREWS = 20;

export interface CrewBusy { crew: number; start: number; end: number }

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Valid crew count, else the default of 1. */
export function normalizeCrews(n: unknown): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v >= MIN_CREWS && v <= MAX_CREWS ? v : 1;
}

/**
 * The crew a new [start, end) job should go to: `preferred` if it is within 1..crews and free, otherwise the lowest-numbered free crew, otherwise
 * null (every crew is busy). `busy` holds non-cancelled bookings (any crew); `ignore` leaves one booking out (a reschedule must not clash with itself).
 */
export function firstFreeCrew(
  crews: number,
  candidate: { start: number; end: number },
  busy: readonly CrewBusy[],
  preferred?: number | null,
): number | null {
  const n = normalizeCrews(crews);
  const free = (crew: number) => !busy.some((b) => b.crew === crew && overlaps(candidate, b));
  if (preferred != null && Number.isInteger(preferred) && preferred >= 1 && preferred <= n && free(preferred)) return preferred;
  for (let crew = 1; crew <= n; crew++) if (free(crew)) return crew;
  return null;
}

/** Does [start, end) still fit on some crew? (Slot offering with several crews: a slot is available while at least one crew is free.) */
export function hasFreeCrew(crews: number, candidate: { start: number; end: number }, busy: readonly CrewBusy[]): boolean {
  return firstFreeCrew(crews, candidate, busy) !== null;
}
