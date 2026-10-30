import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Id, TaskKind } from '@ember/domain';

import { createBenchmarkHarness, type BenchmarkHarness } from './harness.js';
import { calculateDistribution, DeterministicPrng, parseTaskMix } from './metrics.js';
import { resolveBenchmarkGitSha, sanitizeReportConfig } from './evidence.js';
import { generateMarkdownReport } from './report.js';
import { collectMachineSpecs, TelemetryCollector } from './telemetry.js';
import type {
  AgentProvisioningMetrics,
  BenchmarkOptions,
  BenchmarkResult,
  LatencyMetrics,
  ReconciliationReport,
  ResolvedBenchmarkConfig,
  TargetAssessment,
  TaskSample,
} from './types.js';

interface TaskDetailResponse {
  readonly task_id: Id;
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting_approval'
    | 'retryable_failed'
    | 'completed'
    | 'failed'
    | 'cancelled';
}

interface TaskEventItem {
  readonly sequence: number;
  readonly phase: string;
  readonly occurred_at: string;
}

interface TaskEventsResponse {
  readonly task_id: Id;
  readonly events: readonly TaskEventItem[];
}

function resolveConfig(options: BenchmarkOptions): ResolvedBenchmarkConfig {
  const databaseUrl =
    options.databaseUrl ||
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://ember:ember_local_dev_only@127.0.0.1:5432/ember_test';

  const agents = options.agents ?? 1_000;
  const concurrency = options.concurrency ?? 100;
  const warmup = options.warmup ?? 50;
  const totalRequests = options.totalRequests ?? 1_000;
  const durationMs = options.durationMs ?? null;
  const seed = options.seed ?? 42;
  const outDir = options.outDir ?? 'benchmarks/results';
  const isolatedSchema = options.isolatedSchema !== false;
  const keepDb = options.keepDb === true;
  const enableLocalLoad =
    options.enableLocalLoad === true || process.env.EMBER_BENCH_ENABLE_LOCAL_LOAD === 'true';
  const workerConcurrency = options.workerConcurrency ?? concurrency;

  const positiveIntegers = { agents, concurrency, totalRequests, workerConcurrency };
  for (const [name, value] of Object.entries(positiveIntegers)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid ${name}: expected a positive safe integer`);
    }
  }
  if (concurrency > 100) {
    throw new Error('invalid concurrency: local benchmark limit is 100');
  }
  if (!Number.isSafeInteger(warmup) || warmup < 0) {
    throw new Error('invalid warmup: expected a non-negative safe integer');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error('invalid seed: expected a safe integer');
  }
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    throw new Error('invalid duration: expected a positive finite number of milliseconds');
  }

  return {
    agents,
    concurrency,
    taskMix: parseTaskMix(options.taskMix),
    warmup,
    totalRequests,
    durationMs,
    seed,
    outDir,
    databaseUrl,
    isolatedSchema,
    keepDb,
    enableLocalLoad,
    workerConcurrency,
    apiUrl: options.apiUrl,
  };
}

/**
 * Execute the Ember P0B-09C Local Load Benchmark.
 */
export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const config = resolveConfig(options);
  const log = options.log ?? ((msg: string) => console.log(msg));

  // Guardrail check: Task Spec §11 B-T28/B-T29 & Requirement 9
  if ((config.agents > 50 || config.concurrency > 20) && !config.enableLocalLoad) {
    throw new Error(
      `Safety guard: Local load benchmark (${config.agents} agents, ${config.concurrency} concurrency) ` +
        `requires explicit local enablement to prevent accidental CI overload. ` +
        `Pass --enable-local-load or set EMBER_BENCH_ENABLE_LOCAL_LOAD=true.`,
    );
  }

  log(`[Ember Bench] Starting benchmark configuration:`);
  log(`  - Agents: ${config.agents}`);
  log(`  - Concurrency: ${config.concurrency}`);
  log(
    `  - Task Mix: fast ${(config.taskMix.fast * 100).toFixed(0)}%, standard ${(config.taskMix.standard * 100).toFixed(0)}%`,
  );
  log(`  - Warmup requests: ${config.warmup}`);
  log(
    `  - Total requests: ${config.totalRequests}${config.durationMs ? ` (or ${config.durationMs}ms duration)` : ''}`,
  );
  log(`  - Seed: ${config.seed}`);
  log(`  - Isolated Schema: ${config.isolatedSchema}`);

  const prng = new DeterministicPrng(config.seed);
  let currentHttpInFlight = 0;
  let peakHttpInFlight = 0;
  const telemetry = new TelemetryCollector({
    targetWorkerConcurrency: config.workerConcurrency,
  });

  let harness: BenchmarkHarness | undefined;
  let apiUrl = config.apiUrl;
  let token = 'bench-token-default';
  let tenantId: Id = randomUUID();

  const benchmarkStartHr = performance.now();

  try {
    if (!apiUrl) {
      log(`[Ember Bench] Initializing isolated local test harness in PostgreSQL...`);
      harness = await createBenchmarkHarness({
        databaseUrl: config.databaseUrl,
        workerConcurrency: config.workerConcurrency,
        isolatedSchema: config.isolatedSchema,
        keepDb: config.keepDb,
        telemetry,
      });
      telemetry.attachPool(harness.adminPool);
      apiUrl = harness.apiUrl;
      token = harness.token;
      tenantId = harness.tenantId;
      log(`[Ember Bench] Harness ready. Schema: ${harness.schema}, API URL: ${apiUrl}`);
    }

    telemetry.start();
    const machine = await collectMachineSpecs(harness?.adminPool);

    // =========================================================================
    // Phase 1: Provision Persistent Logical Agents
    // =========================================================================
    log(`[Ember Bench] Phase 1: Provisioning ${config.agents} persistent logical agents...`);
    const agentProvisioningStartHr = performance.now();
    const agentIds: Id[] = [];
    const agentCreationLatencies: number[] = [];

    // Concurrently create agents in batches
    const agentCreationConcurrency = Math.min(25, config.concurrency);
    let agentCursor = 0;

    const agentWorkers = Array.from({ length: agentCreationConcurrency }, async () => {
      while (true) {
        const index = agentCursor++;
        if (index >= config.agents) break;

        const name = `bench-agent-${String(index + 1).padStart(5, '0')}`;
        const t0 = performance.now();
        const resp = await fetch(`${apiUrl}/v1/agents`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ name }),
        });

        const elapsed = performance.now() - t0;
        agentCreationLatencies.push(elapsed);

        if (resp.status !== 201) {
          const body = await resp.text().catch(() => '');
          throw new Error(`Failed to create agent ${index}: HTTP ${resp.status} ${body}`);
        }

        const data = (await resp.json()) as { agent_id: Id };
        agentIds.push(data.agent_id);
      }
    });

    await Promise.all(agentWorkers);
    const agentProvisioningDurationMs = performance.now() - agentProvisioningStartHr;

    // Verify database rows
    let verifiedDbAgentCount = agentIds.length;
    let verifiedDbWorkspaceCount = agentIds.length;
    if (harness) {
      const agentCountRes = await harness.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM agents WHERE tenant_id = $1',
        [tenantId],
      );
      const wsCountRes = await harness.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM workspaces WHERE tenant_id = $1',
        [tenantId],
      );
      verifiedDbAgentCount = parseInt(agentCountRes.rows[0]?.count ?? '0', 10);
      verifiedDbWorkspaceCount = parseInt(wsCountRes.rows[0]?.count ?? '0', 10);
    }

    const agentLatenciesDist = calculateDistribution(agentCreationLatencies);
    const agentProvisioningMetrics: AgentProvisioningMetrics = {
      requestedCount: config.agents,
      createdCount: agentIds.length,
      durationMs: Number(agentProvisioningDurationMs.toFixed(1)),
      throughputPerSec: Number(((agentIds.length / agentProvisioningDurationMs) * 1000).toFixed(1)),
      p50CreationLatencyMs: agentLatenciesDist.p50Ms,
      p95CreationLatencyMs: agentLatenciesDist.p95Ms,
      p99CreationLatencyMs: agentLatenciesDist.p99Ms,
      verifiedDbAgentCount,
      verifiedDbWorkspaceCount,
      residentProcessesCount: 0,
      residentSandboxesCount: 0,
    };

    log(
      `[Ember Bench] Phase 1 Complete: ${agentIds.length} agents in ${agentProvisioningDurationMs.toFixed(0)}ms ` +
        `(${agentProvisioningMetrics.throughputPerSec} agents/s, P95=${agentLatenciesDist.p95Ms}ms). ` +
        `DB records: ${verifiedDbAgentCount} agents, ${verifiedDbWorkspaceCount} workspaces. Resident sandboxes: 0.`,
    );

    // Helper: Execute a single task closed-loop
    const executeTask = async (
      sampleId: number,
      isWarmup: boolean = false,
    ): Promise<TaskSample | null> => {
      const agentId = prng.pick(agentIds);
      const isFast = prng.next() < config.taskMix.fast;
      const routePath: 'fast' | 'standard' = isFast ? 'fast' : 'standard';
      const kind: TaskKind = isFast ? 'mock.chat' : 'mock.compute';

      const input = isFast
        ? { prompt: `Benchmark fast chat #${sampleId}`, maxOutputTokens: 64 }
        : {
            operation: 'sha256' as const,
            text: `Standard compute payload #${sampleId} `.repeat(40), // > 512 chars to guarantee standard route
          };

      const idempotencyKey = `bench-${config.seed}-${sampleId}-${randomBytes(4).toString('hex')}`;
      const requestSentAtHr = performance.now();

      let durableAckAtHr: number;
      let durableAckLatencyMs: number;
      let taskId: Id = randomUUID();
      let httpStatus = 0;

      try {
        currentHttpInFlight++;
        peakHttpInFlight = Math.max(peakHttpInFlight, currentHttpInFlight);
        const postResp = await fetch(`${apiUrl}/v1/tasks`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            agent_id: agentId,
            kind,
            input,
          }),
        });

        durableAckAtHr = performance.now();
        currentHttpInFlight--;
        durableAckLatencyMs = durableAckAtHr - requestSentAtHr;
        httpStatus = postResp.status;

        if (postResp.status !== 202 && postResp.status !== 200) {
          const errText = await postResp.text().catch(() => '');
          return {
            sampleId,
            taskId,
            agentId,
            kind,
            routePath,
            requestSentAtHr,
            durableAckAtHr,
            durableAckLatencyMs,
            firstRealEventAtHr: null,
            firstRealEventLatencyMs: null,
            queueWaitMs: null,
            taskTerminalAtHr: null,
            taskCompletionLatencyMs: null,
            status: 'failed',
            httpStatus,
            errorMessage: `HTTP ${postResp.status}: ${errText}`,
            simulatedCpuMs: 0,
            simulatedUsageUnits: 0,
          };
        }

        const receipt = (await postResp.json()) as { task_id: Id };
        taskId = receipt.task_id;
      } catch (err) {
        currentHttpInFlight = Math.max(0, currentHttpInFlight - 1);
        durableAckAtHr = performance.now();
        durableAckLatencyMs = durableAckAtHr - requestSentAtHr;
        return {
          sampleId,
          taskId,
          agentId,
          kind,
          routePath,
          requestSentAtHr,
          durableAckAtHr,
          durableAckLatencyMs,
          firstRealEventAtHr: null,
          firstRealEventLatencyMs: null,
          queueWaitMs: null,
          taskTerminalAtHr: null,
          taskCompletionLatencyMs: null,
          status: 'failed',
          httpStatus: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
          simulatedCpuMs: 0,
          simulatedUsageUnits: 0,
        };
      }

      // Poll until terminal or timeout (15s deadline)
      const pollStartHr = performance.now();
      const pollTimeoutMs = 15_000;
      let taskTerminalAtHr: number | null = null;
      let taskStatus: 'succeeded' | 'failed' | 'timed_out' = 'timed_out';

      while (performance.now() - pollStartHr < pollTimeoutMs) {
        try {
          const getResp = await fetch(`${apiUrl}/v1/tasks/${taskId}`, {
            headers: { authorization: `Bearer ${token}` },
          });

          if (getResp.status === 200) {
            const detail = (await getResp.json()) as TaskDetailResponse;
            if (detail.status === 'completed') {
              taskTerminalAtHr = performance.now();
              taskStatus = 'succeeded';
              break;
            } else if (detail.status === 'failed' || detail.status === 'cancelled') {
              taskTerminalAtHr = performance.now();
              taskStatus = 'failed';
              break;
            }
          }
        } catch {
          // Retry next tick
        }

        await new Promise((r) => setTimeout(r, 20));
      }

      if (!taskTerminalAtHr) {
        taskTerminalAtHr = performance.now();
        taskStatus = 'timed_out';
      }

      const taskCompletionLatencyMs = taskTerminalAtHr - requestSentAtHr;

      // Fetch task events to extract queue_wait and first_real_event
      let firstRealEventLatencyMs: number | null = null;
      let firstRealEventAtHr: number | null = null;
      let queueWaitMs: number | null = null;

      try {
        const eventsResp = await fetch(`${apiUrl}/v1/tasks/${taskId}/events`, {
          headers: { authorization: `Bearer ${token}` },
        });

        if (eventsResp.status === 200) {
          const eventPage = (await eventsResp.json()) as TaskEventsResponse;
          const events = eventPage.events;

          const acceptedEvent = events.find((e) => e.phase === 'accepted');
          const firstExecEvent = events.find((e) => e.phase !== 'accepted');

          if (
            acceptedEvent &&
            firstExecEvent &&
            acceptedEvent.occurred_at &&
            firstExecEvent.occurred_at
          ) {
            const tAccepted = new Date(acceptedEvent.occurred_at).getTime();
            const tExec = new Date(firstExecEvent.occurred_at).getTime();
            if (!Number.isNaN(tAccepted) && !Number.isNaN(tExec)) {
              queueWaitMs = Math.max(0, tExec - tAccepted);
              firstRealEventLatencyMs = Math.max(0, durableAckLatencyMs + queueWaitMs);
              firstRealEventAtHr = requestSentAtHr + firstRealEventLatencyMs;
            }
          }
        }
      } catch {
        // Leave events as null if inaccessible
      }

      const simulatedCpuMs = isFast ? 1 : 2;
      const simulatedUsageUnits = isFast ? 5 : 15;

      if (!isWarmup) {
        telemetry.addSimulatedUsage(simulatedCpuMs, simulatedUsageUnits);
      }

      return {
        sampleId,
        taskId,
        agentId,
        kind,
        routePath,
        requestSentAtHr,
        durableAckAtHr,
        durableAckLatencyMs,
        firstRealEventAtHr,
        firstRealEventLatencyMs,
        queueWaitMs,
        taskTerminalAtHr,
        taskCompletionLatencyMs,
        status: taskStatus,
        httpStatus,
        simulatedCpuMs,
        simulatedUsageUnits,
      };
    };

    // =========================================================================
    // Phase 2: Warmup
    // =========================================================================
    if (config.warmup > 0) {
      log(`[Ember Bench] Phase 2: Warming up with ${config.warmup} requests...`);
      const warmupWorkers = Math.min(10, config.concurrency);
      let warmupCursor = 0;

      const workers = Array.from({ length: warmupWorkers }, async () => {
        while (true) {
          const idx = warmupCursor++;
          if (idx >= config.warmup) break;
          await executeTask(idx, true);
        }
      });

      await Promise.all(workers);
      log(`[Ember Bench] Phase 2: Warmup complete.`);
    }

    // =========================================================================
    // Phase 3: Benchmark Closed-Loop Execution (up to 100 concurrency)
    // =========================================================================
    log(
      `[Ember Bench] Phase 3: Executing load benchmark with concurrency=${config.concurrency}...`,
    );
    const samples: TaskSample[] = [];
    const executionStartHr = performance.now();
    let requestSeq = 0;
    let completedRequests = 0;

    const stopCondition = (): boolean => {
      if (config.durationMs) {
        return performance.now() - executionStartHr >= config.durationMs;
      }
      return completedRequests >= config.totalRequests;
    };

    // Pool of concurrent workers
    const activeWorkers = Array.from({ length: config.concurrency }, async () => {
      while (!stopCondition()) {
        const sampleId = ++requestSeq;
        if (!config.durationMs && sampleId > config.totalRequests) {
          break;
        }

        const sample = await executeTask(sampleId, false);
        if (sample) {
          samples.push(sample);
        }
        completedRequests++;
      }
    });

    await Promise.all(activeWorkers);
    const executionDurationMs = performance.now() - executionStartHr;
    log(
      `[Ember Bench] Phase 3: Load execution finished in ${executionDurationMs.toFixed(0)}ms. ` +
        `Executed ${samples.length} task samples.`,
    );

    // =========================================================================
    // Phase 4: Reconciliation & Invariant Verification
    // =========================================================================
    log(`[Ember Bench] Phase 4: Reconciling task accounting and invariants...`);
    let succeededCount = 0;
    let failedCount = 0;
    let timedOutCount = 0;

    for (const sample of samples) {
      if (sample.status === 'succeeded') {
        succeededCount++;
      } else if (sample.status === 'failed') {
        failedCount++;
      } else if (sample.status === 'timed_out') {
        timedOutCount++;
      }
    }

    const totalSubmitted = samples.length;
    const ackedSamples = samples.filter((s) => s.httpStatus === 202 || s.httpStatus === 200);
    const totalAcked = ackedSamples.length;
    const ackedTaskIds = ackedSamples.map((s) => s.taskId);
    const duplicateAckCount = totalAcked - new Set(ackedTaskIds).size;

    // Independently reconcile durable HTTP acknowledgements with authoritative
    // PostgreSQL rows. Counting local result categories alone cannot detect loss.
    let persistedTaskCount: number | null = null;
    let missingPersistedTaskCount: number | null = null;
    if (harness) {
      const persisted = await harness.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM tasks WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [tenantId, ackedTaskIds],
      );
      const persistedIds = new Set(persisted.rows.map((row) => row.id));
      persistedTaskCount = persistedIds.size;
      missingPersistedTaskCount = ackedTaskIds.filter((id) => !persistedIds.has(id)).length;
    }

    const unclassifiedCount = totalSubmitted - (succeededCount + failedCount + timedOutCount);
    const lostCount = unclassifiedCount + (missingPersistedTaskCount ?? 0) + duplicateAckCount;
    const hasUnexplainedTaskLoss =
      lostCount !== 0 || (totalAcked > 0 && missingPersistedTaskCount === null);
    const successRatePercent =
      totalSubmitted > 0 ? Number(((succeededCount / totalSubmitted) * 100).toFixed(2)) : 0;

    const reconciliation: ReconciliationReport = {
      totalSubmitted,
      totalAcked,
      succeededCount,
      failedCount,
      timedOutCount,
      lostCount,
      persistedTaskCount,
      missingPersistedTaskCount,
      duplicateAckCount,
      successRatePercent,
      hasUnexplainedTaskLoss,
    };

    // =========================================================================
    // Phase 5: Metrics Aggregation
    // =========================================================================
    const durableAckValues = ackedSamples.map((s) => s.durableAckLatencyMs);
    const firstRealEventValues = samples
      .filter((s) => s.firstRealEventLatencyMs !== null)
      .map((s) => s.firstRealEventLatencyMs!);
    const queueWaitValues = samples
      .filter((s) => s.queueWaitMs !== null)
      .map((s) => s.queueWaitMs!);
    const taskCompletionValues = samples
      .filter((s) => s.taskCompletionLatencyMs !== null)
      .map((s) => s.taskCompletionLatencyMs!);

    const latencyMetrics: LatencyMetrics = {
      durableAck: calculateDistribution(durableAckValues),
      firstRealEvent: calculateDistribution(firstRealEventValues),
      queueWait: calculateDistribution(queueWaitValues),
      taskCompletion: calculateDistribution(taskCompletionValues),
    };

    telemetry.stop();
    const telemetrySummary = { ...telemetry.getSummary(), peakHttpInFlight };

    // =========================================================================
    // Phase 6: Target Assessment (Task Spec §12 B-T28, B-T29)
    // =========================================================================
    const durableAckP95ObservedMs = latencyMetrics.durableAck.p95Ms;
    const durableAckTargetMet =
      totalAcked === totalSubmitted && totalAcked > 0 && durableAckP95ObservedMs <= 1_000;
    let bottleneckAnalysis: string | undefined;

    if (!durableAckTargetMet) {
      bottleneckAnalysis =
        `Durable Ack P95 (${durableAckP95ObservedMs}ms) exceeded 1,000ms goal under 100 concurrency. ` +
        `Bottleneck diagnosis: Database connection pool contention (${telemetrySummary.peakPostgresActiveConnections} active conns) ` +
        `and transactional commit serialisation latency on single PostgreSQL instance.`;
    }

    const targetAssessment: TargetAssessment = {
      durableAckP95TargetMs: 1_000,
      durableAckP95ObservedMs,
      durableAckTargetMet,
      bottleneckAnalysis,
      zeroResidentSandboxesMet:
        agentProvisioningMetrics.residentSandboxesCount === 0 &&
        telemetrySummary.idleLiveSandboxes === 0,
      zeroTaskLossMet: !hasUnexplainedTaskLoss,
    };

    const durationTotalMs = Math.round(performance.now() - benchmarkStartHr);

    const result: BenchmarkResult = {
      scenarioId: 'ember-p0b-09c-local-load',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      config,
      machine,
      agentProvisioning: agentProvisioningMetrics,
      reconciliation,
      latencyMetrics,
      telemetry: telemetrySummary,
      targetAssessment,
      durationTotalMs,
    };

    // =========================================================================
    // Phase 7: Report Writing
    // =========================================================================
    mkdirSync(config.outDir, { recursive: true });
    const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(config.outDir, `load-benchmark-${timestampSlug}.json`);
    const mdPath = path.join(config.outDir, `load-benchmark-${timestampSlug}.md`);

    writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
    const mdContent = generateMarkdownReport(result);
    writeFileSync(mdPath, mdContent, 'utf8');

    log(`[Ember Bench] Results saved to:\n  - ${jsonPath}\n  - ${mdPath}`);
    return result;
  } finally {
    if (harness) {
      log(`[Ember Bench] Cleaning up isolated test harness...`);
      await harness.stop();
      log(`[Ember Bench] Clean up complete.`);
    }
  }
}
