import { resolveBenchmarkGitSha } from './evidence.js';
import { calculateDistribution, DeterministicPrng } from './metrics.js';
import { startLocalWorkerdProbe } from './sqlite-probe.js';
import type {
  RegionalRttProfile,
  RegionalRttScenarioResult,
  RttSimulationReport,
} from './v2-types.js';

export const DEFAULT_REGIONAL_RTT_PROFILES: readonly RegionalRttProfile[] = Object.freeze([
  Object.freeze({
    regionId: 'near-region',
    label: 'Near-Region Edge + Colocated DO/D1 (e.g. Tokyo <-> Tokyo)',
    clientToEdgeRttMs: 12,
    clientToEdgeJitterMs: 3,
    edgeToDoRttMs: 4,
    edgeToDoJitterMs: 1,
    doToGlobalControlRttMs: 8,
    doToGlobalControlJitterMs: 2,
  }),
  Object.freeze({
    regionId: 'apac-intra',
    label: 'APAC Intra-Region (e.g. Singapore <-> Tokyo)',
    clientToEdgeRttMs: 20,
    clientToEdgeJitterMs: 5,
    edgeToDoRttMs: 38,
    edgeToDoJitterMs: 8,
    doToGlobalControlRttMs: 42,
    doToGlobalControlJitterMs: 10,
  }),
  Object.freeze({
    regionId: 'eu-us-east',
    label: 'Transatlantic (e.g. Frankfurt/London <-> US-East)',
    clientToEdgeRttMs: 18,
    clientToEdgeJitterMs: 4,
    edgeToDoRttMs: 78,
    edgeToDoJitterMs: 12,
    doToGlobalControlRttMs: 78,
    doToGlobalControlJitterMs: 12,
  }),
  Object.freeze({
    regionId: 'apac-us-west',
    label: 'Transpacific (e.g. Tokyo/Seoul <-> US-West)',
    clientToEdgeRttMs: 22,
    clientToEdgeJitterMs: 5,
    edgeToDoRttMs: 120,
    edgeToDoJitterMs: 16,
    doToGlobalControlRttMs: 120,
    doToGlobalControlJitterMs: 16,
  }),
  Object.freeze({
    regionId: 'cross-global',
    label: 'Cross-Global Long Haul (e.g. Sydney/SG <-> US-East/EU)',
    clientToEdgeRttMs: 25,
    clientToEdgeJitterMs: 6,
    edgeToDoRttMs: 185,
    edgeToDoJitterMs: 25,
    doToGlobalControlRttMs: 185,
    doToGlobalControlJitterMs: 25,
  }),
]);

export interface RttSimulationOptions {
  readonly profiles?: readonly RegionalRttProfile[];
  readonly samplesPerScenario?: number;
  readonly seed?: number;
  readonly concurrency?: number;
  readonly log?: (message: string) => void;
}

function sampleJitteredRtt(prng: DeterministicPrng, baseMs: number, jitterMs: number): number {
  // Deterministic symmetric-skewed jitter (biased slightly toward tail to reflect network P95)
  const u1 = prng.next();
  const u2 = prng.next();
  const offset = (u1 + u2 - 1) * jitterMs;
  return Math.max(1, Math.round(baseMs + offset));
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulate regional network RTT profiles over the local workerd DO SQLite + D1 probe.
 * Clearly tagged `simulated_synthetic`: validates latency sensitivity to RTT and RPC count,
 * NOT a production Cloudflare global SLA measurement.
 */
export async function runRttSimulation(
  options: RttSimulationOptions = {},
): Promise<RttSimulationReport> {
  const profiles = options.profiles ?? DEFAULT_REGIONAL_RTT_PROFILES;
  const samplesPerScenario = options.samplesPerScenario ?? 15;
  const seed = options.seed ?? 42;
  const concurrency = options.concurrency ?? 5;
  const log = options.log ?? ((msg: string) => console.log(msg));

  const prng = new DeterministicPrng(seed);
  log(`[RTT Simulation] Booting local workerd probe for ${profiles.length} regional profiles...`);
  const probe = await startLocalWorkerdProbe();

  try {
    await probe.fetch('/d1/budget_reset', { budgetKey: 'rtt-global', capMicroUsd: 100_000_000 });
    await probe.fetch('/do/normal_turn_prepare', { agentKey: 'rtt-warm', id: 'w' });
    await probe.fetch('/do/normal_turn_commit', { agentKey: 'rtt-warm', id: 'w' });

    const modes: readonly RegionalRttScenarioResult['architectureMode'][] = [
      'covered_preallocated_grant',
      'covered_sync_global_budget',
      'uncovered_registry_plus_sync_budget',
    ];

    const results: RegionalRttScenarioResult[] = [];

    for (const profile of profiles) {
      for (const mode of modes) {
        const ackValues: number[] = [];
        const runtimeValues: number[] = [];
        const budgetValues: number[] = [];
        let cursor = 0;

        const workers = Array.from(
          { length: Math.min(concurrency, samplesPerScenario) },
          async () => {
            for (;;) {
              const idx = cursor++;
              if (idx >= samplesPerScenario) break;

              const turnId = `rtt_${profile.regionId}_${mode}_${idx}`;
              const clientRtt = sampleJitteredRtt(
                prng,
                profile.clientToEdgeRttMs,
                profile.clientToEdgeJitterMs,
              );
              const edgeDoPrepareRtt = sampleJitteredRtt(
                prng,
                profile.edgeToDoRttMs,
                profile.edgeToDoJitterMs,
              );
              const edgeDoCommitRtt = sampleJitteredRtt(
                prng,
                profile.edgeToDoRttMs,
                profile.edgeToDoJitterMs,
              );
              const controlRtt = sampleJitteredRtt(
                prng,
                profile.doToGlobalControlRttMs,
                profile.doToGlobalControlJitterMs,
              );

              const tReqStart = performance.now();

              // Client -> Edge RTT (half on inbound, half on ACK return -> 1 full RTT for ACK)
              await sleepMs(clientRtt);

              // Optional uncovered D1 registry lookup before DO prepare
              if (mode === 'uncovered_registry_plus_sync_budget') {
                await sleepMs(controlRtt);
                const regResp = await probe.fetch('/d1/recovery_lookup', { agentKey: 'agent-1' });
                await regResp.arrayBuffer();
              }

              // Global budget check: local preallocated grant vs synchronous global D1 check
              const tBudgetStart = performance.now();
              if (mode === 'covered_preallocated_grant') {
                // Checked inside local DO prepare transaction -> 0 extra cross-region RPC RTT
              } else {
                await sleepMs(controlRtt);
                const bResp = await probe.fetch('/d1/budget_check', {
                  budgetKey: 'rtt-global',
                  reserveMicroUsd: 5_000,
                });
                await bResp.arrayBuffer();
              }
              const budgetMs = performance.now() - tBudgetStart;

              // Edge -> Agent Head DO prepare RPC
              await sleepMs(edgeDoPrepareRtt);
              const prepResp = await probe.fetch('/do/normal_turn_prepare', {
                agentKey: `rtt-agent-${profile.regionId}`,
                id: turnId,
                text: `Simulated RTT turn ${turnId}`,
              });
              await prepResp.arrayBuffer();

              const ackMs = performance.now() - tReqStart;

              // (Provider model I/O excluded from Runtime Overhead)

              // Edge -> Agent Head DO fenced commit RPC
              const tCommitStart = performance.now();
              await sleepMs(edgeDoCommitRtt);
              const commitResp = await probe.fetch('/do/normal_turn_commit', {
                agentKey: `rtt-agent-${profile.regionId}`,
                id: turnId,
                reply: `Simulated RTT reply ${turnId}`,
              });
              await commitResp.arrayBuffer();
              const commitMs = performance.now() - tCommitStart;

              // Runtime overhead excludes client-to-edge network travel, or measures edge-to-DO-to-control
              // Per ADR-0006: Durable ACK <= 250ms (near-region), Runtime Overhead <= 200ms (excl. model)
              const runtimeOverheadMs = ackMs - clientRtt + commitMs;

              ackValues.push(ackMs);
              runtimeValues.push(runtimeOverheadMs);
              budgetValues.push(budgetMs);
            }
          },
        );

        await Promise.all(workers);

        const ackDist = calculateDistribution(ackValues);
        const runtimeDist = calculateDistribution(runtimeValues);
        const budgetDist = calculateDistribution(budgetValues);

        results.push({
          regionId: profile.regionId,
          regionLabel: profile.label,
          architectureMode: mode,
          sampleCount: samplesPerScenario,
          ackMs: ackDist,
          runtimeOverheadMs: runtimeDist,
          budgetCheckMs: budgetDist,
          meetsAck250msP95: ackDist.p95Ms <= 250,
          meetsRuntime200msP95: runtimeDist.p95Ms <= 200,
          meetsBudget50msP95: budgetDist.p95Ms <= 50,
        });
      }
    }

    return {
      scenarioId: 'ember-v2-m0-rtt-simulation',
      evidenceKind: 'simulated_synthetic',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      seed,
      profiles,
      results,
      caveats: [
        'Network RTT values are synthetic jittered delays injected around local workerd DO/D1 execution.',
        'Covered Preallocated Grant mode checks pre-authorized local DO budget with 0 cross-region RPCs; Sync Global Budget adds 1 D1 control-plane RTT.',
        'Runtime Overhead = Edge-to-DO-to-Control time (ACK minus client RTT + commit); Durable ACK includes 1 client<->edge RTT.',
        'Results validate architectural sensitivity to RPC count and cross-region placement, NOT production Cloudflare SLA.',
      ],
    };
  } finally {
    await probe.dispose();
  }
}
