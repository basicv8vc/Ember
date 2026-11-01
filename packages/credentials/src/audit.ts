/**
 * Redacted audit logging for @ember/credentials.
 *
 * Implements Section 5 of P0-C1C and hardened audit hygiene:
 * - Stores credential references as non-reusable SHA-256 digests.
 * - Stores destination as target origin/domain only, preventing URL path/query parameter leaks.
 * - Stores tenant ID as a privacy-preserving SHA-256 hash.
 * - Proves zero network calls were made (networkCallsMade: 0).
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditSink,
  ConnectorOperationKind,
  EgressDenialCode,
  HttpMethod,
  RedactedAuditRecord,
} from './types.js';

export const SAFE_DENIAL_REASONS: Readonly<Record<EgressDenialCode, string>> = Object.freeze({
  INVALID_URL: 'Request URL format is invalid',
  UNSUPPORTED_SCHEME: 'Protocol scheme is not permitted',
  USERINFO_FORBIDDEN: 'Userinfo credentials in URL are forbidden',
  FRAGMENT_FORBIDDEN: 'URL fragment identifiers are forbidden',
  IP_LITERAL_FORBIDDEN: 'IP address literals are forbidden',
  PRIVATE_OR_LOCAL_HOST: 'Private or loopback network targets are forbidden',
  INVALID_PORT: 'Non-standard port is forbidden',
  ORIGIN_NOT_ALLOWED: 'Target origin is not permitted by egress policy',
  METHOD_NOT_ALLOWED: 'HTTP method is not permitted for rule',
  PATH_NOT_ALLOWED: 'Request path is not permitted by egress policy',
  QUERY_PARAM_NOT_ALLOWED: 'Query parameter keys are not permitted',
  OPERATION_NOT_ALLOWED: 'Operation is not permitted by egress rule',
  WRITE_OPERATION_BLOCKED: 'Mutating write operations are blocked',
  SCOPE_MISMATCH: 'Required scopes are not satisfied',
  NO_MATCHING_RULE: 'No matching egress policy rule found',
  REDIRECT_TARGET_DENIED: 'Redirect target is not permitted',
});

/**
 * Sanitizes a denial reason to guarantee zero leakage of raw paths, query strings,
 * scopes, tokens, or raw error strings (such as String(err)).
 */
export function sanitizeAuditDenialReason(
  code?: EgressDenialCode,
  fallbackReason?: string,
): string | undefined {
  if (code && SAFE_DENIAL_REASONS[code]) {
    return SAFE_DENIAL_REASONS[code];
  }
  if (!fallbackReason) {
    return undefined;
  }
  return 'Access denied by security policy';
}

export function hashTenantId(tenantId: string): string {
  return createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 16);
}

export function hashCredentialRef(credentialRef: string): string {
  return createHash('sha256').update(credentialRef, 'utf8').digest('hex').slice(0, 16);
}

export function extractTargetOrigin(targetUrlOrOrigin: string): string {
  if (!targetUrlOrOrigin || typeof targetUrlOrOrigin !== 'string') {
    return '[UNKNOWN_ORIGIN]';
  }

  // If already an origin or full URL, extract origin
  try {
    const parsed = new URL(targetUrlOrOrigin);
    return parsed.origin.toLowerCase();
  } catch {
    // If invalid URL or malformed string containing @ / relative paths
    return '[INVALID_OR_OPAQUE_ORIGIN]';
  }
}

export interface RecordAuditParams {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callerType: 'management' | 'execution';
  readonly provider: string;
  readonly operation: string;
  readonly operationKind: ConnectorOperationKind;
  readonly credentialRef: string;
  readonly credentialVersion: number;
  readonly targetUrlOrOrigin: string;
  readonly method: HttpMethod;
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly denialReason?: string;
  readonly denialCode?: EgressDenialCode;
  readonly now?: Date;
}

export function createAuditRecord(params: RecordAuditParams): RedactedAuditRecord {
  const auditId = `audit_${randomUUID()}`;
  const timestamp = (params.now ?? new Date()).toISOString();

  return Object.freeze({
    auditId,
    timestamp,
    tenantHash: hashTenantId(params.tenantId),
    taskId: params.taskId,
    runId: params.runId,
    callerType: params.callerType,
    provider: params.provider,
    operation: params.operation,
    operationKind: params.operationKind,
    credentialRefDigest: hashCredentialRef(params.credentialRef),
    credentialVersion: params.credentialVersion,
    targetOrigin: extractTargetOrigin(params.targetUrlOrOrigin),
    method: params.method,
    decision: params.decision,
    ...(params.decision === 'DENIED'
      ? {
          denialReason: sanitizeAuditDenialReason(params.denialCode, params.denialReason),
          ...(params.denialCode ? { denialCode: params.denialCode } : {}),
        }
      : {}),
    networkCallsMade: 0,
  });
}

/**
 * In-memory audit sink for local inspection and unit test assertions.
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly records: RedactedAuditRecord[] = [];

  record(entry: RedactedAuditRecord): void {
    this.records.push(entry);
  }

  getRecords(): readonly RedactedAuditRecord[] {
    return Object.freeze([...this.records]);
  }

  clear(): void {
    this.records.length = 0;
  }
}
