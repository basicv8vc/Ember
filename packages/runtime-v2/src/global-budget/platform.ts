import type { AgentHeadCoreOptions } from '../agent-head/agent-head-do.js';
import { V2_BUDGET_LIMITS } from '../contracts/constants.js';
import type { GlobalBudgetAuthority } from '../contracts/global-budget.js';

export const GLOBAL_BUDGET_OBJECT_NAME = 'global';

export interface GlobalBudgetConfig {
  readonly GLOBAL_DAILY_CEILING_MICRO_USD?: string;
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

/** Use these options for every AgentHeadCore and pass the same binding to local consumers. */
export function createAgentHeadGlobalBudgetOptions(
  env: GlobalBudgetBindings,
): Pick<AgentHeadCoreOptions, 'globalBudget' | 'globalDailyCeilingMicroUsd'> {
  return {
    globalBudget: env.GLOBAL_BUDGET.getByName(GLOBAL_BUDGET_OBJECT_NAME),
    globalDailyCeilingMicroUsd: readGlobalDailyCeiling(env),
  };
}
