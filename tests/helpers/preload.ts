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
