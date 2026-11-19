import {
  APPROVED_REAL_MODELS,
  estimateCostMicroUsd,
  estimateTokensConservative,
  evaluateApproval,
  findRateRow,
  isPastShutdown,
  MODEL_LIMITS,
  MODEL_RATE_ROWS,
  PENDING_MODEL_CANDIDATES,
  serializationOverheadTokens,
  utcDay,
  type ModelRateRow,
} from '../../../packages/model-gateway/src/index.js';
import { resolveBenchmarkGitSha } from './evidence.js';
import type { ModelRoutingCandidateRow, ModelRoutingMatrixReport } from './v2-types.js';

interface EvalCaseSpec {
  readonly id: string;
  readonly category:
    'simple_chat' | 'json_extraction' | 'tool_use' | 'vision_multimodal' | 'private_local';
  readonly promptText: string;
  readonly expectedOutputTokens: number;
  readonly requiresTools: boolean;
  readonly requiresVision: boolean;
  readonly privacySensitive: boolean;
}

const SYNTHETIC_EVAL_CASES: readonly EvalCaseSpec[] = Object.freeze([
  {
    id: 'eval-chat-1',
    category: 'simple_chat',
    promptText: 'Summarize my morning calendar priorities in three short bullets.',
    expectedOutputTokens: 120,
    requiresTools: false,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-chat-2',
    category: 'simple_chat',
    promptText: 'Draft a concise polite follow-up note confirming tomorrow 10am.',
    expectedOutputTokens: 140,
    requiresTools: false,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-json-1',
    category: 'json_extraction',
    promptText: 'Extract structured action items (title, due_at, owner) from these meeting notes.',
    expectedOutputTokens: 280,
    requiresTools: false,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-json-2',
    category: 'json_extraction',
    promptText: 'Parse invoice metadata into strict JSON schema without prose.',
    expectedOutputTokens: 220,
    requiresTools: false,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-tool-1',
    category: 'tool_use',
    promptText:
      'Route this request to delegate_notes_action_items or run_python_agent with valid arguments.',
    expectedOutputTokens: 190,
    requiresTools: true,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-tool-2',
    category: 'tool_use',
    promptText:
      'Generate and verify a deterministic Python data analysis script over attached CSV columns.',
    expectedOutputTokens: 480,
    requiresTools: true,
    requiresVision: false,
    privacySensitive: false,
  },
  {
    id: 'eval-vision-1',
    category: 'vision_multimodal',
    promptText:
      'Read the whiteboard diagram photo and extract architectural components and open risks.',
    expectedOutputTokens: 320,
    requiresTools: true,
    requiresVision: true,
    privacySensitive: false,
  },
  {
    id: 'eval-private-1',
    category: 'private_local',
    promptText:
      'Summarize private local macOS notes and draft reminders without uploading raw files.',
    expectedOutputTokens: 180,
    requiresTools: false,
    requiresVision: false,
    privacySensitive: true,
  },
]);

interface RouteEvaluationSpec {
  readonly routeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly placement: 'cloud' | 'device_local';
  readonly rateRow: ModelRateRow | null;
  readonly approvalStatus: ModelRoutingCandidateRow['approvalStatus'];
  readonly approvalDetail: string;
  readonly authorizationEligible: boolean;
  readonly rateProvenance: ModelRoutingCandidateRow['rateProvenance'];
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly simulatedTtftP50Ms: number;
  readonly simulatedTtftP95Ms: number;
  readonly simulatedCompletionP50Ms: number;
  readonly simulatedCompletionP95Ms: number;
  readonly assumedAccuracyByCategory: Readonly<Record<EvalCaseSpec['category'], number>>;
  readonly retryRatePercent: number;
  readonly capabilities: ModelRoutingCandidateRow['capabilities'];
  readonly privacy: ModelRoutingCandidateRow['privacy'];
}

function deriveRepoRouteSpec(params: {
  readonly routeId: string;
  readonly providerId: 'openai' | 'openrouter';
  readonly modelId: string;
  readonly now: Date;
  readonly simulatedTtftP50Ms: number;
  readonly simulatedTtftP95Ms: number;
  readonly simulatedCompletionP50Ms: number;
  readonly simulatedCompletionP95Ms: number;
  readonly assumedAccuracyByCategory: Readonly<Record<EvalCaseSpec['category'], number>>;
  readonly retryRatePercent: number;
  readonly capabilities: Omit<ModelRoutingCandidateRow['capabilities'], 'reasoningEffort'>;
}): RouteEvaluationSpec {
  const rateRow = findRateRow(MODEL_RATE_ROWS, params.providerId, params.modelId);
  if (rateRow === null) {
    throw new Error(
      `Missing required MODEL_RATE_ROWS entry for ${params.providerId}/${params.modelId}`,
    );
  }

  const approved = APPROVED_REAL_MODELS.find(
    (m) => m.providerId === params.providerId && m.modelId === params.modelId,
  );
  const pending = PENDING_MODEL_CANDIDATES.find(
    (c) => c.providerId === params.providerId && c.modelId === params.modelId,
  );

  const pastShutdown = isPastShutdown(rateRow, params.now);
  let approvalStatus: ModelRoutingCandidateRow['approvalStatus'] = 'research_only';
  let authorizationEligible = false;
  let approvalDetail = 'Not present in APPROVED_REAL_MODELS';

  if (approved !== undefined) {
    const smokeValidity = evaluateApproval(approved.approval, params.now);
    const stagingValidity =
      approved.stagingAlpha !== undefined
        ? evaluateApproval(approved.stagingAlpha.approval, params.now)
        : 'none';

    if (pastShutdown) {
      approvalStatus = 'research_only';
      authorizationEligible = false;
      approvalDetail = `Snapshot past shutdown date ${rateRow.shutdownDate ?? 'unknown'}`;
    } else if (stagingValidity === 'effective' && smokeValidity !== 'effective') {
      approvalStatus = 'smoke_expired_internal_staging_only';
      authorizationEligible = true;
      approvalDetail = `Smoke grant ${approved.approval.approvalId} (${smokeValidity}); internal stagingAlpha ${approved.stagingAlpha!.approval.approvalId} effective`;
    } else if (smokeValidity === 'effective' && stagingValidity === 'effective') {
      approvalStatus = 'internal_staging_only';
      authorizationEligible = true;
      approvalDetail = `Smoke ${approved.approval.approvalId} and internal stagingAlpha ${approved.stagingAlpha!.approval.approvalId} effective`;
    } else if (smokeValidity === 'effective') {
      approvalStatus = 'internal_staging_only';
      authorizationEligible = true;
      approvalDetail = `Smoke-only grant ${approved.approval.approvalId} effective`;
    } else {
      approvalStatus = 'research_only';
      authorizationEligible = false;
      approvalDetail = `All grants expired/invalid (${smokeValidity})`;
    }
  } else if (pending !== undefined) {
    approvalStatus = 'pending_cto_approval';
    authorizationEligible = false;
    approvalDetail = `Pending CTO approval: ${pending.rationale}`;
  }

  const zdr = approved?.openRouterRouting?.zdr === true;
  const dataCollectionDeny = approved?.openRouterRouting?.dataCollection === 'deny';
  const pinnedProviders = approved?.openRouterRouting?.only.join(',');

  return {
    routeId: params.routeId,
    providerId: rateRow.providerId,
    modelId: rateRow.modelId,
    placement: 'cloud',
    rateRow,
    approvalStatus,
    approvalDetail,
    authorizationEligible,
    rateProvenance: rateRow.provenance,
    inputUsdPerMillion: rateRow.inputMicroUsdPerMillion / 1_000_000,
    outputUsdPerMillion: rateRow.outputMicroUsdPerMillion / 1_000_000,
    simulatedTtftP50Ms: params.simulatedTtftP50Ms,
    simulatedTtftP95Ms: params.simulatedTtftP95Ms,
    simulatedCompletionP50Ms: params.simulatedCompletionP50Ms,
    simulatedCompletionP95Ms: params.simulatedCompletionP95Ms,
    assumedAccuracyByCategory: params.assumedAccuracyByCategory,
    retryRatePercent: params.retryRatePercent,
    capabilities: {
      ...params.capabilities,
      reasoningEffort: rateRow.reasoningEffort ?? 'unspecified',
    },
    privacy: {
      zdr,
      dataCollectionDeny,
      localOnly: false,
      summary:
        zdr && dataCollectionDeny
          ? `OpenRouter pinned [${pinnedProviders ?? 'unknown'}] ZDR (dataCollection=deny)`
          : 'Cloud endpoint without repo-pinned ZDR/dataCollection=deny policy',
    },
  };
}

/**
 * Evaluate the V2 M0 Model Routing Matrix directly from `@ember/model-gateway`
 * rate/approval records, separating assumed accuracy from capability, privacy,
 * and authorization eligibility (zero real LLM calls).
 */
export function runModelRoutingMatrix(now: Date = new Date()): ModelRoutingMatrixReport {
  const specs: readonly RouteEvaluationSpec[] = [
    deriveRepoRouteSpec({
      routeId: 'cloud-fast-zdr-nemotron',
      providerId: 'openrouter',
      modelId: 'nvidia/nemotron-3.5-lightning',
      now,
      simulatedTtftP50Ms: 420,
      simulatedTtftP95Ms: 950,
      simulatedCompletionP50Ms: 1_350,
      simulatedCompletionP95Ms: 2_600,
      assumedAccuracyByCategory: {
        simple_chat: 0.94,
        json_extraction: 0.86,
        tool_use: 0.78,
        vision_multimodal: 0.0,
        private_local: 0.0,
      },
      retryRatePercent: 4.5,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: false,
      },
    }),
    deriveRepoRouteSpec({
      routeId: 'cloud-vision-tools-deepseek',
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4.1-flash-1017',
      now,
      simulatedTtftP50Ms: 580,
      simulatedTtftP95Ms: 1_350,
      simulatedCompletionP50Ms: 2_100,
      simulatedCompletionP95Ms: 4_100,
      assumedAccuracyByCategory: {
        simple_chat: 0.96,
        json_extraction: 0.93,
        tool_use: 0.91,
        vision_multimodal: 0.89,
        private_local: 0.0,
      },
      retryRatePercent: 3.0,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: true,
      },
    }),
    deriveRepoRouteSpec({
      routeId: 'cloud-reasoning-gpt56-luna',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      now,
      simulatedTtftP50Ms: 650,
      simulatedTtftP95Ms: 1_500,
      simulatedCompletionP50Ms: 2_400,
      simulatedCompletionP95Ms: 4_800,
      assumedAccuracyByCategory: {
        simple_chat: 0.98,
        json_extraction: 0.97,
        tool_use: 0.96,
        vision_multimodal: 0.93,
        private_local: 0.0,
      },
      retryRatePercent: 1.5,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: true,
      },
    }),
    {
      routeId: 'cloud-adr0006-illustrative',
      providerId: 'illustrative-provider',
      modelId: 'adr0006-budget-reference-model',
      placement: 'cloud',
      rateRow: {
        providerId: 'openai',
        modelId: 'adr0006-budget-reference-model',
        inputMicroUsdPerMillion: 500_000,
        outputMicroUsdPerMillion: 2_000_000,
        rateVersion: 'adr0006-illustrative',
        provenance: 'unverified',
        source: 'ADR-0006 illustrative unit-economics quote',
      },
      approvalStatus: 'research_only',
      approvalDetail: 'Illustrative cost benchmark quote from ADR-0006; not a real model pin',
      authorizationEligible: false,
      rateProvenance: 'illustrative',
      inputUsdPerMillion: 0.5,
      outputUsdPerMillion: 2.0,
      simulatedTtftP50Ms: 750,
      simulatedTtftP95Ms: 1_800,
      simulatedCompletionP50Ms: 2_800,
      simulatedCompletionP95Ms: 5_500,
      assumedAccuracyByCategory: {
        simple_chat: 0.97,
        json_extraction: 0.95,
        tool_use: 0.94,
        vision_multimodal: 0.92,
        private_local: 0.0,
      },
      retryRatePercent: 2.0,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: true,
        reasoningEffort: 'medium',
      },
      privacy: {
        zdr: false,
        dataCollectionDeny: false,
        localOnly: false,
        summary: 'Illustrative cloud quote only (no ZDR or approval)',
      },
    },
    {
      routeId: 'device-local-mlx-small',
      providerId: 'apple-device-local',
      modelId: 'local-4bit-instruct-research',
      placement: 'device_local',
      rateRow: null,
      approvalStatus: 'research_only',
      approvalDetail:
        'M2+ on-device research profile; requires device runtime implementation & quality gate',
      authorizationEligible: false,
      rateProvenance: 'zero_egress_local',
      inputUsdPerMillion: 0.0,
      outputUsdPerMillion: 0.0,
      simulatedTtftP50Ms: 180,
      simulatedTtftP95Ms: 420,
      simulatedCompletionP50Ms: 1_100,
      simulatedCompletionP95Ms: 2_400,
      assumedAccuracyByCategory: {
        simple_chat: 0.85,
        json_extraction: 0.74,
        tool_use: 0.0,
        vision_multimodal: 0.0,
        private_local: 0.89,
      },
      retryRatePercent: 8.0,
      capabilities: {
        toolCalling: false,
        strictJson: false,
        visionInput: false,
        reasoningEffort: 'none',
      },
      privacy: {
        zdr: true,
        dataCollectionDeny: true,
        localOnly: true,
        summary: 'On-device CPU/GPU/NPU execution; zero raw prompt egress to cloud',
      },
    },
  ];

  const contextHistoryTokens = 2_400;
  const fixedSystemTokens =
    Math.ceil(MODEL_LIMITS.systemPromptChars / MODEL_LIMITS.asciiCharsPerToken) +
    serializationOverheadTokens();

  const candidates: ModelRoutingCandidateRow[] = specs.map((spec) => {
    let eligibleAccuracySum = 0;
    let capabilityEligibleCount = 0;
    let privacyEligibleCount = 0;
    let fullyEligibleCount = 0;
    let successCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReservedMicroUsd = 0;

    for (const evalCase of SYNTHETIC_EVAL_CASES) {
      const promptTokens = estimateTokensConservative(evalCase.promptText);
      const caseInputTokens = fixedSystemTokens + contextHistoryTokens + promptTokens;
      const caseOutputTokens = evalCase.expectedOutputTokens;

      const capabilityOk =
        (!evalCase.requiresVision || spec.capabilities.visionInput) &&
        (!evalCase.requiresTools || spec.capabilities.toolCalling);
      // Restrict private inputs to local-only processing absent explicit consent
      const privacyOk = !evalCase.privacySensitive || spec.privacy.localOnly;

      if (capabilityOk) capabilityEligibleCount += 1;
      if (privacyOk) privacyEligibleCount += 1;

      const eligible = capabilityOk && privacyOk;
      if (eligible) {
        fullyEligibleCount += 1;
        const acc = spec.assumedAccuracyByCategory[evalCase.category];
        eligibleAccuracySum += acc;
        if (acc >= 0.75) {
          successCount += 1;
        }
      }

      totalInputTokens += caseInputTokens;
      totalOutputTokens += caseOutputTokens;

      if (spec.rateRow !== null) {
        totalReservedMicroUsd += estimateCostMicroUsd(
          spec.rateRow,
          caseInputTokens,
          MODEL_LIMITS.maxOutputTokens,
        );
      }
    }

    const n = SYNTHETIC_EVAL_CASES.length;
    const avgInputTokensPerTask = Math.round(totalInputTokens / n);
    const avgOutputTokensPerTask = Math.round(totalOutputTokens / n);
    const assumedAccuracyPercent =
      fullyEligibleCount > 0
        ? Number(((eligibleAccuracySum / fullyEligibleCount) * 100).toFixed(1))
        : 0;
    const fullyEligibleSuccessRatePercent = Number(((successCount / n) * 100).toFixed(1));

    let costPerSuccessfulTaskUsd: number | null = null;
    if (spec.inputUsdPerMillion === 0 && spec.outputUsdPerMillion === 0) {
      costPerSuccessfulTaskUsd = 0;
    } else if (successCount > 0) {
      const baseCostPerAttemptUsd =
        (avgInputTokensPerTask / 1_000_000) * spec.inputUsdPerMillion +
        (avgOutputTokensPerTask / 1_000_000) * spec.outputUsdPerMillion;
      const retryFactor = 1 + spec.retryRatePercent / 100;
      const successFraction = successCount / n;
      costPerSuccessfulTaskUsd = Number(
        ((baseCostPerAttemptUsd * retryFactor) / successFraction).toFixed(6),
      );
    }

    return {
      routeId: spec.routeId,
      providerId: spec.providerId,
      modelId: spec.modelId,
      placement: spec.placement,
      approvalStatus: spec.approvalStatus,
      approvalDetail: spec.approvalDetail,
      authorizationEligible: spec.authorizationEligible,
      rateProvenance: spec.rateProvenance,
      inputUsdPerMillion: spec.inputUsdPerMillion,
      outputUsdPerMillion: spec.outputUsdPerMillion,
      simulatedTtftP50Ms: spec.simulatedTtftP50Ms,
      simulatedTtftP95Ms: spec.simulatedTtftP95Ms,
      simulatedCompletionP50Ms: spec.simulatedCompletionP50Ms,
      simulatedCompletionP95Ms: spec.simulatedCompletionP95Ms,
      assumedAccuracyPercent,
      capabilityEligibleCount,
      privacyEligibleCount,
      fullyEligibleSuccessRatePercent,
      retryRatePercent: spec.retryRatePercent,
      avgInputTokensPerTask,
      avgOutputTokensPerTask,
      conservativeReservedMicroUsd: Math.round(totalReservedMicroUsd / n),
      costPerSuccessfulTaskUsd,
      capabilities: spec.capabilities,
      privacy: spec.privacy,
    };
  });

  const nemotronEligible = candidates.find((c) => c.routeId === 'cloud-fast-zdr-nemotron')!;
  const deepseekEligible = candidates.find((c) => c.routeId === 'cloud-vision-tools-deepseek')!;

  return {
    scenarioId: 'ember-v2-m0-model-routing',
    evidenceKind: 'simulated_synthetic',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    evaluationDateUtc: utcDay(now),
    evalCaseCount: SYNTHETIC_EVAL_CASES.length,
    candidates,
    routingPolicySummary: [
      {
        workloadClass: 'simple_low_latency_chat',
        primaryRouteId: nemotronEligible.routeId,
        fallbackRouteId: deepseekEligible.authorizationEligible ? deepseekEligible.routeId : null,
        authorizationScope: nemotronEligible.approvalStatus,
        rationale:
          'Lowest repo-verified ZDR rate ($0.06/$0.16 per 1M, reasoningEffort=none); authorized for internal stagingAlpha only (smoke grant expired).',
      },
      {
        workloadClass: 'tool_calling_and_multimodal',
        primaryRouteId: deepseekEligible.routeId,
        fallbackRouteId: null,
        authorizationScope: deepseekEligible.approvalStatus,
        rationale:
          'Supports image input + tools + tool_choice on pinned DeepInfra fp8 ZDR ($0.098/$0.294 per 1M); no pending/unapproved fallback emitted.',
      },
      {
        workloadClass: 'privacy_sensitive_local_only',
        primaryRouteId: 'device-local-mlx-small',
        fallbackRouteId: null,
        authorizationScope: 'research_only_requires_device_m2_and_user_consent',
        rationale:
          'Private local inputs remain restricted to approved local-only processing absent explicit user/policy cloud consent.',
      },
      {
        workloadClass: 'complex_high_accuracy_reasoning',
        primaryRouteId: deepseekEligible.routeId,
        fallbackRouteId: null,
        authorizationScope: deepseekEligible.approvalStatus,
        rationale:
          'Pending candidate gpt-5.6-luna is NOT authorization-eligible and is excluded from operational fallbacks until CTO approval + ZDR review.',
      },
    ],
    caveats: [
      'NO live LLM API calls were made. Latency, assumedAccuracyPercent, and retryRatePercent are synthetic M0 profiles; real quality/latency require separately approved M4 provider canaries.',
      'Rates, rateProvenance, reasoningEffort, ZDR settings, and approvalStatus are derived directly from @ember/model-gateway at evaluationDateUtc.',
      'Hypothetical synthetic scores never constitute live routing authorization; unavailable/pending models are research-only and excluded from operational fallbacks.',
      'Privacy-sensitive benchmark tasks are scored ineligible (0) on cloud routes absent explicit user consent.',
    ],
  };
}
