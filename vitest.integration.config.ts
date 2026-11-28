import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ember/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@ember/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@ember/model-gateway': fileURLToPath(
        new URL('./packages/model-gateway/src/index.ts', import.meta.url),
      ),
      '@ember/runtime-v2': fileURLToPath(
        new URL('./packages/runtime-v2/src/index.ts', import.meta.url),
      ),
      '@ember/sandbox-daytona': fileURLToPath(
        new URL('./packages/sandbox-daytona/src/index.ts', import.meta.url),
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
