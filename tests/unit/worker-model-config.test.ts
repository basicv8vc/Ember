import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';

describe('Worker model execution purpose', () => {
  it('keeps a Smoke-only approval unavailable to the resident Worker even with a purpose env var', () => {
    const env: NodeJS.ProcessEnv = {
      EMBER_MODEL_EXECUTION: 'real',
      EMBER_MODEL_PROVIDER: 'openrouter',
      EMBER_MODEL_ID: 'nvidia/nemotron-3.5-lightning',
      EMBER_MODEL_EXECUTION_PURPOSE: 'paid_smoke',
    };

    expect(() => loadWorkerConfig(env)).toThrow(/execution_scope_refused/);
  });
});
