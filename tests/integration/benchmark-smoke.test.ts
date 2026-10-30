import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../../apps/benchmark/src/runner.js';

describe('Benchmark Smoke Test (Integration / Real PostgreSQL)', () => {
  it('executes a complete end-to-end small-scale benchmark closed loop', async () => {
    const tempOutDir = mkdtempSync(path.join(os.tmpdir(), 'ember-bench-smoke-'));

    try {
      const result = await runBenchmark({
        agents: 6,
        concurrency: 3,
        warmup: 2,
        totalRequests: 6,
        taskMix: { fast: 0.5, standard: 0.5 },
        seed: 101,
        isolatedSchema: true,
        keepDb: false,
        outDir: tempOutDir,
        enableLocalLoad: true,
        workerConcurrency: 4,
        log: () => undefined, // keep test output clean
      });

      // 1. Verify scenario and metadata
      expect(result.scenarioId).toBe('ember-p0b-09c-local-load');
      expect(result.durationTotalMs).toBeGreaterThan(0);

      // 2. Verify agent provisioning (B-T28)
      expect(result.agentProvisioning.requestedCount).toBe(6);
      expect(result.agentProvisioning.createdCount).toBe(6);
      expect(result.agentProvisioning.verifiedDbAgentCount).toBe(6);
      expect(result.agentProvisioning.verifiedDbWorkspaceCount).toBe(6);
      expect(result.agentProvisioning.residentSandboxesCount).toBe(0);
      expect(result.agentProvisioning.residentProcessesCount).toBe(0);

      // 3. Verify task closed-loop accounting (B-T29)
      expect(result.reconciliation.totalSubmitted).toBe(6);
      expect(result.reconciliation.totalAcked).toBe(6);
      expect(result.reconciliation.succeededCount).toBe(6);
      expect(result.reconciliation.failedCount).toBe(0);
      expect(result.reconciliation.timedOutCount).toBe(0);
      expect(result.reconciliation.lostCount).toBe(0);
      expect(result.reconciliation.persistedTaskCount).toBe(6);
      expect(result.reconciliation.missingPersistedTaskCount).toBe(0);
      expect(result.reconciliation.duplicateAckCount).toBe(0);
      expect(result.reconciliation.hasUnexplainedTaskLoss).toBe(false);
      expect(result.reconciliation.successRatePercent).toBe(100);

      // 4. Verify latency distributions
      expect(result.latencyMetrics.durableAck.count).toBe(6);
      expect(result.latencyMetrics.durableAck.minMs).toBeGreaterThan(0);
      expect(result.latencyMetrics.durableAck.p50Ms).toBeGreaterThan(0);
      expect(result.latencyMetrics.durableAck.p95Ms).toBeGreaterThan(0);

      expect(result.latencyMetrics.taskCompletion.count).toBe(6);
      expect(result.latencyMetrics.taskCompletion.p50Ms).toBeGreaterThanOrEqual(
        result.latencyMetrics.durableAck.p50Ms,
      );

      // 5. Verify telemetry and simulated cost
      expect(result.telemetry.costAccounting.costSource).toBe('simulated');
      expect(result.telemetry.costAccounting.actualVendorCostUsd).toBeNull();
      expect(result.telemetry.peakRssMb).toBeGreaterThan(0);
      expect(result.telemetry.idleLiveSandboxes).toBe(0);
      expect(result.telemetry.postgresSampleCount).toBeGreaterThan(0);
      expect(result.telemetry.peakPostgresTotalConnections).toBeGreaterThan(0);
      expect(result.telemetry.peakHttpInFlight).toBeGreaterThan(0);
      expect(result.telemetry.peakHttpInFlight).toBeLessThanOrEqual(3);
      expect(result.config.databaseUrl).toBe('[REDACTED]');

      // 6. Verify target assessment
      expect(result.targetAssessment.zeroResidentSandboxesMet).toBe(true);
      expect(result.targetAssessment.zeroTaskLossMet).toBe(true);

      // 7. Verify output artifacts written to disk
      const files = existsSync(tempOutDir);
      expect(files).toBe(true);
      const reportPath = readdirSync(tempOutDir).find((name) => name.endsWith('.json'));
      expect(reportPath).toBeDefined();
      const savedReport = readFileSync(path.join(tempOutDir, reportPath!), 'utf8');
      expect(JSON.parse(savedReport).config.databaseUrl).toBe('[REDACTED]');
    } finally {
      try {
        rmSync(tempOutDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
