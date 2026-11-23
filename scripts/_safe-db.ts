/**
 * Guard for scripts that wipe or rewrite data (seed, smoke, ws*-test).
 *
 * Refuses to continue unless DATABASE_URL names a database that looks disposable
 * (its name contains "dev", "test", "scratch" or "local"), or `--force-i-know` is passed.
 * Always prints the target first so a wrong .env is obvious BEFORE anything is deleted.
 */
export const FORCE_FLAG = '--force-i-know';
const SAFE_NAME = /(dev|test|scratch|local)/i;

export function dbTarget(url: string | undefined): { name: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { name: decodeURIComponent(u.pathname.replace(/^\//, '')), host: u.host.replace(/^[^@]*@/, '') };
  } catch {
    return null;
  }
}

export function isSafeDbName(name: string): boolean {
  return SAFE_NAME.test(name);
}

/** Args to forward to a child script (e.g. ws*-test -> seed.ts) so the same decision applies. */
export const forwardedArgs = (): string[] => (process.argv.includes(FORCE_FLAG) ? [FORCE_FLAG] : []);

export function assertSafeDatabase(script: string): void {
  const target = dbTarget(process.env.DATABASE_URL);
  if (!target) {
    console.error(`[${script}] DATABASE_URL is missing or not a valid URL; refusing to run.`);
    process.exit(2);
  }
  console.log(`[${script}] target database: "${target.name}" on ${target.host} -- this script WIPES or rewrites its data`);
  if (isSafeDbName(target.name)) return;
  if (process.argv.includes(FORCE_FLAG)) {
    console.warn(`[${script}] WARNING: "${target.name}" does not look disposable; continuing because ${FORCE_FLAG} was passed.`);
    return;
  }
  console.error(
    `[${script}] REFUSING to run: database "${target.name}" does not contain "dev", "test", "scratch" or "local".\n`
    + `  Point DATABASE_URL at a disposable database (e.g. recepcionista_dev), or pass ${FORCE_FLAG} if you really mean it.`,
  );
  process.exit(2);
}
