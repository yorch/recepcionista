/**
 * Loaded by bunfig.toml before ANY test file. With TEST_DATABASE_URL set it points DATABASE_URL at the
 * (safety-checked) test database up front. Several test files import modules that construct the shared
 * Prisma client while the files are being loaded; without this, whichever file loads first (some of them
 * default DATABASE_URL to a dummy URL) would pin the client to the wrong database for the whole run.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { /* handled below */ }
  if (!/(test|scratch)/i.test(name)) {
    throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
  }
  process.env.DATABASE_URL = url;
}
