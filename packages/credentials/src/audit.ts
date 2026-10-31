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
    ...(params.denialReason ? { denialReason: params.denialReason } : {}),
    ...(params.denialCode ? { denialCode: params.denialCode } : {}),
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
