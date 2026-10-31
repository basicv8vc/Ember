/**
 * Synthetic test fixtures and helpers for @ember/credentials.
 *
 * Implements the explicit requirement:
 * "默认无配置与未知 connector/scope/op/method/route 为拒绝，允许一个明示配置的 synthetic read-only fixture；所有写操作在执行前拒绝。"
 *
 * All values here are purely synthetic. No real API keys or domains.
 */

import type { RunExecutionContext, RunExecutionContextReader } from '@ember/contracts';
import type { AuthContext, Id, LeasedRun } from '@ember/domain';
import type { EgressPolicy, EgressRule, HttpMethod } from './types.js';

export const SYNTHETIC_PROVIDER = 'synthetic-connector';
export const SYNTHETIC_ORIGIN = 'https://api.synthetic-connector.example';
export const SYNTHETIC_SCOPE_READ = 'connector:read';
export const SYNTHETIC_SCOPE_WRITE = 'connector:write';

export const SYNTHETIC_READ_RULE: EgressRule = Object.freeze({
  ruleId: 'rule-synthetic-read',
  provider: SYNTHETIC_PROVIDER,
  allowedOrigins: Object.freeze([SYNTHETIC_ORIGIN]),
  allowedMethods: Object.freeze<HttpMethod[]>(['GET', 'HEAD']),
  allowedPathPatterns: Object.freeze(['/v1/status', '/v1/items', '/v1/items/*']),
  allowedQueryParams: Object.freeze(['limit', 'cursor']),
  requiredScopes: Object.freeze([SYNTHETIC_SCOPE_READ]),
  operationKind: 'read',
  allowRedirects: true,
});

export const SYNTHETIC_EGRESS_POLICY: EgressPolicy = Object.freeze({
  version: 1,
  rules: Object.freeze([SYNTHETIC_READ_RULE]),
  defaultAction: 'deny',
});

export const EMPTY_EGRESS_POLICY: EgressPolicy = Object.freeze({
  version: 1,
  rules: Object.freeze([]),
  defaultAction: 'deny',
});

export function makeSyntheticAuthContext(
  tenantId: Id = '11111111-1111-4111-8111-111111111111',
  principalId: Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  policyVersion: number = 1,
): AuthContext {
  return Object.freeze({
    tenantId,
    principalId,
    policyVersion,
  });
}

export function makeSyntheticLease(
  tenantId: Id = '11111111-1111-4111-8111-111111111111',
  taskId: Id = '22222222-2222-4222-8222-222222222222',
  runId: Id = '33333333-3333-4333-8333-333333333333',
  attempt: number = 1,
  leaseEpoch: number = 1,
  leaseExpiresAt: string = new Date(Date.now() + 60_000).toISOString(),
): LeasedRun {
  return Object.freeze({
    tenantId,
    taskId,
    runId,
    attempt,
    leaseEpoch,
    leaseExpiresAt,
  });
}

export function makeMockContextReader(
  contextOverrides: Partial<RunExecutionContext> = {},
): RunExecutionContextReader {
  return {
    read(lease: LeasedRun): Promise<RunExecutionContext> {
      const context: RunExecutionContext = {
        tenantId: lease.tenantId,
        taskId: lease.taskId,
        runId: lease.runId,
        agentId: '99999999-9999-4999-8999-999999999999',
        attempt: lease.attempt,
        leaseEpoch: lease.leaseEpoch,
        leaseExpiresAt: lease.leaseExpiresAt,
        deadlineAt: null,
        policyVersion: 1,
        kind: 'mock.chat',
        input: { prompt: 'synthetic test prompt' },
        workerId: 'worker-synthetic-1',
        ...contextOverrides,
      };
      return Promise.resolve(context);
    },
  };
}
