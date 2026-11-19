import { resolveBenchmarkGitSha } from './evidence.js';
import { calculateDistribution, DeterministicPrng } from './metrics.js';
import {
  M1_PROBE_MEASUREMENT_GAP,
  startLocalWorkerdProbe,
  type LocalWorkerdProbeHandle,
} from './sqlite-probe.js';
import type {
  RegionalRttProfile,
  RegionalRttScenarioResult,
  RttArchitectureMode,
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

interface CheckedResponse {
  readonly ok: boolean;
  readonly approved?: boolean;
  readonly registered?: boolean;
  readonly confirmed?: boolean;
}

async function callChecked(
  probe: LocalWorkerdProbeHandle,
  pathname: string,
  body: Record<string, unknown>,
): Promise<CheckedResponse> {
  try {
    const resp = await probe.fetch(pathname, body);
    if (!resp.ok) {
      await resp.arrayBuffer().catch(() => undefined);
      return { ok: false };
    }
    const data = (await resp.json()) as {
      approved?: boolean;
      registered?: boolean;
      confirmed?: boolean;
    };
    return {
      ok: true,
      ...(data.approved !== undefined ? { approved: data.approved } : {}),
      ...(data.registered !== undefined ? { registered: data.registered } : {}),
      ...(data.confirmed !== undefined ? { confirmed: data.confirmed } : {}),
    };
  } catch {
    return { ok: false };
  }
}

function sampleJitteredRtt(prng: DeterministicPrng, baseMs: number, jitterMs: number): number {
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
 * Simulate regional network RTT profiles over the local workerd AgentHeadDO +
 * GlobalBudgetDO + D1 probe across both the simplified 2-RPC baseline and the
 * M0 joint A/B 3-RPC contract seam (covered & uncovered).
 * Clearly tagged `simulated_synthetic`: compares architectural sensitivity to RTT
 * and RPC count against provisional ADR-0006 targets, NOT global production SLAs.
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
    await probe.fetch('/budget-do/reset', { budgetKey: 'rtt-global', capMicroUsd: 100_000_000 });
    await probe.fetch('/do/normal_turn_prepare', { agentKey: 'rtt-warm', id: 'w' });
    await probe.fetch('/do/mark_attempt_sent', { agentKey: 'rtt-warm', id: 'w' });
    await probe.fetch('/do/budget_sync_commit', { agentKey: 'rtt-warm', id: 'w' });
    await probe.fetch('/d1/recovery_register', { agentKey: 'rtt-warm', generation: 1 });
    await probe.fetch('/d1/recovery_confirm', { agentKey: 'rtt-warm' });

    const modes: readonly RttArchitectureMode[] = [
      'simplified_2_rpc_local_check',
      'm0_covered_joint_seam_colocated',
      'm0_covered_joint_seam_cross_region_budget',
      'm0_uncovered_joint_seam_with_d1_registration',
    ];

    const results: RegionalRttScenarioResult[] = [];

    for (const profile of profiles) {
      for (const mode of modes) {
        const ackValues: number[] = [];
        const runtimeValues: number[] = [];
        const budgetValues: number[] = [];
        let successCount = 0;
        let deniedCount = 0;
        let errorCount = 0;
        let cursor = 0;

        const workers = Array.from(
          { length: Math.min(concurrency, samplesPerScenario) },
          async () => {
            for (;;) {
              const idx = cursor++;
              if (idx >= samplesPerScenario) break;

              const turnId = `rtt_${profile.regionId}_${mode}_${idx}`;
              const grantId = `rtt_g_${profile.regionId}_${mode}_${idx}`;
              const agentKey = `rtt-agent-${profile.regionId}`;

              const clientRtt = sampleJitteredRtt(
                prng,
                profile.clientToEdgeRttMs,
                profile.clientToEdgeJitterMs,
              );
              const rttEdgeDo = () =>
                sampleJitteredRtt(prng, profile.edgeToDoRttMs, profile.edgeToDoJitterMs);
              const rttControl = () =>
                sampleJitteredRtt(
                  prng,
                  profile.doToGlobalControlRttMs,
                  profile.doToGlobalControlJitterMs,
                );

              const tReqStart = performance.now();

              // Client <-> Edge network leg for request/ACK
              await sleepMs(clientRtt);

              if (mode === 'simplified_2_rpc_local_check') {
                // Simplified 2-RPC microbenchmark: local DO check inside prepare + commit (unapproved M0 hypothesis)
                await sleepMs(rttEdgeDo());
                const tB0 = performance.now();
                const prep = await callChecked(probe, '/do/normal_turn_prepare', {
                  agentKey,
                  id: turnId,
                  text: `Simulated RTT simplified turn ${turnId}`,
                });
                // Local budget check happens inside prepare transaction (~local SQLite read/update portion)
                const budgetMs = Number(((performance.now() - tB0) * 0.25).toFixed(2));
                const ackMs = performance.now() - tReqStart;

                const tCom0 = performance.now();
                await sleepMs(rttEdgeDo());
                const commit = await callChecked(probe, '/do/normal_turn_commit', {
                  agentKey,
                  id: turnId,
                  reply: `Simulated RTT simplified reply ${turnId}`,
                });
                const commitMs = performance.now() - tCom0;

                if (!prep.ok || !commit.ok) {
                  errorCount++;
                  continue;
                }
                successCount++;
                ackValues.push(ackMs);
                runtimeValues.push(ackMs - clientRtt + commitMs);
                budgetValues.push(budgetMs);
                continue;
              }

              // Joint M0 A/B 3-RPC + GlobalBudgetDO seam
              const budgetRtt =
                mode === 'm0_covered_joint_seam_colocated' ? rttEdgeDo() : rttControl();

              // 1. GlobalBudgetDO.reserve
              const tBudget1 = performance.now();
              await sleepMs(budgetRtt);
              const reserve = await callChecked(probe, '/budget-do/reserve', {
                budgetKey: 'rtt-global',
                grantId,
                reserveMicroUsd: 5_000,
              });
              const reserveMs = performance.now() - tBudget1;
              if (!reserve.ok) {
                errorCount++;
                continue;
              }
              if (reserve.approved !== true) {
                deniedCount++;
                continue;
              }

              // 2. Uncovered path only: D1 recovery_register write + confirmation before accepting work
              if (mode === 'm0_uncovered_joint_seam_with_d1_registration') {
                await sleepMs(rttControl());
                const reg = await callChecked(probe, '/d1/recovery_register', {
                  agentKey,
                  generation: idx + 1,
                });
                await sleepMs(rttControl());
                const conf = await callChecked(probe, '/d1/recovery_confirm', { agentKey });
                if (!reg.ok || reg.registered !== true || !conf.ok || conf.confirmed !== true) {
                  errorCount++;
                  continue;
                }
              }

              // 3. AgentHeadDO.prepareTurn -> Durable ACK point
              await sleepMs(rttEdgeDo());
              const prep = await callChecked(probe, '/do/normal_turn_prepare', {
                agentKey,
                id: turnId,
                text: `Simulated RTT joint A/B turn ${turnId}`,
              });
              if (!prep.ok) {
                errorCount++;
                continue;
              }
              const ackMs = performance.now() - tReqStart;

              // 4. GlobalBudgetDO.authorize + AgentHeadDO.markAttemptSent before outbound model send
              const tPostAckStart = performance.now();
              const tBudget2 = performance.now();
              await sleepMs(
                mode === 'm0_covered_joint_seam_colocated' ? rttEdgeDo() : rttControl(),
              );
              const auth = await callChecked(probe, '/budget-do/authorize', {
                budgetKey: 'rtt-global',
                grantId,
              });
              const authMs = performance.now() - tBudget2;
              if (!auth.ok) {
                errorCount++;
                continue;
              }
              if (auth.approved !== true) {
                deniedCount++;
                continue;
              }

              await sleepMs(rttEdgeDo());
              const mark = await callChecked(probe, '/do/mark_attempt_sent', {
                agentKey,
                id: turnId,
              });

              // 5. (Provider model I/O excluded from Runtime Overhead)

              // 6. AgentHeadDO.commitTurn (with durable budget_sync) + GlobalBudgetDO.settle
              await sleepMs(rttEdgeDo());
              const commit = await callChecked(probe, '/do/budget_sync_commit', {
                agentKey,
                id: turnId,
                reply: `Simulated RTT joint A/B reply ${turnId}`,
              });

              await sleepMs(
                mode === 'm0_covered_joint_seam_colocated' ? rttEdgeDo() : rttControl(),
              );
              const settle = await callChecked(probe, '/budget-do/settle', {
                budgetKey: 'rtt-global',
                grantId,
                actualMicroUsd: 1_200,
              });
              const postAckMs = performance.now() - tPostAckStart;

              if (!mark.ok || !commit.ok || !settle.ok) {
                errorCount++;
                continue;
              }

              successCount++;
              ackValues.push(ackMs);
              runtimeValues.push(ackMs - clientRtt + postAckMs);
              budgetValues.push(reserveMs + authMs);
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
          isApprovedM0Contract: mode !== 'simplified_2_rpc_local_check',
          sampleCount: samplesPerScenario,
          successCount,
          deniedCount,
          errorCount,
          ackMs: ackDist,
          runtimeOverheadMs: runtimeDist,
          budgetCheckMs: budgetDist,
          withinTargetAck250msP95: successCount === samplesPerScenario && ackDist.p95Ms <= 250,
          withinTargetRuntime200msP95:
            successCount === samplesPerScenario && runtimeDist.p95Ms <= 200,
          withinTargetBudget50msP95: successCount === samplesPerScenario && budgetDist.p95Ms <= 50,
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
      m1MeasurementGap: M1_PROBE_MEASUREMENT_GAP,
      caveats: [
        'Network RTT values are synthetic jittered delays injected around local workerd AgentHeadDO + GlobalBudgetDO + D1 execution.',
        'simplified_2_rpc_local_check reflects an unapproved 2-RPC local-check optimization hypothesis, NOT the current M0 joint A/B contract.',
        'm0_covered_joint_seam_* models 3 DO RPCs (prepare, markAttemptSent, commit+budget_sync) plus GlobalBudgetDO (reserve, authorize, settle).',
        'm0_uncovered_joint_seam_with_d1_registration adds D1 recovery_register write and recovery_confirm round-trips.',
        '250 ms ACK / 200 ms Runtime / 50 ms Budget thresholds are provisional ADR-0006 engineering targets, NOT certified M0 results or global production SLAs.',
      ],
    };
  } finally {
    await probe.dispose();
  }
}
