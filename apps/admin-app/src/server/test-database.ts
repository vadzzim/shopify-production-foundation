import { PrismaClient } from '@prisma/client';

/**
 * A real PostgreSQL connection for the tests that need one.
 *
 * Most of this codebase is tested against fakes, and deliberately so — it keeps
 * the suite fast and it is what makes the failure paths cheap to reach. But two
 * of the things phase 3 rests on are *not properties of our code at all*, and a
 * fake can only ever confirm that we called the method we meant to call:
 *
 * - `ON CONFLICT DO NOTHING` making a duplicate insert a no-op (rule 10), and
 * - `FOR UPDATE SKIP LOCKED` handing one row to exactly one of two concurrent
 *   claimants (rule 9).
 *
 * A mocked `prisma.job.createMany` returning `{count: 0}` on the second call
 * proves nothing except that the mock was written to. So those tests talk to
 * PostgreSQL.
 *
 * They skip themselves when `DATABASE_URL` is unset, so `pnpm test` still
 * passes for someone who has cloned the repository and not started Docker yet.
 * CI does set it — there is a `postgres:16-alpine` service in the workflow —
 * which is the point: the guarantees above are checked on every pull request,
 * not only on the machine of whoever remembered to run `docker compose up`.
 */

export const databaseUrl = process.env.DATABASE_URL;

/** True when the integration tests can run. Used with `describe.skipIf`. */
export const hasDatabase = Boolean(databaseUrl);

/**
 * Shop domains used by integration tests.
 *
 * A prefix rather than a truncated database, so a test run cannot destroy
 * whatever a developer has in their local store's tables. Every row an
 * integration test writes is scoped to a shop starting with this, and cleanup
 * deletes exactly that.
 */
export const TEST_SHOP_PREFIX = 'itest-';

export function testShop(name: string): string {
  return `${TEST_SHOP_PREFIX}${name}.myshopify.com`;
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient();
}

/**
 * Remove what one integration file has written.
 *
 * Scoped to a single shop rather than to the whole `itest-` prefix, so one
 * file's `afterEach` cannot delete rows another file is still asserting on.
 * That is not hypothetical — it is how these tests first failed, together with
 * the file parallelism now turned off in `vitest.config.ts`: the queue is
 * deliberately global, so a worker in one file will happily claim a job created
 * in another.
 */
export async function cleanTestData(
  prisma: PrismaClient,
  shop: string,
): Promise<void> {
  await prisma.job.deleteMany({ where: { shop } });
  await prisma.webhookDelivery.deleteMany({ where: { shop } });
  // BundleItem rows cascade from Bundle.
  await prisma.bundle.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
}

/**
 * The single element of an array, or a failure that says what was there.
 *
 * `noUncheckedIndexedAccess` is on, so `const [job] = await claimJobs(...)`
 * gives `QueueJob | undefined` and every use of it needs a guard. Writing `!`
 * at each one would turn a genuinely empty result — the queue handed back
 * nothing — into `Cannot read properties of undefined`, which is a worse
 * failure message than the assertion it replaced.
 */
export function only<T>(items: readonly T[]): T {
  if (items.length !== 1) {
    throw new Error(`Expected exactly one item, got ${String(items.length)}.`);
  }
  return items[0] as T;
}
