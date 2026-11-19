import { DurableObject } from 'cloudflare:workers';
import { GlobalBudgetAuthorityCore } from '../../../packages/runtime-v2/src/global-budget/authority.ts';

export class GlobalBudgetDO extends DurableObject {
  #authority;

  constructor(ctx, env) {
    super(ctx, env);
    this.#authority = new GlobalBudgetAuthorityCore(ctx.storage);
  }

  reserveGlobal(input) {
    return this.#authority.reserveGlobal(input);
  }

  authorizeGlobalSend(input) {
    return this.#authority.authorizeGlobalSend(input);
  }

  renewGlobalGrant(input) {
    return this.#authority.renewGlobalGrant(input);
  }

  settleGlobal(input) {
    return this.#authority.settleGlobal(input);
  }

  alarm() {
    return this.#authority.alarm();
  }
}

// Loopback test transport. The namespace exposes the four actual DO RPCs.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { pathname } = new URL(request.url);
    const [scenario, method] = pathname.slice(1).split('/');
    const authority = env.GLOBAL_BUDGET.getByName(scenario);
    const input = await request.json();
    switch (method) {
      case 'reserveGlobal':
        return Response.json(await authority.reserveGlobal(input));
      case 'authorizeGlobalSend':
        return Response.json(await authority.authorizeGlobalSend(input));
      case 'renewGlobalGrant':
        return Response.json(await authority.renewGlobalGrant(input));
      case 'settleGlobal':
        return Response.json(await authority.settleGlobal(input));
      default:
        return new Response(null, { status: 404 });
    }
  },
};
