import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests never touch PostgreSQL and never bind a fixed port.
 * `@ember/postgres` resolves to TypeScript sources so tests do not require a build.
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
      '@ember/sandbox-daytona': fileURLToPath(
        new URL('./packages/sandbox-daytona/src/index.ts', import.meta.url),
      ),
      '@ember/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'unit',
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.ts'],
  },
});
