/**
 * Loaded by bunfig.toml before ANY test file. With TEST_DATABASE_URL set it points DATABASE_URL at the
 * (safety-checked) test database up front. Several test files import modules that construct the shared
 * Prisma client while the files are being loaded; without this, whichever file loads first (some of them
 * default DATABASE_URL to a dummy URL) would pin the client to the wrong database for the whole run.
 */
const url = process.env.TEST_DATABASE_URL;
// The database-backed tests skip themselves without TEST_DATABASE_URL (convenient locally). In CI a skipped
// suite would turn the build green with no database coverage (a renamed secret, a dropped env line), so fail loudly.
const ci = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());
if (ci && !url) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the database-backed tests would be skipped silently. '
    + 'Set TEST_DATABASE_URL (a database whose name contains "test" or "scratch"), or unset CI to run only the unit tests.');
}
if (url) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { /* handled below */ }
  if (!/(test|scratch)/i.test(name)) {
    throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
  }
  process.env.DATABASE_URL = url;
  // Lets tests count the SQL statements a code path runs (src/lib/db/client.ts recordQueries). Never set in production.
  process.env.PRISMA_QUERY_EVENTS = '1';
}

// TEST_CLOCK_SHIFT_HOURS=<n>: run the suite as if the wall clock were n hours later (Date.now() and a bare `new Date()` only; explicit dates are untouched). Tests must
// not depend on the time of day they run at (CI runs at any hour): `for h in 0 3 6 9 12 15 18 21; do TEST_CLOCK_SHIFT_HOURS=$h bun test <file>; done` proves it.
const shiftHours = Number(process.env.TEST_CLOCK_SHIFT_HOURS ?? '');
if (Number.isFinite(shiftHours) && shiftHours !== 0) {
  const shiftMs = shiftHours * 3_600_000;
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (args.length === 0) super(RealDate.now() + shiftMs); else super(...(args as [any]));
    }
    static now(): number { return RealDate.now() + shiftMs; }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
}
