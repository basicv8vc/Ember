/**
 * Type declarations for the dependency-free staging preflight guard.
 *
 * The guard is plain ESM so it can run on a host that has Docker but no TypeScript
 * toolchain. Tests import it directly; this declaration is what makes that type-safe.
 */

export declare const GUARD_VERSION: string;

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

export declare function parseEnvFile(text: string): Map<string, string>;

export declare function evaluateStagingEnv(
  env: Map<string, string>,
  options?: { readonly mode?: 'staging' | 'local' },
): GuardResult;

export declare function formatReport(result: GuardResult, envFileLabel?: string): string;
