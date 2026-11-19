import {
  APPROVED_REAL_MODELS,
  estimateCostMicroUsd,
  estimateTokensConservative,
  findRateRow,
  MODEL_LIMITS,
  MODEL_RATE_ROWS,
  PENDING_MODEL_CANDIDATES,
  serializationOverheadTokens,
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

interface RouteSimulationProfile {
  readonly routeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly placement: 'cloud' | 'device_local';
  readonly approvalStatus: ModelRoutingCandidateRow['approvalStatus'];
  readonly rateProvenance: ModelRoutingCandidateRow['rateProvenance'];
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly simulatedTtftP50Ms: number;
  readonly simulatedTtftP95Ms: number;
  readonly simulatedCompletionP50Ms: number;
  readonly simulatedCompletionP95Ms: number;
  readonly baseAccuracyByCategory: Readonly<Record<EvalCaseSpec['category'], number>>;
  readonly retryRatePercent: number;
  readonly capabilities: ModelRoutingCandidateRow['capabilities'];
  readonly privacy: ModelRoutingCandidateRow['privacy'];
}

function resolveRepoRates(
  providerId: 'openai' | 'openrouter',
  modelId: string,
  fallbackIn: number,
  fallbackOut: number,
): { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number } {
  const row = findRateRow(MODEL_RATE_ROWS, providerId, modelId);
  if (row === null) {
    return { inputUsdPerMillion: fallbackIn, outputUsdPerMillion: fallbackOut };
  }
  return {
    inputUsdPerMillion: row.inputMicroUsdPerMillion / 1_000_000,
    outputUsdPerMillion: row.outputMicroUsdPerMillion / 1_000_000,
  };
}

/**
 * Evaluate the V2 M0 Model Routing Matrix using verified repository rate rows,
 * conservative token estimation (`@ember/model-gateway`), and deterministic
 * offline simulation profiles (zero real LLM calls).
 */
export function runModelRoutingMatrix(): ModelRoutingMatrixReport {
  const nemotronApproved = APPROVED_REAL_MODELS.find(
    (m) => m.modelId === 'nvidia/nemotron-3.5-lightning',
  );
  const deepseekApproved = APPROVED_REAL_MODELS.find(
    (m) => m.modelId === 'deepseek/deepseek-v4.1-flash-1017',
  );
  const lunaCandidate = PENDING_MODEL_CANDIDATES.find((c) => c.modelId === 'gpt-5.6-luna');

  const nemotronRates = resolveRepoRates('openrouter', 'nvidia/nemotron-3.5-lightning', 0.06, 0.16);
  const deepseekRates = resolveRepoRates(
    'openrouter',
    'deepseek/deepseek-v4.1-flash-1017',
    0.098,
    0.294,
  );
  const lunaRates = resolveRepoRates('openai', 'gpt-5.6-luna', 0.2, 1.2);

  const profiles: readonly RouteSimulationProfile[] = [
    {
      routeId: 'cloud-fast-zdr-nemotron',
      providerId: nemotronApproved?.providerId ?? 'openrouter',
      modelId: nemotronApproved?.modelId ?? 'nvidia/nemotron-3.5-lightning',
      placement: 'cloud',
      approvalStatus: 'approved_smoke_staging',
      rateProvenance: 'official_price_verified',
      inputUsdPerMillion: nemotronRates.inputUsdPerMillion,
      outputUsdPerMillion: nemotronRates.outputUsdPerMillion,
      simulatedTtftP50Ms: 420,
      simulatedTtftP95Ms: 950,
      simulatedCompletionP50Ms: 1_350,
      simulatedCompletionP95Ms: 2_600,
      baseAccuracyByCategory: {
        simple_chat: 0.94,
        json_extraction: 0.86,
        tool_use: 0.78,
        vision_multimodal: 0.0,
        private_local: 0.92,
      },
      retryRatePercent: 4.5,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: false,
        reasoningEffort: 'none',
      },
      privacy: {
        zdr: nemotronApproved?.openRouterRouting?.zdr ?? true,
        dataCollectionDeny: nemotronApproved?.openRouterRouting?.dataCollection === 'deny',
        localOnly: false,
        summary: 'OpenRouter pinned DeepInfra ZDR (dataCollection=deny)',
      },
    },
    {
      routeId: 'cloud-vision-tools-deepseek',
      providerId: deepseekApproved?.providerId ?? 'openrouter',
      modelId: deepseekApproved?.modelId ?? 'deepseek/deepseek-v4.1-flash-1017',
      placement: 'cloud',
      approvalStatus: 'approved_smoke_staging',
      rateProvenance: 'official_price_verified',
      inputUsdPerMillion: deepseekRates.inputUsdPerMillion,
      outputUsdPerMillion: deepseekRates.outputUsdPerMillion,
      simulatedTtftP50Ms: 580,
      simulatedTtftP95Ms: 1_350,
      simulatedCompletionP50Ms: 2_100,
      simulatedCompletionP95Ms: 4_100,
      baseAccuracyByCategory: {
        simple_chat: 0.96,
        json_extraction: 0.93,
        tool_use: 0.91,
        vision_multimodal: 0.89,
        private_local: 0.94,
      },
      retryRatePercent: 3.0,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: true,
        reasoningEffort: 'none',
      },
      privacy: {
        zdr: deepseekApproved?.openRouterRouting?.zdr ?? true,
        dataCollectionDeny: deepseekApproved?.openRouterRouting?.dataCollection === 'deny',
        localOnly: false,
        summary: 'OpenRouter pinned DeepInfra fp8 ZDR (vision + tools, dataCollection=deny)',
      },
    },
    {
      routeId: 'cloud-reasoning-gpt56-luna',
      providerId: lunaCandidate?.providerId ?? 'openai',
      modelId: lunaCandidate?.modelId ?? 'gpt-5.6-luna',
      placement: 'cloud',
      approvalStatus: 'pending_cto_approval',
      rateProvenance: 'unverified',
      inputUsdPerMillion: lunaRates.inputUsdPerMillion,
      outputUsdPerMillion: lunaRates.outputUsdPerMillion,
      simulatedTtftP50Ms: 650,
      simulatedTtftP95Ms: 1_500,
      simulatedCompletionP50Ms: 2_400,
      simulatedCompletionP95Ms: 4_800,
      baseAccuracyByCategory: {
        simple_chat: 0.98,
        json_extraction: 0.97,
        tool_use: 0.96,
        vision_multimodal: 0.93,
        private_local: 0.96,
      },
      retryRatePercent: 1.5,
      capabilities: {
        toolCalling: true,
        strictJson: true,
        visionInput: true,
        reasoningEffort: 'none',
      },
      privacy: {
        zdr: false,
        dataCollectionDeny: false,
        localOnly: false,
        summary: 'Direct OpenAI candidate (pending CTO approval & privacy/ZDR review)',
      },
    },
    {
      routeId: 'cloud-adr0006-illustrative',
      providerId: 'illustrative-provider',
      modelId: 'adr0006-budget-reference-model',
      placement: 'cloud',
      approvalStatus: 'research_profile',
      rateProvenance: 'illustrative',
      inputUsdPerMillion: 0.5,
      outputUsdPerMillion: 2.0,
      simulatedTtftP50Ms: 750,
      simulatedTtftP95Ms: 1_800,
      simulatedCompletionP50Ms: 2_800,
      simulatedCompletionP95Ms: 5_500,
      baseAccuracyByCategory: {
        simple_chat: 0.97,
        json_extraction: 0.95,
        tool_use: 0.94,
        vision_multimodal: 0.92,
        private_local: 0.95,
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
        summary: 'ADR-0006 cost envelope illustrative pricing ($0.50/$2.00 per 1M)',
      },
    },
    {
      routeId: 'device-local-mlx-small',
      providerId: 'apple-device-local',
      modelId: 'local-4bit-instruct-research',
      placement: 'device_local',
      approvalStatus: 'research_profile',
      rateProvenance: 'zero_egress_local',
      inputUsdPerMillion: 0.0,
      outputUsdPerMillion: 0.0,
      simulatedTtftP50Ms: 180,
      simulatedTtftP95Ms: 420,
      simulatedCompletionP50Ms: 1_100,
      simulatedCompletionP95Ms: 2_400,
      baseAccuracyByCategory: {
        simple_chat: 0.85,
        json_extraction: 0.74,
        tool_use: 0.58,
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

  // Assume realistic bounded context window + system prompt per ADR-0006 / MODEL_LIMITS
  const contextHistoryTokens = 2_400;
  const fixedSystemTokens =
    Math.ceil(MODEL_LIMITS.systemPromptChars / MODEL_LIMITS.asciiCharsPerToken) +
    serializationOverheadTokens();

  const candidates: ModelRoutingCandidateRow[] = profiles.map((profile) => {
    let accuracySum = 0;
    let successCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReservedMicroUsd = 0;

    for (const evalCase of SYNTHETIC_EVAL_CASES) {
      const promptTokens = estimateTokensConservative(evalCase.promptText);
      const caseInputTokens = fixedSystemTokens + contextHistoryTokens + promptTokens;
      const caseOutputTokens = evalCase.expectedOutputTokens;

      const capabilityBlocked =
        (evalCase.requiresVision && !profile.capabilities.visionInput) ||
        (evalCase.requiresTools && !profile.capabilities.toolCalling);

      const acc = capabilityBlocked ? 0 : profile.baseAccuracyByCategory[evalCase.category];
      accuracySum += acc;
      if (acc >= 0.75) {
        successCount += 1;
      }

      totalInputTokens += caseInputTokens;
      totalOutputTokens += caseOutputTokens;

      if (profile.inputUsdPerMillion > 0 || profile.outputUsdPerMillion > 0) {
        const syntheticRateRow: ModelRateRow = {
          providerId: profile.providerId === 'openai' ? 'openai' : 'openrouter',
          modelId: profile.modelId,
          inputMicroUsdPerMillion: Math.round(profile.inputUsdPerMillion * 1_000_000),
          outputMicroUsdPerMillion: Math.round(profile.outputUsdPerMillion * 1_000_000),
          rateVersion: 'v2-m0-eval',
          provenance: 'unverified',
          source: 'v2-m0-eval',
        };
        totalReservedMicroUsd += estimateCostMicroUsd(
          syntheticRateRow,
          caseInputTokens,
          MODEL_LIMITS.maxOutputTokens,
        );
      }
    }

    const n = SYNTHETIC_EVAL_CASES.length;
    const avgInputTokensPerTask = Math.round(totalInputTokens / n);
    const avgOutputTokensPerTask = Math.round(totalOutputTokens / n);
    const accuracyPercent = Number(((accuracySum / n) * 100).toFixed(1));
    const taskSuccessRatePercent = Number(((successCount / n) * 100).toFixed(1));

    const baseCostPerAttemptUsd =
      (avgInputTokensPerTask / 1_000_000) * profile.inputUsdPerMillion +
      (avgOutputTokensPerTask / 1_000_000) * profile.outputUsdPerMillion;
    const retryFactor = 1 + profile.retryRatePercent / 100;
    const successFraction = Math.max(0.01, taskSuccessRatePercent / 100);
    const costPerSuccessfulTaskUsd = Number(
      ((baseCostPerAttemptUsd * retryFactor) / successFraction).toFixed(6),
    );

    return {
      routeId: profile.routeId,
      providerId: profile.providerId,
      modelId: profile.modelId,
      placement: profile.placement,
      approvalStatus: profile.approvalStatus,
      rateProvenance: profile.rateProvenance,
      inputUsdPerMillion: profile.inputUsdPerMillion,
      outputUsdPerMillion: profile.outputUsdPerMillion,
      simulatedTtftP50Ms: profile.simulatedTtftP50Ms,
      simulatedTtftP95Ms: profile.simulatedTtftP95Ms,
      simulatedCompletionP50Ms: profile.simulatedCompletionP50Ms,
      simulatedCompletionP95Ms: profile.simulatedCompletionP95Ms,
      accuracyPercent,
      taskSuccessRatePercent,
      retryRatePercent: profile.retryRatePercent,
      avgInputTokensPerTask,
      avgOutputTokensPerTask,
      conservativeReservedMicroUsd: Math.round(totalReservedMicroUsd / n),
      costPerSuccessfulTaskUsd,
      capabilities: profile.capabilities,
      privacy: profile.privacy,
    };
  });

  return {
    scenarioId: 'ember-v2-m0-model-routing',
    evidenceKind: 'simulated_synthetic',
    gitSha: resolveBenchmarkGitSha(),
    timestamp: new Date().toISOString(),
    evalCaseCount: SYNTHETIC_EVAL_CASES.length,
    candidates,
    routingPolicySummary: [
      {
        workloadClass: 'simple_low_latency_chat',
        primaryRouteId: 'cloud-fast-zdr-nemotron',
        fallbackRouteId: 'cloud-vision-tools-deepseek',
        rationale:
          'Lowest verified ZDR cost ($0.06/$0.16 per 1M), reasoningEffort=none, fast simulated TTFT.',
      },
      {
        workloadClass: 'tool_calling_and_multimodal',
        primaryRouteId: 'cloud-vision-tools-deepseek',
        fallbackRouteId: 'cloud-reasoning-gpt56-luna',
        rationale:
          'Supports image input + tools + tool_choice on pinned DeepInfra fp8 ZDR endpoint ($0.098/$0.294 per 1M).',
      },
      {
        workloadClass: 'privacy_sensitive_or_offline_device',
        primaryRouteId: 'device-local-mlx-small',
        fallbackRouteId: 'cloud-fast-zdr-nemotron',
        rationale:
          'Zero cloud egress for authorized Mac/iPhone local execution; fallback to cloud ZDR only with user/policy authorization.',
      },
      {
        workloadClass: 'complex_high_accuracy_reasoning',
        primaryRouteId: 'cloud-vision-tools-deepseek',
        fallbackRouteId: 'cloud-reasoning-gpt56-luna',
        rationale:
          'Use approved ZDR DeepSeek until gpt-5.6-luna receives explicit CTO approval and ZDR/privacy signoff.',
      },
    ],
    caveats: [
      'NO live LLM API calls were made. Latency, accuracy, and retry rates are deterministic M0 evaluation profiles.',
      'Token pricing uses verified MODEL_RATE_ROWS from @ember/model-gateway where marked official_price_verified.',
      'M4 rollout requires live provider canary measurements per ADR-0006 before revising budgets or model pins.',
    ],
  };
}
