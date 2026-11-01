import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Chaos tests require a real PostgreSQL instance via `TEST_DATABASE_URL`.
 * Each test run creates and drops its own uniquely named schema; nothing else is touched.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ember/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@ember/credentials': fileURLToPath(
        new URL('./packages/credentials/src/index.ts', import.meta.url),
      ),
      '@ember/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@ember/execution': fileURLToPath(
        new URL('./packages/execution/src/index.ts', import.meta.url),
      ),
      '@ember/postgres': fileURLToPath(
        new URL('./packages/postgres/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'chaos',
    environment: 'node',
    globals: false,
    include: ['tests/chaos/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
