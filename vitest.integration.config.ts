import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests require a real PostgreSQL instance via `TEST_DATABASE_URL`.
 * Each test run creates and drops its own uniquely named schema; nothing else is touched.
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
      '@ember/model-gateway': fileURLToPath(
        new URL('./packages/model-gateway/src/index.ts', import.meta.url),
      ),
      '@ember/postgres/b2-worker': fileURLToPath(
        new URL('./packages/postgres/src/b2-worker.ts', import.meta.url),
      ),
      '@ember/postgres': fileURLToPath(
        new URL('./packages/postgres/src/index.ts', import.meta.url),
      ),
      '@ember/worker/b1/model-turn-responder': fileURLToPath(
        new URL('./apps/worker/src/b1/model-turn-responder.ts', import.meta.url),
      ),
      '@ember/worker/notes-task-handler': fileURLToPath(
        new URL('./apps/worker/src/notes-task-handler.ts', import.meta.url),
      ),
      '@ember/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'integration',
    environment: 'node',
    globals: false,
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
