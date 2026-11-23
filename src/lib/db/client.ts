/**
 * One Prisma client per process. Next's dev server reloads modules on every
 * edit, and each reload would otherwise open a new pool until Postgres refuses
 * connections — the global cache is what makes hot reload survivable.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

/** The shared client or an interactive-transaction client: helpers that must join a caller's transaction accept either. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
