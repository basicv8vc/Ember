/**
 * Core type definitions for @ember/credentials.
 *
 * Designed in accordance with ADR-005 (RFC v0.2):
 * - Sandboxes and untrusted agent execution never hold long-term credentials.
 * - Credential references are opaque, tenant-isolated, synthetic metadata only.
 * - Real API keys, tokens, or OAuth secrets are never stored, logged, or echoed.
 * - Egress policies enforce default-deny routing for outbound requests.
 */

import type { AuthContext, Id, LeasedRun } from '@ember/domain';
import type { RunExecutionContextReader } from '@ember/contracts';

export type CredentialStatus = 'active' | 'revoked' | 'expired';

/**
 * Tenant-scoped non-sensitive metadata for a synthetic credential.
 *
 * CRITICAL: Under no circumstances does this record contain plaintext secrets,
 * encrypted keys, API keys, bearer tokens, or refresh tokens.
 */
export interface CredentialMetadata {
  readonly credentialRef: string;
  readonly tenantId: Id;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly status: CredentialStatus;
  readonly version: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description?: string;
}

export interface RegisterCredentialOptions {
  /** Optional custom synthetic reference ID; auto-generated if omitted. */
  readonly credentialRef?: string;
  /** Connector or service provider name (e.g. 'github', 'slack'). */
  readonly provider: string;
  /** Explicit non-empty list of allowlisted scopes. */
  readonly scopes: readonly string[];
  /** Optional RFC 3339 expiration instant. */
  readonly expiresAt?: string | null;
  /** Safe diagnostic description. */
  readonly description?: string;
}

export interface RotateCredentialOptions {
  /** Optional new synthetic reference ID; auto-generated if omitted. Must differ from rotated ref. */
  readonly newCredentialRef?: string;
  /** Optional updated expiration instant. */
  readonly newExpiresAt?: string | null;
  /** Optional updated scopes. */
  readonly newScopes?: readonly string[];
  /** Optional updated description. */
  readonly description?: string;
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type ConnectorOperationKind = 'read' | 'write' | 'admin';

/**
 * Trusted server-side egress rule.
 */
export interface EgressRule {
  readonly ruleId: string;
  readonly provider: string;
  /** Exact HTTPS origin strings (e.g. ['https://api.github.com']). */
  readonly allowedOrigins: readonly string[];
  /** Allowed HTTP methods (typically ['GET', 'HEAD']). */
  readonly allowedMethods: readonly HttpMethod[];
  /** Whitelisted path patterns (e.g. ['/user', '/repos/:org/:repo']). */
  readonly allowedPathPatterns: readonly string[];
  /** Permitted query parameter keys. Any unknown query key triggers rejection. */
  readonly allowedQueryParams?: readonly string[];
  /** Scopes required for this rule. */
  readonly requiredScopes: readonly string[];
  /** Whitelisted operation IDs explicitly permitted for this rule. */
  readonly allowedOperations: readonly string[];
  /** Operation classification. In P0-C1C, only 'read' is allowed. */
  readonly operationKind: ConnectorOperationKind;
  /** Whether redirect candidates may be evaluated (each hop is re-authenticated). */
  readonly allowRedirects?: boolean;
}

/**
 * Comprehensive egress policy document. Default action is always 'deny'.
 */
export interface EgressPolicy {
  readonly version: number;
  readonly tenantId?: Id;
  readonly rules: readonly EgressRule[];
  readonly defaultAction: 'deny';
}

/**
 * An outbound egress request candidate presented for policy evaluation.
 */
export interface EgressRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly provider: string;
  readonly operation: string;
  readonly operationKind?: ConnectorOperationKind;
  readonly requestedScopes?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export const EGRESS_DENIAL_CODES = [
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'USERINFO_FORBIDDEN',
  'FRAGMENT_FORBIDDEN',
  'IP_LITERAL_FORBIDDEN',
  'PRIVATE_OR_LOCAL_HOST',
  'INVALID_PORT',
  'ORIGIN_NOT_ALLOWED',
  'METHOD_NOT_ALLOWED',
  'PATH_NOT_ALLOWED',
  'QUERY_PARAM_NOT_ALLOWED',
  'OPERATION_NOT_ALLOWED',
  'WRITE_OPERATION_BLOCKED',
  'SCOPE_MISMATCH',
  'NO_MATCHING_RULE',
  'REDIRECT_TARGET_DENIED',
] as const;

export type EgressDenialCode = (typeof EGRESS_DENIAL_CODES)[number];

export interface EgressDecisionAllowed {
  readonly allowed: true;
  readonly matchedRuleId: string;
  readonly sanitizedUrl: string;
  readonly method: HttpMethod;
  readonly provider: string;
  readonly operation: string;
}

export interface EgressDecisionDenied {
  readonly allowed: false;
  readonly reason: string;
  readonly denialCode: EgressDenialCode;
  readonly diagnostic?: string;
}

export type EgressDecision = EgressDecisionAllowed | EgressDecisionDenied;

/**
 * Synthetic result returned by the network-free proxy shell upon authorization.
 * No socket or HTTP requests are made.
 */
export interface SimulatedProxyResult {
  readonly status: 'SIMULATED';
  readonly allowed: true;
  readonly connector: string;
  readonly operation: string;
  readonly timestamp: string;
  readonly executionContext: {
    readonly tenantId: Id;
    readonly taskId: Id;
    readonly runId: Id;
  };
  readonly egress: {
    readonly sanitizedUrl: string;
    readonly method: HttpMethod;
    readonly matchedRuleId: string;
  };
  readonly auditId: string;
}

/**
 * Redacted audit record guaranteeing zero secret leakage and zero network activity.
 *
 * In accordance with hardened audit guidelines:
 * - credentialRef is stored strictly as a non-reusable reference digest (SHA-256 slice).
 * - targetOrigin stores only scheme + host/domain, never sensitive URL paths or query params.
 * - operation and provider serve as fixed operation identifiers.
 */
export interface RedactedAuditRecord {
  readonly auditId: string;
  readonly timestamp: string;
  readonly tenantHash: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callerType: 'management' | 'execution';
  readonly provider: string;
  readonly operation: string;
  readonly operationKind: ConnectorOperationKind;
  readonly credentialRefDigest: string;
  readonly credentialVersion: number;
  readonly targetOrigin: string;
  readonly method: HttpMethod;
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly denialReason?: string;
  readonly denialCode?: EgressDenialCode;
  readonly networkCallsMade: 0;
}

export interface AuditSink {
  record(entry: RedactedAuditRecord): void;
}

export interface ExecutionCallerContext {
  readonly lease: LeasedRun;
  readonly contextReader: RunExecutionContextReader;
  readonly now?: Date;
}

/**
 * Context presented for management plane operations.
 *
 * CRITICAL TRUST BOUNDARY:
 * `AuthContext` is strictly created and authenticated by the trusted perimeter API gateway
 * (e.g. reverse proxy / perimeter authentication middleware after validating mTLS or JWT session).
 * It CANNOT be synthesized, forged, or supplied by untrusted user agents, sandbox code,
 * or tenant-controlled worker execution runtimes.
 */
export interface ManagementCallerContext {
  readonly authContext: AuthContext;
  readonly now?: Date;
}
