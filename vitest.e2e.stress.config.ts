import { defineConfig } from 'vitest/config';
import e2eConfig from './vitest.e2e.config.js';

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    name: 'e2e-stress',
    include: ['tests/e2e/stress/**/*.stress.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
