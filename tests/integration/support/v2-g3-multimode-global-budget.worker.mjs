import {
  GLOBAL_BUDGET_OBJECT_NAME,
  GLOBAL_BUDGET_REAL_OBJECT_NAME,
  createAgentHeadGlobalBudgetOptions,
} from '@ember/runtime-v2';
import { AgentHeadDO, getHead } from '../../../apps/api/src/local-v2/runtime-head.js';

export { AgentHeadDO };
export { GlobalBudgetDO } from '@ember/runtime-v2/global-budget-do';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { pathname } = new URL(request.url);
    const body = await request.json();

    if (pathname === '/d1/migrate') {
      const statements = String(body.sql)
        .replace(/--[^\n]*\n?/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await env.D1_RECOVERY.batch(statements.map((stmt) => env.D1_RECOVERY.prepare(stmt)));
      return Response.json({ ok: true });
    }

    if (pathname === '/head/bootstrap') {
      const head = getHead(env, body.tenantId, body.agentId);
      return Response.json(
        await head.bootstrap(
          { tenantId: body.tenantId, agentId: body.agentId },
          body.conversationId,
        ),
      );
    }

    if (pathname === '/head/rpc') {
      const head = getHead(env, body.tenantId, body.agentId);
      return Response.json(await head.edgeRpc(body.method, body.request));
    }

    if (pathname === '/gb/reserve') {
      const targetName =
        body.target === 'real' ? GLOBAL_BUDGET_REAL_OBJECT_NAME : GLOBAL_BUDGET_OBJECT_NAME;
      const stub = env.GLOBAL_BUDGET.getByName(targetName);
      return Response.json(await stub.reserveGlobal(body.request));
    }

    if (pathname === '/gb/options') {
      const opts = createAgentHeadGlobalBudgetOptions(env);
      return Response.json({
        globalDailyCeilingMicroUsd: opts.globalDailyCeilingMicroUsd,
        hasReal: opts.realGlobalBudget !== undefined,
      });
    }

    return new Response(null, { status: 404 });
  },

  async queue() {
    // Unused in this budget-transition test.
  },
};
