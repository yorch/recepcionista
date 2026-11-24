/**
 * One Prisma client per process. Next's dev server reloads modules on every
 * edit, and each reload would otherwise open a new pool until Postgres refuses
 * connections — the global cache is what makes hot reload survivable.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

/** The shared client or an interactive-transaction client: helpers that must join a caller's transaction accept either. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaQueryRecorder?: { active: string[] | null } };

/** Tests only (set by tests/helpers/preload.ts): emit query events so a test can count the statements a code path runs. */
const queryEvents = process.env.PRISMA_QUERY_EVENTS === '1';

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: queryEvents
      ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
      : process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

/** While `active` is an array, every SQL statement the shared client runs is appended to it (see `recordQueries`). Inert unless PRISMA_QUERY_EVENTS=1. */
export const queryRecorder = (globalForPrisma.prismaQueryRecorder ??= { active: null });
if (queryEvents && !globalForPrisma.prisma) {
  (prisma as unknown as { $on(ev: 'query', cb: (e: { query: string }) => void): void }).$on('query', (e) => { queryRecorder.active?.push(e.query); });
}

/** Run `fn` and return the SQL statements it caused (requires PRISMA_QUERY_EVENTS=1; otherwise the list is empty). Test helper. */
export async function recordQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  const queries: string[] = [];
  queryRecorder.active = queries;
  try {
    return { result: await fn(), queries };
  } finally {
    queryRecorder.active = null;
  }
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
