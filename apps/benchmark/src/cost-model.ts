import { resolveBenchmarkGitSha } from './evidence.js';
import type {
  CostModelInput,
  CostModelOutput,
  CostSensitivityReport,
  IndependentRecoveryParams,
  LlmCostParams,
  MeterBreakdown,
  PerEventMeterAssumptions,
  SandboxCostParams,
  StorageGrowthParams,
  UserWorkloadCohort,
} from './v2-types.js';

export const ADR0006_WORKERS_PAID_BASE_USD = 5.0;
export const ADR0006_DO_MEMORY_GB = 0.128;

export const ADR0006_DEFAULT_COHORTS: readonly UserWorkloadCohort[] = Object.freeze([
  Object.freeze({
    name: 'light' as const,
    share: 0.6,
    turnsPerDay: 5,
    tasksPerDay: 1,
    doDbAvgMb: 5,
    r2AvgMb: 20,
  }),
  Object.freeze({
    name: 'medium' as const,
    share: 0.3,
    turnsPerDay: 20,
    tasksPerDay: 4,
    doDbAvgMb: 20,
    r2AvgMb: 100,
  }),
  Object.freeze({
    name: 'heavy' as const,
    share: 0.1,
    turnsPerDay: 100,
    tasksPerDay: 20,
    doDbAvgMb: 100,
    r2AvgMb: 500,
  }),
]);

export const ADR0006_DEFAULT_PER_EVENT: PerEventMeterAssumptions = Object.freeze({
  workerRequestsPerEvent: 6,
  workerNonStreamCpuMsPerEvent: 30,
  workerStreamCpuMsPerEvent: 10,
  doRequestsPerEvent: 4,
  doBillableDurationSecPerEvent: 0.5,
  doRowsReadPerEvent: 200,
  doRowsWrittenPerEvent: 20,
  d1RowsReadPerEvent: 10,
  d1RowsWrittenPerEvent: 0.2,
  d1StorageMbPerAgent: 0.25,
  queueOpsPerEvent: 1.2,
  r2ClassAPerEvent: 0.1,
  r2ClassBPerEvent: 0.2,
  observabilityBytesPerEvent: 2_000,
  observabilityRetentionDays: 7,
});

export const ADR0006_DEFAULT_RECOVERY: IndependentRecoveryParams = Object.freeze({
  enabled: false,
  cronInvocationsPerMonth: 43_200, // 1/min * 60 * 24 * 30
  d1WritesPerEvent: 2, // 1 register + 1 delete/retire per obligation
  d1ReadsPerEvent: 2, // 1 due sweep + 1 reconciliation lookup
  extraDoRequestsPerRecoveryEvent: 1,
  recoveryEventRate: 0.02,
});

export const ADR0006_DEFAULT_STORAGE_GROWTH: StorageGrowthParams = Object.freeze({
  monthsElapsed: 0, // 0 = steady-state ADR-0006 baseline average (19 MB DO, 92 MB R2)
  initialDoMbPerAgent: 0.5,
  netDoBytesPerEvent: 2_000,
  initialR2MbPerAgent: 2,
  netR2BytesPerEvent: 8_000,
  dormantRetainedRatio: 0,
  dormantDoMbPerAgent: 5,
  dormantR2MbPerAgent: 20,
});

export const ADR0006_DEFAULT_LLM: LlmCostParams = Object.freeze({
  inputTokensPerEvent: 5_000,
  outputTokensPerEvent: 1_000,
  cachedInputShare: 0,
  cachedInputDiscount: 0.5,
  inputUsdPerMillion: 0.5,
  outputUsdPerMillion: 2.0,
  retryMultiplier: 1.0,
});

export const ADR0006_DEFAULT_SANDBOX: SandboxCostParams = Object.freeze({
  eligibleRunsPerUserPerMonth: 30,
  avgRunMinutes: 5,
  vcpus: 1,
  ramGib: 1,
  storageGibPerActiveUser: 0,
  deviceOffloadRate: 0,
});

export const DAYTONA_OFFICIAL_RATES = Object.freeze({
  vcpuPerHourUsd: 0.0504,
  ramGibPerHourUsd: 0.0162,
  storageGibPerHourUsd: 0.000108,
  freeStorageGib: 5,
});

interface MeterSpec {
  readonly meter: string;
  readonly unit: string;
  readonly includedAllowance: number;
  readonly unitQuantum: number;
  readonly ratePerUnitUsd: number;
  readonly roundingRule: 'ceil' | 'prorated';
  readonly usage: number;
}

function roundUsd(val: number): number {
  return Number(val.toFixed(4));
}

function roundUsd2(val: number): number {
  return Number(val.toFixed(2));
}

/**
 * Reproducible ADR-0006 cloud runtime, storage-growth, independent recovery,
 * LLM, and Daytona sandbox cost calculator.
 */
export function calculateAdr0006Cost(input: CostModelInput): CostModelOutput {
  if (!Number.isFinite(input.mau) || input.mau < 0) {
    throw new Error(`invalid mau: ${input.mau}`);
  }
  const mau = input.mau;
  const daysPerMonth = input.daysPerMonth ?? 30;
  const allowanceRemainingRatio = input.allowanceRemainingRatio ?? 1.0;
  if (allowanceRemainingRatio < 0 || allowanceRemainingRatio > 1) {
    throw new Error(`allowanceRemainingRatio must be in [0, 1], got ${allowanceRemainingRatio}`);
  }

  const cohorts = input.cohorts ?? ADR0006_DEFAULT_COHORTS;
  const shareSum = cohorts.reduce((acc, c) => acc + c.share, 0);
  if (Math.abs(shareSum - 1) > 1e-6) {
    throw new Error(`cohort shares must sum to 1.0, got ${shareSum}`);
  }

  const perEvent: PerEventMeterAssumptions = {
    ...ADR0006_DEFAULT_PER_EVENT,
    ...(input.perEvent ?? {}),
  };
  const recovery: IndependentRecoveryParams = {
    ...ADR0006_DEFAULT_RECOVERY,
    ...(input.independentRecovery ?? {}),
  };
  const storageGrowth: StorageGrowthParams = {
    ...ADR0006_DEFAULT_STORAGE_GROWTH,
    ...(input.storageGrowth ?? {}),
  };
  const llm: LlmCostParams = {
    ...ADR0006_DEFAULT_LLM,
    ...(input.llm ?? {}),
  };
  const sandbox: SandboxCostParams = {
    ...ADR0006_DEFAULT_SANDBOX,
    ...(input.sandbox ?? {}),
  };

  let weightedEventsPerUserPerMonth = 0;
  let weightedDoAvgMb = 0;
  let weightedR2AvgMb = 0;

  for (const c of cohorts) {
    const eventsPerUserMonth = (c.turnsPerDay + c.tasksPerDay) * daysPerMonth;
    weightedEventsPerUserPerMonth += c.share * eventsPerUserMonth;
    weightedDoAvgMb += c.share * c.doDbAvgMb;
    weightedR2AvgMb += c.share * c.r2AvgMb;
  }

  // If storageGrowth.monthsElapsed > 0, compute cumulative stock + dormant users; otherwise use ADR-0006 steady-state stock
  let totalDoStorageGb: number;
  let totalR2StorageGb: number;
  if (storageGrowth.monthsElapsed > 0) {
    const activeDoMb =
      storageGrowth.initialDoMbPerAgent +
      (weightedEventsPerUserPerMonth *
        storageGrowth.monthsElapsed *
        storageGrowth.netDoBytesPerEvent) /
        1_000_000;
    const activeR2Mb =
      storageGrowth.initialR2MbPerAgent +
      (weightedEventsPerUserPerMonth *
        storageGrowth.monthsElapsed *
        storageGrowth.netR2BytesPerEvent) /
        1_000_000;
    const dormantAgents = mau * storageGrowth.dormantRetainedRatio;
    weightedDoAvgMb = activeDoMb;
    weightedR2AvgMb = activeR2Mb;
    totalDoStorageGb =
      (mau * activeDoMb + dormantAgents * storageGrowth.dormantDoMbPerAgent) / 1_000;
    totalR2StorageGb =
      (mau * activeR2Mb + dormantAgents * storageGrowth.dormantR2MbPerAgent) / 1_000;
  } else {
    const dormantAgents = mau * storageGrowth.dormantRetainedRatio;
    totalDoStorageGb =
      (mau * weightedDoAvgMb + dormantAgents * storageGrowth.dormantDoMbPerAgent) / 1_000;
    totalR2StorageGb =
      (mau * weightedR2AvgMb + dormantAgents * storageGrowth.dormantR2MbPerAgent) / 1_000;
  }

  const E = weightedEventsPerUserPerMonth * mau;
  const workerCpuPerEvent =
    perEvent.workerNonStreamCpuMsPerEvent + perEvent.workerStreamCpuMsPerEvent;

  const recoveryExtraWorkerReq = recovery.enabled
    ? recovery.cronInvocationsPerMonth + E * recovery.recoveryEventRate
    : 0;
  const recoveryExtraWorkerCpuMs = recovery.enabled
    ? recovery.cronInvocationsPerMonth * 2 + E * recovery.recoveryEventRate * 10
    : 0;
  const recoveryExtraDoReq = recovery.enabled
    ? E * recovery.recoveryEventRate * recovery.extraDoRequestsPerRecoveryEvent
    : 0;
  const recoveryExtraD1Writes = recovery.enabled ? E * recovery.d1WritesPerEvent : 0;
  const recoveryExtraD1Reads = recovery.enabled
    ? E * recovery.d1ReadsPerEvent + recovery.cronInvocationsPerMonth * 5
    : 0;

  const obsIngestedGb = (E * perEvent.observabilityBytesPerEvent) / 1_000_000_000;
  const obsRetainedGbMonth = obsIngestedGb * (perEvent.observabilityRetentionDays / daysPerMonth);

  const meterSpecs: readonly MeterSpec[] = [
    {
      meter: 'workers_requests',
      unit: '1M requests',
      includedAllowance: 10_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.3,
      roundingRule: 'prorated',
      usage: E * perEvent.workerRequestsPerEvent + recoveryExtraWorkerReq,
    },
    {
      meter: 'workers_cpu',
      unit: '1M CPU ms',
      includedAllowance: 30_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.02,
      roundingRule: 'prorated',
      usage: E * workerCpuPerEvent + recoveryExtraWorkerCpuMs,
    },
    {
      meter: 'do_requests',
      unit: '1M requests',
      includedAllowance: 1_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.15,
      roundingRule: 'ceil',
      usage: E * perEvent.doRequestsPerEvent + recoveryExtraDoReq,
    },
    {
      meter: 'do_duration',
      unit: '1M GB-s',
      includedAllowance: 400_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 12.5,
      roundingRule: 'ceil',
      usage: ADR0006_DO_MEMORY_GB * perEvent.doBillableDurationSecPerEvent * E,
    },
    {
      meter: 'do_sqlite_rows_read',
      unit: '1M rows',
      includedAllowance: 25_000_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.001,
      roundingRule: 'prorated',
      usage: E * perEvent.doRowsReadPerEvent,
    },
    {
      meter: 'do_sqlite_rows_written',
      unit: '1M rows',
      includedAllowance: 50_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 1.0,
      roundingRule: 'prorated',
      usage: E * perEvent.doRowsWrittenPerEvent,
    },
    {
      meter: 'do_sqlite_storage',
      unit: '1 GB-month',
      includedAllowance: 5,
      unitQuantum: 1,
      ratePerUnitUsd: 0.2,
      roundingRule: 'prorated',
      usage: totalDoStorageGb,
    },
    {
      meter: 'd1_rows_read',
      unit: '1M rows',
      includedAllowance: 25_000_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.001,
      roundingRule: 'prorated',
      usage: E * perEvent.d1RowsReadPerEvent + recoveryExtraD1Reads,
    },
    {
      meter: 'd1_rows_written',
      unit: '1M rows',
      includedAllowance: 50_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 1.0,
      roundingRule: 'prorated',
      usage: E * perEvent.d1RowsWrittenPerEvent + recoveryExtraD1Writes,
    },
    {
      meter: 'd1_storage',
      unit: '1 GB-month',
      includedAllowance: 5,
      unitQuantum: 1,
      ratePerUnitUsd: 0.75,
      roundingRule: 'prorated',
      usage: (mau * perEvent.d1StorageMbPerAgent) / 1_000,
    },
    {
      meter: 'queues_operations',
      unit: '1M ops',
      includedAllowance: 1_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.4,
      roundingRule: 'prorated',
      usage: E * perEvent.queueOpsPerEvent,
    },
    {
      meter: 'r2_storage',
      unit: '1 GB-month',
      includedAllowance: 10,
      unitQuantum: 1,
      ratePerUnitUsd: 0.015,
      roundingRule: 'ceil',
      usage: totalR2StorageGb,
    },
    {
      meter: 'r2_class_a',
      unit: '1M ops',
      includedAllowance: 1_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 4.5,
      roundingRule: 'ceil',
      usage: E * perEvent.r2ClassAPerEvent,
    },
    {
      meter: 'r2_class_b',
      unit: '1M ops',
      includedAllowance: 10_000_000,
      unitQuantum: 1_000_000,
      ratePerUnitUsd: 0.36,
      roundingRule: 'ceil',
      usage: E * perEvent.r2ClassBPerEvent,
    },
    {
      meter: 'observability_ingested',
      unit: '1 GB',
      includedAllowance: 50,
      unitQuantum: 1,
      ratePerUnitUsd: 0.25,
      roundingRule: 'prorated',
      usage: obsIngestedGb,
    },
    {
      meter: 'observability_retained',
      unit: '1 GB-month',
      includedAllowance: 10,
      unitQuantum: 1,
      ratePerUnitUsd: 0.1,
      roundingRule: 'prorated',
      usage: obsRetainedGbMonth,
    },
  ];

  const meters: MeterBreakdown[] = [];
  let meterOverageTotalUsd = 0;

  for (const spec of meterSpecs) {
    const otherB = input.otherProductsUsage?.[spec.meter];
    const remainingAllowance =
      otherB !== undefined
        ? Math.max(spec.includedAllowance - otherB, 0)
        : spec.includedAllowance * allowanceRemainingRatio;
    const overageRaw = Math.max(spec.usage - remainingAllowance, 0);
    const unitsRaw = overageRaw / spec.unitQuantum;
    const billableUnits = spec.roundingRule === 'ceil' ? Math.ceil(unitsRaw) : unitsRaw;
    const costUsd = billableUnits * spec.ratePerUnitUsd;
    meterOverageTotalUsd += costUsd;

    meters.push({
      meter: spec.meter,
      unit: spec.unit,
      emberUsage: Number(spec.usage.toFixed(4)),
      includedAllowance: spec.includedAllowance,
      remainingAllowance: Number(remainingAllowance.toFixed(4)),
      overageRaw: Number(overageRaw.toFixed(4)),
      billableUnits: Number(billableUnits.toFixed(6)),
      ratePerUnitUsd: spec.ratePerUnitUsd,
      roundingRule: spec.roundingRule,
      costUsd: roundUsd(costUsd),
    });
  }

  const cloudTotalUsd = roundUsd2(ADR0006_WORKERS_PAID_BASE_USD + meterOverageTotalUsd);

  // Variable LLM cost
  const uncachedShare = Math.max(0, 1 - llm.cachedInputShare);
  const effectiveInputRate =
    llm.inputUsdPerMillion * (uncachedShare + llm.cachedInputShare * (1 - llm.cachedInputDiscount));
  const llmPerEventUsd =
    ((llm.inputTokensPerEvent / 1_000_000) * effectiveInputRate +
      (llm.outputTokensPerEvent / 1_000_000) * llm.outputUsdPerMillion) *
    llm.retryMultiplier;
  const llmCostUsd = roundUsd2(E * llmPerEventUsd);

  // Variable Daytona Sandbox cost
  const activeHours = (mau * sandbox.eligibleRunsPerUserPerMonth * sandbox.avgRunMinutes) / 60;
  const hourlyRatePerInstance =
    sandbox.vcpus * DAYTONA_OFFICIAL_RATES.vcpuPerHourUsd +
    sandbox.ramGib * DAYTONA_OFFICIAL_RATES.ramGibPerHourUsd;
  const totalStorageGib = mau * sandbox.storageGibPerActiveUser;
  const billableStorageGib = Math.max(0, totalStorageGib - DAYTONA_OFFICIAL_RATES.freeStorageGib);
  const monthlyStorageCostUsd =
    billableStorageGib * (daysPerMonth * 24) * DAYTONA_OFFICIAL_RATES.storageGibPerHourUsd;

  const sandboxGrossComputeUsd = activeHours * hourlyRatePerInstance;
  const sandboxGrossCostUsd = roundUsd2(sandboxGrossComputeUsd + monthlyStorageCostUsd);
  const sandboxSavingsUsd = roundUsd2(sandboxGrossComputeUsd * sandbox.deviceOffloadRate);
  const sandboxNetAfterOffloadUsd = roundUsd2(sandboxGrossCostUsd - sandboxSavingsUsd);

  const totalVariableUsd = roundUsd2(llmCostUsd + sandboxNetAfterOffloadUsd);
  const combinedMonthlyUsd = roundUsd2(cloudTotalUsd + totalVariableUsd);

  return {
    input: {
      mau,
      totalEventsPerMonth: Math.round(E),
      allowanceRemainingRatio,
      weightedDoAvgMb: Number(weightedDoAvgMb.toFixed(2)),
      weightedR2AvgMb: Number(weightedR2AvgMb.toFixed(2)),
    },
    cloudRuntime: {
      baseFeeUsd: ADR0006_WORKERS_PAID_BASE_USD,
      meterOverageTotalUsd: roundUsd2(meterOverageTotalUsd),
      totalUsd: cloudTotalUsd,
      meters,
    },
    variableExecution: {
      llmCostUsd,
      sandboxGrossCostUsd,
      sandboxNetAfterOffloadUsd,
      sandboxSavingsUsd,
      totalVariableUsd,
    },
    combinedMonthlyUsd,
    costPerMauUsd: mau > 0 ? roundUsd(combinedMonthlyUsd / mau) : 0,
  };
}

/**
 * Generate the full ADR-0006 reference cost matrix and multi-parameter sensitivity sweeps.
 */
export function runCostModelAnalysis(): CostSensitivityReport {
  const mauTiers = [10, 100, 1_000, 10_000, 100_000] as const;

  const adr0006ReferenceMatrix = mauTiers.map((mau) => ({
    mau,
    fullAllowanceUsd: calculateAdr0006Cost({ mau, allowanceRemainingRatio: 1.0 }).cloudRuntime
      .totalUsd,
    halfAllowanceUsd: calculateAdr0006Cost({ mau, allowanceRemainingRatio: 0.5 }).cloudRuntime
      .totalUsd,
    zeroAllowanceUsd: calculateAdr0006Cost({ mau, allowanceRemainingRatio: 0.0 }).cloudRuntime
      .totalUsd,
  }));

  const doWriteRowsSensitivity: CostSensitivityReport['doWriteRowsSensitivity'][number][] = [];
  for (const mau of [1_000, 10_000, 100_000] as const) {
    for (const doRowsWrittenPerEvent of [10, 20, 30, 40, 60] as const) {
      const res = calculateAdr0006Cost({
        mau,
        allowanceRemainingRatio: 1.0,
        perEvent: { doRowsWrittenPerEvent },
      });
      const writeMeter = res.cloudRuntime.meters.find((m) => m.meter === 'do_sqlite_rows_written')!;
      doWriteRowsSensitivity.push({
        mau,
        doRowsWrittenPerEvent,
        cloudRuntimeUsd: res.cloudRuntime.totalUsd,
        doWriteOverageUsd: roundUsd2(writeMeter.costUsd),
      });
    }
  }

  const doDurationSensitivity: CostSensitivityReport['doDurationSensitivity'][number][] = [];
  for (const mau of [1_000, 10_000, 100_000] as const) {
    for (const doBillableDurationSecPerEvent of [0.2, 0.5, 2.0, 5.0, 10.0] as const) {
      const res = calculateAdr0006Cost({
        mau,
        allowanceRemainingRatio: 1.0,
        perEvent: { doBillableDurationSecPerEvent },
      });
      const durMeter = res.cloudRuntime.meters.find((m) => m.meter === 'do_duration')!;
      doDurationSensitivity.push({
        mau,
        doDurationSecPerEvent: doBillableDurationSecPerEvent,
        cloudRuntimeUsd: res.cloudRuntime.totalUsd,
        doDurationOverageUsd: roundUsd2(durMeter.costUsd),
      });
    }
  }

  const streamingCpuSensitivity: CostSensitivityReport['streamingCpuSensitivity'][number][] = [];
  for (const mau of [10_000, 100_000] as const) {
    for (const workerStreamCpuMsPerEvent of [0, 10, 20, 40, 80] as const) {
      const res = calculateAdr0006Cost({
        mau,
        allowanceRemainingRatio: 1.0,
        perEvent: { workerStreamCpuMsPerEvent },
      });
      const cpuMeter = res.cloudRuntime.meters.find((m) => m.meter === 'workers_cpu')!;
      streamingCpuSensitivity.push({
        mau,
        workerCpuMsPerEvent: 30 + workerStreamCpuMsPerEvent,
        cloudRuntimeUsd: res.cloudRuntime.totalUsd,
        workerCpuOverageUsd: roundUsd2(cpuMeter.costUsd),
      });
    }
  }

  const storageGrowthProjection: CostSensitivityReport['storageGrowthProjection'][number][] = [];
  for (const mau of [1_000, 10_000, 100_000] as const) {
    for (const monthsElapsed of [1, 6, 12] as const) {
      for (const dormantRetainedRatio of [0, 2.0] as const) {
        const res = calculateAdr0006Cost({
          mau,
          allowanceRemainingRatio: 1.0,
          storageGrowth: {
            monthsElapsed,
            initialDoMbPerAgent: 0.5,
            netDoBytesPerEvent: 3_500, // empirically conservative with indexes
            dormantRetainedRatio,
            dormantDoMbPerAgent: 5,
          },
        });
        const storMeter = res.cloudRuntime.meters.find((m) => m.meter === 'do_sqlite_storage')!;
        storageGrowthProjection.push({
          mau,
          monthsElapsed,
          dormantRetainedRatio,
          avgDoMbPerActiveAgent: res.input.weightedDoAvgMb,
          totalDoStorageGb: Number(storMeter.emberUsage.toFixed(2)),
          cloudRuntimeUsd: res.cloudRuntime.totalUsd,
          doStorageOverageUsd: roundUsd2(storMeter.costUsd),
        });
      }
    }
  }

  const independentRecoverySensitivity: CostSensitivityReport['independentRecoverySensitivity'][number][] =
    [];
  for (const mau of [1_000, 10_000, 100_000] as const) {
    const baseline = calculateAdr0006Cost({ mau, allowanceRemainingRatio: 1.0 }).cloudRuntime
      .totalUsd;
    for (const d1WritesPerEvent of [0, 1, 2] as const) {
      const res = calculateAdr0006Cost({
        mau,
        allowanceRemainingRatio: 1.0,
        independentRecovery: {
          enabled: d1WritesPerEvent > 0,
          d1WritesPerEvent,
        },
      });
      independentRecoverySensitivity.push({
        mau,
        d1WritesPerEvent,
        cloudRuntimeUsd: res.cloudRuntime.totalUsd,
        incrementalRecoveryUsd: roundUsd2(res.cloudRuntime.totalUsd - baseline),
      });
    }
  }

  const llmProfiles = [
    {
      name: 'Nemotron-3.5-Lightning ZDR ($0.06/$0.16)',
      inputUsdPerMillion: 0.06,
      outputUsdPerMillion: 0.16,
    },
    {
      name: 'DeepSeek-V4.1-Flash ZDR ($0.098/$0.294)',
      inputUsdPerMillion: 0.098,
      outputUsdPerMillion: 0.294,
    },
    {
      name: 'ADR-0006 Illustrative ($0.50/$2.00)',
      inputUsdPerMillion: 0.5,
      outputUsdPerMillion: 2.0,
    },
  ] as const;

  const variableCostAndOffloadSensitivity: CostSensitivityReport['variableCostAndOffloadSensitivity'][number][] =
    [];
  for (const mau of [1_000, 10_000] as const) {
    for (const lp of llmProfiles) {
      for (const deviceOffloadRate of [0, 0.5] as const) {
        const res = calculateAdr0006Cost({
          mau,
          allowanceRemainingRatio: 1.0,
          llm: {
            inputUsdPerMillion: lp.inputUsdPerMillion,
            outputUsdPerMillion: lp.outputUsdPerMillion,
          },
          sandbox: { deviceOffloadRate },
        });
        variableCostAndOffloadSensitivity.push({
          mau,
          llmProfile: lp.name,
          deviceOffloadRate,
          cloudRuntimeUsd: res.cloudRuntime.totalUsd,
          llmCostUsd: res.variableExecution.llmCostUsd,
          sandboxNetUsd: res.variableExecution.sandboxNetAfterOffloadUsd,
          totalCombinedUsd: res.combinedMonthlyUsd,
        });
      }
    }
  }

  return {
    scenarioId: 'ember-v2-m0-cost-model',
    evidenceKind: 'estimated_adr0006',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    adr0006ReferenceMatrix,
    doWriteRowsSensitivity,
    doDurationSensitivity,
    streamingCpuSensitivity,
    storageGrowthProjection,
    independentRecoverySensitivity,
    variableCostAndOffloadSensitivity,
  };
}
