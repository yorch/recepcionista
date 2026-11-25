/**
 * Migration 20261207120000_review16_fixes: upgrades a POPULATED database that is at the previous migration (owner replies in every state, a transferred call
 * with pending forward seconds), keeps every row, accepts the new 'uncertain' status, validates every CHECK, is re-runnable, and leaves zero drift between
 * prisma/migrations and schema.prisma.
 *
 * Skipped unless TEST_DATABASE_URL names a disposable database containing "test" or "scratch" (it creates and drops scratch_mig_* databases on the same server).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
const suite = url ? describe : describe.skip;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');
const PRISMA = path.join(ROOT, 'node_modules/.bin/prisma');
const NEW = '20261207120000_review16_fixes';

suite('migration review16_fixes (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = Math.random().toString(36).slice(2, 8);
  const names: string[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'mig16-'));
  let admin: any;
  let PrismaClient: any;
  const dbUrl = (name: string) => { const u = new URL(url!); u.pathname = `/${name}`; return u.toString(); };
  const newDb = async (suffix: string) => { const name = `scratch_mig_${run}_${suffix}`; await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); names.push(name); return name; };
  const prisma = (args: string[], databaseUrl: string, schema = path.join(ROOT, 'prisma/schema.prisma')) => {
    const r = spawnSync(PRISMA, [...args, '--schema', schema], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const rawPrisma = (args: string[], databaseUrl: string) => {
    const r = spawnSync(PRISMA, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const fails = async (q: PromiseLike<unknown>): Promise<boolean> => { try { await q; return false; } catch { return true; } };
  const client = (name: string) => new PrismaClient({ datasources: { db: { url: dbUrl(name) } }, log: [] });

  beforeAll(async () => { ({ PrismaClient } = await import('@prisma/client')); admin = new PrismaClient({ datasources: { db: { url } }, log: [] }); });
  afterAll(async () => {
    for (const n of names) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dirs = () => readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
  const historyBefore = (name: string, before: string) => {
    const root = path.join(tmp, name);
    mkdirSync(path.join(root, 'prisma/migrations'), { recursive: true });
    cpSync(path.join(ROOT, 'prisma/schema.prisma'), path.join(root, 'prisma/schema.prisma'));
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(root, 'prisma/migrations/migration_lock.toml'));
    for (const d of dirs().filter((x) => x < before)) cpSync(path.join(MIGRATIONS, d), path.join(root, 'prisma/migrations', d), { recursive: true });
    return path.join(root, 'prisma/schema.prisma');
  };

  test('upgrades a populated database at the previous migration, keeps every row, accepts "uncertain", validates the CHECKs, is re-runnable, zero drift', async () => {
    const oldSchema = historyBefore('old', NEW);
    const name = await newDb('old');
    expect(prisma(['migrate', 'deploy'], dbUrl(name), oldSchema).code).toBe(0);
    const c = client(name);
    try {
      // old schema: 'uncertain' is not a status yet, and calls has no forward_pending_key
      await c.$executeRawUnsafe(`INSERT INTO businesses(id,name) VALUES ('b16','Old Co')`);
      for (const [id, status] of [['r1', 'proposed'], ['r2', 'sending'], ['r3', 'sent'], ['r4', 'failed'], ['r5', 'cancelled'], ['r6', 'refused']] as const) {
        await c.$executeRawUnsafe(`INSERT INTO owner_replies(id,business_id,lead_kind,to_e164,body,status,expires_at,decided_at,sent_at,created_at) VALUES ('${id}','b16','call','+13055550142','hello','${status}', now() + interval '1 hour', ${status === 'proposed' ? 'NULL' : 'now()'}, ${status === 'sent' ? 'now()' : 'NULL'}, now() - interval '1 minute')`);
      }
      await c.$executeRawUnsafe(`INSERT INTO calls(id,business_id,caller_phone,status,transfer_status,forward_pending_secs,metered_at) VALUES ('c16','b16','+13055550101','completed','connected',60, now())`);
      expect(await fails(c.$executeRawUnsafe(`UPDATE owner_replies SET status='uncertain' WHERE id='r2'`))).toBe(true);
      expect(await c.$queryRawUnsafe(`SELECT 1 FROM information_schema.columns WHERE table_name='calls' AND column_name='forward_pending_key'`)).toEqual([]);
    } finally { await c.$disconnect(); }

    const up = prisma(['migrate', 'deploy'], dbUrl(name));
    expect(up.out).toContain('successfully applied');
    expect(up.code).toBe(0);

    const d = client(name);
    try {
      const rows = await d.$queryRawUnsafe(`SELECT id, status FROM owner_replies ORDER BY id`);
      expect(rows.map((r: any) => `${r.id}:${r.status}`)).toEqual(['r1:proposed', 'r2:sending', 'r3:sent', 'r4:failed', 'r5:cancelled', 'r6:refused']); // nothing rewritten
      expect(await d.$queryRawUnsafe(`SELECT forward_pending_secs, forward_pending_key FROM calls WHERE id='c16'`)).toEqual([{ forward_pending_secs: 60, forward_pending_key: null }]);
      await d.$executeRawUnsafe(`UPDATE owner_replies SET status='uncertain' WHERE id='r2'`); // now allowed
      expect(await fails(d.$executeRawUnsafe(`UPDATE owner_replies SET status='bogus' WHERE id='r2'`))).toBe(true); // still a closed list
      expect(await fails(d.$executeRawUnsafe(`UPDATE owner_replies SET status='uncertain', decided_at=NULL WHERE id='r1'`))).toBe(true); // uncertain needs decided_at
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      // re-runnable: applying the migration SQL again changes nothing and fails nowhere
      const sql = readFileSync(path.join(MIGRATIONS, NEW, 'migration.sql'), 'utf8');
      for (const stmt of sql.match(/DO \$\$[\s\S]*?END \$\$;|ALTER TABLE "public"\."calls"[^;]*;/g)!) await d.$executeRawUnsafe(stmt);
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
    } finally { await d.$disconnect(); }

    // zero drift: the migrations produce exactly schema.prisma
    const shadow = await newDb('shadow');
    const diff = rawPrisma(['migrate', 'diff', '--from-migrations', path.join(ROOT, 'prisma/migrations'), '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--shadow-database-url', dbUrl(shadow), '--exit-code'], dbUrl(name));
    expect(diff.out).toContain('No difference detected');
    expect(diff.code).toBe(0);
  }, 180_000);
});
