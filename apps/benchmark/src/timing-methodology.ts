import { resolveBenchmarkGitSha } from './evidence.js';
import { calculateDistribution } from './metrics.js';
import {
  M1_PROBE_MEASUREMENT_GAP,
  startLocalWorkerdProbe,
  type LocalWorkerdProbeHandle,
} from './sqlite-probe.js';
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

interface ProbeJsonResult {
  readonly approved?: boolean;
  readonly registered?: boolean;
  readonly confirmed?: boolean;
}

async function postJsonChecked(
  probe: LocalWorkerdProbeHandle,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ readonly ok: boolean; readonly data: ProbeJsonResult | null }> {
  try {
    const resp = await probe.fetch(pathname, body);
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      return { ok: false, data: null };
    }
    const data = (await resp.json()) as ProbeJsonResult;
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
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
  targetAuthority: BudgetCheckTimingResult['targetAuthority'],
  mode: BudgetCheckTimingResult['mode'],
  concurrency: number,
  attempts: number,
  capMicroUsd: number,
): Promise<BudgetCheckTimingResult> {
  const budgetKey = `budget-${targetAuthority}-${mode}-${Date.now()}`;
  const resetPath =
    targetAuthority === 'global_budget_do' ? '/budget-do/reset' : '/d1/budget_reset';
  const checkPath =
    targetAuthority === 'global_budget_do' ? '/budget-do/reserve' : '/d1/budget_check';
  await probe.fetch(resetPath, { budgetKey, capMicroUsd });

  const reserveMicroUsd = 5_000;
  const latencies: number[] = [];
  let approvedCount = 0;
  let deniedExpectedCount = 0;
  let errorCount = 0;
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= attempts) break;
      const t0 = performance.now();
      const res = await postJsonChecked(probe, checkPath, {
        budgetKey,
        grantId: `bc_${idx}`,
        reserveMicroUsd,
      });
      latencies.push(performance.now() - t0);
      if (!res.ok || res.data === null) {
        errorCount++;
      } else if (res.data.approved === true) {
        approvedCount++;
      } else {
        deniedExpectedCount++;
      }
    }
  });

  await Promise.all(workers);
  const maxAllowedApprovals = Math.floor(capMicroUsd / reserveMicroUsd);

  return {
    targetAuthority,
    mode,
    concurrency,
    sampleCount: attempts,
    approvedCount,
    deniedExpectedCount,
    errorCount,
    overCommitted: approvedCount > maxAllowedApprovals,
    latencyMs: calculateDistribution(latencies),
  };
}

/**
 * Establish and measure V2 timing methodologies across both the simplified 2-RPC
 * microbenchmark and the representative M1 joint A/B 3-RPC + GlobalBudgetDO + D1 seam,
 * plus synthetic Streaming CPU and Global Budget contention / fail-closed checks.
 */
export async function runTimingMethodology(
  options: TimingMethodologyOptions = {},
): Promise<TimingMethodologyReport> {
  const turnIterations = options.turnIterations ?? 30;
  const streamIterations = options.streamIterations ?? 8;
  const contentionConcurrency = options.budgetContentionConcurrency ?? 20;
  const log = options.log ?? ((msg: string) => console.log(msg));

  log(
    `[Timing Methodology] Booting local workerd probe for simplified & joint A/B seam measurements...`,
  );
  const probe = await startLocalWorkerdProbe();

  try {
    // Warmup D1, AgentHeadDO, and GlobalBudgetDO
    await probe.fetch('/d1/budget_reset', { budgetKey: 'warm', capMicroUsd: 100_000_000 });
    await probe.fetch('/d1/budget_check', { budgetKey: 'warm', reserveMicroUsd: 5_000 });
    await probe.fetch('/budget-do/reset', { budgetKey: 'warm-do', capMicroUsd: 100_000_000 });
    await probe.fetch('/budget-do/reserve', {
      budgetKey: 'warm-do',
      grantId: 'wg',
      reserveMicroUsd: 5_000,
    });
    await probe.fetch('/budget-do/authorize', { budgetKey: 'warm-do', grantId: 'wg' });
    await probe.fetch('/budget-do/settle', {
      budgetKey: 'warm-do',
      grantId: 'wg',
      actualMicroUsd: 1_200,
    });
    await probe.fetch('/do/normal_turn_prepare', { agentKey: 'timing-agent', id: 'warm' });
    await probe.fetch('/do/mark_attempt_sent', { agentKey: 'timing-agent', id: 'warm' });
    await probe.fetch('/do/budget_sync_commit', { agentKey: 'timing-agent', id: 'warm' });
    await probe.fetch('/d1/recovery_register', { agentKey: 'timing-agent', generation: 1 });
    await probe.fetch('/d1/recovery_confirm', { agentKey: 'timing-agent' });

    // -------------------------------------------------------------------------
    // Part A: Simplified 2-RPC Microbenchmark (historical reference series)
    // -------------------------------------------------------------------------
    const simpAck: number[] = [];
    const simpD1Budget: number[] = [];
    const simpPrepare: number[] = [];
    const simpCommit: number[] = [];
    const simpRuntime: number[] = [];
    let simpSuccess = 0;
    let simpError = 0;

    await probe.fetch('/d1/budget_reset', { budgetKey: 'timing-global', capMicroUsd: 100_000_000 });

    for (let i = 0; i < turnIterations; i++) {
      const turnId = `simp_${i}`;
      const tReqStart = performance.now();

      const tBudget0 = performance.now();
      const bRes = await postJsonChecked(probe, '/d1/budget_check', {
        budgetKey: 'timing-global',
        reserveMicroUsd: 5_000,
      });
      const budgetMs = performance.now() - tBudget0;

      const tPrep0 = performance.now();
      const pRes = await postJsonChecked(probe, '/do/normal_turn_prepare', {
        agentKey: 'timing-agent',
        id: turnId,
        text: `Simplified microbenchmark turn #${i}`,
      });
      const prepMs = performance.now() - tPrep0;
      const ackMs = performance.now() - tReqStart;

      const tCommit0 = performance.now();
      const cRes = await postJsonChecked(probe, '/do/normal_turn_commit', {
        agentKey: 'timing-agent',
        id: turnId,
        reply: `Simplified microbenchmark reply #${i}`,
      });
      const commitMs = performance.now() - tCommit0;

      if (!bRes.ok || bRes.data?.approved !== true || !pRes.ok || !cRes.ok) {
        simpError++;
        continue;
      }

      simpSuccess++;
      simpAck.push(ackMs);
      simpD1Budget.push(budgetMs);
      simpPrepare.push(prepMs);
      simpCommit.push(commitMs);
      simpRuntime.push(ackMs + commitMs);
    }

    // -------------------------------------------------------------------------
    // Part B: Representative M1 Joint A/B Seam (3 DO RPCs + GlobalBudgetDO + Uncovered D1 reg)
    // -------------------------------------------------------------------------
    const jointAckCov: number[] = [];
    const jointAckUncov: number[] = [];
    const jointReserve: number[] = [];
    const jointAuthorize: number[] = [];
    const jointPrepare: number[] = [];
    const jointMarkSent: number[] = [];
    const jointCommitSync: number[] = [];
    const jointSettle: number[] = [];
    const jointD1Reg: number[] = [];
    const jointRuntimeCov: number[] = [];
    const jointRuntimeUncov: number[] = [];
    let jointSuccess = 0;
    let jointDenied = 0;
    let jointError = 0;

    await probe.fetch('/budget-do/reset', {
      budgetKey: 'timing-global-do',
      capMicroUsd: 100_000_000,
    });

    for (let i = 0; i < turnIterations; i++) {
      const turnId = `jab_${i}`;
      const grantId = `jgrant_${i}`;

      const t0 = performance.now();

      // 1. GlobalBudgetDO.reserve
      const tRes0 = performance.now();
      const resCall = await postJsonChecked(probe, '/budget-do/reserve', {
        budgetKey: 'timing-global-do',
        grantId,
        reserveMicroUsd: 5_000,
      });
      const reserveMs = performance.now() - tRes0;

      if (!resCall.ok || resCall.data === null) {
        jointError++;
        continue;
      }
      if (resCall.data.approved !== true) {
        jointDenied++;
        continue;
      }

      // 2. AgentHeadDO.prepareTurn
      const tPrep0 = performance.now();
      const prepCall = await postJsonChecked(probe, '/do/normal_turn_prepare', {
        agentKey: 'timing-ab-agent',
        id: turnId,
        text: `Joint A/B seam turn #${i}`,
      });
      const prepMs = performance.now() - tPrep0;

      const ackCoveredMs = performance.now() - t0;

      // 2b. Uncovered path extra step: D1 registration write + confirmation
      const tReg0 = performance.now();
      const regCall = await postJsonChecked(probe, '/d1/recovery_register', {
        agentKey: `timing-ab-uncovered-${i % 5}`,
        generation: i + 1,
      });
      const confCall = await postJsonChecked(probe, '/d1/recovery_confirm', {
        agentKey: `timing-ab-uncovered-${i % 5}`,
      });
      const d1RegMs = performance.now() - tReg0;

      // 3. GlobalBudgetDO.authorize (before outbound model send)
      const tAuth0 = performance.now();
      const authCall = await postJsonChecked(probe, '/budget-do/authorize', {
        budgetKey: 'timing-global-do',
        grantId,
      });
      const authMs = performance.now() - tAuth0;

      // 4. AgentHeadDO.markAttemptSent (durable one-send intent/CAS)
      const tMark0 = performance.now();
      const markCall = await postJsonChecked(probe, '/do/mark_attempt_sent', {
        agentKey: 'timing-ab-agent',
        id: turnId,
      });
      const markMs = performance.now() - tMark0;

      // (Provider model I/O excluded from Runtime Overhead)

      // 5. AgentHeadDO.commitTurn + durable budget_sync
      const tCom0 = performance.now();
      const comCall = await postJsonChecked(probe, '/do/budget_sync_commit', {
        agentKey: 'timing-ab-agent',
        id: turnId,
        reply: `Joint A/B seam reply #${i}`,
      });
      const comMs = performance.now() - tCom0;

      // 6. GlobalBudgetDO.settle
      const tSet0 = performance.now();
      const setCall = await postJsonChecked(probe, '/budget-do/settle', {
        budgetKey: 'timing-global-do',
        grantId,
        actualMicroUsd: 1_200,
      });
      const settleMs = performance.now() - tSet0;

      if (
        !prepCall.ok ||
        !regCall.ok ||
        regCall.data?.registered !== true ||
        !confCall.ok ||
        confCall.data?.confirmed !== true ||
        !authCall.ok ||
        !markCall.ok ||
        !comCall.ok ||
        !setCall.ok
      ) {
        jointError++;
        continue;
      }
      if (authCall.data?.approved !== true) {
        jointDenied++;
        continue;
      }

      jointSuccess++;
      jointReserve.push(reserveMs);
      jointAuthorize.push(authMs);
      jointPrepare.push(prepMs);
      jointMarkSent.push(markMs);
      jointCommitSync.push(comMs);
      jointSettle.push(settleMs);
      jointD1Reg.push(d1RegMs);

      const rtCovered = reserveMs + prepMs + authMs + markMs + comMs + settleMs;
      jointAckCov.push(ackCoveredMs);
      jointAckUncov.push(ackCoveredMs + d1RegMs);
      jointRuntimeCov.push(rtCovered);
      jointRuntimeUncov.push(rtCovered + d1RegMs);
    }

    log(
      `[Timing Methodology] Measuring synthetic Streaming CPU vs Wall Time across SSE chunk profiles...`,
    );
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
      await runBudgetCheckMode(probe, 'global_budget_do', 'sequential_warm', 1, 30, 100_000_000),
      await runBudgetCheckMode(
        probe,
        'global_budget_do',
        'concurrent_contention',
        contentionConcurrency,
        40,
        100_000_000,
      ),
      await runBudgetCheckMode(
        probe,
        'global_budget_do',
        'exhaustion_fail_closed',
        contentionConcurrency,
        20,
        50_000,
      ),
      await runBudgetCheckMode(probe, 'd1_control_row', 'sequential_warm', 1, 30, 100_000_000),
      await runBudgetCheckMode(
        probe,
        'd1_control_row',
        'concurrent_contention',
        contentionConcurrency,
        40,
        100_000_000,
      ),
      await runBudgetCheckMode(
        probe,
        'd1_control_row',
        'exhaustion_fail_closed',
        contentionConcurrency,
        20,
        50_000,
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
          formula:
            'T_ack = t_http_ack - t_req_start = T_edge_auth + T_budget_reserve + T_do_prepare (+ T_d1_register_confirm if uncovered)',
          targetDescription: 'ADR-0006 provisional near-region Durable ACK P95 target <= 250 ms',
          includesModelIo: false,
        },
        {
          metric: 'runtime_overhead',
          formula:
            'T_runtime = T_edge_auth + T_budget_reserve + T_do_prepare (+ T_d1_reg if uncovered) + T_budget_authorize + T_do_mark_attempt_sent + T_do_commit_sync + T_budget_settle + T_stream_cpu',
          targetDescription:
            'ADR-0006 provisional near-region Runtime Overhead P95 target <= 200 ms (excl. model/provider)',
          includesModelIo: false,
        },
        {
          metric: 'streaming_cpu',
          formula:
            'C_stream = (process.cpuUsage().user + process.cpuUsage().system) delta in ms (Node/V8 synthetic proxy)',
          targetDescription:
            'Workers Standard bills active CPU ms ($0.02/M ms), not idle network wait wall time',
          includesModelIo: false,
        },
        {
          metric: 'global_budget_check',
          formula:
            'T_budget = T_global_budget_reserve + T_global_budget_authorize (subset of T_runtime)',
          targetDescription:
            'ADR-0006 provisional M1 target <= 50 ms near-region P95 inside <= 200 ms Runtime Overhead',
          includesModelIo: false,
        },
      ],
      simplified2RpcMicrobenchmark: {
        evidenceKind: 'measured_local_workerd',
        label:
          'Simplified 2-RPC microbenchmark (1 D1 update + DO prepare + DO commit; excludes joint A/B seam)',
        sampleCount: turnIterations,
        successCount: simpSuccess,
        errorCount: simpError,
        ackMs: calculateDistribution(simpAck),
        d1CounterUpdateMs: calculateDistribution(simpD1Budget),
        doPrepareMs: calculateDistribution(simpPrepare),
        doCommitMs: calculateDistribution(simpCommit),
        runtimeOverheadMs: calculateDistribution(simpRuntime),
      },
      jointAbSeamTiming: {
        evidenceKind: 'measured_local_workerd',
        label:
          'Representative M1 joint A/B 3-RPC + GlobalBudgetDO + D1 uncovered registration seam',
        sampleCount: turnIterations,
        successCount: jointSuccess,
        deniedCount: jointDenied,
        errorCount: jointError,
        ackCoveredMs: calculateDistribution(jointAckCov),
        ackUncoveredMs: calculateDistribution(jointAckUncov),
        globalBudgetReserveMs: calculateDistribution(jointReserve),
        globalBudgetAuthorizeMs: calculateDistribution(jointAuthorize),
        doPrepareMs: calculateDistribution(jointPrepare),
        doMarkAttemptSentMs: calculateDistribution(jointMarkSent),
        doCommitWithBudgetSyncMs: calculateDistribution(jointCommitSync),
        globalBudgetSettleMs: calculateDistribution(jointSettle),
        d1UncoveredRegisterAndConfirmMs: calculateDistribution(jointD1Reg),
        runtimeOverheadCoveredMs: calculateDistribution(jointRuntimeCov),
        runtimeOverheadUncoveredMs: calculateDistribution(jointRuntimeUncov),
      },
      streamingCpu: {
        evidenceKind: 'simulated_synthetic',
        runtimeNotice:
          'Measured via Node.js/V8 process.cpuUsage() over synthetic Web ReadableStream; NOT Cloudflare Workers isolate CPU.',
        samples: streamingSamples,
      },
      budgetCheckContention: {
        evidenceKind: 'measured_local_workerd',
        results: budgetResults,
      },
      m1MeasurementGap: M1_PROBE_MEASUREMENT_GAP,
    };
  } finally {
    await probe.dispose();
  }
}
