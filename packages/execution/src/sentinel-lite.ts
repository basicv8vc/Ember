import { DomainError } from '@ember/domain';
import { z } from 'zod';

/**
 * UUID regex pattern adhering to RFC 9562.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Default policy version for Sentinel-lite.
 */
export const SENTINEL_POLICY_VERSION = 1;

/**
 * Closed action categories evaluated by Sentinel-lite.
 *
 * All candidate actions must map into one of these categories:
 * - Local safe mocks: `mock.read`, `mock.write`, `mock.compute`
 * - Mutating operations requiring durable human approval: `external.mutate`
 * - Hard-denied high-risk actions in Round 1: `network.egress`, `host.exec`, `credential.use`
 *
 * Deeply frozen at runtime to prevent in-process tampering.
 */
export const SENTINEL_ACTION_CATEGORIES: readonly [
  'mock.read',
  'mock.write',
  'mock.compute',
  'external.mutate',
  'network.egress',
  'host.exec',
  'credential.use',
] = Object.freeze([
  'mock.read',
  'mock.write',
  'mock.compute',
  'external.mutate',
  'network.egress',
  'host.exec',
  'credential.use',
] as const);

export type SentinelActionCategory = (typeof SENTINEL_ACTION_CATEGORIES)[number];

/**
 * Safe local mock action categories. Only these three categories can ever enter
 * the `allow` decision branch when explicitly permitted by policy.
 */
export const SAFE_MOCK_ACTION_CATEGORIES: readonly ['mock.read', 'mock.write', 'mock.compute'] =
  Object.freeze(['mock.read', 'mock.write', 'mock.compute'] as const);

export type SafeMockActionCategory = (typeof SAFE_MOCK_ACTION_CATEGORIES)[number];

/**
 * Check whether a given value is an explicitly safe mock action category.
 */
export function isSafeMockActionCategory(value: unknown): value is SafeMockActionCategory {
  return (
    typeof value === 'string' && (SAFE_MOCK_ACTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Check whether a given value is a known Sentinel action category.
 */
export function isSentinelActionCategory(value: unknown): value is SentinelActionCategory {
  return (
    typeof value === 'string' && (SENTINEL_ACTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Stable, non-sensitive reason codes for Sentinel decisions.
 *
 * Never derives from or reflects user prompt text, command bodies, URLs, or secrets.
 * Deeply frozen at runtime.
 */
export const SENTINEL_REASON_CODES: readonly [
  'ALLOWED_LOCAL_MOCK',
  'REQUIRE_APPROVAL_EXTERNAL_MUTATE',
  'DENY_HIGH_RISK_EGRESS',
  'DENY_HIGH_RISK_EXEC',
  'DENY_HIGH_RISK_CREDENTIAL',
  'DENY_MOCK_ACTION_DISALLOWED',
  'DENY_UNKNOWN_ACTION',
  'DENY_POLICY_VERSION_MISMATCH',
  'DENY_INVALID_INTENT',
  'DENY_INVALID_POLICY',
  'DENY_TENANT_MISMATCH',
  'DENY_DEFAULT',
] = Object.freeze([
  'ALLOWED_LOCAL_MOCK',
  'REQUIRE_APPROVAL_EXTERNAL_MUTATE',
  'DENY_HIGH_RISK_EGRESS',
  'DENY_HIGH_RISK_EXEC',
  'DENY_HIGH_RISK_CREDENTIAL',
  'DENY_MOCK_ACTION_DISALLOWED',
  'DENY_UNKNOWN_ACTION',
  'DENY_POLICY_VERSION_MISMATCH',
  'DENY_INVALID_INTENT',
  'DENY_INVALID_POLICY',
  'DENY_TENANT_MISMATCH',
  'DENY_DEFAULT',
] as const);

export type SentinelReasonCode = (typeof SENTINEL_REASON_CODES)[number];

/**
 * Tri-state verdict returned by Sentinel policy evaluation.
 */
export type SentinelVerdict = 'allow' | 'require_approval' | 'deny';

/**
 * Immutable decision object resulting from policy evaluation.
 */
export interface SentinelDecision {
  readonly verdict: SentinelVerdict;
  /** Ergonomic alias for `verdict`. */
  readonly decision: SentinelVerdict;
  readonly reasonCode: SentinelReasonCode;
  readonly actionCategory: SentinelActionCategory | 'unknown';
  readonly policyVersion: number;
}

/**
 * Strict schema for trusted Sentinel policies.
 *
 * Enforces strict keys: any extra, unknown, or spoofed fields will cause validation failure.
 */
export const SentinelPolicySchema = z.strictObject({
  policyId: z.string().min(1).max(128),
  policyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  tenantId: z.string().regex(UUID_PATTERN, 'tenantId must be a valid UUID'),
  allowedActions: z.array(z.string().min(1).max(64)).max(32),
});

export type SentinelPolicy = z.infer<typeof SentinelPolicySchema>;

/**
 * Strict schema for action intents submitted for admission.
 *
 * Carries only action category, policy version, and minimal execution IDs.
 * Strictly forbids prompt bodies, command strings, tokens, file payloads, or client self-attested roles.
 */
export const SentinelIntentSchema = z.strictObject({
  actionCategory: z.string().min(1).max(64),
  policyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  tenantId: z.string().regex(UUID_PATTERN, 'tenantId must be a valid UUID'),
  runId: z.string().regex(UUID_PATTERN, 'runId must be a valid UUID'),
  taskId: z.string().regex(UUID_PATTERN, 'taskId must be a valid UUID').optional(),
  actionId: z.string().regex(UUID_PATTERN, 'actionId must be a valid UUID').optional(),
});

export type SentinelIntent = z.infer<typeof SentinelIntentSchema>;

/**
 * Safe policy validation helper.
 */
export function parseSentinelPolicy(
  raw: unknown,
): { success: true; data: SentinelPolicy } | { success: false; error: z.ZodError } {
  return SentinelPolicySchema.safeParse(raw);
}

/**
 * Safe intent validation helper.
 */
export function parseSentinelIntent(
  raw: unknown,
): { success: true; data: SentinelIntent } | { success: false; error: z.ZodError } {
  return SentinelIntentSchema.safeParse(raw);
}

/**
 * Options for constructing a default SentinelPolicy.
 */
export interface CreateSentinelPolicyOptions {
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly tenantId: string;
  readonly allowedActions?: readonly string[];
  readonly allowMockWrite?: boolean;
}

/**
 * Construct a valid, trusted SentinelPolicy.
 *
 * By default, only local mock read and mock compute are permitted.
 * Mock write is disabled by default to enforce the zero external side-effects requirement,
 * and must be explicitly enabled via `allowMockWrite: true` or by including `'mock.write'` in `allowedActions`.
 */
export function createDefaultSentinelPolicy(
  options: CreateSentinelPolicyOptions,
): Readonly<SentinelPolicy> {
  const allowed = options.allowedActions
    ? [...options.allowedActions]
    : options.allowMockWrite
      ? ['mock.read', 'mock.compute', 'mock.write']
      : ['mock.read', 'mock.compute'];

  const policy: SentinelPolicy = {
    policyId: options.policyId ?? 'sentinel-policy-default',
    policyVersion: options.policyVersion ?? SENTINEL_POLICY_VERSION,
    tenantId: options.tenantId,
    allowedActions: allowed,
  };

  return deepFreeze(SentinelPolicySchema.parse(policy));
}

const VALID_VERDICTS: ReadonlySet<string> = new Set(['allow', 'require_approval', 'deny']);
const VALID_REASON_CODES: ReadonlySet<string> = new Set(SENTINEL_REASON_CODES);

/**
 * Adapt a non-allow decision to the existing stable domain error vocabulary.
 *
 * Uses `POLICY_DENIED`. The diagnostic names only fixed verdict, reason code,
 * normalized action category, and policy version. It never echoes prompts or secrets.
 *
 * Runtime validation is enforced on `decision` to prevent untrusted / malicious objects
 * from injecting arbitrary strings into diagnostic text.
 */
export function toSentinelDeniedError(decision: unknown): DomainError {
  let safeVerdict: SentinelVerdict = 'deny';
  let safeReason: SentinelReasonCode = 'DENY_DEFAULT';
  let safeAction: SentinelActionCategory | 'unknown' = 'unknown';
  let safeVersion = 0;

  if (decision !== null && typeof decision === 'object') {
    const candidate = decision as Record<string, unknown>;

    if (typeof candidate['verdict'] === 'string' && VALID_VERDICTS.has(candidate['verdict'])) {
      safeVerdict = candidate['verdict'] as SentinelVerdict;
    }

    if (
      typeof candidate['reasonCode'] === 'string' &&
      VALID_REASON_CODES.has(candidate['reasonCode'])
    ) {
      safeReason = candidate['reasonCode'] as SentinelReasonCode;
    }

    if (
      typeof candidate['actionCategory'] === 'string' &&
      isSentinelActionCategory(candidate['actionCategory'])
    ) {
      safeAction = candidate['actionCategory'];
    }

    if (
      typeof candidate['policyVersion'] === 'number' &&
      Number.isInteger(candidate['policyVersion']) &&
      candidate['policyVersion'] >= 1 &&
      candidate['policyVersion'] <= Number.MAX_SAFE_INTEGER
    ) {
      safeVersion = candidate['policyVersion'];
    }
  }

  return new DomainError(
    'POLICY_DENIED',
    `sentinel gate denied: verdict=${safeVerdict} reason=${safeReason} ` +
      `action=${safeAction} version=${safeVersion}`,
  );
}

/**
 * Pure, deterministic Sentinel-lite policy evaluation.
 *
 * Rules:
 * 1. Policy & intent must strictly adhere to schemas (no unknown keys, valid numbers/UUIDs).
 *    Any validation failure fails closed (`deny`).
 * 2. `intent.policyVersion` must match `policy.policyVersion` (`DENY_POLICY_VERSION_MISMATCH`).
 * 3. `intent.tenantId` must match `policy.tenantId` (`DENY_TENANT_MISMATCH`).
 * 4. High-risk actions (`network.egress`, `host.exec`, `credential.use`) are permanently
 *    `deny` in Round 1, even if misconfigured in `policy.allowedActions`.
 * 5. `external.mutate` is ALWAYS `require_approval`, never granting direct execution rights.
 * 6. Local safe mock operations (`mock.read`, `mock.compute`, `mock.write`) can be `allow`
 *    only if explicitly present in `policy.allowedActions`.
 * 7. Non-mock categories can NEVER enter the `allow` branch under any circumstances.
 * 8. Unknown actions fail closed (`DENY_UNKNOWN_ACTION`).
 * 9. Never reads clock, never calls random, never accesses DB or network, does not mutate inputs.
 *    The returned decision is deeply frozen.
 */
export function evaluateSentinelPolicy(
  policy: unknown,
  intent: unknown,
): Readonly<SentinelDecision> {
  // Step 1: Validate policy schema
  const parsedPolicyResult = parseSentinelPolicy(policy);
  if (!parsedPolicyResult.success) {
    return makeDecision('deny', 'DENY_INVALID_POLICY', 'unknown', 0);
  }
  const trustedPolicy = parsedPolicyResult.data;

  // Step 2: Validate intent schema
  const parsedIntentResult = parseSentinelIntent(intent);
  if (!parsedIntentResult.success) {
    return makeDecision('deny', 'DENY_INVALID_INTENT', 'unknown', trustedPolicy.policyVersion);
  }
  const trustedIntent = parsedIntentResult.data;

  // Step 3: Policy version match check
  if (trustedIntent.policyVersion !== trustedPolicy.policyVersion) {
    const safeCategory = isSentinelActionCategory(trustedIntent.actionCategory)
      ? trustedIntent.actionCategory
      : 'unknown';
    return makeDecision(
      'deny',
      'DENY_POLICY_VERSION_MISMATCH',
      safeCategory,
      trustedPolicy.policyVersion,
    );
  }

  // Step 4: Tenant matching check (anti-spoofing boundary check)
  if (trustedIntent.tenantId !== trustedPolicy.tenantId) {
    const safeCategory = isSentinelActionCategory(trustedIntent.actionCategory)
      ? trustedIntent.actionCategory
      : 'unknown';
    return makeDecision('deny', 'DENY_TENANT_MISMATCH', safeCategory, trustedPolicy.policyVersion);
  }

  // Step 5: Check action category
  if (!isSentinelActionCategory(trustedIntent.actionCategory)) {
    return makeDecision('deny', 'DENY_UNKNOWN_ACTION', 'unknown', trustedPolicy.policyVersion);
  }

  const category = trustedIntent.actionCategory;

  // Step 6: Hard-denied high risk operations (Round 1 invariant: deny regardless of policy allowlist)
  if (category === 'network.egress') {
    return makeDecision('deny', 'DENY_HIGH_RISK_EGRESS', category, trustedPolicy.policyVersion);
  }
  if (category === 'host.exec') {
    return makeDecision('deny', 'DENY_HIGH_RISK_EXEC', category, trustedPolicy.policyVersion);
  }
  if (category === 'credential.use') {
    return makeDecision('deny', 'DENY_HIGH_RISK_CREDENTIAL', category, trustedPolicy.policyVersion);
  }

  // Step 7: External mutation (always requires human/durable approval, never grants direct execution)
  if (category === 'external.mutate') {
    return makeDecision(
      'require_approval',
      'REQUIRE_APPROVAL_EXTERNAL_MUTATE',
      category,
      trustedPolicy.policyVersion,
    );
  }

  // Step 8: Only explicitly safe mock categories can ever enter the allow check
  if (isSafeMockActionCategory(category)) {
    if (trustedPolicy.allowedActions.includes(category)) {
      return makeDecision('allow', 'ALLOWED_LOCAL_MOCK', category, trustedPolicy.policyVersion);
    }
    return makeDecision(
      'deny',
      'DENY_MOCK_ACTION_DISALLOWED',
      category,
      trustedPolicy.policyVersion,
    );
  }

  // Step 9: Any non-mock category that somehow reaches here is unconditionally denied
  return makeDecision('deny', 'DENY_DEFAULT', 'unknown', trustedPolicy.policyVersion);
}

/**
 * Enforce admission gate before executing a side effect (asynchronous).
 *
 * Invariants:
 * - If verdict is `allow`: calls `action()` exactly 1 time and returns result.
 * - If verdict is `deny`, `require_approval`, or if parsing fails: calls `action()` 0 times,
 *   and throws `DomainError('POLICY_DENIED')`.
 */
export async function enforceSentinelGate<T>(
  policy: unknown,
  intent: unknown,
  action: () => Promise<T> | T,
): Promise<T> {
  const decision = evaluateSentinelPolicy(policy, intent);
  if (decision.verdict !== 'allow') {
    throw toSentinelDeniedError(decision);
  }
  return await action();
}

/**
 * Enforce admission gate before executing a side effect (synchronous).
 *
 * Invariants:
 * - If verdict is `allow`: calls `action()` exactly 1 time and returns result.
 * - If verdict is `deny`, `require_approval`, or if parsing fails: calls `action()` 0 times,
 *   and throws `DomainError('POLICY_DENIED')`.
 */
export function enforceSentinelGateSync<T>(policy: unknown, intent: unknown, action: () => T): T {
  const decision = evaluateSentinelPolicy(policy, intent);
  if (decision.verdict !== 'allow') {
    throw toSentinelDeniedError(decision);
  }
  return action();
}

// ---------------------------------------------------------------------------------------
// Internal purity & immutability helpers
// ---------------------------------------------------------------------------------------

function makeDecision(
  verdict: SentinelVerdict,
  reasonCode: SentinelReasonCode,
  actionCategory: SentinelActionCategory | 'unknown',
  policyVersion: number,
): Readonly<SentinelDecision> {
  return deepFreeze<SentinelDecision>({
    verdict,
    decision: verdict,
    reasonCode,
    actionCategory,
    policyVersion,
  });
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}
