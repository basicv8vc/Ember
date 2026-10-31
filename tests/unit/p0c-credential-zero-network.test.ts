import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  CredentialBroker,
  CredentialProxy,
  InMemoryAuditSink,
  InMemoryCredentialRegistry,
  SYNTHETIC_EGRESS_POLICY,
  SYNTHETIC_ORIGIN,
  SYNTHETIC_PROVIDER,
  SYNTHETIC_SCOPE_READ,
  makeMockContextReader,
  makeSyntheticAuthContext,
  makeSyntheticLease,
  type EgressRequest,
} from '@ember/credentials';
import { FakeSandboxProvider } from '@ember/execution';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const AUTH_CTX: ReturnType<typeof makeSyntheticAuthContext> = makeSyntheticAuthContext(TENANT_A);
const BASE_TIME = new Date('2026-10-31T12:00:00.000Z');

describe('Zero-Network Execution & Non-Leakage Guarantees', () => {
  it('proves zero network, HTTP, socket, or DNS calls during broker and proxy operations', async () => {
    // 1. Setup spies on all core Node.js networking primitives
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const netConnectSpy = vi.spyOn(net, 'connect');
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const dnsLookupSpy = vi.spyOn(dns, 'lookup');
    const dnsResolveSpy = vi.spyOn(dns, 'resolve');

    // Spy on global fetch if present
    const fetchSpy = typeof globalThis.fetch === 'function' ? vi.spyOn(globalThis, 'fetch') : null;

    try {
      const auditSink = new InMemoryAuditSink();
      const registry = new InMemoryCredentialRegistry();
      const broker = new CredentialBroker({
        registry,
        policy: SYNTHETIC_EGRESS_POLICY,
        auditSink,
      });
      const proxy = new CredentialProxy({ broker });

      // Register synthetic credential
      const cred = await broker.registerCredential(
        AUTH_CTX,
        {
          provider: SYNTHETIC_PROVIDER,
          scopes: [SYNTHETIC_SCOPE_READ],
        },
        BASE_TIME,
      );

      const lease = makeSyntheticLease(TENANT_A);
      const reader = makeMockContextReader();

      // Execute legitimate read-only request
      const allowedRequest: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'status_check',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
      };

      const result = await proxy.proxyRequest(
        lease,
        cred.credentialRef,
        allowedRequest,
        reader,
        BASE_TIME,
      );

      expect(result.status).toBe('SIMULATED');
      expect(result.allowed).toBe(true);

      // Execute denied request (adversarial evil origin)
      const deniedRequest: EgressRequest = {
        url: 'https://evil.example.com/exfiltrate',
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'status_check',
        operationKind: 'read',
      };

      await expect(
        proxy.proxyRequest(lease, cred.credentialRef, deniedRequest, reader, BASE_TIME),
      ).rejects.toThrow();

      // 2. Assert strictly ZERO network calls were made across all operations
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(netConnectSpy).not.toHaveBeenCalled();
      expect(socketConnectSpy).not.toHaveBeenCalled();
      expect(dnsLookupSpy).not.toHaveBeenCalled();
      expect(dnsResolveSpy).not.toHaveBeenCalled();
      if (fetchSpy) {
        expect(fetchSpy).not.toHaveBeenCalled();
      }

      // 3. Assert proxy-level reported metrics
      expect(proxy.activeSocketsCount()).toBe(0);
      expect(proxy.networkCallsAttempted()).toBe(0);

      // 4. Inspect audit records for network calls count
      const records = auditSink.getRecords();
      expect(records.length).toBeGreaterThanOrEqual(1);
      for (const rec of records) {
        expect(rec.networkCallsMade).toBe(0);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('verifies FakeSandbox.networkPolicy remains false and is not forged to true', async () => {
    const sandboxProvider = new FakeSandboxProvider({
      tenantId: TENANT_A,
      clock: { now: () => BASE_TIME },
    });

    const caps = await sandboxProvider.capabilities();
    expect(caps.networkPolicy).toBe(false);
  });

  describe('redaction and secret non-leakage', () => {
    it('ensures audit logs, errors, and responses contain no tokens, secrets, or Authorization headers', async () => {
      const auditSink = new InMemoryAuditSink();
      const registry = new InMemoryCredentialRegistry();
      const broker = new CredentialBroker({
        registry,
        policy: SYNTHETIC_EGRESS_POLICY,
        auditSink,
      });

      const cred = await broker.registerCredential(
        AUTH_CTX,
        {
          provider: SYNTHETIC_PROVIDER,
          scopes: [SYNTHETIC_SCOPE_READ],
        },
        BASE_TIME,
      );

      const lease = makeSyntheticLease(TENANT_A);
      const reader = makeMockContextReader();

      const egressRequest: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/items?limit=10&cursor=secret_cursor_val`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_items',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
        headers: {
          Authorization: 'Bearer synthetic-secret-token-value-12345',
          'X-Custom-Secret': 'super-confidential-string',
        },
      };

      const result = await broker.executeWithCredential(
        lease,
        cred.credentialRef,
        egressRequest,
        reader,
        BASE_TIME,
      );

      // Result inspection
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain('synthetic-secret-token-value-12345');
      expect(resultJson).not.toContain('super-confidential-string');
      expect(resultJson).not.toContain('Bearer');
      expect(resultJson).not.toContain('secret_cursor_val');

      // Audit records inspection
      const records = auditSink.getRecords();
      expect(records.length).toBe(1);
      const auditJson = JSON.stringify(records[0]);
      expect(auditJson).not.toContain('synthetic-secret-token-value-12345');
      expect(auditJson).not.toContain('super-confidential-string');
      expect(auditJson).not.toContain('Authorization');
      expect(auditJson).not.toContain('Bearer');
      expect(auditJson).not.toContain('secret_cursor_val');

      // Verify raw credentialRef is NOT present in the audit record, only non-reusable digest
      expect(auditJson).not.toContain(cred.credentialRef);
      expect(records[0]?.credentialRefDigest).toBeDefined();
      expect(records[0]?.credentialRefDigest.length).toBe(16);

      // Verify URL path and query parameters are stripped; only targetOrigin is retained
      expect(auditJson).not.toContain('/v1/items');
      expect(records[0]?.targetOrigin).toBe(SYNTHETIC_ORIGIN);

      // Verify tenantId is hashed in audit record
      expect(records[0]?.tenantHash).not.toBe(TENANT_A);
      expect(records[0]?.tenantHash.length).toBe(16);
    });

    it('replaces credentialRef with non-reusable digest and strips sensitive URL paths in audit trail', async () => {
      const auditSink = new InMemoryAuditSink();
      const registry = new InMemoryCredentialRegistry();
      const broker = new CredentialBroker({
        registry,
        policy: SYNTHETIC_EGRESS_POLICY,
        auditSink,
      });

      const sensitiveRefId = 'cred_private_token_vault_ref_998877';
      const cred = await broker.registerCredential(
        AUTH_CTX,
        {
          credentialRef: sensitiveRefId,
          provider: SYNTHETIC_PROVIDER,
          scopes: [SYNTHETIC_SCOPE_READ],
        },
        BASE_TIME,
      );

      const lease = makeSyntheticLease(TENANT_A);
      const reader = makeMockContextReader();

      const sensitivePathUrl = `${SYNTHETIC_ORIGIN}/v1/items/doc_confidential_secret_id_443322`;
      const egressRequest: EgressRequest = {
        url: sensitivePathUrl,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_confidential_doc',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
      };

      await broker.executeWithCredential(
        lease,
        cred.credentialRef,
        egressRequest,
        reader,
        BASE_TIME,
      );

      const records = auditSink.getRecords();
      expect(records.length).toBe(1);
      const audit = records[0]!;
      const auditText = JSON.stringify(audit);

      // Raw reference string must NOT exist in the audit log
      expect(auditText).not.toContain(sensitiveRefId);
      expect(audit.credentialRefDigest).not.toBe(sensitiveRefId);
      expect(audit.credentialRefDigest.length).toBe(16);

      // Path parameter and resource IDs must NOT exist in the audit log
      expect(auditText).not.toContain('doc_confidential_secret_id_443322');
      expect(auditText).not.toContain('/v1/items');

      // Fixed identifiers only
      expect(audit.targetOrigin).toBe(SYNTHETIC_ORIGIN);
      expect(audit.provider).toBe(SYNTHETIC_PROVIDER);
      expect(audit.operation).toBe('get_confidential_doc');
      expect(audit.operationKind).toBe('read');
      expect(audit.decision).toBe('ALLOWED');
      expect(audit.networkCallsMade).toBe(0);
    });
  });
});
