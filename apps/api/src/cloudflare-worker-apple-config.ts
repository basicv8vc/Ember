import { loadAppleVerifierConfig, type AppleVerifierConfig } from './auth/apple-identity.js';
import type { JWTVerifyGetKey } from 'jose';

export interface CloudflareAppleVerifierBindings {
  readonly EMBER_APPLE_BUNDLE_ID: string;
  readonly EMBER_APPLE_CLOCK_SKEW_SECONDS?: string;
  readonly EMBER_APPLE_MAX_TOKEN_AGE_SECONDS?: string;
  readonly EMBER_APPLE_JWKS_TIMEOUT_MS?: string;
  readonly EMBER_APPLE_JWKS_COOLDOWN_MS?: string;
  readonly EMBER_APPLE_JWKS_CACHE_MAX_AGE_MS?: string;
}

/** Maps the deployed Worker vars to the shared Apple verifier configuration. */
export function loadCloudflareAppleVerifierConfig(
  bindings: CloudflareAppleVerifierBindings,
  keyResolver: JWTVerifyGetKey,
): AppleVerifierConfig {
  return {
    ...loadAppleVerifierConfig({ ...bindings }),
    keyResolver,
  };
}
