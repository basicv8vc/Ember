import type { DurableObjectId, DurableObjectState } from '@cloudflare/workers-types/index.js';
import { DurableObject } from 'cloudflare:workers';
import type {
  GlobalBudgetAuthority,
  GlobalBudgetAuthorizeSendRequest,
  GlobalBudgetRenewGrantRequest,
  GlobalBudgetReserveRequest,
  GlobalBudgetSettleRequest,
} from '../contracts/global-budget.js';
import {
  parseGlobalBudgetAuthorizeSendRequest,
  parseGlobalBudgetRenewGrantRequest,
  parseGlobalBudgetReserveRequest,
  parseGlobalBudgetSettleRequest,
} from '../contracts/validation.js';
import { GlobalBudgetAuthorityCore } from './authority.js';
import {
  GLOBAL_BUDGET_REAL_OBJECT_NAME,
  readGlobalDailyCeiling,
  resolveGlobalBudgetObjectName,
  type GlobalBudgetConfig,
  type GlobalBudgetModeConfig,
} from './platform.js';

interface GlobalBudgetWorkerEnv extends GlobalBudgetConfig, GlobalBudgetModeConfig {
  readonly GLOBAL_BUDGET: { idFromName(name: string): DurableObjectId };
}

export class GlobalBudgetDO
  extends DurableObject<GlobalBudgetWorkerEnv>
  implements GlobalBudgetAuthority
{
  readonly #authority: GlobalBudgetAuthorityCore;
  readonly #objectName: string;

  constructor(ctx: DurableObjectState, env: GlobalBudgetWorkerEnv) {
    super(ctx, env);
    const objectName = resolveGlobalBudgetObjectName(env);
    if (!ctx.id.equals(env.GLOBAL_BUDGET.idFromName(objectName))) {
      throw new Error('Unexpected GlobalBudgetDO instance');
    }
    this.#objectName = objectName;
    this.#authority = new GlobalBudgetAuthorityCore(ctx.storage, readGlobalDailyCeiling(env));
  }

  async reserveGlobal(req: GlobalBudgetReserveRequest) {
    const parsed = parseGlobalBudgetReserveRequest(req);
    const result = await this.#authority.reserveGlobal(parsed);
    if (this.#objectName === GLOBAL_BUDGET_REAL_OBJECT_NAME) {
      console.log(
        JSON.stringify({
          event: 'v2.global_budget.reserve',
          ledger: this.#objectName,
          operationId: parsed.operationId,
          utcDay: parsed.utcDay,
          amountMicroUsd: parsed.amountMicroUsd,
          ceilingMicroUsd: parsed.ceilingMicroUsd,
          kind: result.kind,
          ...(result.kind === 'reserved' ? { replayed: result.replayed } : {}),
          ...(result.kind === 'budget_halted' ? { reason: result.reason } : {}),
        }),
      );
    }
    return result;
  }

  async authorizeGlobalSend(req: GlobalBudgetAuthorizeSendRequest) {
    return this.#authority.authorizeGlobalSend(parseGlobalBudgetAuthorizeSendRequest(req));
  }

  async renewGlobalGrant(req: GlobalBudgetRenewGrantRequest) {
    return this.#authority.renewGlobalGrant(parseGlobalBudgetRenewGrantRequest(req));
  }

  async settleGlobal(req: GlobalBudgetSettleRequest) {
    const parsed = parseGlobalBudgetSettleRequest(req);
    const result = await this.#authority.settleGlobal(parsed);
    if (this.#objectName === GLOBAL_BUDGET_REAL_OBJECT_NAME) {
      console.log(
        JSON.stringify({
          event: 'v2.global_budget.settle',
          ledger: this.#objectName,
          operationId: parsed.operationId,
          settlementRevision: parsed.settlementRevision,
          requestedState: parsed.state,
          chargeMicroUsd: parsed.chargeMicroUsd,
          observedCostMicroUsd: parsed.observedCostMicroUsd ?? null,
          reservedMicroUsd: parsed.reservedMicroUsd,
          applied: result.applied,
          alreadySettled: result.alreadySettled,
          conflict: result.conflict,
          effectiveState: result.effectiveState,
          incidentOpened: result.incidentOpened,
        }),
      );
    }
    return result;
  }

  override alarm() {
    return this.#authority.alarm();
  }
}
