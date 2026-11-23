/**
 * Money is INTEGER CENTS everywhere in the database and in code
 * (bookings.price_estimate, bookings.deposit_amount, briefing stats.revenue,
 * payment amount_cents). Convert only at the edges (agent input, display).
 * Service.base_price (catalog JSON) is the one dollar-denominated value.
 */

/** Dollars (maybe fractional, maybe a "$1,234.50" string) -> integer cents. NaN-safe: returns null. */
export function dollarsToCents(dollars: number | string | null | undefined): number | null {
  if (dollars == null) return null;
  const n = typeof dollars === 'number'
    ? dollars
    : Number(String(dollars).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** "$189", "$1,234.50" — cents in, display string out. */
export function formatCents(cents: number | null | undefined, opts: { fractionalAlways?: boolean } = {}): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const rounded = Math.round(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const dollars = abs / 100;
  const whole = abs % 100 === 0 && !opts.fractionalAlways;
  const body = dollars.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return `${negative ? '-' : ''}$${body}`;
}
