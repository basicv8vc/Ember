import type { AgentHeadCoreOptions } from '../agent-head/agent-head-do.js';
import { V2_BUDGET_LIMITS } from '../contracts/constants.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';

export const GLOBAL_BUDGET_OBJECT_NAME = 'global';
export const GLOBAL_BUDGET_REAL_OBJECT_NAME = 'global-real';
export const REAL_GLOBAL_GRANT_PREFIX = 'real:';

export interface GlobalBudgetConfig {
  readonly GLOBAL_DAILY_CEILING_MICRO_USD?: string;
}

export interface GlobalBudgetModeConfig {
  readonly EMBER_MODEL_MODE?: string | undefined;
}

/**
 * Select the global budget DO name for NEW reservations (`global-real` for `real` mode,
 * `global` for `fake`/simulated mode) so simulated turns never consume or pin the real-LLM UTC day.
 */
export function resolveGlobalBudgetObjectName(config: GlobalBudgetModeConfig): string {
  return config.EMBER_MODEL_MODE?.trim().toLowerCase() === 'real'
    ? GLOBAL_BUDGET_REAL_OBJECT_NAME
    : GLOBAL_BUDGET_OBJECT_NAME;
}

export function isRealGlobalGrantId(globalGrantId: string): boolean {
  return globalGrantId.startsWith(REAL_GLOBAL_GRANT_PREFIX);
}

export interface GlobalBudgetBindings extends GlobalBudgetConfig {
  readonly GLOBAL_BUDGET: { getByName(name: string): GlobalBudgetAuthority };
}

export function readGlobalDailyCeiling(config: GlobalBudgetConfig): number {
  const raw = config.GLOBAL_DAILY_CEILING_MICRO_USD;
  if (raw === undefined) return V2_BUDGET_LIMITS.globalDailyMicroUsd;

  const amount = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(amount) ||
    amount > V2_BUDGET_LIMITS.globalDailyMicroUsd
  ) {
    throw new Error('Invalid GLOBAL_DAILY_CEILING_MICRO_USD');
  }
  return amount;
}

/**
 * Bind BOTH the fake/default (`global`) and real-LLM (`global-real`) GlobalBudgetDO instances
 * so AgentHeadCore reserves new attempts in the mode-appropriate ledger while authorizations,
 * renewals, and late/recovery settlements always target the original reservation's ledger.
 */
export function createAgentHeadGlobalBudgetOptions(
  env: GlobalBudgetBindings & GlobalBudgetModeConfig,
): Pick<AgentHeadCoreOptions, 'globalBudget' | 'realGlobalBudget' | 'globalDailyCeilingMicroUsd'> {
  return {
    globalBudget: env.GLOBAL_BUDGET.getByName(GLOBAL_BUDGET_OBJECT_NAME),
    realGlobalBudget: env.GLOBAL_BUDGET.getByName(GLOBAL_BUDGET_REAL_OBJECT_NAME),
    globalDailyCeilingMicroUsd: readGlobalDailyCeiling(env),
  };
}
