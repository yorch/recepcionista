/**
 * Migration 20261208120000_mock_replacement_schema: upgrades a POPULATED database that is at the previous migration (a legacy non-IANA time zone, paid / unpaid deposits,
 * bookings, briefings, SMS rows), keeps every row, applies the backfills, makes the overlap guard per crew, validates every CHECK, is re-runnable, and leaves zero drift
 * between prisma/migrations and schema.prisma.
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
const NEW = '20261208120000_mock_replacement_schema';
const FIX = '20261209120000_review19_fixes';


/** Split the migration into executable statements: DO blocks stay whole; everything else is split on ';' at the end of a line. */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  const noComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const re = /\s*(DO \$\$[\s\S]*?END \$\$;|[^;]+;)/g;
  for (const m of noComments.matchAll(re)) { const st = m[1].trim().replace(/;$/, ''); if (st) out.push(st); }
  return out;
}

suite('migration mock_replacement_schema (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = Math.random().toString(36).slice(2, 8);
  const names: string[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'mig17-'));
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

  test('upgrades a populated database at the previous migration, keeps every row, backfills, crew-aware overlap guard, CHECKs validated, re-runnable, zero drift', async () => {
    const oldSchema = historyBefore('old', NEW);
    const name = await newDb('old');
    expect(prisma(['migrate', 'deploy'], dbUrl(name), oldSchema).code).toBe(0);
    const c = client(name);
    const t0 = `now() + interval '3 days'`;
    try {
      await c.$executeRawUnsafe(`INSERT INTO businesses(id,name,timezone) VALUES ('m1','Old Co','EST'), ('m2','Good Co','America/Chicago'), ('m4','Pacific Co','PST8PDT'), ('m5','Tokyo Co','Japan'), ('m6','Odd Co','Not/A_Zone!')`);
      // bookings: a stripe-paid deposit, a mock-paid deposit (no stripe ref), an unpaid one, an adjacent one and a cancelled overlapping one
      await c.$executeRawUnsafe(`INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes,deposit_amount,deposit_paid,stripe_payment_intent_id,status) VALUES
        ('k1','m1','Ann','+13055550101','AC', ${t0}, 60, 5000, true, 'pi_1', 'confirmed'),
        ('k2','m1','Bob','+13055550102','AC', ${t0} + interval '1 hour', 60, 4000, true, NULL, 'confirmed'),
        ('k3','m1','Cy','+13055550103','AC', ${t0} + interval '2 hours', 60, NULL, false, NULL, 'pending'),
        ('k4','m1','Di','+13055550104','AC', ${t0}, 60, NULL, false, NULL, 'cancelled')`);
      await c.$executeRawUnsafe(`INSERT INTO briefings(id,business_id,date,transcript,audio_url) VALUES ('br1','m1','2030-01-01','t','/audio/briefing-m1-2030-01-01.mp3')`);
      await c.$executeRawUnsafe(`INSERT INTO sms_log(id,business_id,to_phone,body,kind) VALUES ('s1','m1','+13055550101','x','manual'), ('s2','m1','+13055550101','x','owner_alert')`);
      expect(await c.$queryRawUnsafe(`SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='crew'`)).toEqual([]);
      expect(await fails(c.$executeRawUnsafe(`INSERT INTO sms_log(id,business_id,to_phone,body,kind) VALUES ('s3','m1','+13055550101','x','owner_inbox_reply')`))).toBe(true); // not a kind yet
    } finally { await c.$disconnect(); }

    const up = prisma(['migrate', 'deploy'], dbUrl(name));
    expect(up.out).toContain('successfully applied');
    expect(up.code).toBe(0);

    const d = client(name);
    try {
      // every row survived; a legacy zone that Intl knows keeps its meaning (mapped to its IANA name, never silently moved to New York), an unknown one falls back to the
      // default the app already used, every repair is audited, and a good zone is untouched
      expect((await d.$queryRawUnsafe(`SELECT id, timezone FROM businesses ORDER BY id`)).map((r: any) => `${r.id}:${r.timezone}`)).toEqual(['m1:America/Panama', 'm2:America/Chicago', 'm4:America/Los_Angeles', 'm5:Asia/Tokyo', 'm6:America/New_York']);
      expect((await d.$queryRawUnsafe(`SELECT business_id, meta->>'from' AS f, meta->>'to' AS t, meta->>'mapped' AS m FROM audit_events WHERE action='business.timezone_repaired' ORDER BY business_id`))).toEqual([
        { business_id: 'm1', f: 'EST', t: 'America/Panama', m: 'true' }, { business_id: 'm4', f: 'PST8PDT', t: 'America/Los_Angeles', m: 'true' },
        { business_id: 'm5', f: 'Japan', t: 'Asia/Tokyo', m: 'true' }, { business_id: 'm6', f: 'Not/A_Zone!', t: 'America/New_York', m: 'false' },
      ]);
      expect((await d.$queryRawUnsafe(`SELECT id FROM bookings ORDER BY id`)).map((r: any) => r.id)).toEqual(['k1', 'k2', 'k3', 'k4']);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM briefings WHERE audio_url = '/audio/briefing-m1-2030-01-01.mp3'`)).toEqual([{ n: 1 }]); // audio_url semantics preserved
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM sms_log`)).toEqual([{ n: 2 }]);
      // defaults reproduce the old behaviour
      expect(await d.$queryRawUnsafe(`SELECT slot_minutes, min_lead_minutes, horizon_days, buffer_minutes, crews, deposit_enabled, deposit_mode, native_transfer_enabled, review_url, assistant_name, elevenlabs_phone_number_id, twilio_phone_sid, content_confirmed_at FROM businesses WHERE id='m1'`))
        .toEqual([{ slot_minutes: 60, min_lead_minutes: 60, horizon_days: 14, buffer_minutes: 0, crews: 1, deposit_enabled: false, deposit_mode: 'fixed', native_transfer_enabled: false, review_url: null, assistant_name: null, elevenlabs_phone_number_id: null, twilio_phone_sid: null, content_confirmed_at: null }]);
      // bookings: crew 1, created_via ai, deposit_source backfilled only where Stripe is known
      expect(await d.$queryRawUnsafe(`SELECT id, crew, created_via, deposit_source FROM bookings ORDER BY id`)).toEqual([
        { id: 'k1', crew: 1, created_via: 'ai', deposit_source: 'stripe' }, { id: 'k2', crew: 1, created_via: 'ai', deposit_source: null },
        { id: 'k3', crew: 1, created_via: 'ai', deposit_source: null }, { id: 'k4', crew: 1, created_via: 'ai', deposit_source: null },
      ]);
      // the overlap guard still forbids a same-crew overlap and now allows a different crew
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes) VALUES ('k5','m1','E','','AC', ${t0} + interval '30 minutes', 60)`))).toBe(true);
      await d.$executeRawUnsafe(`INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes,crew) VALUES ('k5','m1','E','','AC', ${t0} + interval '30 minutes', 60, 2)`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes,crew) VALUES ('k6','m1','E','','AC', ${t0} + interval '45 minutes', 60, 2)`))).toBe(true);
      expect(await d.$queryRawUnsafe(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='bookings_no_overlap'`)).toEqual([{ d: expect.stringContaining('crew') }]);
      // new CHECKs
      expect(await fails(d.$executeRawUnsafe(`UPDATE businesses SET timezone='EST' WHERE id='m1'`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`UPDATE bookings SET crew=21 WHERE id='k3'`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`UPDATE bookings SET created_via='robot' WHERE id='k3'`))).toBe(true);
      await d.$executeRawUnsafe(`INSERT INTO sms_log(id,business_id,to_phone,body,kind) VALUES ('s3','m1','+13055550101','x','owner_inbox_reply')`); // now allowed
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO sms_log(id,business_id,to_phone,body,kind) VALUES ('s4','m1','+13055550101','x','bogus')`))).toBe(true); // still a closed list
      // new tables work and cascade
      await d.$executeRawUnsafe(`INSERT INTO briefing_audio(id,briefing_id,content_type,bytes) VALUES ('a1','br1','audio/mpeg','\\x0102')`);
      await d.$executeRawUnsafe(`INSERT INTO inbound_messages(id,business_id,from_e164,from_phone,body,twilio_message_sid,booking_id) VALUES ('i1','m1','+13055550101','x','hi','SM1','k1')`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO inbound_messages(id,business_id,from_e164,from_phone,body,twilio_message_sid) VALUES ('i2','m1','+13055550101','x','hi','SM1')`))).toBe(true); // sid unique
      await d.$executeRawUnsafe(`DELETE FROM bookings WHERE id='k1'`);
      expect(await d.$queryRawUnsafe(`SELECT booking_id FROM inbound_messages WHERE id='i1'`)).toEqual([{ booking_id: null }]);
      await d.$executeRawUnsafe(`DELETE FROM businesses WHERE id='m1'`);
      expect(await d.$queryRawUnsafe(`SELECT (SELECT count(*)::int FROM inbound_messages) AS i, (SELECT count(*)::int FROM briefing_audio) AS a`)).toEqual([{ i: 0, a: 0 }]);
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      // re-runnable: the whole migration SQL again changes nothing and fails nowhere
      await d.$executeRawUnsafe(`INSERT INTO businesses(id,name) VALUES ('m3','Again Co')`);
      for (const dir of [NEW, FIX]) for (const stmt of splitSql(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'))) await d.$executeRawUnsafe(stmt);
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM businesses`)).toEqual([{ n: 5 }]); // m1 was deleted above; m2 m3 m4 m5 m6 remain
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM audit_events WHERE action='business.timezone_repaired'`)).toEqual([{ n: 4 }]); // the four repairs of the first run (the audit trail outlives the deleted business); the re-run repaired nothing again
    } finally { await d.$disconnect(); }

    // zero drift: the migrations produce exactly schema.prisma
    const shadow = await newDb('shadow');
    const diff = rawPrisma(['migrate', 'diff', '--from-migrations', path.join(ROOT, 'prisma/migrations'), '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--shadow-database-url', dbUrl(shadow), '--exit-code'], dbUrl(name));
    expect(diff.out).toContain('No difference detected');
    expect(diff.code).toBe(0);
  }, 180_000);

  test('a database that already applied the FIRST version of 20261208 (before the lock split) upgrades through 20261209 as a no-op for the parts it already has', async () => {
    const oldSchema = historyBefore('old2', NEW);
    const name = await newDb('v1');
    expect(prisma(['migrate', 'deploy'], dbUrl(name), oldSchema).code).toBe(0);
    const c = client(name);
    try {
      await c.$executeRawUnsafe(`INSERT INTO businesses(id,name,timezone) VALUES ('v1','V1 Co','America/Chicago')`);
      // the first version of the migration, applied by hand exactly as `migrate deploy` would have (a fixture: the file in git history)
      for (const stmt of splitSql(readFileSync(path.join(ROOT, 'tests/db/fixtures/20261208120000_mock_replacement_schema.v1.sql'), 'utf8'))) await c.$executeRawUnsafe(stmt);
    } finally { await c.$disconnect(); }
    expect(rawPrisma(['migrate', 'resolve', '--applied', NEW, '--schema', path.join(ROOT, 'prisma/schema.prisma')], dbUrl(name)).code).toBe(0);
    const up = prisma(['migrate', 'deploy'], dbUrl(name));
    expect(up.code).toBe(0);
    expect(up.out).toContain(FIX);
    const d = client(name);
    try {
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM businesses`)).toEqual([{ n: 1 }]);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='briefing_audio' AND column_name='text_hash'`)).toEqual([{ n: 1 }]);
      expect(await d.$queryRawUnsafe(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='bookings_no_overlap'`)).toEqual([{ d: expect.stringContaining('crew') }]);
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
    } finally { await d.$disconnect(); }
    const diff = rawPrisma(['migrate', 'diff', '--from-url', dbUrl(name), '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--exit-code'], dbUrl(name));
    expect(diff.out).toContain('No difference detected');
  }, 180_000);

  test('a fresh database (all migrations from scratch) has the new defaults and no legacy repair side effects', async () => {
    const name = await newDb('fresh');
    expect(prisma(['migrate', 'deploy'], dbUrl(name)).code).toBe(0);
    const d = client(name);
    try {
      await d.$executeRawUnsafe(`INSERT INTO businesses(id,name) VALUES ('f1','Fresh')`);
      expect(await d.$queryRawUnsafe(`SELECT timezone, crews, slot_minutes FROM businesses`)).toEqual([{ timezone: 'America/New_York', crews: 1, slot_minutes: 60 }]);
    } finally { await d.$disconnect(); }
  }, 120_000);
});
