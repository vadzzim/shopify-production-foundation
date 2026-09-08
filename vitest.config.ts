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
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov'],
      include: ['apps/*/src/**', 'packages/*/src/**'],
      exclude: ['**/*.test.ts', 'apps/*/src/web/**'],
    },
  },
});
