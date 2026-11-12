/**
 * Type declarations for the dependency-free staging preflight guard.
 *
 * The guard is plain ESM so it can run on a host that has Docker but no TypeScript
 * toolchain. Tests import it directly; this declaration is what makes that type-safe.
 */

export declare const GUARD_VERSION: string;

/** Location of the reviewed paid-model authorization, fixed by module path. */
export declare const MODEL_AUTHORIZATION_PATH: URL;

export interface GuardViolation {
  readonly code: string;
  readonly variable: string;
  readonly message: string;
}

export interface GuardWarning {
  readonly code: string;
  readonly message: string;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly mode: string;
  readonly violations: readonly GuardViolation[];
  readonly warnings: readonly GuardWarning[];
}

/** One reviewed decision that allows a paid model to be used by a deployment. */
export interface ModelAuthorizationEntry {
  readonly authorizationId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionScope: 'resident' | 'smoke_only';
  readonly rateVersion: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  /** Official provider catalog pricing URL reviewed before the first call; invoices are reconciled later. */
  readonly priceSource: string;
  readonly maxPerAttemptMicroUsd: number;
  readonly maxPrincipalDailyMicroUsd: number;
  readonly maxTenantDailyMicroUsd: number;
  readonly maxGlobalDailyMicroUsd: number;
  readonly maxPrincipalDailyTurns: number;
  readonly maxPaidSmokeTurns: number;
  readonly stagingAlpha?: {
    readonly approval: {
      readonly approvalId: string;
      readonly approvedBy: string;
      readonly approvedAt: string;
      readonly expiresAt: string;
    };
    readonly budgetCeilings: {
      readonly perAttemptMicroUsd: number;
      readonly principalDailyMicroUsd: number;
      readonly tenantDailyMicroUsd: number;
      readonly globalDailyMicroUsd: number;
      readonly principalDailyTurns: number;
    };
    readonly externalApiKeySpendLimitUsd: 1;
    readonly maxTurns: 1;
    readonly maxProviderAttemptsPerTurn: 1;
  };
}

export interface ModelAuthorizationManifest {
  readonly readable: boolean;
  readonly entries: readonly ModelAuthorizationEntry[];
  readonly reason: 'shape' | 'json' | 'read' | null;
}

export type ModelAuthorizationStatus =
  | 'authorized'
  | 'not_requested'
  | 'manifest_unreadable'
  | 'model_unset'
  | 'no_authorization'
  | 'duplicate_authorization'
  | 'malformed_authorization'
  | 'not_yet_valid'
  | 'expired';

export type ModelAuthorizationLookup =
  | { readonly status: 'authorized'; readonly entry: ModelAuthorizationEntry }
  | { readonly status: Exclude<ModelAuthorizationStatus, 'authorized'> };

export declare function parseEnvFile(text: string): Map<string, string>;

export declare function utcDay(date?: Date): string;

export declare function loadModelAuthorizationManifest(source?: URL): ModelAuthorizationManifest;

export declare function findModelAuthorization(
  manifest: ModelAuthorizationManifest | undefined,
  query: { readonly providerId: string; readonly modelId: string; readonly today: string },
): ModelAuthorizationLookup;

export declare function isE2eRunPrefix(value: string | undefined): boolean;

export declare function generateE2eRunPrefix(): string;

export declare function evaluateStagingEnv(
  env: Map<string, string>,
  options?: {
    readonly mode?: 'staging' | 'local' | 'e2e';
    readonly authorization?: ModelAuthorizationManifest;
    readonly now?: Date;
  },
): GuardResult;

export declare function formatReport(result: GuardResult, envFileLabel?: string): string;
