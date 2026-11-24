/**
 * Migration tests: applies the real migration history to brand-new databases (empty, and seeded with
 * old-schema data right before the newest migration), checks the backfills and constraint validation,
 * and verifies there is no drift between prisma/migrations and schema.prisma.
 *
 * Skipped unless TEST_DATABASE_URL names a disposable database containing "test" or "scratch". It creates
 * (and drops) extra databases named scratch_mig_<random>_* ON THE SAME SERVER, so the role needs CREATEDB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}
const suite = url ? describe : describe.skip;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');
const PRISMA = path.join(ROOT, 'node_modules/.bin/prisma');

suite('migrations (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = Math.random().toString(36).slice(2, 8);
  const names: string[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'mig-'));
  let admin: any;
  let PrismaClient: any;

  const dbUrl = (name: string) => {
    const u = new URL(url!);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const newDb = async (suffix: string) => {
    const name = `scratch_mig_${run}_${suffix}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    names.push(name);
    return name;
  };
  const prisma = (args: string[], databaseUrl: string, schema = path.join(ROOT, 'prisma/schema.prisma')) => {
    const r = spawnSync(PRISMA, [...args, '--schema', schema], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const rawPrisma = (args: string[], databaseUrl: string) => {
    const r = spawnSync(PRISMA, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const client = (name: string) => new PrismaClient({ datasources: { db: { url: dbUrl(name) } }, log: [] });

  beforeAll(async () => {
    ({ PrismaClient } = await import('@prisma/client'));
    admin = new PrismaClient({ datasources: { db: { url } }, log: [] });
  });

  afterAll(async () => {
    for (const n of names) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  const dirs = () => readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
  /** The accounts/billing/E.164 migration (the constraint-validation DO block lives there) and the round-3 repair migration after it. */
  const ACCOUNTS = '20261125120000_accounts_billing_e164_constraints';
  const REPAIR = '20261126120000_review3_optout_repair_trials_indexes';
  const sqlOf = (dir: string) => readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
  /** A copy of schema + migration history (oldest first) up to and including `last`, in its own project dir. */
  const historyUpTo = (name: string, last: string) => {
    const root = path.join(tmp, name);
    mkdirSync(path.join(root, 'prisma/migrations'), { recursive: true });
    cpSync(path.join(ROOT, 'prisma/schema.prisma'), path.join(root, 'prisma/schema.prisma'));
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(root, 'prisma/migrations/migration_lock.toml'));
    for (const d of dirs().filter((x) => x <= last)) cpSync(path.join(MIGRATIONS, d), path.join(root, 'prisma/migrations', d), { recursive: true });
    return path.join(root, 'prisma/schema.prisma');
  };

  test('applies from scratch on an empty database, creates the new objects and validates every CHECK', async () => {
    const name = await newDb('empty');
    const r = prisma(['migrate', 'deploy'], dbUrl(name));
    expect(r.out).toContain('successfully applied');
    expect(r.code).toBe(0);
    const c = client(name);
    try {
      const tables = (await c.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).map((x: any) => x.table_name);
      for (const t of ['recovery_codes', 'email_tokens', 'audit_events', 'usage_counters']) expect(tables).toContain(t);
      for (const t of ['calendar_connections', 'calendar_event_links', 'calendar_busy_blocks', 'owner_kb_changes', 'call_transcript_events', 'passkey_credentials', 'webauthn_challenges', 'memberships']) expect(tables).toContain(t);
      const notValid = await c.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE contype='c' AND NOT convalidated`);
      expect(notValid).toEqual([]);
      // the validation step is idempotent: running the migration's last block again is a no-op
      const sql = sqlOf(ACCOUNTS);
      const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g)!;
      await c.$executeRawUnsafe(blocks.at(-1)!);
      await c.$executeRawUnsafe(blocks.at(-1)!);
    } finally {
      await c.$disconnect();
    }
  }, 120_000);

  test('validation step lists the violating constraint and row count, then succeeds after a fix', async () => {
    const name = await newDb('validate');
    expect(prisma(['migrate', 'deploy'], dbUrl(name)).code).toBe(0);
    const c = client(name);
    try {
      const b = `b_${run}`;
      await c.$executeRawUnsafe(`INSERT INTO businesses(id,name) VALUES ('${b}','v')`);
      await c.$executeRawUnsafe(`INSERT INTO usage_counters(id,business_id,period_start,sms_count) VALUES ('u1','${b}','2027-01-01',1),('u2','${b}','2027-02-01',2)`);
      await c.$executeRawUnsafe(`ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_nonnegative_check`);
      await c.$executeRawUnsafe(`UPDATE usage_counters SET sms_count = -1`);
      await c.$executeRawUnsafe(`ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_nonnegative_check CHECK (sms_count >= 0 AND call_seconds >= 0) NOT VALID`);
      const sql = sqlOf(ACCOUNTS);
      const validate = sql.match(/DO \$\$[\s\S]*?END \$\$;/g)!.at(-1)!;
      let msg = '';
      try { await c.$executeRawUnsafe(validate); } catch (e) { msg = String((e as Error).message); }
      expect(msg).toContain('usage_counters_nonnegative_check');
      expect(msg).toContain('2 row(s)');
      await c.$executeRawUnsafe(`UPDATE usage_counters SET sms_count = 0`);
      await c.$executeRawUnsafe(validate);
      expect(await c.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE NOT convalidated`)).toEqual([]);
    } finally {
      await c.$disconnect();
    }
  }, 120_000);

  test('upgrades an old-schema database with data: backfills E.164, fixes bad rows, keeps everything', async () => {
    const newest = ACCOUNTS;
    // a copy of the history BEFORE the accounts migration, next to a copy of the schema
    const oldSchema = historyUpTo('old', dirs().filter((d) => d < ACCOUNTS).at(-1)!);

    const name = await newDb('old');
    const r1 = prisma(['migrate', 'deploy'], dbUrl(name), oldSchema);
    expect(r1.code).toBe(0);
    expect((await (async () => { const c = client(name); try { return await c.$queryRawUnsafe(`SELECT 1 FROM information_schema.tables WHERE table_name='usage_counters'`); } finally { await c.$disconnect(); } })())).toEqual([]);

    const c = client(name);
    try {
      for (const q of [
        `INSERT INTO businesses(id,name,phone,phone_key,owner_phone,retention_days) VALUES
           ('b1','A','+13055550142','3055550142','(305) 555-0199',365),
           ('b2','B','+44 7911 123456','7911123456','07911 123456',30),
           ('b3','C',NULL,NULL,'+1 123 456 7890',365)`,
        `INSERT INTO calls(id,business_id,caller_phone) VALUES ('c1','b1','305-555-0111'),('c2','b1','anonymous'),('c3','b2','+447911123456')`,
        `INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,price_estimate,deposit_amount) VALUES
           ('k1','b1','x','1 (305) 555-0100','s','2027-01-01 10:00',10000,2000),
           ('k2','b1','y','','s','2027-01-02 10:00',-5,-1)`,
        `INSERT INTO sms_log(id,business_id,to_phone,body,kind) VALUES ('s1','b1','+13055550100','hi','manual'),('s2','b2','abc','hi','manual'),('s3','b1','+52 55 1234 5678','hi','manual')`,
        // o3: a Mexican customer's STOP (last 10 digits only); o4: a +44 number's STOP with no other trace
        `INSERT INTO sms_opt_outs(id,business_id,phone_key,source) VALUES ('o1','b1','3055550100','stop_keyword'),('o2','b2','7911123456','stop_keyword'),('o3','b1','5512345678','stop_keyword'),('o4','b1','2079460958','stop_keyword')`,
        `INSERT INTO users(id,email,password_hash,business_id,role) VALUES ('u1','a@x.com','h','b1','owner'),('u2','root@x.com','h',NULL,'admin')`,
        `INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES ('ss1','u1','th1',now()+interval '1 day')`,
        `INSERT INTO processed_events(source,id) VALUES ('stripe','e1')`,
      ]) await c.$executeRawUnsafe(q);

      const r2 = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r2.out).toContain(newest);
      expect(r2.out).toContain(REPAIR);
      expect(r2.code).toBe(0);

      const one = async (sql: string) => (await c.$queryRawUnsafe(sql)) as any[];
      expect((await one(`SELECT id, phone_e164 p, owner_phone_e164 o, billing_status s FROM businesses ORDER BY id`))).toEqual([
        { id: 'b1', p: '+13055550142', o: '+13055550199', s: 'none' },
        { id: 'b2', p: '+447911123456', o: null, s: 'none' }, // 07911... without '+' is not clean US: left NULL
        { id: 'b3', p: null, o: null, s: 'none' },           // '+1 123 ...' is not a NANP number
      ]);
      expect((await one(`SELECT id, caller_e164 e FROM calls ORDER BY id`)).map((r) => r.e)).toEqual(['+13055550111', null, '+447911123456']);
      expect(await one(`SELECT id, phone_e164 e, price_estimate p, deposit_amount d FROM bookings ORDER BY id`)).toEqual([
        { id: 'k1', e: '+13055550100', p: 10000, d: 2000 },
        { id: 'k2', e: null, p: null, d: null }, // negative amounts were cleaned up, erased phone stays NULL
      ]);
      expect((await one(`SELECT to_e164 e FROM sms_log ORDER BY id`)).map((r) => r.e)).toEqual(['+13055550100', null, '+525512345678']);
      // H3: legacy opt-outs are NEVER blindly mapped to +1. o1: the only evidence is a +1 number; o3: evidence is the +52 number (NOT +15512345678);
      // o4: no evidence at all -> NULL (matched by last 10 digits for every country, i.e. suppression).
      expect((await one(`SELECT id, phone_e164 e FROM sms_opt_outs ORDER BY id`))).toEqual([
        { id: 'o1', e: '+13055550100' }, { id: 'o2', e: '+447911123456' }, { id: 'o3', e: '+525512345678' }, { id: 'o4', e: null },
      ]);
      expect((await one(`SELECT email_verified_at IS NOT NULL v FROM users`)).every((r) => r.v)).toBe(true);
      expect(await one(`SELECT kind, user_id FROM user_sessions`)).toEqual([{ kind: 'user', user_id: 'u1' }]);
      expect(await one(`SELECT count(*)::int n FROM processed_events`)).toEqual([{ n: 1 }]);
      expect(await one(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      expect(await one(`SELECT 1 FROM pg_proc WHERE proname = '_rc_to_e164'`)).toEqual([]); // helper dropped
      // the migration is recorded exactly once
      expect(await one(`SELECT count(*)::int n FROM _prisma_migrations WHERE migration_name = '${newest}' AND finished_at IS NOT NULL`)).toEqual([{ n: 1 }]);
      expect(await one(`SELECT count(*)::int n FROM _prisma_migrations WHERE migration_name = '${REPAIR}' AND finished_at IS NOT NULL`)).toEqual([{ n: 1 }]);
    } finally {
      await c.$disconnect();
    }
  }, 180_000);

  test('H3 repair: a database where the old blind backfill already ran gets its non-US opt-outs un-mapped (idempotent)', async () => {
    const upToAccounts = historyUpTo('repair', ACCOUNTS);
    const name = await newDb('repair');
    expect(prisma(['migrate', 'deploy'], dbUrl(name), upToAccounts).code).toBe(0);
    const c = client(name);
    try {
      const run1 = async (q: string) => c.$executeRawUnsafe(q);
      await run1(`INSERT INTO businesses(id,name) VALUES ('rb','Repair Biz')`);
      // evidence the repair may use (all in the same business)
      await run1(`INSERT INTO sms_log(id,business_id,to_phone,to_e164,body,kind) VALUES
        ('e1','rb','+52 55 1234 5678','+525512345678','x','manual'),
        ('e2','rb','(415) 555-0123','+14155550123','x','manual'),
        ('e3','rb','+52 415 555 0123','+524155550123','x','manual')`);
      await run1(`INSERT INTO calls(id,business_id,caller_phone,caller_e164) VALUES ('ec1','rb','305-555-0100','+13055550100')`);
      // legacy rows (opted out BEFORE the previous migration finished) carrying what the faulty backfill wrote
      await run1(`INSERT INTO sms_opt_outs(id,business_id,phone_key,phone_e164,source,opted_out_at) VALUES
        ('m_mx','rb','5512345678','+15512345678','stop_keyword', now() - interval '2 days'),
        ('m_uk','rb','2079460958','+12079460958','stop_keyword', now() - interval '2 days'),
        ('m_us','rb','3055550100','+13055550100','stop_keyword', now() - interval '2 days'),
        ('m_amb','rb','4155550123','+14155550123','stop_keyword', now() - interval '2 days')`);
      // written by the new application AFTER the previous migration: trustworthy, must be left alone
      await run1(`INSERT INTO sms_opt_outs(id,business_id,phone_key,phone_e164,source,opted_out_at) VALUES
        ('n_us','rb','7865550000','+17865550000','stop_keyword', now() + interval '1 hour'),
        ('n_mx','rb','+525599990000','+15599990000','stop_keyword', now() + interval '1 hour')`);

      const r = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r.out).toContain(REPAIR);
      expect(r.code).toBe(0);
      const rows = async () => ((await c.$queryRawUnsafe(`SELECT id, phone_key k, phone_e164 e FROM sms_opt_outs ORDER BY id`)) as any[]);
      const expected = [
        { id: 'm_amb', k: '4155550123', e: null },          // +1 AND +52 evidence: ambiguous -> country-agnostic (suppresses both)
        { id: 'm_mx', k: '5512345678', e: '+525512345678' }, // proven +52 (not the stranger +1 551 number)
        { id: 'm_uk', k: '2079460958', e: null },            // no evidence: never assumed +1
        { id: 'm_us', k: '3055550100', e: '+13055550100' },  // proven +1
        { id: 'n_mx', k: '+525599990000', e: '+525599990000' }, // new-format non-US key: e164 agrees with the key
        { id: 'n_us', k: '7865550000', e: '+17865550000' },  // written after the previous migration: untouched
      ];
      expect(await rows()).toEqual(expected);
      // idempotent: running the repair statement again changes nothing
      const block = sqlOf(REPAIR).match(/DO \$\$[\s\S]*?END \$\$;/)![0];
      await c.$executeRawUnsafe(block);
      expect(await rows()).toEqual(expected);
      expect(await c.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
    } finally {
      await c.$disconnect();
    }
  }, 180_000);

  test('call-mode migration: defaults keep every business on ai, legacy enum values are normalised, dangling sms booking ids are cleared, constraints hold', async () => {
    const CALL_MODE = '20261127120000_call_mode_forwarding';
    const name = await newDb('callmode');
    const before = historyUpTo('before-callmode', dirs().filter((d) => d < CALL_MODE).at(-1)!);
    expect(prisma(['migrate', 'deploy'], dbUrl(name), before).code).toBe(0);
    const c = client(name);
    try {
      for (const q of [
        `INSERT INTO businesses(id,name,status) VALUES ('b1','A','live'),('b2','B','zombie')`,
        `INSERT INTO calls(id,business_id,status,urgency) VALUES ('c1','b1','completed','routine'),('c2','b1','weird','whenever')`,
        `INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,status) VALUES
           ('k1','b1','x','1','s','2027-01-01 10:00','confirmed'),('k2','b1','y','2','s','2027-01-02 10:00','maybe')`,
        `INSERT INTO sms_log(id,business_id,to_phone,body,kind,status,booking_id) VALUES
           ('s1','b1','+13055550100','hi','confirmation','sent','k1'),('s2','b1','+13055550100','hi','spam','delivered?','ghost-booking')`,
      ]) await c.$executeRawUnsafe(q);

      const r = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r.out).toContain(CALL_MODE);
      expect(r.code).toBe(0);
      const one = async (sql: string) => (await c.$queryRawUnsafe(sql)) as any[];
      expect(await one(`SELECT id, call_mode m, forward_number n, forward_number_verified_at v, forward_during_hours h FROM businesses ORDER BY id`)).toEqual([
        { id: 'b1', m: 'ai', n: null, v: null, h: false }, { id: 'b2', m: 'ai', n: null, v: null, h: false },
      ]);
      expect((await one(`SELECT id, status FROM businesses ORDER BY id`)).map((x) => x.status)).toEqual(['live', 'onboarding']);
      expect(await one(`SELECT id, status, urgency FROM calls ORDER BY id`)).toEqual([
        { id: 'c1', status: 'completed', urgency: 'routine' }, { id: 'c2', status: 'completed', urgency: 'unsure' },
      ]);
      expect((await one(`SELECT status FROM bookings ORDER BY id`)).map((x) => x.status)).toEqual(['confirmed', 'confirmed']);
      expect(await one(`SELECT id, kind, status, booking_id FROM sms_log ORDER BY id`)).toEqual([
        { id: 's1', kind: 'confirmation', status: 'sent', booking_id: 'k1' }, { id: 's2', kind: 'other', status: 'failed', booking_id: null },
      ]);
      const bad = async (sql: string) => { try { await c.$executeRawUnsafe(sql); return 'accepted'; } catch { return 'rejected'; } };
      expect(await bad(`UPDATE businesses SET call_mode = 'sleep' WHERE id = 'b1'`)).toBe('rejected');
      expect(await bad(`UPDATE businesses SET forward_number_e164 = '911' WHERE id = 'b1'`)).toBe('rejected');
      expect(await bad(`UPDATE businesses SET forward_number_verified_at = now() WHERE id = 'b1'`)).toBe('rejected');
      expect(await bad(`UPDATE businesses SET call_mode = 'forward', forward_number_e164 = '+13055550142', forward_number_verified_at = now() WHERE id = 'b1'`)).toBe('accepted');
      expect(await bad(`UPDATE bookings SET status = 'nope' WHERE id = 'k1'`)).toBe('rejected');
      expect(await bad(`INSERT INTO sms_log(id,business_id,to_phone,body,kind,status,booking_id) VALUES ('s9','b1','x','x','other','sent','ghost')`)).toBe('rejected');
      expect(await bad(`DELETE FROM bookings WHERE id = 'k1'`)).toBe('accepted');
      expect((await one(`SELECT booking_id FROM sms_log WHERE id = 's1'`))[0].booking_id).toBeNull(); // ON DELETE SET NULL
      expect(await c.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
    } finally {
      await c.$disconnect();
    }
  }, 180_000);

  test('phase 1 migration on an old-schema database with data: memberships backfilled, usage history settled, defaults, constraints and triggers hold, re-runnable', async () => {
    const PHASE1 = '20261201120000_phase1_calendar_kb_transcript_passkeys_memberships';
    const name = await newDb('phase1');
    const before = historyUpTo('before-phase1', dirs().filter((d) => d < PHASE1).at(-1)!);
    expect(prisma(['migrate', 'deploy'], dbUrl(name), before).code).toBe(0);
    const c = client(name);
    try {
      for (const q of [
        `INSERT INTO businesses(id,name,status) VALUES ('b1','A','live'),('b2','B','live')`,
        `INSERT INTO users(id,email,password_hash,business_id,role,disabled_at) VALUES
           ('u1','o1@x.com','h','b1','owner',NULL),('u2','s1@x.com','h','b1','staff',now()),('u3','o2@x.com','h','b2','owner',NULL),('root','root@x.com','h',NULL,'admin',NULL)`,
        `INSERT INTO calls(id,business_id,status,started_at,ended_at,duration_sec,conversation_id) VALUES
           ('c1','b1','completed','2027-01-01 10:00','2027-01-01 10:05',300,'conv1'),('c2','b1','in_progress','2027-01-02 10:00',NULL,NULL,'conv2')`,
        `INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes,status) VALUES
           ('k1','b1','x','1','s','2027-02-01 10:00',60,'confirmed'),('k2','b1','y','2','s','2027-02-01 10:00',60,'cancelled')`,
        `INSERT INTO usage_counters(id,business_id,period_start,sms_count) VALUES ('uc1','b1','2027-01-01',5)`,
        `INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES ('ss1','u1','th1',now()+interval '1 day')`,
        `INSERT INTO email_tokens(id,email,purpose,token_hash,business_id,role,expires_at) VALUES ('t1','new@x.com','invite','tt1','b1','staff',now()+interval '1 day')`,
      ]) await c.$executeRawUnsafe(q);

      const r = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r.out).toContain(PHASE1);
      expect(r.code).toBe(0);
      const one = async (sql: string) => (await c.$queryRawUnsafe(sql)) as any[];

      // memberships: one per non-admin user, same role, admin none; existing legacy columns untouched
      expect(await one(`SELECT user_id, business_id, role, disabled_at IS NULL AS enabled FROM memberships ORDER BY user_id`)).toEqual([
        { user_id: 'u1', business_id: 'b1', role: 'owner', enabled: true },
        { user_id: 'u2', business_id: 'b1', role: 'staff', enabled: true },
        { user_id: 'u3', business_id: 'b2', role: 'owner', enabled: true },
      ]);
      expect(await one(`SELECT id, business_id, role, locale FROM users ORDER BY id`)).toEqual([
        { id: 'root', business_id: null, role: 'admin', locale: 'en' }, { id: 'u1', business_id: 'b1', role: 'owner', locale: 'en' },
        { id: 'u2', business_id: 'b1', role: 'staff', locale: 'en' }, { id: 'u3', business_id: 'b2', role: 'owner', locale: 'en' },
      ]);
      // history that was already metered (its duration was stored) counts as settled (the reconcile job must not meter it again); a call that was
      // still IN PROGRESS at the upgrade is NOT settled (review 14 M5: its post-call webhook / the reconcile job must still meter it). The rest of the
      // new columns take their defaults
      expect(await one(`SELECT id, metered_at IS NOT NULL AS settled, kind, transfer_status, stir_status, caller_verified, reconcile_attempts FROM calls ORDER BY id`)).toEqual([
        { id: 'c1', settled: true, kind: 'customer', transfer_status: 'none', stir_status: null, caller_verified: null, reconcile_attempts: 0 },
        { id: 'c2', settled: false, kind: 'customer', transfer_status: 'none', stir_status: null, caller_verified: null, reconcile_attempts: 0 },
      ]);
      expect((await one(`SELECT metered_at AT TIME ZONE 'UTC' AS t FROM calls WHERE id = 'c1'`))[0].t.toISOString()).toBe('2027-01-01T10:05:00.000Z');
      expect(await one(`SELECT locale_default, vertical, voice_id, refund_policy, refund_policy_text, billing_interval FROM businesses WHERE id = 'b1'`)).toEqual([
        { locale_default: 'en', vertical: 'hvac', voice_id: null, refund_policy: 'full_24h', refund_policy_text: null, billing_interval: 'month' },
      ]);
      expect(await one(`SELECT refund_status, reschedule_count, refund_amount_cents, rescheduled_from_id FROM bookings WHERE id = 'k1'`)).toEqual([
        { refund_status: 'none', reschedule_count: 0, refund_amount_cents: null, rescheduled_from_id: null },
      ]);
      expect(await one(`SELECT sms_count, sms_warned_80_at, forward_warned_100_at FROM usage_counters`)).toEqual([{ sms_count: 5, sms_warned_80_at: null, forward_warned_100_at: null }]);
      expect(await one(`SELECT active_business_id FROM user_sessions`)).toEqual([{ active_business_id: null }]);
      expect(await one(`SELECT user_id FROM email_tokens WHERE id = 't1'`)).toEqual([{ user_id: null }]); // invites of unknown addresses are unchanged
      expect(await one(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      expect(await one(`SELECT count(*)::int n FROM _prisma_migrations WHERE migration_name = '${PHASE1}' AND finished_at IS NOT NULL`)).toEqual([{ n: 1 }]);

      const bad = async (sql: string) => { try { await c.$executeRawUnsafe(sql); return 'accepted'; } catch { return 'rejected'; } };
      // the booking exclusion constraint survived untouched
      expect(await bad(`INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at,duration_minutes) VALUES ('k3','b1','z','3','s','2027-02-01 10:30',60)`)).toBe('rejected');
      expect(await bad(`UPDATE bookings SET status = 'confirmed' WHERE id = 'k2'`)).toBe('rejected'); // k2 would overlap k1 once un-cancelled
      // the new CHECKs
      for (const q of [
        `UPDATE businesses SET locale_default = 'fr' WHERE id = 'b1'`, `UPDATE businesses SET vertical = 'bakery' WHERE id = 'b1'`,
        `UPDATE businesses SET refund_policy = 'x' WHERE id = 'b1'`, `UPDATE businesses SET billing_interval = 'week' WHERE id = 'b1'`,
        `UPDATE businesses SET refund_policy_text = repeat('x', 2001) WHERE id = 'b1'`, `UPDATE users SET locale = 'de' WHERE id = 'u1'`,
        `UPDATE calls SET kind = 'robot' WHERE id = 'c1'`, `UPDATE calls SET transfer_status = 'x' WHERE id = 'c1'`,
        `UPDATE bookings SET refund_status = 'x' WHERE id = 'k1'`, `UPDATE bookings SET refund_status = 'refunded' WHERE id = 'k1'`,
        `INSERT INTO memberships(id,user_id,business_id,role) VALUES ('mx','u3','b1','admin')`,
      ]) expect(await bad(q)).toBe('rejected');
      // triggers: legacy writes are mirrored, a deleted business keeps people who belong elsewhere
      expect(await bad(`INSERT INTO users(id,email,password_hash,business_id,role) VALUES ('u4','n@x.com','h','b2','staff')`)).toBe('accepted');
      expect(await one(`SELECT business_id, role FROM memberships WHERE user_id = 'u4'`)).toEqual([{ business_id: 'b2', role: 'staff' }]);
      await c.$executeRawUnsafe(`UPDATE users SET role = 'owner' WHERE id = 'u4'`);
      expect(await one(`SELECT role FROM memberships WHERE user_id = 'u4'`)).toEqual([{ role: 'owner' }]);
      await c.$executeRawUnsafe(`INSERT INTO memberships(id,user_id,business_id,role) VALUES ('m-extra','u1','b2','staff')`);
      await c.$executeRawUnsafe(`DELETE FROM businesses WHERE id = 'b1'`);
      expect(await one(`SELECT id, business_id, role FROM users ORDER BY id`)).toEqual([
        { id: 'root', business_id: null, role: 'admin' }, { id: 'u1', business_id: 'b2', role: 'staff' }, { id: 'u3', business_id: 'b2', role: 'owner' }, { id: 'u4', business_id: 'b2', role: 'owner' },
      ]); // u2 (only in b1) went with it; u1 moved to b2
      expect(await one(`SELECT user_id, business_id FROM memberships ORDER BY user_id`)).toEqual([
        { user_id: 'u1', business_id: 'b2' }, { user_id: 'u3', business_id: 'b2' }, { user_id: 'u4', business_id: 'b2' },
      ]);

      // privacy trigger: no transcript rows for a declined call
      await c.$executeRawUnsafe(`INSERT INTO calls(id,business_id,consent_status) VALUES ('cd','b2','declined'),('cu','b2','unknown')`);
      await c.$executeRawUnsafe(`INSERT INTO call_transcript_events(id,call_id,seq,role,text,at) VALUES ('e1','cd',0,'caller','x',now()),('e2','cu',0,'caller','y',now())`);
      expect(await one(`SELECT call_id FROM call_transcript_events`)).toEqual([{ call_id: 'cu' }]);
      await c.$executeRawUnsafe(`UPDATE calls SET consent_status = 'declined' WHERE id = 'cu'`);
      expect(await one(`SELECT 1 FROM call_transcript_events`)).toEqual([]);

      // the whole migration can be applied again (IF NOT EXISTS / guarded / OR REPLACE), and the validation block is a no-op
      const rerun = rawPrisma(['db', 'execute', '--file', path.join(MIGRATIONS, PHASE1, 'migration.sql'), '--schema', path.join(ROOT, 'prisma/schema.prisma')], dbUrl(name));
      expect(rerun.out).toContain('Script executed successfully');
      expect(rerun.code).toBe(0);
      const validate = sqlOf(PHASE1).match(/DO \$\$[\s\S]*?END \$\$;/g)!.at(-1)!;
      await c.$executeRawUnsafe(validate);
      expect(await one(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
    } finally {
      await c.$disconnect();
    }
  }, 240_000);

  test('review 14 migration on an old-schema database: in-flight calls are un-settled, the queue takes ElevenLabs rows, the consent guard locks, the link column exists, re-runnable, zero drift', async () => {
    const R14 = '20261203120000_review14_provider_deletions_consent_lock_metering';
    const name = await newDb('review14');
    const before = historyUpTo('before-r14', dirs().filter((d) => d < R14).at(-1)!);
    expect(prisma(['migrate', 'deploy'], dbUrl(name), before).code).toBe(0);
    const c = client(name);
    try {
      const AC = `AC${'a'.repeat(32)}`, RE = `RE${'b'.repeat(32)}`;
      for (const q of [
        `INSERT INTO businesses(id,name,status) VALUES ('b1','A','live')`,
        // what the phase-1 backfill did to every existing call: metered_at = COALESCE(ended_at, started_at). Four shapes:
        //  m1 finished, duration stored (really metered by the old code)      -> stays settled
        //  m2 still in progress at the upgrade (no end, no duration)           -> un-settled
        //  m3 ended but its duration never arrived (webhook failed)            -> un-settled
        //  m4 claimed by the NEW code (metered_at = now(), not the signature)  -> untouched even though it has no duration
        `INSERT INTO calls(id,business_id,status,started_at,ended_at,duration_sec,conversation_id) VALUES
           ('m1','b1','completed', now() - interval '1 day', now() - interval '1 day' + interval '5 minutes', 300, 'cm1'),
           ('m2','b1','in_progress', now() - interval '1 hour', NULL, NULL, 'cm2'),
           ('m3','b1','completed', now() - interval '2 hours', now() - interval '2 hours' + interval '4 minutes', NULL, 'cm3'),
           ('m4','b1','completed', now() - interval '3 hours', now() - interval '3 hours' + interval '4 minutes', NULL, 'cm4')`,
        `UPDATE calls SET metered_at = COALESCE(ended_at, started_at) AT TIME ZONE 'UTC' WHERE id IN ('m1','m2','m3')`, // the faulty backfill, as it ran
        `UPDATE calls SET metered_at = now() WHERE id = 'm4'`,
        `INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,business_id) VALUES ('q1','${AC}','${RE}','b1')`,
        `INSERT INTO calls(id,business_id,status,consent_status) VALUES ('cc','b1','completed','declined')`,
        `INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at) VALUES ('k1','b1','x','1','s','2027-02-01 10:00')`,
      ]) await c.$executeRawUnsafe(q);

      const r = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r.out).toContain(R14);
      expect(r.code).toBe(0);
      const one = async (sql: string) => (await c.$queryRawUnsafe(sql)) as any[];
      expect(await one(`SELECT id, metered_at IS NOT NULL AS settled FROM calls WHERE id LIKE 'm%' ORDER BY id`)).toEqual([
        { id: 'm1', settled: true }, { id: 'm2', settled: false }, { id: 'm3', settled: false }, { id: 'm4', settled: true },
      ]);
      expect(await one(`SELECT provider, account_sid FROM pending_recording_deletions`)).toEqual([{ provider: 'twilio', account_sid: AC }]); // existing rows are Twilio rows
      expect(await one(`SELECT stripe_payment_link_id FROM bookings WHERE id = 'k1'`)).toEqual([{ stripe_payment_link_id: null }]);
      const bad = async (sql: string) => { try { await c.$executeRawUnsafe(sql); return 'accepted'; } catch { return 'rejected'; } };
      expect(await bad(`INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,provider) VALUES ('q2','elevenlabs','conv_abc123','elevenlabs')`)).toBe('accepted');
      for (const q of [
        `INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,provider) VALUES ('q3','elevenlabs','x','elevenlabs')`,                       // conversation id shape
        `INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,provider) VALUES ('q4','elevenlabs','conv_abc123','twilio')`,                // provider / sid mismatch
        `INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,provider) VALUES ('q5','${AC}','conv_abc123','twilio')`,                     // twilio needs RE sid
        `INSERT INTO pending_recording_deletions(id,account_sid,recording_sid,provider) VALUES ('q6','${AC}','${RE.replace('b', 'c')}','pigeon')`,         // unknown provider
      ]) expect(await bad(q)).toBe('rejected');
      expect(await one(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);

      // the consent guard: it now locks the call row (FOR SHARE) before it looks at the consent status
      expect(sqlOf(R14)).toMatch(/FOR SHARE/);
      await c.$executeRawUnsafe(`INSERT INTO call_transcript_events(id,call_id,seq,role,text,at) VALUES ('e1','cc',0,'caller','x',now())`);
      expect(await one(`SELECT 1 FROM call_transcript_events`)).toEqual([]); // a declined call still stores nothing

      // re-runnable: the whole file can be applied again (a populated database), and it changes nothing the second time
      const rerun = rawPrisma(['db', 'execute', '--file', path.join(MIGRATIONS, R14, 'migration.sql'), '--schema', path.join(ROOT, 'prisma/schema.prisma')], dbUrl(name));
      expect(rerun.out).toContain('Script executed successfully');
      expect(await one(`SELECT id, metered_at IS NOT NULL AS settled FROM calls WHERE id LIKE 'm%' ORDER BY id`)).toEqual([
        { id: 'm1', settled: true }, { id: 'm2', settled: false }, { id: 'm3', settled: false }, { id: 'm4', settled: true },
      ]);
      // zero drift between the migration history and schema.prisma
      const drift = rawPrisma(['migrate', 'diff', '--from-url', dbUrl(name), '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--exit-code'], dbUrl(name));
      expect(drift.code).toBe(0);
    } finally {
      await c.$disconnect();
    }
  }, 240_000);

  test('phase 1 validation step names the violating constraint', async () => {
    const PHASE1 = '20261201120000_phase1_calendar_kb_transcript_passkeys_memberships';
    const name = await newDb('phase1val');
    expect(prisma(['migrate', 'deploy'], dbUrl(name)).code).toBe(0);
    const c = client(name);
    try {
      await c.$executeRawUnsafe(`INSERT INTO businesses(id,name) VALUES ('vb','v')`);
      await c.$executeRawUnsafe(`ALTER TABLE businesses DROP CONSTRAINT businesses_vertical_check`);
      await c.$executeRawUnsafe(`UPDATE businesses SET vertical = 'bakery'`);
      await c.$executeRawUnsafe(`ALTER TABLE businesses ADD CONSTRAINT businesses_vertical_check CHECK (vertical IN ('hvac','plumbing','electrical','cleaning','landscaping','dental','general')) NOT VALID`);
      const validate = sqlOf(PHASE1).match(/DO \$\$[\s\S]*?END \$\$;/g)!.at(-1)!;
      let msg = '';
      try { await c.$executeRawUnsafe(validate); } catch (e) { msg = String((e as Error).message); }
      expect(msg).toContain('businesses_vertical_check');
      expect(msg).toContain('1 row(s)');
      await c.$executeRawUnsafe(`UPDATE businesses SET vertical = 'general'`);
      await c.$executeRawUnsafe(validate);
    } finally {
      await c.$disconnect();
    }
  }, 120_000);

  test('integration-gaps migration on an old-schema database with data: block_on_busy backfilled from the audit trail, defaults, CHECKs, re-runnable', async () => {
    const GAPS = '20261202120000_integration_gaps';
    const name = await newDb('gaps');
    const before = historyUpTo('before-gaps', dirs().filter((d) => d < GAPS).at(-1)!);
    expect(prisma(['migrate', 'deploy'], dbUrl(name), before).code).toBe(0);
    const c = client(name);
    try {
      for (const q of [
        `INSERT INTO businesses(id,name,status) VALUES ('b1','A','live'),('b2','B','live'),('b3','C','live')`,
        `INSERT INTO calendar_connections(id,business_id,account_email,status) VALUES ('c1','b1','a@x.com','revoked'),('c2','b2','b@x.com','revoked'),('c3','b3','c@x.com','revoked')`,
        // b1: off then on again (latest wins -> true); b2: on then off (-> false); b3: never set (-> default true)
        `INSERT INTO audit_events(id,at,actor_kind,business_id,action,meta) VALUES
           ('a1','2027-01-01 10:00','user','b1','calendar.settings_changed','{"block_on_busy": false}'),
           ('a2','2027-01-02 10:00','user','b1','calendar.settings_changed','{"block_on_busy": true}'),
           ('a3','2027-01-01 10:00','user','b2','calendar.settings_changed','{"block_on_busy": true}'),
           ('a4','2027-01-03 10:00','user','b2','calendar.settings_changed','{"block_on_busy": false}')`,
        `INSERT INTO bookings(id,business_id,customer_name,customer_phone,service,scheduled_at) VALUES ('k1','b1','x','1','s','2027-02-01 10:00')`,
      ]) await c.$executeRawUnsafe(q);
      const r = prisma(['migrate', 'deploy'], dbUrl(name));
      expect(r.out).toContain(GAPS);
      expect(r.code).toBe(0);
      const one = async (sql: string) => (await c.$queryRawUnsafe(sql)) as any[];
      expect(await one(`SELECT business_id, block_on_busy FROM calendar_connections ORDER BY business_id`)).toEqual([
        { business_id: 'b1', block_on_busy: true }, { business_id: 'b2', block_on_busy: false }, { business_id: 'b3', block_on_busy: true },
      ]);
      expect(await one(`SELECT closed_dates FROM businesses WHERE id = 'b1'`)).toEqual([{ closed_dates: [] }]);
      expect(await one(`SELECT dispute_status FROM bookings WHERE id = 'k1'`)).toEqual([{ dispute_status: 'none' }]);
      expect(await one(`SELECT 1 FROM pg_constraint WHERE contype='c' AND NOT convalidated`)).toEqual([]);
      const bad = async (sql: string) => { try { await c.$executeRawUnsafe(sql); return 'accepted'; } catch { return 'rejected'; } };
      expect(await bad(`UPDATE bookings SET dispute_status = 'maybe' WHERE id = 'k1'`)).toBe('rejected');
      expect(await bad(`UPDATE bookings SET dispute_status = 'open' WHERE id = 'k1'`)).toBe('accepted');
      expect(await bad(`UPDATE businesses SET closed_dates = '{"a":1}' WHERE id = 'b1'`)).toBe('rejected');
      expect(await bad(`UPDATE businesses SET closed_dates = (SELECT jsonb_agg(to_char(d, 'YYYY-MM-DD')) FROM generate_series('2027-01-01'::date, '2028-01-02'::date, '1 day') d) WHERE id = 'b1'`)).toBe('rejected'); // 367 dates
      expect(await bad(`UPDATE businesses SET closed_dates = '["2027-12-25"]' WHERE id = 'b1'`)).toBe('accepted');
      // the whole migration can be applied again
      const rerun = rawPrisma(['db', 'execute', '--file', path.join(MIGRATIONS, GAPS, 'migration.sql'), '--schema', path.join(ROOT, 'prisma/schema.prisma')], dbUrl(name));
      expect(rerun.out).toContain('Script executed successfully');
      expect(rerun.code).toBe(0);
      expect(await one(`SELECT business_id, block_on_busy FROM calendar_connections ORDER BY business_id`)).toEqual([
        { business_id: 'b1', block_on_busy: true }, { business_id: 'b2', block_on_busy: false }, { business_id: 'b3', block_on_busy: true },
      ]);
    } finally {
      await c.$disconnect();
    }
  }, 240_000);

  test('no drift between prisma/migrations and schema.prisma', async () => {
    const shadow = await newDb('shadow');
    const r = rawPrisma(['migrate', 'diff', '--from-migrations', MIGRATIONS, '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--shadow-database-url', dbUrl(shadow), '--exit-code'], dbUrl(shadow));
    expect(r.out).toContain('No difference detected');
    expect(r.code).toBe(0);
  }, 120_000);
});
