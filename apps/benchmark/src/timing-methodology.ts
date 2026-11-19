import { resolveBenchmarkGitSha } from './evidence.js';
import { calculateDistribution } from './metrics.js';
import { startLocalWorkerdProbe, type LocalWorkerdProbeHandle } from './sqlite-probe.js';
import type {
  BudgetCheckTimingResult,
  StreamingCpuSample,
  TimingMethodologyReport,
} from './v2-types.js';

export interface TimingMethodologyOptions {
  readonly turnIterations?: number;
  readonly streamIterations?: number;
  readonly budgetContentionConcurrency?: number;
  readonly log?: (message: string) => void;
}

async function measureStreamingCpuScenario(params: {
  readonly label: string;
  readonly chunkCount: number;
  readonly chunkBytes: number;
  readonly simulatedTokenDelayMs: number;
  readonly iterations: number;
}): Promise<StreamingCpuSample> {
  const wallDurations: number[] = [];
  const cpuDurations: number[] = [];
  const payloadText = 'x'.repeat(Math.max(1, params.chunkBytes));

  for (let iter = 0; iter < params.iterations; iter++) {
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();

    const encoder = new TextEncoder();
    let totalBytes = 0;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < params.chunkCount; i++) {
          if (params.simulatedTokenDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, params.simulatedTokenDelayMs));
          }
          const sseFrame = `event: token.delta\ndata: ${JSON.stringify({ seq: i, delta: payloadText })}\n\n`;
          controller.enqueue(encoder.encode(sseFrame));
        }
        controller.enqueue(
          encoder.encode(`event: turn.done\ndata: ${JSON.stringify({ status: 'completed' })}\n\n`),
        );
        controller.close();
      },
    });

    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
    }

    const wallMs = performance.now() - wallBefore;
    const cpuDelta = process.cpuUsage(cpuBefore);
    const activeCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;

    if (totalBytes === 0) {
      throw new Error('Synthetic stream emitted zero bytes');
    }

    wallDurations.push(wallMs);
    cpuDurations.push(activeCpuMs);
  }

  const wallDist = calculateDistribution(wallDurations);
  const cpuDist = calculateDistribution(cpuDurations);
  const waitWallRatioPercent =
    wallDist.meanMs > 0
      ? Number(Math.max(0, ((wallDist.meanMs - cpuDist.meanMs) / wallDist.meanMs) * 100).toFixed(2))
      : 0;

  return {
    label: params.label,
    chunkCount: params.chunkCount,
    chunkBytes: params.chunkBytes,
    simulatedTokenDelayMs: params.simulatedTokenDelayMs,
    iterations: params.iterations,
    wallMs: wallDist,
    activeCpuMs: cpuDist,
    waitWallRatioPercent,
  };
}

async function runBudgetCheckMode(
  probe: LocalWorkerdProbeHandle,
  mode: BudgetCheckTimingResult['mode'],
  concurrency: number,
  attempts: number,
  capMicroUsd: number,
): Promise<BudgetCheckTimingResult> {
  const budgetKey = `budget-${mode}-${Date.now()}`;
  await probe.fetch('/d1/budget_reset', { budgetKey, capMicroUsd });

  const reserveMicroUsd = 5_000;
  const latencies: number[] = [];
  let approvedCount = 0;
  let rejectedCount = 0;
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= attempts) break;
      const t0 = performance.now();
      const resp = await probe.fetch('/d1/budget_check', { budgetKey, reserveMicroUsd });
      const data = (await resp.json()) as { approved: boolean };
      latencies.push(performance.now() - t0);
      if (data.approved) {
        approvedCount++;
      } else {
        rejectedCount++;
      }
    }
  });

  await Promise.all(workers);
  const maxAllowedApprovals = Math.floor(capMicroUsd / reserveMicroUsd);

  return {
    mode,
    concurrency,
    attempts,
    approvedCount,
    rejectedCount,
    overCommitted: approvedCount > maxAllowedApprovals,
    latencyMs: calculateDistribution(latencies),
  };
}

/**
 * Establish and measure V2 timing methodologies for ACK, Runtime Overhead,
 * Streaming CPU vs wall time, and synchronous Global Budget Check contention.
 */
export async function runTimingMethodology(
  options: TimingMethodologyOptions = {},
): Promise<TimingMethodologyReport> {
  const turnIterations = options.turnIterations ?? 30;
  const streamIterations = options.streamIterations ?? 8;
  const contentionConcurrency = options.budgetContentionConcurrency ?? 20;
  const log = options.log ?? ((msg: string) => console.log(msg));

  log(`[Timing Methodology] Booting local workerd probe for ACK/Runtime/Budget measurements...`);
  const probe = await startLocalWorkerdProbe();

  try {
    // Warmup DO and D1
    await probe.fetch('/d1/budget_reset', { budgetKey: 'warm', capMicroUsd: 10_000_000 });
    await probe.fetch('/d1/budget_check', { budgetKey: 'warm', reserveMicroUsd: 5_000 });
    await probe.fetch('/do/normal_turn_prepare', { agentKey: 'timing-agent', id: 'warm' });
    await probe.fetch('/do/normal_turn_commit', { agentKey: 'timing-agent', id: 'warm' });

    const ackLatencies: number[] = [];
    const budgetLatencies: number[] = [];
    const prepareLatencies: number[] = [];
    const commitLatencies: number[] = [];
    const runtimeOverheadLatencies: number[] = [];

    await probe.fetch('/d1/budget_reset', {
      budgetKey: 'timing-global',
      capMicroUsd: 100_000_000,
    });

    for (let i = 0; i < turnIterations; i++) {
      const turnId = `tm_${i}`;
      const tReqStart = performance.now();

      // 1) Synchronous Global Budget Check (D1 atomic reservation)
      const tBudget0 = performance.now();
      const bResp = await probe.fetch('/d1/budget_check', {
        budgetKey: 'timing-global',
        reserveMicroUsd: 5_000,
      });
      await bResp.arrayBuffer();
      const budgetMs = performance.now() - tBudget0;

      // 2) DO Fast Path Prepare (durable user message + turn + outbox + alarm) -> Durable ACK point
      const tPrep0 = performance.now();
      const pResp = await probe.fetch('/do/normal_turn_prepare', {
        agentKey: 'timing-agent',
        id: turnId,
        text: `Timing methodology turn #${i}`,
      });
      await pResp.arrayBuffer();
      const prepMs = performance.now() - tPrep0;

      const ackMs = performance.now() - tReqStart;

      // (External model I/O excluded from Runtime Overhead per ADR-0006)

      // 3) DO Fenced Commit
      const tCommit0 = performance.now();
      const cResp = await probe.fetch('/do/normal_turn_commit', {
        agentKey: 'timing-agent',
        id: turnId,
        reply: `Timing methodology reply #${i}`,
      });
      await cResp.arrayBuffer();
      const commitMs = performance.now() - tCommit0;

      ackLatencies.push(ackMs);
      budgetLatencies.push(budgetMs);
      prepareLatencies.push(prepMs);
      commitLatencies.push(commitMs);
      runtimeOverheadLatencies.push(ackMs + commitMs);
    }

    log(`[Timing Methodology] Measuring Streaming CPU vs Wall Time across SSE chunk profiles...`);
    const streamingSamples: StreamingCpuSample[] = [
      await measureStreamingCpuScenario({
        label: 'burst_50_chunks_24B',
        chunkCount: 50,
        chunkBytes: 24,
        simulatedTokenDelayMs: 0,
        iterations: streamIterations,
      }),
      await measureStreamingCpuScenario({
        label: 'burst_200_chunks_24B',
        chunkCount: 200,
        chunkBytes: 24,
        simulatedTokenDelayMs: 0,
        iterations: streamIterations,
      }),
      await measureStreamingCpuScenario({
        label: 'paced_50_chunks_5ms_wait',
        chunkCount: 50,
        chunkBytes: 24,
        simulatedTokenDelayMs: 5,
        iterations: Math.max(4, Math.floor(streamIterations / 2)),
      }),
    ];

    log(`[Timing Methodology] Measuring Global Budget Check contention & fail-closed behavior...`);
    const budgetResults: BudgetCheckTimingResult[] = [
      await runBudgetCheckMode(probe, 'sequential_warm', 1, 30, 10_000_000),
      await runBudgetCheckMode(
        probe,
        'concurrent_contention',
        contentionConcurrency,
        40,
        10_000_000,
      ),
      await runBudgetCheckMode(
        probe,
        'exhaustion_fail_closed',
        contentionConcurrency,
        20,
        50_000, // Allows exactly 10 reservations of 5,000 micro-USD; next 10 must fail closed
      ),
    ];

    return {
      scenarioId: 'ember-v2-m0-timing-methodology',
      evidenceKind: 'measured_local_workerd',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      definitions: [
        {
          metric: 'ack',
          formula: 'T_ack = t_http_ack - t_req_start = T_edge_auth + T_budget_check + T_do_prepare',
          targetDescription: 'ADR-0006 near-region Durable ACK P95 <= 250 ms',
          includesModelIo: false,
        },
        {
          metric: 'runtime_overhead',
          formula:
            'T_runtime = T_edge_auth + T_budget_check + T_do_prepare + T_do_commit + T_stream_cpu',
          targetDescription:
            'ADR-0006 near-region Runtime Overhead P95 <= 200 ms (excl. model/provider)',
          includesModelIo: false,
        },
        {
          metric: 'streaming_cpu',
          formula:
            'C_stream = (cpuUsage_after.user + cpuUsage_after.system - cpuUsage_before) / 1000 ms',
          targetDescription:
            'Workers Standard bills active CPU ms ($0.02/M ms), not network wait wall time',
          includesModelIo: false,
        },
        {
          metric: 'global_budget_check',
          formula: 'T_budget = t_atomic_reserve_ack - t_budget_rpc_start (subset of T_runtime)',
          targetDescription:
            'ADR-0006 M1 gate <= 50 ms near-region P95 inside <= 200 ms Runtime Overhead',
          includesModelIo: false,
        },
      ],
      localTurnTiming: {
        evidenceKind: 'measured_local_workerd',
        iterations: turnIterations,
        ackMs: calculateDistribution(ackLatencies),
        globalBudgetCheckMs: calculateDistribution(budgetLatencies),
        doPrepareMs: calculateDistribution(prepareLatencies),
        doCommitMs: calculateDistribution(commitLatencies),
        runtimeOverheadMs: calculateDistribution(runtimeOverheadLatencies),
      },
      streamingCpu: {
        evidenceKind: 'simulated_synthetic',
        samples: streamingSamples,
      },
      budgetCheckContention: {
        evidenceKind: 'measured_local_workerd',
        results: budgetResults,
      },
    };
  } finally {
    await probe.dispose();
  }
}
