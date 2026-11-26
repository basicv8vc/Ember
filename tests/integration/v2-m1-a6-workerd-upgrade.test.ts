import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const runtimeRequire = createRequire(
  new URL('../../packages/runtime-v2/package.json', import.meta.url),
);

interface WorkerdHarness {
  listen(): Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  getWorker(): {
    evictDurableObject(binding: string, options: { name: string }): Promise<void>;
  };
  close(): Promise<void>;
}

describe('M1-A6 real workerd persistent pre-v4 -> v4 & GlobalBudgetDO upgrade, rollback, restart & retry', () => {
  it('preserves historical data, active leases, pending outbox, unsettled budgets, incidents, and FKs across DO eviction restarts and failed migration rollback', async () => {
    const wrangler = (await import(apiRequire.resolve('wrangler'))) as {
      createTestHarness(options: unknown): WorkerdHarness;
    };
    const harness = wrangler.createTestHarness({
      root: REPO_ROOT,
      workers: [
        {
          config: {
            name: 'ember-v2-m1-a6-upgrade-test',
            main: 'tests/integration/support/v2-m1-a6-upgrade.worker.mjs',
            compatibility_date: '2026-11-01',
            send_metrics: false,
            compatibility_flags: ['nodejs_compat'],
            alias: {
              '@ember/runtime-v2': runtimeRequire.resolve('@ember/runtime-v2'),
            },
            durable_objects: {
              bindings: [
                { name: 'AGENT_HEAD', class_name: 'UpgradeTestAgentHeadDO' },
                { name: 'GLOBAL_BUDGET', class_name: 'UpgradeTestGlobalBudgetDO' },
              ],
            },
            migrations: [
              {
                tag: 'v1',
                new_sqlite_classes: ['UpgradeTestAgentHeadDO', 'UpgradeTestGlobalBudgetDO'],
              },
            ],
          },
        },
      ],
    });
    await harness.listen();

    try {
      // Phase 1: Seed persisted legacy pre-v4 AgentHeadDO + pre-OPT-5 GlobalBudgetDO in real workerd
      const agentSeed = (await (
        await harness.fetch('/agent/run?mode=seed_legacy', { method: 'POST' })
      ).json()) as {
        ok: boolean;
        appliedVersions: number[];
        turnsCount: number;
        outboxCount: number;
        attemptsCount: number;
        incidentsCount: number;
        devicePlacementsCount: number;
      };
      expect(agentSeed).toMatchObject({
        ok: true,
        appliedVersions: [1, 2, 3, 4],
        turnsCount: 2,
        outboxCount: 2,
        attemptsCount: 2,
        incidentsCount: 1,
        devicePlacementsCount: 1,
      });

      const gbSeed = (await (
        await harness.fetch('/gb/run?mode=seed_legacy', { method: 'POST' })
      ).json()) as {
        ok: boolean;
        reservationsWithoutRowid: boolean;
        reservationsCount: number;
        settlementsCount: number;
        incidentsCount: number;
      };
      expect(gbSeed).toMatchObject({
        ok: true,
        reservationsWithoutRowid: false,
        reservationsCount: 2,
        settlementsCount: 1,
        incidentsCount: 1,
      });

      // Evict & restart both DOs from persisted SQLite storage
      await harness.getWorker().evictDurableObject('AGENT_HEAD', { name: 'upgrade-agent-1' });
      await harness.getWorker().evictDurableObject('GLOBAL_BUDGET', { name: 'global' });

      // Phase 2: Inject mid-migration failures -> verify atomic transaction rollback!
      const agentFail = (await (
        await harness.fetch('/agent/run?mode=fail_upgrade', { method: 'POST' })
      ).json()) as {
        threw: boolean;
        appliedVersionsInDb: number[];
        hasLeftoverV4TempTables: boolean;
        assistantTurnsWithoutRowid: boolean;
        turnsCount: number;
        outboxCount: number;
        attemptsCount: number;
        incidentsCount: number;
        fkViolations: number;
      };
      expect(agentFail).toMatchObject({
        threw: true,
        appliedVersionsInDb: [1, 2, 3, 4],
        hasLeftoverV4TempTables: false,
        assistantTurnsWithoutRowid: false,
        turnsCount: 2,
        outboxCount: 2,
        attemptsCount: 2,
        incidentsCount: 1,
        fkViolations: 0,
      });

      const gbFail = (await (
        await harness.fetch('/gb/run?mode=fail_upgrade', { method: 'POST' })
      ).json()) as {
        threw: boolean;
        reservationsWithoutRowid: boolean;
        hasLeftoverV2TempTables: boolean;
        reservationsCount: number;
        settlementsCount: number;
        incidentsCount: number;
        fkViolations: number;
      };
      expect(gbFail).toMatchObject({
        threw: true,
        reservationsWithoutRowid: false,
        hasLeftoverV2TempTables: false,
        reservationsCount: 2,
        settlementsCount: 1,
        incidentsCount: 1,
        fkViolations: 0,
      });

      // Evict & restart both DOs again after failed migration
      await harness.getWorker().evictDurableObject('AGENT_HEAD', { name: 'upgrade-agent-1' });
      await harness.getWorker().evictDurableObject('GLOBAL_BUDGET', { name: 'global' });

      // Phase 3: Retry real v4 -> current (v8) + GlobalBudgetDO WITHOUT ROWID upgrade on persisted DBs!
      const agentUp = (await (
        await harness.fetch('/agent/run?mode=upgrade_v4', { method: 'POST' })
      ).json()) as {
        ok: boolean;
        appliedVersions: number[];
        alreadyAppliedVersions: number[];
        replayAppliedVersions: number[];
        hasDupMsgIndex: boolean;
        hasPartialRespIndex: boolean;
        hasOpRevIndex: boolean;
        withoutRowidTables: Record<string, boolean>;
        historicalMessagesCount: number;
        activeLeaseTurn: {
          id: string;
          status: string;
          lease_owner: string | null;
          lease_expires_at_ms: number | null;
        } | null;
        pendingOutboxIds: string[];
        unsettledAttempt: {
          operation_id: string;
          state: string;
          reserved_micro_usd: number;
        } | null;
        spendDayCount: number;
        incidentsCount: number;
        devicePlacementsCount: number;
        nativeDevicePlacement: {
          task_id: string;
          capability: string;
          capability_version: number;
        } | null;
        fkViolations: number;
        rejectsDupRespMsg: boolean;
        rejectsOrphanFk: boolean;
      };
      expect(agentUp).toMatchObject({
        ok: true,
        appliedVersions: [5, 6, 7, 8, 9],
        alreadyAppliedVersions: [1, 2, 3, 4],
        replayAppliedVersions: [],
        hasDupMsgIndex: false,
        hasPartialRespIndex: true,
        hasOpRevIndex: true,
        withoutRowidTables: {
          assistant_turns: true,
          model_attempts: true,
          agent_spend_days: true,
          v2_dispatch_outbox: true,
        },
        historicalMessagesCount: 3,
        activeLeaseTurn: {
          id: 'turn-active',
          status: 'running',
          lease_owner: 'worker-live',
          lease_expires_at_ms: 90_000,
        },
        pendingOutboxIds: ['budget_sync:op-settled:rev:0', 'turn:turn-active:epoch:1'],
        unsettledAttempt: {
          operation_id: 'op-active',
          state: 'reserved',
          reserved_micro_usd: 250,
        },
        spendDayCount: 2,
        incidentsCount: 1,
        devicePlacementsCount: 1,
        nativeDevicePlacement: {
          task_id: 'task-dev-1',
          capability: 'device.text.process',
          capability_version: 1,
        },
        fkViolations: 0,
        rejectsDupRespMsg: true,
        rejectsOrphanFk: true,
      });

      const gbUp = (await (
        await harness.fetch('/gb/run?mode=upgrade_v4', { method: 'POST' })
      ).json()) as {
        ok: boolean;
        reservationsWithoutRowid: boolean;
        settlementsWithoutRowid: boolean;
        reservationsCount: number;
        settlementsCount: number;
        incidentsCount: number;
        unsettledReservationState: string | null;
        haltedBeforeResolve: boolean;
        postResolveSettled: boolean;
        rejectsDupGrantId: boolean;
        rejectsOrphanSettlementFk: boolean;
        fkViolations: number;
      };
      expect(gbUp).toMatchObject({
        ok: true,
        reservationsWithoutRowid: true,
        settlementsWithoutRowid: true,
        reservationsCount: 3,
        settlementsCount: 2,
        incidentsCount: 1,
        unsettledReservationState: 'reserved',
        haltedBeforeResolve: true,
        postResolveSettled: true,
        rejectsDupGrantId: true,
        rejectsOrphanSettlementFk: true,
        fkViolations: 0,
      });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
