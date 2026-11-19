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
  GLOBAL_BUDGET_OBJECT_NAME,
  readGlobalDailyCeiling,
  type GlobalBudgetConfig,
} from './platform.js';

interface GlobalBudgetWorkerEnv extends GlobalBudgetConfig {
  readonly GLOBAL_BUDGET: { idFromName(name: string): DurableObjectId };
}

export class GlobalBudgetDO
  extends DurableObject<GlobalBudgetWorkerEnv>
  implements GlobalBudgetAuthority
{
  readonly #authority: GlobalBudgetAuthorityCore;

  constructor(ctx: DurableObjectState, env: GlobalBudgetWorkerEnv) {
    super(ctx, env);
    if (!ctx.id.equals(env.GLOBAL_BUDGET.idFromName(GLOBAL_BUDGET_OBJECT_NAME))) {
      throw new Error('Unexpected GlobalBudgetDO instance');
    }
    this.#authority = new GlobalBudgetAuthorityCore(ctx.storage, readGlobalDailyCeiling(env));
  }

  async reserveGlobal(req: GlobalBudgetReserveRequest) {
    return this.#authority.reserveGlobal(parseGlobalBudgetReserveRequest(req));
  }

  async authorizeGlobalSend(req: GlobalBudgetAuthorizeSendRequest) {
    return this.#authority.authorizeGlobalSend(parseGlobalBudgetAuthorizeSendRequest(req));
  }

  async renewGlobalGrant(req: GlobalBudgetRenewGrantRequest) {
    return this.#authority.renewGlobalGrant(parseGlobalBudgetRenewGrantRequest(req));
  }

  async settleGlobal(req: GlobalBudgetSettleRequest) {
    return this.#authority.settleGlobal(parseGlobalBudgetSettleRequest(req));
  }

  override alarm() {
    return this.#authority.alarm();
  }
}
