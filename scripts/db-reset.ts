/**
 * `bun run db:reset`: drop every table, re-apply the migrations and load the demo seed.
 *
 * `prisma migrate reset` is destructive, so the SAME database-name guard that protects seed.ts runs FIRST,
 * before anything is dropped. Pass --force-i-know to reset a database whose name does not look disposable.
 */
import { spawnSync } from 'node:child_process';
import { assertSafeDatabase, forwardedArgs } from './_safe-db';

assertSafeDatabase('db:reset');

const run = (cmd: string[]) => {
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

run(['bunx', 'prisma', 'migrate', 'reset', '--force', '--skip-seed']);
run(['bun', 'scripts/seed.ts', ...forwardedArgs()]);
