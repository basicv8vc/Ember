import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests require a real PostgreSQL instance via `TEST_DATABASE_URL` (or `DATABASE_URL`).
 * Each test run creates and drops its own uniquely named ephemeral schema (`ember_e2e_*`).
 * The full HTTP loopback API and Durable Worker are run and verified end-to-end.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ember/connectors': fileURLToPath(
        new URL('./packages/connectors/src/index.ts', import.meta.url),
      ),
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
      '@ember/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'e2e',
    environment: 'node',
    globals: false,
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
