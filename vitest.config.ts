import { defineConfig } from 'vitest/config';

/**
 * One Vitest run for the whole workspace.
 *
 * Tests live next to the code they cover rather than in a parallel tree: a
 * module and its test move together, and a test with no module beside it is
 * visible as dead weight.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Several suites assert on the failure paths, which log at error level.
    // Without this the reporter's output is mostly the errors the tests asked
    // for, and a real one is hard to spot among them.
    setupFiles: ['vitest.setup.ts'],
    // The integration suites share one PostgreSQL database, and the queue they
    // exercise is deliberately global: `claimJobs` takes the oldest runnable
    // job regardless of shop, which is the behaviour a second worker process
    // needs. Two test files running at once are two such workers, and each was
    // claiming the other's jobs. Scoping the fixtures per shop is not enough on
    // its own, so files run one at a time. The suite is small enough that this
    // costs under a second.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      include: ['apps/*/src/**', 'packages/*/src/**'],
      exclude: ['**/*.test.ts', 'apps/*/src/web/**'],
    },
  },
});
