import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests never touch PostgreSQL and never bind a fixed port.
 * `@ember/postgres` resolves to TypeScript sources so tests do not require a build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ember/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@ember/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@ember/postgres': fileURLToPath(
        new URL('./packages/postgres/src/index.ts', import.meta.url),
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
