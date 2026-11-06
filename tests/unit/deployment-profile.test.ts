import { describe, expect, it } from 'vitest';

import {
  assertDevProviderBootConfig,
  createDevProviderPolicy,
  loadB1AuthEnvironment,
  type LoopbackListener,
} from '../../apps/api/src/auth/dev-provider-policy.js';
import { EMBER_ENV_DEPLOYMENT, resolveDeploymentProfile } from '../../apps/api/src/deployment.js';
import { EMBER_ENVS } from '../../apps/api/src/env.js';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';

/**
 * One deployment classification, consumed by both the API and the Worker.
 *
 * The matrix is the security boundary: a run may only expose a development surface when *no*
 * environment marker says otherwise, and an unrecognised marker must never be read as
 * "development". These cases are deliberately exhaustive over the markers the code consults.
 */

function loopbackListener(): LoopbackListener {
  return { address: '127.0.0.1', family: 'IPv4', port: 8787 };
}

describe('resolveDeploymentProfile', () => {
  it('classifies every EMBER_ENV the API schema accepts', () => {
    // Drift guard: adding an environment to `EMBER_ENVS` without classifying it here would let
    // that environment skip the development-surface gate.
    expect(Object.keys(EMBER_ENV_DEPLOYMENT).sort()).toEqual([...EMBER_ENVS].sort());
  });

  it('treats local, test and ci as development runs', () => {
    for (const emberEnv of ['local', 'test', 'ci'] as const) {
      const profile = resolveDeploymentProfile({ EMBER_ENV: emberEnv });

      expect(profile.deployment).toBe('development');
      expect(profile.declaredBy).toBeNull();
      expect(profile.developmentSurfacesAllowed).toBe(true);
    }
  });

  it('defaults to development when nothing is declared', () => {
    const profile = resolveDeploymentProfile({});

    expect(profile.deployment).toBe('development');
    expect(profile.nodeEnv).toBeNull();
    expect(profile.developmentSurfacesAllowed).toBe(true);
  });

  it('treats staging and production as shared deployments', () => {
    expect(resolveDeploymentProfile({ EMBER_ENV: 'staging' })).toEqual({
      deployment: 'staging',
      nodeEnv: null,
      declaredBy: 'EMBER_ENV=staging',
      developmentSurfacesAllowed: false,
    });
    expect(resolveDeploymentProfile({ NODE_ENV: 'production' })).toEqual({
      deployment: 'production',
      nodeEnv: 'production',
      declaredBy: 'NODE_ENV=production',
      developmentSurfacesAllowed: false,
    });
  });

  it('takes the more restrictive of the two markers', () => {
    // A development marker must never downgrade a shared deployment.
    expect(
      resolveDeploymentProfile({ EMBER_ENV: 'local', NODE_ENV: 'production' }).deployment,
    ).toBe('production');
    expect(resolveDeploymentProfile({ EMBER_ENV: 'test', NODE_ENV: 'staging' }).deployment).toBe(
      'staging',
    );
    expect(resolveDeploymentProfile({ EMBER_ENV: 'staging', NODE_ENV: 'test' }).deployment).toBe(
      'staging',
    );
    expect(
      resolveDeploymentProfile({ EMBER_ENV: 'production', NODE_ENV: 'staging' }).deployment,
    ).toBe('production');
  });

  it('normalises the case and surrounding whitespace of NODE_ENV', () => {
    expect(resolveDeploymentProfile({ NODE_ENV: ' PRODUCTION ' }).deployment).toBe('production');
    expect(resolveDeploymentProfile({ NODE_ENV: 'Staging' }).deployment).toBe('staging');
    expect(resolveDeploymentProfile({ NODE_ENV: '  test  ' }).deployment).toBe('development');
  });

  it('fails closed on an unrecognised marker', () => {
    // An unknown marker is not evidence of a developer workstation.
    expect(resolveDeploymentProfile({ NODE_ENV: 'qa' })).toMatchObject({
      deployment: 'production',
      declaredBy: 'NODE_ENV=qa',
      developmentSurfacesAllowed: false,
    });
    // `EMBER_ENV` is compared exactly, mirroring the schema, so a padded value is not "local".
    expect(resolveDeploymentProfile({ EMBER_ENV: ' local ' }).deployment).toBe('production');
    expect(resolveDeploymentProfile({ EMBER_ENV: 'LOCAL' }).deployment).toBe('production');
  });

  it('never echoes a hostile marker verbatim', () => {
    const profile = resolveDeploymentProfile({ NODE_ENV: 'prod\nuction leaked=token' });

    expect(profile.declaredBy).toBe('NODE_ENV=<unrecognised>');
    expect(profile.deployment).toBe('production');
  });
});

describe('dev provider gate under a shared deployment', () => {
  function evaluateDevProvider(env: Record<string, string | undefined>) {
    return createDevProviderPolicy({
      environment: loadB1AuthEnvironment({
        EMBER_HOST: '127.0.0.1',
        EMBER_DEV_PROVIDER_ENABLED: 'true',
        EMBER_DEV_PROVIDER_ISOLATED: 'true',
        ...env,
      }),
      actualListener: loopbackListener,
    }).evaluate();
  }

  it('denies the dev path when only EMBER_ENV declares staging', () => {
    // `NODE_ENV` is unset here: the deployment marker alone must be enough.
    const decision = evaluateDevProvider({ EMBER_ENV: 'staging' });

    expect(decision.enabled).toBe(false);
    expect(decision.deniedBy).toContain('production_environment');
  });

  it('denies the dev path in production even when EMBER_ENV claims ci', () => {
    const decision = evaluateDevProvider({ EMBER_ENV: 'ci', NODE_ENV: 'production' });

    expect(decision.enabled).toBe(false);
    expect(decision.deniedBy).toContain('production_environment');
    // Defense in depth: the isolated-environment condition also refuses a non-isolated run.
    expect(decision.deniedBy).toContain('not_isolated_environment');
  });

  it('refuses to boot a shared deployment with the dev provider enabled', () => {
    for (const env of [
      { EMBER_ENV: 'staging' },
      { EMBER_ENV: 'production' },
      { NODE_ENV: 'staging' },
      { NODE_ENV: 'production' },
      { EMBER_ENV: 'ci', NODE_ENV: 'production' },
    ]) {
      expect(
        () =>
          assertDevProviderBootConfig(
            loadB1AuthEnvironment({
              EMBER_HOST: '127.0.0.1',
              EMBER_DEV_PROVIDER_ENABLED: 'true',
              ...env,
            }),
          ),
        JSON.stringify(env),
      ).toThrow(/refusing to start/);
    }
  });

  it('allows a shared deployment to boot with the dev provider left off', () => {
    expect(() =>
      assertDevProviderBootConfig(
        loadB1AuthEnvironment({ EMBER_ENV: 'staging', EMBER_HOST: '127.0.0.1' }),
      ),
    ).not.toThrow();
  });
});

describe('worker deployment classification', () => {
  it('accepts EMBER_ENV=staging for a reaper-only worker', () => {
    const config = loadWorkerConfig({ EMBER_ENV: 'staging' });

    expect(config.env).toBe('staging');
    expect(config.mode).toBe('reaper-only');
    expect(config.simulatedExecution).toBe('disabled');
    expect(config.b1FakeResponderEnabled).toBe(false);
  });

  it('refuses the fake responder and simulated execution in staging', () => {
    expect(() =>
      loadWorkerConfig({ EMBER_ENV: 'staging', EMBER_B1_FAKE_RESPONDER_ENABLED: 'true' }),
    ).toThrow(/production or staging environments/);

    expect(() =>
      loadWorkerConfig({
        EMBER_ENV: 'staging',
        EMBER_WORKER_MODE: 'poll',
        EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
      }),
    ).toThrow(/staging or production/);
  });

  it('refuses a shared deployment declared only through NODE_ENV', () => {
    expect(() =>
      loadWorkerConfig({ NODE_ENV: 'staging', EMBER_B1_FAKE_RESPONDER_ENABLED: 'true' }),
    ).toThrow(/production or staging environments/);

    expect(() =>
      loadWorkerConfig({
        NODE_ENV: 'production',
        EMBER_WORKER_MODE: 'poll',
        EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
      }),
    ).toThrow(/staging or production/);
  });

  it('fails closed on an unrecognised NODE_ENV', () => {
    expect(() =>
      loadWorkerConfig({ NODE_ENV: 'qa', EMBER_B1_FAKE_RESPONDER_ENABLED: 'true' }),
    ).toThrow(/production or staging environments/);
  });

  it('still allows the local simulated poll worker used by every e2e suite', () => {
    for (const env of [{ EMBER_ENV: 'local' }, { NODE_ENV: 'test' }, {}]) {
      expect(
        loadWorkerConfig({
          ...env,
          EMBER_WORKER_MODE: 'poll',
          EMBER_WORKER_SIMULATED_EXECUTION: 'local-only',
        }).mode,
        JSON.stringify(env),
      ).toBe('poll');
    }
  });
});
