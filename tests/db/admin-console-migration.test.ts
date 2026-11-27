/**
 * Migration 20261211120000_admin_console_schema: upgrades a POPULATED database that is at the previous migration (businesses on known and unknown plan strings, admin and owner users),
 * keeps every row, REGISTERS unknown plan strings as hidden non-comped plans with NULL caps exactly like the trigger (no remap to the comped 'legacy'; recorded in audit_events), migrates admins to platform_role 'owner', seeds plans and settings_state, validates
 * every constraint it adds, registers unknown plans through the trigger afterwards, is re-runnable, and leaves zero drift between prisma/migrations and schema.prisma.
 *
 * Skipped unless TEST_DATABASE_URL names a disposable database containing "test" or "scratch" (it creates and drops scratch_mig_* databases on the same server).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
const NEW = '20261211120000_admin_console_schema';

suite('migration admin_console_schema (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const run = Math.random().toString(36).slice(2, 8);
  const names: string[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'mig-admin-'));
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

  test('upgrades a populated old-schema database safely, maps plans, migrates admins, validates constraints, is re-runnable, zero drift', async () => {
    const oldSchema = historyBefore('old', NEW);
    const name = await newDb('old');
    expect(prisma(['migrate', 'deploy'], dbUrl(name), oldSchema).code).toBe(0);
    const c = client(name);
    try {
      expect(await c.$queryRawUnsafe(`SELECT to_regclass('public.plans')::text AS t`)).toEqual([{ t: null }]);
      for (const [id, plan] of [['b_std', 'standard'], ['b_comp', 'comp'], ['b_x', 'x'], ['b_cap', 'Plan'], ['b_legacy', 'legacy'], ['b_null', null], ['b_demo', 'demo']] as const) {
        await c.$executeRawUnsafe(`INSERT INTO businesses(id,name,plan) VALUES ($1,$2,$3)`, id, `Co ${id}`, plan);
      }
      for (const [id, email, role, biz] of [['u_a1', 'root@example.test', 'admin', null], ['u_a2', 'second@example.test', 'admin', null], ['u_o1', 'owner@example.test', 'owner', 'b_std']] as const) {
        await c.$executeRawUnsafe(`INSERT INTO users(id,email,password_hash,role,business_id) VALUES ($1,$2,'x',$3,$4)`, id, email, role, biz);
      }
      await c.$executeRawUnsafe(`INSERT INTO audit_events(id,actor_kind,action) VALUES ('pre_audit','system','pre.existing')`);
    } finally { await c.$disconnect(); }

    const up = prisma(['migrate', 'deploy'], dbUrl(name));
    expect(up.out).toContain('successfully applied');
    expect(up.code).toBe(0);

    const d = client(name);
    try {
      // nothing lost
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM businesses`)).toEqual([{ n: 7 }]);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM audit_events WHERE id='pre_audit'`)).toEqual([{ n: 1 }]);
      // plan strings: every string stays AS IS (no remap: a tenant on an unknown plan name is not silently comped), NULL stays NULL
      const plans = Object.fromEntries((await d.$queryRawUnsafe(`SELECT id, plan FROM businesses`)).map((r: any) => [r.id, r.plan]));
      expect(plans).toEqual({ b_std: 'standard', b_comp: 'comp', b_x: 'x', b_cap: 'Plan', b_legacy: 'legacy', b_null: null, b_demo: 'demo' });
      // the unknown strings are registered exactly as the trigger does: hidden, NOT comped, NULL caps (inherit the platform), never the comped 'legacy'
      expect(await d.$queryRawUnsafe(`SELECT key, public, is_comped, sms_cap, call_minutes_cap, voicemail_minutes_cap, forward_minutes_cap, sort FROM plans WHERE key IN ('comp','x','Plan') ORDER BY key COLLATE "C"`)).toEqual([
        { key: 'Plan', public: false, is_comped: false, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, sort: 1000 },
        { key: 'comp', public: false, is_comped: false, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, sort: 1000 },
        { key: 'x', public: false, is_comped: false, sms_cap: null, call_minutes_cap: null, voicemail_minutes_cap: null, forward_minutes_cap: null, sort: 1000 },
      ]);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM audit_events WHERE action='plans.migrated'`)).toEqual([{ n: 0 }]);
      expect(await d.$queryRawUnsafe(`SELECT meta->>'plan' AS p, (meta->>'businesses')::int AS n FROM audit_events WHERE action='plans.registered' ORDER BY (meta->>'plan') COLLATE "C"`)).toEqual([{ p: 'Plan', n: 1 }, { p: 'comp', n: 1 }, { p: 'x', n: 1 }]);
      // seeds
      expect(await d.$queryRawUnsafe(`SELECT key, is_comped, public, sms_cap, call_minutes_cap, voicemail_minutes_cap, forward_minutes_cap FROM plans WHERE key IN ('standard','legacy','grandfathered','demo') ORDER BY sort`)).toEqual([
        { key: 'standard', is_comped: false, public: true, sms_cap: 500, call_minutes_cap: 300, voicemail_minutes_cap: 60, forward_minutes_cap: 600 },
        { key: 'legacy', is_comped: true, public: false, sms_cap: 500, call_minutes_cap: 300, voicemail_minutes_cap: 60, forward_minutes_cap: 600 },
        { key: 'grandfathered', is_comped: true, public: false, sms_cap: 500, call_minutes_cap: 300, voicemail_minutes_cap: 60, forward_minutes_cap: 600 },
        { key: 'demo', is_comped: false, public: false, sms_cap: 500, call_minutes_cap: 300, voicemail_minutes_cap: 60, forward_minutes_cap: 600 },
      ]);
      expect(await d.$queryRawUnsafe(`SELECT id, global_version::int AS v FROM settings_state`)).toEqual([{ id: 1, v: 0 }]);
      // admins -> owner; owners and staff have no platform role
      expect(await d.$queryRawUnsafe(`SELECT id, platform_role FROM users ORDER BY id`)).toEqual([{ id: 'u_a1', platform_role: 'owner' }, { id: 'u_a2', platform_role: 'owner' }, { id: 'u_o1', platform_role: null }]);
      // every constraint it added is validated
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE NOT convalidated`)).toEqual([]);
      // the trigger registers a new unknown plan as a hidden, non-comped, cap-less plan (so every writer of a free string keeps working)
      await d.$executeRawUnsafe(`UPDATE businesses SET plan='brand-new' WHERE id='b_null'`);
      expect(await d.$queryRawUnsafe(`SELECT key, public, is_comped, sms_cap FROM plans WHERE key='brand-new'`)).toEqual([{ key: 'brand-new', public: false, is_comped: false, sms_cap: null }]);
      await d.$executeRawUnsafe(`INSERT INTO businesses(id,name,plan) VALUES ('b_ins','Ins','another-new')`);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM plans WHERE key='another-new'`)).toEqual([{ n: 1 }]);
      // the plan cannot be deleted while a business uses it
      expect(await fails(d.$executeRawUnsafe(`DELETE FROM plans WHERE key='standard'`))).toBe(true);
      // CHECK constraints
      expect(await fails(d.$executeRawUnsafe(`UPDATE users SET platform_role='owner' WHERE id='u_o1'`))).toBe(true); // only for admins
      expect(await fails(d.$executeRawUnsafe(`UPDATE users SET platform_role='god' WHERE id='u_a1'`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`UPDATE businesses SET suspended_at=now() WHERE id='b_std'`))).toBe(true); // suspended_by is required with suspended_at
      await d.$executeRawUnsafe(`UPDATE businesses SET suspended_at=now(), suspended_by='u_a1', suspended_reason='abuse' WHERE id='b_std'`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO platform_settings(key,integrity_mac) VALUES ('a.b','m')`))).toBe(true); // neither value nor envelope
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO platform_settings(key,value,secret_envelope,integrity_mac) VALUES ('a.b','1','v2.x','m')`))).toBe(true); // both
      await d.$executeRawUnsafe(`INSERT INTO platform_settings(key,value,integrity_mac) VALUES ('a.b','1','m')`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO platform_settings(key,value,integrity_mac) VALUES ('BAD KEY','1','m')`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO settings_state(id) VALUES (2)`))).toBe(true); // a single row
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO setting_change_sets(id,status) VALUES ('cs','bogus')`))).toBe(true);
      await d.$executeRawUnsafe(`INSERT INTO setting_change_sets(id,status) VALUES ('cs1','pending_approval')`); // reserved for approval flows
      await d.$executeRawUnsafe(`INSERT INTO setting_change_sets(id,status) VALUES ('cs2','scheduled')`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO job_runs(id,job,started_at,status) VALUES ('j','cleanup',now(),'weird')`))).toBe(true);
      await d.$executeRawUnsafe(`INSERT INTO job_runs(id,job,started_at,dry_run) VALUES ('j1','cleanup',now(),true)`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO legal_pages(slug,locale) VALUES ('cookies','en')`))).toBe(true);
      await d.$executeRawUnsafe(`INSERT INTO legal_pages(slug,locale) VALUES ('terms','en')`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO legal_page_versions(id,slug,locale,version,body) VALUES ('l1','terms','en',1,$1)`, 'x'.repeat(200_001)))).toBe(true); // size cap
      await d.$executeRawUnsafe(`INSERT INTO legal_page_versions(id,slug,locale,version,body) VALUES ('l1','terms','en',1,'# Terms')`);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO legal_page_versions(id,slug,locale,version,body) VALUES ('l2','terms','en',1,'dup')`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO plans(key,name,sms_cap) VALUES ('neg','Neg',-1)`))).toBe(true);
      expect(await fails(d.$executeRawUnsafe(`INSERT INTO support_grants(id,user_id,business_id,reason,expires_at) VALUES ('g','u_a1','b_std','why', now() - interval '1 hour')`))).toBe(true);
      // deleting a business removes its overrides and grants; deleting an admin removes their grants
      await d.$executeRawUnsafe(`INSERT INTO tenant_setting_overrides(business_id,key,value) VALUES ('b_x','jobs.briefing_hour','19')`);
      await d.$executeRawUnsafe(`DELETE FROM businesses WHERE id='b_x'`);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM tenant_setting_overrides`)).toEqual([{ n: 0 }]);

      // re-runnable: applying the migration SQL again changes nothing and fails nowhere (no duplicate audit rows, no second seed, admins untouched)
      const auditBefore = await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM audit_events WHERE action='plans.registered'`);
      const file = path.join(MIGRATIONS, NEW, 'migration.sql');
      const again = rawPrisma(['db', 'execute', '--file', file, '--schema', path.join(ROOT, 'prisma/schema.prisma')], dbUrl(name));
      expect(again.code).toBe(0);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM audit_events WHERE action='plans.registered'`)).toEqual(auditBefore);
      expect(await d.$queryRawUnsafe(`SELECT count(*)::int AS n FROM plans WHERE key IN ('standard','legacy','grandfathered','demo')`)).toEqual([{ n: 4 }]);
      expect(await d.$queryRawUnsafe(`SELECT global_version::int AS v FROM settings_state`)).toEqual([{ v: 0 }]);
      expect(await d.$queryRawUnsafe(`SELECT conname FROM pg_constraint WHERE NOT convalidated`)).toEqual([]);
    } finally { await d.$disconnect(); }

    // zero drift: the migrations produce exactly schema.prisma
    const shadow = await newDb('shadow');
    const diff = rawPrisma(['migrate', 'diff', '--from-migrations', path.join(ROOT, 'prisma/migrations'), '--to-schema-datamodel', path.join(ROOT, 'prisma/schema.prisma'), '--shadow-database-url', dbUrl(shadow), '--exit-code'], dbUrl(name));
    expect(diff.out).toContain('No difference detected');
    expect(diff.code).toBe(0);
  }, 240_000);
});
