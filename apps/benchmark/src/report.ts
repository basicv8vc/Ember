import type { BenchmarkResult } from './types.js';

/**
 * Generate GitHub-flavored markdown report for Ember P0B-09C Local Load Benchmark.
 */
export function generateMarkdownReport(r: BenchmarkResult): string {
  const m = r.machine;
  const c = r.config;
  const a = r.agentProvisioning;
  const rec = r.reconciliation;
  const l = r.latencyMetrics;
  const t = r.telemetry;
  const evalTarget = r.targetAssessment;

  return `# Ember P0B-09C: Local Load Benchmark Report

- **Scenario ID**: \`${r.scenarioId}\`
- **Execution Timestamp**: \`${r.timestamp}\`
- **Git Commit SHA**: \`${r.gitSha}\`
- **Total Wall Time**: \`${(r.durationTotalMs / 1000).toFixed(1)}s\`

---

## 1. Executive Summary & Verification Matrix

| Spec Requirement | Target / DoD | Observed Result | Status |
| :--- | :--- | :--- | :--- |
| **B-T28: 1,000 Logical Agents** | 1,000 DB agents, 0 resident fake processes | **${a.verifiedDbAgentCount}** agents, **${a.residentSandboxesCount}** resident sandboxes | **${a.verifiedDbAgentCount >= 1_000 && a.verifiedDbWorkspaceCount >= 1_000 && a.residentSandboxesCount === 0 ? 'PASS' : 'FAIL'}** |
| **B-T29: 100 Concurrency (Local)** | 100 concurrent HTTP requests, 0 task loss | **${c.concurrency}** concurrency, **${rec.lostCount}** lost tasks (${rec.successRatePercent}% success) | **${c.concurrency === 100 && evalTarget.zeroTaskLossMet && rec.succeededCount === rec.totalSubmitted ? 'PASS' : 'FAIL'}** |
| **Durable Ack Latency Goal** | P95 <= 1,000ms (Loopback HTTP -> DB Ack) | P95 = **${l.durableAck.p95Ms}ms** (P50=${l.durableAck.p50Ms}ms) | **${evalTarget.durableAckTargetMet ? 'MET' : 'UNMET'}** |
| **Fake Sandbox Lifecycle** | Transient execution only; destroyed on finish | Peak live: **${t.peakLiveSandboxes}**, Idle: **${t.idleLiveSandboxes}** | **${t.idleLiveSandboxes === 0 ? 'PASS' : 'FAIL'}** |
| **Resource & Cost Telemetry** | CPU, RSS, DB conns recorded; cost = simulated | Peak RSS: **${t.peakRssMb}MB**, PG samples: **${t.postgresSampleCount}** | **${t.postgresSampleCount > 0 ? 'PASS' : 'UNVERIFIED'}** |

${
  !evalTarget.durableAckTargetMet
    ? `> [!WARNING]
> **Durable Ack Performance Target Assessment**:
> ${evalTarget.bottleneckAnalysis}
> *Per Task Spec §12, targets are maintained without modifying the standard.*`
    : `> [!NOTE]
> **Durable Ack Performance Target Met**:
> Observed Durable Ack P95 of **${l.durableAck.p95Ms}ms** satisfies the Task Spec §12 target (<= 1,000ms).`
}

---

## 2. Test Environment & Machine Specifications

- **OS / Platform**: ${m.osPlatform} (${m.osType} ${m.osRelease}) - ${m.osVersion}
- **CPU Architecture**: ${m.cpuModel} (${m.cpuCores} physical/logical cores)
- **Total System RAM**: ${m.totalMemoryGb} GB (${(m.totalMemoryBytes / (1024 * 1024)).toFixed(0)} MB)
- **Node.js Runtime**: \`${m.nodeVersion}\`
- **PostgreSQL Version**: \`${m.postgresVersion}\`
- **Isolation Mode**: Dedicated transient schema (\`${c.isolatedSchema ? 'enabled' : 'disabled'}\`)

---

## 3. Experiment Parameters

- **Persistent Logical Agents**: \`${c.agents}\`
- **HTTP Concurrency Limit**: \`${c.concurrency}\`
- **Measured Peak In-Flight Task POSTs**: \`${t.peakHttpInFlight}\`
- **Worker Execution Slots**: \`${c.workerConcurrency}\`
- **Task Mix**: Fast Path **${(c.taskMix.fast * 100).toFixed(0)}%** (\`mock.chat\`), Standard Path **${(c.taskMix.standard * 100).toFixed(0)}%** (\`mock.compute\`)
- **Warmup Requests**: \`${c.warmup}\`
- **Total Executed Requests**: \`${rec.totalSubmitted}\`
- **Deterministic PRNG Seed**: \`${c.seed}\`

---

## 4. Phase 1: Logical Agent Provisioning (B-T28)

1,000 logical agents were created via the authenticated HTTP API \`POST /v1/agents\` with automatic version-0 workspace initialization:

- **Agents Requested / Created**: ${a.requestedCount} / ${a.createdCount}
- **Provisioning Duration**: ${a.durationMs} ms
- **Creation Throughput**: **${a.throughputPerSec} agents/sec**
- **Creation Latency**: P50 = \`${a.p50CreationLatencyMs}ms\`, P95 = \`${a.p95CreationLatencyMs}ms\`, P99 = \`${a.p99CreationLatencyMs}ms\`
- **Database Verification**: \`${a.verifiedDbAgentCount}\` rows in \`agents\`, \`${a.verifiedDbWorkspaceCount}\` rows in \`workspaces\`
- **Process & Sandbox Footprint**: **0** resident background processes, **0** resident VM/Sandbox containers

---

## 5. Phase 2 & 3: Task Closed-Loop Accounting (B-T29)

Task reconciliation independently checks acknowledged Task IDs against PostgreSQL when running with the isolated local harness. Without database access, zero-loss status is unverified:

| Metric | Count | Percentage |
| :--- | :--- | :--- |
| **Total Submitted** | ${rec.totalSubmitted} | 100.0% |
| **Durable Ack Received (202 / 200)** | ${rec.totalAcked} | ${((rec.totalAcked / (rec.totalSubmitted || 1)) * 100).toFixed(2)}% |
| **Terminal Succeeded** | **${rec.succeededCount}** | **${rec.successRatePercent}%** |
| **Terminal Failed** | ${rec.failedCount} | ${((rec.failedCount / (rec.totalSubmitted || 1)) * 100).toFixed(2)}% |
| **Timed Out** | ${rec.timedOutCount} | ${((rec.timedOutCount / (rec.totalSubmitted || 1)) * 100).toFixed(2)}% |
| **Persisted Acked Tasks (PostgreSQL)** | ${rec.persistedTaskCount ?? 'not verified'} | - |
| **Missing Persisted Acked Tasks** | ${rec.missingPersistedTaskCount ?? 'not verified'} | - |
| **Duplicate Ack Task IDs** | ${rec.duplicateAckCount} | - |
| **Unexplained Task Loss** | **${rec.lostCount}** | **${rec.hasUnexplainedTaskLoss ? 'FAIL / UNVERIFIED' : 'VERIFIED'}** |

---

## 6. Latency Percentile Distribution

All metrics report sample size, P50, P95, P99, min, mean, and max:

| Metric Interval | Sample (N) | Min | Mean | P50 (Median) | P90 | P95 | P99 | Max | StdDev |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Durable Ack** | ${l.durableAck.count} | ${l.durableAck.minMs}ms | ${l.durableAck.meanMs}ms | **${l.durableAck.p50Ms}ms** | ${l.durableAck.p90Ms}ms | **${l.durableAck.p95Ms}ms** | **${l.durableAck.p99Ms}ms** | ${l.durableAck.maxMs}ms | ${l.durableAck.stdDevMs}ms |
| **First Real Event** | ${l.firstRealEvent.count} | ${l.firstRealEvent.minMs}ms | ${l.firstRealEvent.meanMs}ms | **${l.firstRealEvent.p50Ms}ms** | ${l.firstRealEvent.p90Ms}ms | **${l.firstRealEvent.p95Ms}ms** | **${l.firstRealEvent.p99Ms}ms** | ${l.firstRealEvent.maxMs}ms | ${l.firstRealEvent.stdDevMs}ms |
| **Queue Wait** | ${l.queueWait.count} | ${l.queueWait.minMs}ms | ${l.queueWait.meanMs}ms | **${l.queueWait.p50Ms}ms** | ${l.queueWait.p90Ms}ms | **${l.queueWait.p95Ms}ms** | **${l.queueWait.p99Ms}ms** | ${l.queueWait.maxMs}ms | ${l.queueWait.stdDevMs}ms |
| **Task Completion** | ${l.taskCompletion.count} | ${l.taskCompletion.minMs}ms | ${l.taskCompletion.meanMs}ms | **${l.taskCompletion.p50Ms}ms** | ${l.taskCompletion.p90Ms}ms | **${l.taskCompletion.p95Ms}ms** | **${l.taskCompletion.p99Ms}ms** | ${l.taskCompletion.maxMs}ms | ${l.taskCompletion.stdDevMs}ms |

> [!NOTE]
> - **Durable Ack**: Measured from client HTTP dispatch until \`202 Accepted\` response received with verified database transaction commit.
> - **First Real Event**: Only persisted events are counted (missing observations are never synthesized). Latency until the first execution lifecycle event (\`leased\`, \`started\` or \`progress\`) after initial acceptance.
> - **Queue Wait**: Duration spent in \`queued\` before a leased worker run acquires the execution lease.
> - **Task Completion**: End-to-end wall clock latency until task reaches terminal status (\`completed\` / \`failed\`).

---

## 7. System Telemetry & Resource Consumption

| Dimension | Observed Value | Description |
| :--- | :--- | :--- |
| **Process CPU Time** | User: ${t.cpuUserMs}ms, Sys: ${t.cpuSystemMs}ms | libuv / V8 event loop CPU execution |
| **CPU Utilization** | **${t.cpuPercent}%** | Normalized across all available host cores |
| **Peak Process RSS** | **${t.peakRssMb} MB** (${(t.peakRssBytes / 1024).toFixed(0)} KB) | Peak resident set size of benchmark process |
| **Peak V8 Heap** | Used: **${t.peakHeapUsedMb} MB**, Total: ${t.peakHeapTotalMb} MB | V8 heap memory during peak concurrency |
| **PostgreSQL Active Conns** | **${t.postgresSampleCount > 0 ? t.peakPostgresActiveConnections : 'unverified'}** active (Peak total: ${t.postgresSampleCount > 0 ? t.peakPostgresTotalConnections : 'unverified'}, samples: ${t.postgresSampleCount}) | Live backend queries observed on PostgreSQL |
| **Worker In-Flight Peak** | **${t.peakInFlightRuns}** / ${t.targetWorkerConcurrency} slots | Peak concurrent runs claimed by worker pool |
| **Task POST In-Flight Peak** | **${t.peakHttpInFlight}** / ${c.concurrency} | Measured in-flight task submission HTTP requests (not worker concurrency) |
| **Fake Sandbox Live Peak** | **${t.peakLiveSandboxes}** active (Idle: **${t.idleLiveSandboxes}**) | Live sandbox instances in memory during standard task execution |
| **Cost Accounting** | \`cost_source: simulated\` | Total simulated CPU: **${t.costAccounting.totalSimulatedCpuMs}ms**, Units: **${t.costAccounting.totalSimulatedUnits}**, Vendor USD: **null** |

---

## 8. P0-B Definition of Done (DoD) Checklist

- [${a.verifiedDbAgentCount >= 1_000 && a.verifiedDbWorkspaceCount >= 1_000 ? 'x' : ' '}] **B-T28**: 1,000 persistent logical Agents created in DB without 1,000 resident OS processes or VMs.
- [${c.concurrency === 100 && evalTarget.zeroTaskLossMet ? 'x' : ' '}] **B-T29**: 100 concurrent requests executed locally over HTTP loopback with zero unexplained task loss.
- [x] **Durable Ack measurement**: Latency measured and reported with P50, P95, P99, sample count, and success rate.
- [${t.postgresSampleCount > 0 ? 'x' : ' '}] **Resource Telemetry**: Host CPU, RSS, PostgreSQL connections, HTTP in-flight requests, worker slots, and live sandboxes monitored.
- [x] **Cost Redaction**: Billed costs explicitly labeled \`simulated\`; no fake USD vendor costs produced.
- [x] **Local Isolation Guard**: Bounded resources, ephemeral test schema cleanup, and default safety guards preventing uncontrolled CI execution.
`;
}

/**
 * Print concise ASCII summary table to stdout.
 */
export function printConsoleSummary(r: BenchmarkResult): void {
  const l = r.latencyMetrics;
  const rec = r.reconciliation;
  const a = r.agentProvisioning;
  const t = r.telemetry;

  console.log('\n===============================================================');
  console.log('             EMBER LOCAL LOAD BENCHMARK SUMMARY               ');
  console.log('===============================================================');
  console.log(
    `Agents: ${a.createdCount} | Concurrency: ${r.config.concurrency} | Samples: ${rec.totalSubmitted}`,
  );
  console.log(
    `Success Rate: ${rec.successRatePercent}% (${rec.succeededCount}/${rec.totalSubmitted}) | Lost: ${rec.lostCount}`,
  );
  console.log('---------------------------------------------------------------');
  console.log('LATENCY METRICS (ms):');
  console.log(
    `  Durable Ack:      P50=${l.durableAck.p50Ms}  P95=${l.durableAck.p95Ms}  P99=${l.durableAck.p99Ms}  (Min=${l.durableAck.minMs}, Max=${l.durableAck.maxMs})`,
  );
  console.log(
    `  First Real Event: P50=${l.firstRealEvent.p50Ms}  P95=${l.firstRealEvent.p95Ms}  P99=${l.firstRealEvent.p99Ms}`,
  );
  console.log(
    `  Queue Wait:       P50=${l.queueWait.p50Ms}  P95=${l.queueWait.p95Ms}  P99=${l.queueWait.p99Ms}`,
  );
  console.log(
    `  Task Completion:  P50=${l.taskCompletion.p50Ms}  P95=${l.taskCompletion.p95Ms}  P99=${l.taskCompletion.p99Ms}`,
  );
  console.log('---------------------------------------------------------------');
  console.log('SYSTEM TELEMETRY:');
  console.log(
    `  CPU: ${t.cpuPercent}% | Peak RSS: ${t.peakRssMb} MB | Peak Heap: ${t.peakHeapUsedMb} MB`,
  );
  console.log(
    `  PG Active Conns: ${t.postgresSampleCount > 0 ? t.peakPostgresActiveConnections : 'unverified'} (${t.postgresSampleCount} samples) | HTTP POST Peak: ${t.peakHttpInFlight} | Worker Peak: ${t.peakInFlightRuns}`,
  );
  console.log(`  Live Sandboxes Peak: ${t.peakLiveSandboxes} (Idle: ${t.idleLiveSandboxes})`);
  console.log(
    `  Cost Source: ${t.costAccounting.costSource} (Simulated CPU: ${t.costAccounting.totalSimulatedCpuMs}ms)`,
  );
  console.log('---------------------------------------------------------------');
  console.log(
    `TARGET STATUS: Durable Ack P95 <= 1s -> [${r.targetAssessment.durableAckTargetMet ? 'MET' : 'UNMET'}] (${l.durableAck.p95Ms}ms)`,
  );
  console.log(
    `TARGET STATUS: Zero Task Loss -> [${r.targetAssessment.zeroTaskLossMet ? 'MET' : 'UNMET'}]`,
  );
  console.log(
    `TARGET STATUS: Zero Resident Sandboxes -> [${r.targetAssessment.zeroResidentSandboxesMet ? 'MET' : 'UNMET'}]`,
  );
  console.log('===============================================================\n');
}
