import {
  PostgresB1AssistantTurnRepository,
  PostgresB1ConsumerProvisioningRepository,
  PostgresB1ConsumerSessionRepository,
  PostgresB1ConversationReadRepository,
  PostgresB1ConversationWriteRepository,
  createPool,
} from '@ember/postgres/b1-worker';
import type { B1SessionPorts } from './auth/session-service.js';
import { createB1SessionRuntime } from './auth/b1-auth-runtime.js';
import {
  APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS,
  APPLE_DEFAULT_JWKS_COOLDOWN_MS,
  APPLE_DEFAULT_JWKS_TIMEOUT_MS,
  APPLE_JWKS_URL,
  loadAppleVerifierConfig,
} from './auth/apple-identity.js';
import type { B1SessionRuntime } from './auth/b1-auth-runtime.js';
import { createDevTokenAuthenticator } from './auth/bearer-authenticator.js';
import { createLogger } from './logger.js';
import { createDatabaseReadiness } from './readiness.js';
import { createApp } from './app.js';
import type { DevProviderPolicy } from './auth/dev-provider-policy.js';
import { PostgresB1MeProjectionReader } from './auth/b1-me-projection-reader.js';
import {
  createCloudflareAppleNonceReplayStore,
  createCloudflareAppleNonceVerifier,
} from './cloudflare-apple-replay.js';
import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export interface CloudflareHyperdriveBinding {
  readonly connectionString: string;
}

export interface CloudflareApiBindings {
  readonly HYPERDRIVE: CloudflareHyperdriveBinding;
  readonly EMBER_APPLE_BUNDLE_ID: string;
  readonly EMBER_APPLE_CLOCK_SKEW_SECONDS?: string;
  readonly EMBER_APPLE_MAX_TOKEN_AGE_SECONDS?: string;
  readonly EMBER_APPLE_JWKS_TIMEOUT_MS?: string;
  readonly EMBER_APPLE_JWKS_COOLDOWN_MS?: string;
  readonly EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS?: string;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type WorkerPool = ReturnType<typeof createPool>;

const APPLE_KEY_RESOLVER: JWTVerifyGetKey = createRemoteJWKSet(new URL(APPLE_JWKS_URL), {
  timeoutDuration: APPLE_DEFAULT_JWKS_TIMEOUT_MS,
  cooldownDuration: APPLE_DEFAULT_JWKS_COOLDOWN_MS,
  cacheMaxAge: APPLE_DEFAULT_JWKS_CACHE_MAX_AGE_MS,
});

const DENY_DEV_PROVIDER: DevProviderPolicy = Object.freeze({
  evaluate: () => ({
    enabled: false,
    deniedBy: Object.freeze([
      'production_environment',
      'opt_in_missing',
      'not_isolated_environment',
      'listener_not_loopback',
    ] as const),
  }),
});

function authEnvironment(bindings: CloudflareApiBindings): NodeJS.ProcessEnv {
  return {
    EMBER_APPLE_BUNDLE_ID: bindings.EMBER_APPLE_BUNDLE_ID,
    EMBER_APPLE_CLOCK_SKEW_SECONDS: bindings.EMBER_APPLE_CLOCK_SKEW_SECONDS,
    EMBER_APPLE_MAX_TOKEN_AGE_SECONDS: bindings.EMBER_APPLE_MAX_TOKEN_AGE_SECONDS,
    EMBER_APPLE_JWKS_TIMEOUT_MS: bindings.EMBER_APPLE_JWKS_TIMEOUT_MS,
    EMBER_APPLE_JWKS_COOLDOWN_MS: bindings.EMBER_APPLE_JWKS_COOLDOWN_MS,
    EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS: bindings.EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS,
  };
}

function createWorkerPool(bindings: CloudflareApiBindings): WorkerPool {
  return createPool(
    {
      connectionString: bindings.HYPERDRIVE.connectionString,
      maxConnections: 1,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 5_000,
      // Hyperdrive uses transaction pooling; the runtime role applies the 5 s default.
      statementTimeoutOnConnect: false,
      applicationName: 'ember-api-workers',
    },
    {
      onClientError: () => {
        // Driver error text can include SQL or connection details; do not log it.
      },
    },
  );
}

function createWorkerLogger(): ReturnType<typeof createLogger> {
  return createLogger({
    level: 'info',
    sink: (level, line) => {
      if (level === 'error') {
        console.error(line);
      } else if (level === 'warn') {
        console.warn(line);
      } else if (level === 'info') {
        console.log(line);
      }
    },
  });
}

function createWorkerApp(pool: WorkerPool, bindings: CloudflareApiBindings) {
  const ports: B1SessionPorts = {
    provisioning: new PostgresB1ConsumerProvisioningRepository(pool),
    sessions: new PostgresB1ConsumerSessionRepository(pool),
    me: new PostgresB1MeProjectionReader(pool),
  };
  const apple = {
    ...loadAppleVerifierConfig(authEnvironment(bindings)),
    keyResolver: APPLE_KEY_RESOLVER,
  };
  const sessionRuntime = createB1SessionRuntime({
    ports,
    apple,
    devProvider: DENY_DEV_PROVIDER,
  });
  const b1Session: B1SessionRuntime = Object.freeze({
    ...sessionRuntime,
    appleVerifier: createCloudflareAppleNonceVerifier(
      sessionRuntime.appleVerifier,
      createCloudflareAppleNonceReplayStore(pool),
    ),
  });
  const logger = createWorkerLogger();

  // The API exposes the same B1 HTTP routes and SQL repositories as Node. It has no background
  // responder, model credential, or Fake Model path; model completion remains the PR #130 seam.
  return createApp({
    readiness: createDatabaseReadiness(pool),
    serviceVersion: 'cloudflare-poc',
    logger,
    authenticator: createDevTokenAuthenticator([]),
    b1Session,
    b1ConversationWriteRepository: new PostgresB1ConversationWriteRepository(pool),
    b1ConversationReadRepository: new PostgresB1ConversationReadRepository(pool),
    b1AssistantTurnRepository: new PostgresB1AssistantTurnRepository(pool),
  });
}

export default {
  async fetch(
    request: Request,
    bindings: CloudflareApiBindings,
    context: WorkerExecutionContext,
  ): Promise<Response> {
    const pool = createWorkerPool(bindings);

    try {
      return await createWorkerApp(pool, bindings).fetch(request);
    } finally {
      // Hyperdrive owns the cross-isolate pool; do not hold a client socket in the isolate.
      // The request response is already determined by the awaited route before this cleanup.
      context.waitUntil(pool.end().catch(() => undefined));
    }
  },
};
