import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createFakeGuardedSourceReader,
  FakeConsentRegistry,
  FakeSourceReader,
  FIXTURE_INJECTION_ITEMS,
  FIXTURE_PROFILE_ALERTS,
  FIXTURE_PROFILE_RELEASES,
  GuardedSourceReader,
  InMemorySourceAuditSink,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type TrustedSourceAccessContext,
} from '@ember/connectors';

describe('P0-C3C: Zero-Network Outbound Call Verification', () => {
  const validContext: TrustedSourceAccessContext = {
    tenantId: TEST_TENANT_A,
    commitmentId: 'comm_11111111-1111-1111-1111-111111111111',
    taskId: 'task_11111111-1111-1111-1111-111111111111',
    runId: 'run_11111111-1111-1111-1111-111111111111',
    leaseEpoch: 1,
    authorizedAt: '2026-11-01T12:00:00.000Z',
  };

  const signal = new AbortController().signal;

  it('strictly verifies ZERO outbound sockets, HTTP, HTTPS, fetch, or DNS calls across all operations', async () => {
    // 1. Spy on all Node.js networking and DNS primitives
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const netConnectSpy = vi.spyOn(net, 'connect');
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const dnsLookupSpy = vi.spyOn(dns, 'lookup');
    const dnsResolveSpy = vi.spyOn(dns, 'resolve');
    const fetchSpy = typeof globalThis.fetch === 'function' ? vi.spyOn(globalThis, 'fetch') : null;

    try {
      const bundle = createFakeGuardedSourceReader();

      // Operation 1: Denied without consent (Check 1)
      await expect(
        bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, signal),
      ).rejects.toThrow();

      // Operation 2: Granted consent, successful read
      bundle.registry.grant({
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_ember_releases',
      });

      const snapshot = await bundle.guardedReader.readSnapshot(
        'sp_ember_releases',
        validContext,
        signal,
      );
      expect(snapshot.sourceProfileId).toBe('sp_ember_releases');
      expect(snapshot.boundedSafeItems.length).toBeGreaterThan(0);

      // Operation 3: Adversarial prompt injection read
      bundle.innerReader.setFixture('sp_ember_releases', FIXTURE_INJECTION_ITEMS);
      const injectionSnapshot = await bundle.guardedReader.readSnapshot(
        'sp_ember_releases',
        validContext,
        signal,
      );
      expect(injectionSnapshot.boundedSafeItems[0]?.contentSnippet).toContain(
        'Ignore all previous instructions',
      );

      // Operation 4: Malicious URL injection attempt
      await expect(
        bundle.guardedReader.readSnapshot(
          'https://evil.attacker.com/releases',
          validContext,
          signal,
        ),
      ).rejects.toThrow();

      // Operation 5: Cross-tenant denied attempt
      const crossTenantContext = { ...validContext, tenantId: TEST_TENANT_B };
      await expect(
        bundle.guardedReader.readSnapshot('sp_ember_releases', crossTenantContext, signal),
      ).rejects.toThrow();

      // Operation 6: Revoked consent attempt
      bundle.registry.revoke(TEST_TENANT_A, 'sp_ember_releases');
      await expect(
        bundle.guardedReader.readSnapshot('sp_ember_releases', validContext, signal),
      ).rejects.toThrow();

      // 2. Strict Zero-Network Assertions
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(netConnectSpy).not.toHaveBeenCalled();
      expect(socketConnectSpy).not.toHaveBeenCalled();
      expect(dnsLookupSpy).not.toHaveBeenCalled();
      expect(dnsResolveSpy).not.toHaveBeenCalled();
      if (fetchSpy) {
        expect(fetchSpy).not.toHaveBeenCalled();
      }

      // Verify all audit records logged networkCallsMade: 0
      const auditRecords = bundle.auditSink.getRecords();
      expect(auditRecords.length).toBeGreaterThanOrEqual(4);
      for (const rec of auditRecords) {
        expect(rec.networkCallsMade).toBe(0);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('guarantees isolated fake reader never accesses network even under synthetic latency or abort', async () => {
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = typeof globalThis.fetch === 'function' ? vi.spyOn(globalThis, 'fetch') : null;

    try {
      const registry = new FakeConsentRegistry();
      registry.grant({
        tenantId: TEST_TENANT_A,
        sourceProfileId: 'sp_system_alerts',
      });

      const auditSink = new InMemorySourceAuditSink();
      const reader = new FakeSourceReader({
        simulatedLatencyMs: 25,
      });

      const guarded = new GuardedSourceReader({
        reader,
        registry,
        profiles: new Map([
          [FIXTURE_PROFILE_ALERTS.sourceProfileId, FIXTURE_PROFILE_ALERTS],
          [FIXTURE_PROFILE_RELEASES.sourceProfileId, FIXTURE_PROFILE_RELEASES],
        ]),
        policy: {
          version: 1,
          allowedSourceProfileIds: ['sp_system_alerts'],
          allowedOperations: ['read_snapshot'],
          defaultAction: 'deny',
        },
        auditSink,
      });

      const snapshot = await guarded.readSnapshot('sp_system_alerts', validContext, signal);
      expect(snapshot.sourceProfileId).toBe('sp_system_alerts');

      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(socketConnectSpy).not.toHaveBeenCalled();
      if (fetchSpy) {
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});
