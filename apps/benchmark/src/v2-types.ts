import type { LatencyDistribution, MachineSpecs } from './types.js';

/**
 * Strict provenance classification required by ADR-0006 and V2-M0-D guardrails.
 * Never conflate local measurements, synthetic simulations, and cloud billing projections.
 */
export type EvidenceSourceKind =
  'measured_local_pg' | 'measured_local_workerd' | 'simulated_synthetic' | 'estimated_adr0006';

export interface M1MeasurementGap {
  readonly scope: string;
  readonly implementedInM0Probe: readonly string[];
  readonly missingInM0Probe: readonly string[];
  readonly requiredInM1AndM4: readonly string[];
  readonly provisionalTargetsNotice: string;
}

export interface EndpointLatencySummary {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly concurrency: number;
  readonly sampleCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly throughputReqPerSec: number;
  readonly latency: LatencyDistribution;
}

export interface PostgresTableStatDelta {
  readonly tableName: string;
  readonly inserts: number;
  readonly updates: number;
  readonly deletes: number;
  readonly totalMutations: number;
  readonly liveRowsAfter: number;
  readonly totalBytesAfter: number;
}

export interface V1BaselineWorkloadStats {
  readonly workloadName: string;
  readonly concurrency: number;
  readonly sampleCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly exactTableRowDeltas: Readonly<Record<string, number>>;
  readonly exactNetRowsInserted: number;
  readonly exactNetRowsPerOperation: number;
  readonly pgStatTupleMutations: number;
  readonly pgStatMutationsPerOperation: number;
  readonly pgStatAttributionComplete: boolean;
  readonly pgStatAttributionNote: string;
  readonly totalSchemaBytesAfter: number;
  readonly peakActiveConnections: number;
  readonly peakTotalConnections: number;
  readonly peakRssMb: number;
  readonly tables: readonly PostgresTableStatDelta[];
}

export interface V1BaselineReport {
  readonly scenarioId: 'ember-v2-m0-v1-baseline';
  readonly evidenceKind: 'measured_local_pg';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly machine: MachineSpecs;
  readonly conversationBenchmarks: readonly EndpointLatencySummary[];
  readonly taskBenchmarks: readonly EndpointLatencySummary[];
  readonly statusReadBenchmarks: readonly EndpointLatencySummary[];
  readonly concurrencySweep: readonly {
    readonly concurrency: number;
    readonly chatSampleCount: number;
    readonly chatSuccessCount: number;
    readonly chatAckP50Ms: number;
    readonly chatAckP95Ms: number;
    readonly chatCompletionP50Ms: number;
    readonly chatCompletionP95Ms: number;
    readonly taskSampleCount: number;
    readonly taskSuccessCount: number;
    readonly taskAckP50Ms: number;
    readonly taskAckP95Ms: number;
    readonly taskCompletionP50Ms: number;
    readonly taskCompletionP95Ms: number;
    readonly statusReadP95Ms: number;
    readonly chatThroughputPerSec: number;
    readonly taskThroughputPerSec: number;
  }[];
  readonly dbMutationStats: readonly V1BaselineWorkloadStats[];
  readonly notes: readonly string[];
}

export interface SqlOperationProbeMetrics {
  readonly engine: 'do_sqlite' | 'd1_local' | 'global_budget_do';
  readonly operation: string;
  readonly iterations: number;
  readonly logicalStatementsPerOp: number;
  readonly logicalMutationsPerOp: number;
  readonly observedRowsReadMean: number;
  readonly observedRowsReadP95: number;
  readonly observedRowsWrittenMean: number;
  readonly observedRowsWrittenP95: number;
  readonly setAlarmCallsPerOp: number;
  readonly latencyMs: LatencyDistribution;
  readonly sqlDurationMs?: LatencyDistribution;
  readonly dbSizeBeforeBytes: number;
  readonly dbSizeAfterBytes: number;
  readonly storageDeltaBytesTotal: number;
  readonly storageDeltaBytesPerOp: number;
}

export interface StorageGrowthPoint {
  readonly turnCount: number;
  readonly doSqliteBytes: number;
  readonly d1Bytes: number;
}

export interface SqliteProbeReport {
  readonly scenarioId: 'ember-v2-m0-sqlite-d1-probe';
  readonly evidenceKind: 'measured_local_workerd';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly wranglerVersion: string;
  readonly probeIterations: number;
  readonly operations: readonly SqlOperationProbeMetrics[];
  readonly comparisonSummary: readonly {
    readonly operation: string;
    readonly doRowsReadMean: number;
    readonly doRowsWrittenMean: number;
    readonly doLatencyP50Ms: number;
    readonly doLatencyP95Ms: number;
    readonly d1RowsReadMean: number;
    readonly d1RowsWrittenMean: number;
    readonly d1LatencyP50Ms: number;
    readonly d1LatencyP95Ms: number;
    readonly doSetAlarmCalls: number;
  }[];
  readonly jointAbSeamOps: readonly {
    readonly engine: 'do_sqlite' | 'd1_local' | 'global_budget_do';
    readonly operation: string;
    readonly rowsReadMean: number;
    readonly rowsWrittenMean: number;
    readonly setAlarmCallsPerOp: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
  }[];
  readonly alarmRealFireVerified: boolean;
  readonly alarmRealFireDelayMs: number | null;
  readonly storageGrowth: {
    readonly points: readonly StorageGrowthPoint[];
    readonly doStartingBytes: number;
    readonly doNetBytesPerTurn: number;
    readonly d1StartingBytes: number;
    readonly d1NetBytesPerTurn: number;
  };
  readonly m1MeasurementGap: M1MeasurementGap;
  readonly caveats: readonly string[];
}

export interface StreamingCpuSample {
  readonly label: string;
  readonly chunkCount: number;
  readonly chunkBytes: number;
  readonly simulatedTokenDelayMs: number;
  readonly iterations: number;
  readonly wallMs: LatencyDistribution;
  readonly activeCpuMs: LatencyDistribution;
  readonly waitWallRatioPercent: number;
}

export interface BudgetCheckTimingResult {
  readonly targetAuthority: 'd1_control_row' | 'global_budget_do';
  readonly mode: 'sequential_warm' | 'concurrent_contention' | 'exhaustion_fail_closed';
  readonly concurrency: number;
  readonly sampleCount: number;
  readonly approvedCount: number;
  readonly deniedExpectedCount: number;
  readonly errorCount: number;
  readonly overCommitted: boolean;
  readonly latencyMs: LatencyDistribution;
}

export interface TimingMethodologyReport {
  readonly scenarioId: 'ember-v2-m0-timing-methodology';
  readonly evidenceKind: 'measured_local_workerd' | 'simulated_synthetic';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly definitions: readonly {
    readonly metric: 'ack' | 'runtime_overhead' | 'streaming_cpu' | 'global_budget_check';
    readonly formula: string;
    readonly targetDescription: string;
    readonly includesModelIo: boolean;
  }[];
  readonly simplified2RpcMicrobenchmark: {
    readonly evidenceKind: 'measured_local_workerd';
    readonly label: string;
    readonly sampleCount: number;
    readonly successCount: number;
    readonly errorCount: number;
    readonly ackMs: LatencyDistribution;
    readonly d1CounterUpdateMs: LatencyDistribution;
    readonly doPrepareMs: LatencyDistribution;
    readonly doCommitMs: LatencyDistribution;
    readonly runtimeOverheadMs: LatencyDistribution;
  };
  readonly jointAbSeamTiming: {
    readonly evidenceKind: 'measured_local_workerd';
    readonly label: string;
    readonly sampleCount: number;
    readonly successCount: number;
    readonly deniedCount: number;
    readonly errorCount: number;
    readonly ackCoveredMs: LatencyDistribution;
    readonly ackUncoveredMs: LatencyDistribution;
    readonly globalBudgetReserveMs: LatencyDistribution;
    readonly globalBudgetAuthorizeMs: LatencyDistribution;
    readonly doPrepareMs: LatencyDistribution;
    readonly doMarkAttemptSentMs: LatencyDistribution;
    readonly doCommitWithBudgetSyncMs: LatencyDistribution;
    readonly globalBudgetSettleMs: LatencyDistribution;
    readonly d1UncoveredRegisterAndConfirmMs: LatencyDistribution;
    readonly runtimeOverheadCoveredMs: LatencyDistribution;
    readonly runtimeOverheadUncoveredMs: LatencyDistribution;
  };
  readonly streamingCpu: {
    readonly evidenceKind: 'simulated_synthetic';
    readonly runtimeNotice: string;
    readonly samples: readonly StreamingCpuSample[];
  };
  readonly budgetCheckContention: {
    readonly evidenceKind: 'measured_local_workerd';
    readonly results: readonly BudgetCheckTimingResult[];
  };
  readonly m1MeasurementGap: M1MeasurementGap;
}

export interface RegionalRttProfile {
  readonly regionId: string;
  readonly label: string;
  readonly clientToEdgeRttMs: number;
  readonly clientToEdgeJitterMs: number;
  readonly edgeToDoRttMs: number;
  readonly edgeToDoJitterMs: number;
  readonly doToGlobalControlRttMs: number;
  readonly doToGlobalControlJitterMs: number;
}

export type RttArchitectureMode =
  | 'simplified_2_rpc_local_check'
  | 'm0_covered_joint_seam_colocated'
  | 'm0_covered_joint_seam_cross_region_budget'
  | 'm0_uncovered_joint_seam_with_d1_registration';

export interface RegionalRttScenarioResult {
  readonly regionId: string;
  readonly regionLabel: string;
  readonly architectureMode: RttArchitectureMode;
  readonly isApprovedM0Contract: boolean;
  readonly sampleCount: number;
  readonly successCount: number;
  readonly deniedCount: number;
  readonly errorCount: number;
  readonly ackMs: LatencyDistribution;
  readonly runtimeOverheadMs: LatencyDistribution;
  readonly budgetCheckMs: LatencyDistribution;
  readonly withinTargetAck250msP95: boolean;
  readonly withinTargetRuntime200msP95: boolean;
  readonly withinTargetBudget50msP95: boolean;
}

export interface RttSimulationReport {
  readonly scenarioId: 'ember-v2-m0-rtt-simulation';
  readonly evidenceKind: 'simulated_synthetic';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly seed: number;
  readonly profiles: readonly RegionalRttProfile[];
  readonly results: readonly RegionalRttScenarioResult[];
  readonly m1MeasurementGap: M1MeasurementGap;
  readonly caveats: readonly string[];
}

export interface UserWorkloadCohort {
  readonly name: 'light' | 'medium' | 'heavy';
  readonly share: number;
  readonly turnsPerDay: number;
  readonly tasksPerDay: number;
  readonly doDbAvgMb: number;
  readonly r2AvgMb: number;
}

export interface PerEventMeterAssumptions {
  readonly workerRequestsPerEvent: number;
  readonly workerNonStreamCpuMsPerEvent: number;
  readonly workerStreamCpuMsPerEvent: number;
  readonly doRequestsPerEvent: number;
  readonly doBillableDurationSecPerEvent: number;
  readonly doRowsReadPerEvent: number;
  readonly doRowsWrittenPerEvent: number;
  readonly d1RowsReadPerEvent: number;
  readonly d1RowsWrittenPerEvent: number;
  readonly d1StorageMbPerAgent: number;
  readonly queueOpsPerEvent: number;
  readonly r2ClassAPerEvent: number;
  readonly r2ClassBPerEvent: number;
  readonly observabilityBytesPerEvent: number;
  readonly observabilityRetentionDays: number;
}

export interface IndependentRecoveryParams {
  readonly enabled: boolean;
  readonly cronInvocationsPerMonth: number;
  readonly d1WritesPerEvent: number;
  readonly d1ReadsPerEvent: number;
  readonly extraDoRequestsPerRecoveryEvent: number;
  readonly recoveryEventRate: number;
}

export interface StorageGrowthParams {
  readonly monthsElapsed: number;
  readonly initialDoMbPerAgent: number;
  readonly netDoBytesPerEvent: number;
  readonly initialR2MbPerAgent: number;
  readonly netR2BytesPerEvent: number;
  readonly dormantRetainedRatio: number;
  readonly dormantDoMbPerAgent: number;
  readonly dormantR2MbPerAgent: number;
}

export interface LlmCostParams {
  readonly inputTokensPerEvent: number;
  readonly outputTokensPerEvent: number;
  readonly cachedInputShare: number;
  readonly cachedInputDiscount: number;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly retryMultiplier: number;
}

export interface SandboxCostParams {
  readonly eligibleRunsPerUserPerMonth: number;
  readonly avgRunMinutes: number;
  readonly vcpus: number;
  readonly ramGib: number;
  readonly storageGibPerActiveUser: number;
  readonly deviceOffloadRate: number;
}

export interface CostModelInput {
  readonly mau: number;
  readonly daysPerMonth?: number;
  readonly allowanceRemainingRatio?: number;
  readonly otherProductsUsage?: Partial<Record<string, number>>;
  readonly cohorts?: readonly UserWorkloadCohort[];
  readonly perEvent?: Partial<PerEventMeterAssumptions>;
  readonly independentRecovery?: Partial<IndependentRecoveryParams>;
  readonly storageGrowth?: Partial<StorageGrowthParams>;
  readonly llm?: Partial<LlmCostParams>;
  readonly sandbox?: Partial<SandboxCostParams>;
}

export interface MeterBreakdown {
  readonly meter: string;
  readonly unit: string;
  readonly emberUsage: number;
  readonly includedAllowance: number;
  readonly remainingAllowance: number;
  readonly overageRaw: number;
  readonly billableUnits: number;
  readonly ratePerUnitUsd: number;
  readonly roundingRule: 'ceil' | 'prorated';
  readonly costUsd: number;
}

export interface CostModelOutput {
  readonly input: {
    readonly mau: number;
    readonly totalEventsPerMonth: number;
    readonly allowanceRemainingRatio: number;
    readonly weightedDoAvgMb: number;
    readonly weightedR2AvgMb: number;
  };
  readonly cloudRuntime: {
    readonly baseFeeUsd: number;
    readonly meterOverageTotalUsd: number;
    readonly totalUsd: number;
    readonly meters: readonly MeterBreakdown[];
  };
  readonly variableExecution: {
    readonly llmCostUsd: number;
    readonly sandboxGrossCostUsd: number;
    readonly sandboxNetAfterOffloadUsd: number;
    readonly sandboxSavingsUsd: number;
    readonly totalVariableUsd: number;
  };
  readonly combinedMonthlyUsd: number;
  readonly costPerMauUsd: number;
}

export interface CostSensitivityReport {
  readonly scenarioId: 'ember-v2-m0-cost-model';
  readonly evidenceKind: 'estimated_adr0006';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly adr0006ReferenceMatrix: readonly {
    readonly mau: number;
    readonly fullAllowanceUsd: number;
    readonly halfAllowanceUsd: number;
    readonly zeroAllowanceUsd: number;
  }[];
  readonly doWriteRowsSensitivity: readonly {
    readonly mau: number;
    readonly doRowsWrittenPerEvent: number;
    readonly cloudRuntimeUsd: number;
    readonly doWriteOverageUsd: number;
  }[];
  readonly doDurationSensitivity: readonly {
    readonly mau: number;
    readonly doDurationSecPerEvent: number;
    readonly cloudRuntimeUsd: number;
    readonly doDurationOverageUsd: number;
  }[];
  readonly streamingCpuSensitivity: readonly {
    readonly mau: number;
    readonly workerCpuMsPerEvent: number;
    readonly cloudRuntimeUsd: number;
    readonly workerCpuOverageUsd: number;
  }[];
  readonly storageGrowthProjection: readonly {
    readonly mau: number;
    readonly monthsElapsed: number;
    readonly dormantRetainedRatio: number;
    readonly avgDoMbPerActiveAgent: number;
    readonly totalDoStorageGb: number;
    readonly cloudRuntimeUsd: number;
    readonly doStorageOverageUsd: number;
  }[];
  readonly independentRecoverySensitivity: readonly {
    readonly mau: number;
    readonly d1WritesPerEvent: number;
    readonly cloudRuntimeUsd: number;
    readonly incrementalRecoveryUsd: number;
  }[];
  readonly variableCostAndOffloadSensitivity: readonly {
    readonly mau: number;
    readonly llmProfile: string;
    readonly deviceOffloadRate: number;
    readonly cloudRuntimeUsd: number;
    readonly llmCostUsd: number;
    readonly sandboxNetUsd: number;
    readonly totalCombinedUsd: number;
  }[];
}

export interface ModelRoutingCandidateRow {
  readonly routeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly placement: 'cloud' | 'device_local';
  readonly approvalStatus:
    | 'internal_staging_only'
    | 'smoke_expired_internal_staging_only'
    | 'pending_cto_approval'
    | 'research_only';
  readonly approvalDetail: string;
  readonly authorizationEligible: boolean;
  readonly rateProvenance:
    | 'official_price_verified'
    | 'invoice_verified'
    | 'unverified'
    | 'illustrative'
    | 'zero_egress_local';
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly simulatedTtftP50Ms: number;
  readonly simulatedTtftP95Ms: number;
  readonly simulatedCompletionP50Ms: number;
  readonly simulatedCompletionP95Ms: number;
  readonly assumedAccuracyPercent: number;
  readonly capabilityEligibleCount: number;
  readonly privacyEligibleCount: number;
  readonly fullyEligibleSuccessRatePercent: number;
  readonly retryRatePercent: number;
  readonly avgInputTokensPerTask: number;
  readonly avgOutputTokensPerTask: number;
  readonly conservativeReservedMicroUsd: number;
  readonly costPerSuccessfulTaskUsd: number | null;
  readonly capabilities: {
    readonly toolCalling: boolean;
    readonly strictJson: boolean;
    readonly visionInput: boolean;
    readonly reasoningEffort: string;
  };
  readonly privacy: {
    readonly zdr: boolean;
    readonly dataCollectionDeny: boolean;
    readonly localOnly: boolean;
    readonly summary: string;
  };
}

export interface ModelRoutingMatrixReport {
  readonly scenarioId: 'ember-v2-m0-model-routing';
  readonly evidenceKind: 'simulated_synthetic';
  readonly gitSha: string;
  readonly timestamp: string;
  readonly evaluationDateUtc: string;
  readonly evalCaseCount: number;
  readonly candidates: readonly ModelRoutingCandidateRow[];
  readonly routingPolicySummary: readonly {
    readonly workloadClass: string;
    readonly primaryRouteId: string;
    readonly fallbackRouteId: string | null;
    readonly authorizationScope: string;
    readonly rationale: string;
  }[];
  readonly caveats: readonly string[];
}
