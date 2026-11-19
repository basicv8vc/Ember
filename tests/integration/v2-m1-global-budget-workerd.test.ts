import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GlobalBudgetAuthority } from '../../packages/runtime-v2/src/contracts/global-budget.js';
import { GLOBAL_BUDGET_OBJECT_NAME } from '../../packages/runtime-v2/src/global-budget/platform.js';

type Request = Parameters<GlobalBudgetAuthority['reserveGlobal']>[0];
type Result<Method extends keyof GlobalBudgetAuthority> = Awaited<
  ReturnType<GlobalBudgetAuthority[Method]>
>;

interface WorkerdHarness {
  listen(): Promise<void>;
  fetch(path: string, init: RequestInit): Promise<Response>;
  getWorker(): {
    evictDurableObject(binding: string, options: { name: string }): Promise<void>;
    getDurableObjectStorage(
      binding: string,
      options: { name: string },
    ): Promise<{
      exec(query: string, ...bindings: string[]): Promise<unknown>;
    }>;
  };
  close(): Promise<void>;
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const requestModule = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const runtimePackage = createRequire(
  new URL('../../packages/runtime-v2/package.json', import.meta.url),
);
const binding = 'GLOBAL_BUDGET';

describe('isolated workerd GlobalBudgetDO authority', () => {
  let harness: WorkerdHarness;
  const evidence: Array<{ scenario: string; samples: unknown }> = [];

  beforeEach(async () => {
    const wrangler = (await import(requestModule.resolve('wrangler'))) as {
      createTestHarness(options: unknown): WorkerdHarness;
    };
    harness = wrangler.createTestHarness({
      root,
      workers: [
        {
          config: {
            name: 'ember-v2-m1-global-budget-test',
            main: 'tests/integration/support/v2-m1-global-budget.worker.mjs',
            compatibility_date: '2026-11-01',
            send_metrics: false,
            compatibility_flags: ['nodejs_compat'],
            vars: { GLOBAL_DAILY_CEILING_MICRO_USD: '3000' },
            alias: {
              '@ember/runtime-v2/global-budget-do': runtimePackage.resolve(
                '@ember/runtime-v2/global-budget-do',
              ),
              '@ember/runtime-v2': runtimePackage.resolve('@ember/runtime-v2'),
            },
            durable_objects: { bindings: [{ name: binding, class_name: 'GlobalBudgetDO' }] },
            migrations: [{ tag: 'v1', new_sqlite_classes: ['GlobalBudgetDO'] }],
          },
        },
      ],
    });
    await harness.listen();
  });

  afterEach(async () => {
    await harness?.close();
  });

  afterAll(() => {
    if (process.env.EMBER_GLOBAL_BUDGET_EVIDENCE && evidence.length === 2) {
      writeFileSync(
        process.env.EMBER_GLOBAL_BUDGET_EVIDENCE,
        JSON.stringify(
          {
            evidence: 'local workerd Worker fetch to SQLite DO RPC, per request, milliseconds',
            measuredAt: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            wrangler: (requestModule('wrangler/package.json') as { version: string }).version,
            scenarios: evidence,
          },
          null,
          2,
        ) + '\n',
      );
    }
  });

  function reserveRequest(overrides: Partial<Request> = {}): Request {
    const now = Date.now();
    return {
      tenantId: randomUUID(),
      principalId: randomUUID(),
      agentId: randomUUID(),
      leaseEpoch: 1,
      utcDay: new Date(now).toISOString().slice(0, 10),
      amountMicroUsd: 250,
      ceilingMicroUsd: 3_000,
      expiresAtMs: now + 120_000,
      operationId: randomUUID(),
      ...overrides,
    };
  }

  async function rpc<Method extends keyof GlobalBudgetAuthority>(
    method: Method,
    input: Parameters<GlobalBudgetAuthority[Method]>[0],
  ): Promise<{ result: Result<Method>; ms: number }> {
    const started = performance.now();
    const response = await harness.fetch(`/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`${method} ${response.status} ${await response.text()}`);
    const result = (await response.json()) as Result<Method>;
    return { result, ms: performance.now() - started };
  }

  async function storage() {
    return harness
      .getWorker()
      .getDurableObjectStorage(binding, { name: GLOBAL_BUDGET_OBJECT_NAME });
  }

  it('admits 12 of 32 concurrent reserves and captures reserve, authorize, and settle timings', async () => {
    const scenario = 'different-operations';
    const requests = Array.from({ length: 32 }, () => reserveRequest());
    const paths = await Promise.all(
      requests.map(async (request) => {
        const started = performance.now();
        const reserve = await rpc('reserveGlobal', request);
        const { result } = reserve;
        const entry = {
          operationId: request.operationId,
          kind: result.kind,
          reserveMs: reserve.ms,
        };
        if (result.kind !== 'reserved') return { entry };
        const key = {
          tenantId: request.tenantId,
          operationId: request.operationId,
          globalGrantId: result.globalGrantId,
        };
        const authorize = await rpc('authorizeGlobalSend', key);
        return {
          key,
          entry: {
            ...entry,
            authorized: authorize.result.authorized,
            authorizeMs: authorize.ms,
            reserveAndAuthorizeMs: performance.now() - started,
          },
        };
      }),
    );
    const admitted = paths.flatMap(({ key }) => (key ? [key] : []));
    expect(admitted).toHaveLength(12);
    expect(paths.filter(({ entry }) => entry.kind === 'budget_exceeded')).toHaveLength(20);
    expect(paths.filter(({ entry }) => 'authorized' in entry && entry.authorized)).toHaveLength(12);
    const sql = await storage();
    expect(
      await sql.exec('SELECT reserved_micro_usd, consumed_micro_usd FROM global_spend_days'),
    ).toEqual([{ reserved_micro_usd: 3_000, consumed_micro_usd: 0 }]);

    const settles = await Promise.all(
      admitted.map(async (key) => {
        const { result, ms } = await rpc('settleGlobal', {
          ...key,
          settlementRevision: 0,
          state: 'settled',
          reservedMicroUsd: 250,
          chargeMicroUsd: 200,
          observedCostMicroUsd: 200,
        });
        return { operationId: key.operationId, applied: result.applied, ms };
      }),
    );
    expect(settles.every(({ applied }) => applied)).toBe(true);
    expect(
      await sql.exec('SELECT reserved_micro_usd, consumed_micro_usd FROM global_spend_days'),
    ).toEqual([{ reserved_micro_usd: 0, consumed_micro_usd: 2_400 }]);
    evidence.push({
      scenario,
      samples: { reserveAndAuthorize: paths.map(({ entry }) => entry), settles },
    });
  });

  it('allows one send and one settlement during duplicate bursts and persists them across eviction', async () => {
    const scenario = 'same-operation';
    const request = reserveRequest();
    const reservations = await Promise.all(
      Array.from({ length: 32 }, () => rpc('reserveGlobal', request)),
    );
    const newGrants = reservations.flatMap(({ result }) =>
      result.kind === 'reserved' && !result.replayed ? [result.globalGrantId] : [],
    );
    expect(newGrants).toHaveLength(1);
    const globalGrantId = newGrants[0]!;
    expect(
      reservations.every(
        ({ result }) => result.kind === 'reserved' && result.globalGrantId === globalGrantId,
      ),
    ).toBe(true);

    const key = { tenantId: request.tenantId, operationId: request.operationId, globalGrantId };
    const authorizations = await Promise.all(
      Array.from({ length: 32 }, () => rpc('authorizeGlobalSend', key)),
    );
    expect(authorizations.filter(({ result }) => result.authorized)).toHaveLength(1);
    await harness.getWorker().evictDurableObject(binding, { name: GLOBAL_BUDGET_OBJECT_NAME });
    expect((await rpc('authorizeGlobalSend', key)).result).toEqual({ authorized: false });

    const report = {
      ...key,
      settlementRevision: 0,
      state: 'unknown_billed',
      reservedMicroUsd: 250,
      chargeMicroUsd: 250,
    } as const;
    const settles = await Promise.all(
      Array.from({ length: 32 }, () => rpc('settleGlobal', report)),
    );
    expect(settles.filter(({ result }) => result.applied)).toHaveLength(1);
    expect(settles.filter(({ result }) => result.alreadySettled && !result.conflict)).toHaveLength(
      31,
    );
    expect((await rpc('settleGlobal', { ...report, chargeMicroUsd: 251 })).result).toMatchObject({
      conflict: true,
      alreadySettled: false,
    });
    const sql = await storage();
    expect(await sql.exec('SELECT delta_micro_usd FROM global_budget_settlements')).toEqual([
      { delta_micro_usd: 250 },
    ]);
    evidence.push({
      scenario,
      samples: {
        reserves: reservations.map(({ result, ms }) => ({ kind: result.kind, ms })),
        authorizations: authorizations.map(({ result, ms }) => ({
          authorized: result.authorized,
          ms,
        })),
        settles: settles.map(({ result, ms }) => ({
          applied: result.applied,
          alreadySettled: result.alreadySettled,
          ms,
        })),
      },
    });
  });

  it('enforces strict canonical RPC validation and one configured ceiling across Agent identities', async () => {
    const first = reserveRequest();
    const differentAgent = reserveRequest();
    expect(first.tenantId).not.toBe(differentAgent.tenantId);
    expect(first.agentId).not.toBe(differentAgent.agentId);
    await expect(
      harness.fetch('/wrong-instance', {
        method: 'POST',
        body: JSON.stringify(first),
      }),
    ).rejects.toThrow('Unexpected GlobalBudgetDO instance');
    await expect(rpc('reserveGlobal', { ...first, agentId: 'invalid-id' })).rejects.toThrow();
    await expect(rpc('reserveGlobal', { ...first, unexpected: true } as Request)).rejects.toThrow();
    expect((await rpc('reserveGlobal', { ...first, ceilingMicroUsd: 5_000 })).result).toEqual({
      kind: 'budget_exceeded',
    });
    expect((await rpc('reserveGlobal', first)).result).toMatchObject({ kind: 'reserved' });
    expect(
      (await rpc('reserveGlobal', { ...differentAgent, ceilingMicroUsd: 500 })).result,
    ).toEqual({ kind: 'budget_exceeded' });
    const other = (await rpc('reserveGlobal', differentAgent)).result;
    expect(other).toMatchObject({ kind: 'reserved' });
    expect(
      (await rpc('reserveGlobal', { ...reserveRequest(), ceilingMicroUsd: 5_000 })).result,
    ).toEqual({ kind: 'budget_exceeded' });
    const sql = await storage();
    expect(
      await sql.exec('SELECT ceiling_micro_usd, reserved_micro_usd FROM global_spend_days'),
    ).toEqual([{ ceiling_micro_usd: 3_000, reserved_micro_usd: 500 }]);
  });

  it('expires via a real idle alarm after eviction, denies refund, and halts on late overage', async () => {
    const request = reserveRequest({ expiresAtMs: Date.now() + 1_500 });
    const { result } = await rpc('reserveGlobal', request);
    if (result.kind !== 'reserved') throw new Error('Expected grant');
    const key = {
      tenantId: request.tenantId,
      operationId: request.operationId,
      globalGrantId: result.globalGrantId,
    };

    const other = reserveRequest();
    const second = (await rpc('reserveGlobal', other)).result;
    if (second.kind !== 'reserved') throw new Error('Expected second grant');
    const extension = request.expiresAtMs + 500;
    expect((await rpc('renewGlobalGrant', { ...key, newExpiresAtMs: extension })).result).toEqual({
      renewed: true,
      state: 'reserved',
    });
    await harness.getWorker().evictDurableObject(binding, { name: GLOBAL_BUDGET_OBJECT_NAME });
    const sql = await storage();
    const readState = () =>
      sql.exec(
        'SELECT state FROM global_budget_reservations WHERE operation_id = ?',
        request.operationId,
      );
    expect(await readState()).toEqual([{ state: 'reserved' }]);
    await expect
      .poll(readState, { timeout: 8_000, interval: 100 })
      .toEqual([{ state: 'expired_consumed' }]);

    const initial = {
      ...key,
      settlementRevision: 0,
      state: 'released',
      reservedMicroUsd: 250,
      chargeMicroUsd: 0,
    } as const;
    expect((await rpc('settleGlobal', initial)).result).toMatchObject({
      applied: false,
      alreadySettled: true,
      effectiveState: 'expired_consumed',
    });
    expect(
      (
        await rpc('settleGlobal', {
          ...initial,
          settlementRevision: 1,
          state: 'settled',
          chargeMicroUsd: 2_850,
          observedCostMicroUsd: 2_850,
        })
      ).result,
    ).toMatchObject({ applied: true, incidentOpened: true });
    expect(
      (
        await rpc('authorizeGlobalSend', {
          tenantId: other.tenantId,
          operationId: other.operationId,
          globalGrantId: second.globalGrantId,
        })
      ).result,
    ).toEqual({ authorized: false });
    expect((await rpc('reserveGlobal', reserveRequest())).result).toEqual({
      kind: 'budget_halted',
      reason: 'day_ceiling_exceeded',
    });
    expect(
      await sql.exec(
        'SELECT reserved_micro_usd, consumed_micro_usd, overage_micro_usd FROM global_spend_days',
      ),
    ).toEqual([{ reserved_micro_usd: 250, consumed_micro_usd: 2_750, overage_micro_usd: '100' }]);
  });
});
