/**
 * Redacted, privacy-preserving audit logging for @ember/connectors.
 *
 * Guarantees:
 * - Hashes tenant IDs using SHA-256 (prefix 16 hex characters).
 * - Sanitizes denial reasons into safe, static descriptions without raw input text or tokens.
 * - Explicitly asserts and records zero outbound network calls (networkCallsMade: 0).
 */

import { createHash, randomUUID } from 'node:crypto';
import { deepFreeze } from './canonical.js';
import type { SourceAuditRecord, SourceAuditSink, SourceDenialCode } from './types.js';

export const SAFE_DENIAL_DESCRIPTIONS: Readonly<Record<SourceDenialCode, string>> = Object.freeze({
  SOURCE_PROFILE_NOT_FOUND: 'Source profile not found',
  SOURCE_PROFILE_DISABLED: 'Source profile is disabled',
  INVALID_SOURCE_PROFILE_ID: 'Invalid source profile identifier format',
  TENANT_MISMATCH: 'Tenant isolation violation detected',
  CONSENT_NOT_FOUND: 'No active consent grant for source profile',
  CONSENT_REVOKED: 'User consent was revoked',
  CONSENT_EXPIRED: 'User consent grant has expired',
  OPERATION_NOT_ALLOWED: 'Operation is not permitted by policy or grant',
  SCOPE_NOT_GRANTED: 'Required scope is not granted',
  PAYLOAD_LIMIT_EXCEEDED: 'Snapshot payload size or item count exceeded limits',
  READ_ABORTED: 'Read operation was aborted by cancellation signal',
  REVOKED_DURING_EXECUTION: 'Consent was revoked while read was in-flight',
  UNTRUSTED_CONTENT_DETECTED: 'Security-sensitive or forbidden content detected',
  POLICY_DENIED: 'Operation denied by source access policy',
});

export function hashTenantId(tenantId: string): string {
  return createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 16);
}

export function sanitizeDenialReason(code?: SourceDenialCode): string | undefined {
  if (code && SAFE_DENIAL_DESCRIPTIONS[code]) {
    return SAFE_DENIAL_DESCRIPTIONS[code];
  }
  return code ? 'Access denied by security policy' : undefined;
}

export interface CreateAuditRecordParams {
  readonly tenantId: string;
  readonly commitmentId: string;
  readonly occurrenceId: string;
  readonly taskId: string;
  readonly sourceProfileId: string;
  readonly decision: 'ALLOWED' | 'DENIED';
  readonly denialCode?: SourceDenialCode;
  readonly now?: Date;
}

export function createSourceAuditRecord(params: CreateAuditRecordParams): SourceAuditRecord {
  const auditId = `audit_src_${randomUUID()}`;
  const timestamp = (params.now ?? new Date()).toISOString();

  const record: SourceAuditRecord = {
    auditId,
    timestamp,
    tenantIdHash: hashTenantId(params.tenantId),
    commitmentId: params.commitmentId,
    occurrenceId: params.occurrenceId,
    taskId: params.taskId,
    sourceProfileId: params.sourceProfileId,
    decision: params.decision,
    denialCode: params.denialCode,
    denialReason: sanitizeDenialReason(params.denialCode),
    networkCallsMade: 0,
  };

  return deepFreeze(record);
}

export class InMemorySourceAuditSink implements SourceAuditSink {
  private readonly records: SourceAuditRecord[] = [];

  record(record: SourceAuditRecord): void {
    if (record.networkCallsMade !== 0) {
      throw new Error('Integrity violation: networkCallsMade must strictly be 0');
    }
    this.records.push(record);
  }

  getRecords(): readonly SourceAuditRecord[] {
    return Object.freeze([...this.records]);
  }

  clear(): void {
    this.records.length = 0;
  }
}
