import type { AddressInfo } from 'node:net';
import type { JWTVerifyGetKey } from 'jose';
import {
  createAppleIdentityVerifier,
  loadAppleVerifierConfig,
  type AppleVerifierConfig,
} from './apple-identity.js';
import {
  assertDevProviderBootConfig,
  createDevProviderPolicy,
  loadB1AuthEnvironment,
  type LoopbackListener,
} from './dev-provider-policy.js';
import { createDevIdentityVerifier, type IdentityVerifier } from './identity-verifier.js';
import {
  createSessionService,
  type B1MeProjectionReader,
  type B1SessionPorts,
  type SessionService,
} from './session-service.js';
import type { DevProviderPolicy } from './dev-provider-policy.js';

/**
 * Composition root for the B1 auth runtime.
 *
 * Every dependency is explicitly typed and injected. The API startup composition supplies
 * the PostgreSQL-backed ports; unit and E2E tests may supply isolated PostgreSQL fixtures.
 * Until a runtime is injected, `createApp` registers none of the new endpoints (fail closed).
 */
export interface B1SessionRuntime {
  readonly service: SessionService;
  readonly appleVerifier: IdentityVerifier;
  readonly devVerifier: IdentityVerifier;
  readonly devProvider: DevProviderPolicy;
  readonly me: B1MeProjectionReader;
}

export interface CreateB1SessionRuntimeOptions {
  readonly ports: B1SessionPorts;
  readonly apple: AppleVerifierConfig;
  readonly devProvider: DevProviderPolicy;
  readonly now?: () => Date;
}

export function createB1SessionRuntime(options: CreateB1SessionRuntimeOptions): B1SessionRuntime {
  // Invalid or placeholder Apple configuration throws here, before any request is served.
  const appleVerifier = createAppleIdentityVerifier(options.apple);

  return Object.freeze({
    service: createSessionService({ ports: options.ports, now: options.now }),
    appleVerifier,
    devVerifier: createDevIdentityVerifier(),
    devProvider: options.devProvider,
    me: options.ports.me,
  });
}

export interface CreateB1AuthRuntimeFromEnvironmentOptions {
  readonly ports: B1SessionPorts;
  readonly env?: NodeJS.ProcessEnv;
  /** Real bound address from `server.address()`; omitted means "not listening" (deny). */
  readonly actualListener?: () => LoopbackListener;
  /** In-process deterministic JWKS fixture seam; never read from environment or production config. */
  readonly appleKeyResolver?: JWTVerifyGetKey;
  readonly now?: () => Date;
}

/**
 * Production/DI entry point. Loads configuration, asserts the R-9 boot rules and builds
 * the runtime. `EMBER_APPLE_BUNDLE_ID` is mandatory: a process without real verification
 * configuration refuses to start rather than serving an unusable or unsafe auth route.
 */
export function createB1AuthRuntimeFromEnvironment(
  options: CreateB1AuthRuntimeFromEnvironmentOptions,
): B1SessionRuntime {
  const env = options.env ?? process.env;
  const authEnvironment = loadB1AuthEnvironment(env);
  assertDevProviderBootConfig(authEnvironment);

  return createB1SessionRuntime({
    ports: options.ports,
    apple: {
      ...loadAppleVerifierConfig(env),
      ...(options.appleKeyResolver === undefined ? {} : { keyResolver: options.appleKeyResolver }),
    },
    devProvider: createDevProviderPolicy({
      environment: authEnvironment,
      ...(options.actualListener === undefined ? {} : { actualListener: options.actualListener }),
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Helper for the CTO's final runtime wiring: the exact listener type Node reports. */
export type ListenerAddress = AddressInfo | string | null;
