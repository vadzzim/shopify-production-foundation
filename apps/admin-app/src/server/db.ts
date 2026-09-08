import { PrismaClient } from '@prisma/client';

/**
 * One PrismaClient for the process.
 *
 * `tsx watch` re-evaluates modules on every save; without this cache each
 * reload would open a new connection pool and the database would refuse
 * connections after a few dozen edits.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
