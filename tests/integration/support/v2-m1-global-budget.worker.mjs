import { createAgentHeadGlobalBudgetOptions } from '@ember/runtime-v2';

export { GlobalBudgetDO } from '@ember/runtime-v2/global-budget-do';

// Loopback test transport. The namespace exposes the four actual DO RPCs.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { pathname } = new URL(request.url);
    const method = pathname.slice(1);
    const { globalBudget: authority } = createAgentHeadGlobalBudgetOptions(env);
    const input = await request.json();
    if (method === 'wrong-instance') {
      const other = env.GLOBAL_BUDGET.getByName('non-platform-test-object');
      return Response.json(await other.reserveGlobal(input));
    }
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
