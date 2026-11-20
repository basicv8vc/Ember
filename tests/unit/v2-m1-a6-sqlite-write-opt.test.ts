import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AlarmMultiplexer,
  OutboxCoordinator,
  RecoveryCoverageCoordinator,
  ScheduleRepository,
  applyAgentHeadMigrations,
  createAgentHeadBusinessDoMigration,
  createDefaultAgentHeadMigrations,
  createEventRecoveryDoMigration,
  type AuthoritativeBusinessPort,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
} from '../../packages/runtime-v2/src/index.js';
import { GlobalBudgetLedger } from '../../packages/runtime-v2/src/global-budget/ledger.js';

function createSqliteDoHarness(initialAlarm: number | null = null) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  let inTx = false;
  let armedAlarm: number | null = initialAlarm;
  let setAlarmCalls = 0;
  let deleteAlarmCalls = 0;
  let getAlarmCalls = 0;
  let sqlWriteStatements = 0;
  let sqlChangesTotal = 0;
  let getAlarmDelayMs = 0;
  let failNextSetAlarm = false;

  const storage: DurableObjectStorageLike = {
    sql: {
      exec<T extends SqlStorageRow = SqlStorageRow>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursorLike<T> {
        const trimmed = query.trim();
        const isMulti = trimmed.includes(';') && trimmed.indexOf(';') < trimmed.length - 1;
        if (isMulti && bindings.length === 0) {
          db.exec(query);
          return {
            toArray: () => [],
            one: () => {
              throw new Error('no rows');
            },
            rowsRead: 0,
            rowsWritten: 0,
            [Symbol.iterator]: () => [][Symbol.iterator](),
          };
        }
        const stmt = db.prepare(query);
        const sqlParams = bindings as Array<string | number | null | Uint8Array>;
        if (/^(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed)) {
          const rows = stmt.all(...sqlParams) as T[];
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length === 0) throw new Error('no rows');
              return rows[0]!;
            },
            rowsRead: rows.length,
            rowsWritten: 0,
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        }
        const info = stmt.run(...sqlParams);
        const changes = Number(info.changes);
        if (!/^PRAGMA\b/i.test(trimmed)) {
          sqlWriteStatements += 1;
          sqlChangesTotal += changes;
        }
        return {
          toArray: () => [],
          one: () => {
            throw new Error('no rows');
          },
          rowsRead: 0,
          rowsWritten: changes,
          [Symbol.iterator]: () => [][Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      if (inTx) return closure();
      inTx = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const res = closure();
        db.exec('COMMIT');
        return res;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTx = false;
      }
    },
    async getAlarm(): Promise<number | null> {
      getAlarmCalls += 1;
      if (getAlarmDelayMs > 0) {
        await new Promise((r) => setTimeout(r, getAlarmDelayMs));
      }
      return armedAlarm;
    },
    setAlarm(ts: number | Date): Promise<void> {
      setAlarmCalls += 1;
      if (failNextSetAlarm) {
        failNextSetAlarm = false;
        return Promise.reject(new Error('injected setAlarm failure'));
      }
      armedAlarm = ts instanceof Date ? ts.getTime() : ts;
      return Promise.resolve();
    },
    deleteAlarm(): Promise<void> {
      deleteAlarmCalls += 1;
      armedAlarm = null;
      return Promise.resolve();
    },
  };

  return {
    db,
    storage,
    setGetAlarmDelayMs: (ms: number) => {
      getAlarmDelayMs = ms;
    },
    setFailNextSetAlarm: (fail: boolean) => {
      failNextSetAlarm = fail;
    },
    resetCounters: () => {
      setAlarmCalls = 0;
      deleteAlarmCalls = 0;
      getAlarmCalls = 0;
      sqlWriteStatements = 0;
      sqlChangesTotal = 0;
    },
    getMetrics: () => ({
      armedAlarm,
      setAlarmCalls,
      deleteAlarmCalls,
      getAlarmCalls,
      sqlWriteStatements,
      sqlChangesTotal,
    }),
  };
}

describe('M1-A6 DO SQLite Write Amplification Optimizations', () => {
  it('upgrades existing pre-v5 AgentHeadDO database (v1..v4 incl. M2-F2) to v5 (OPT-1, OPT-2, OPT-5) preserving all rows, UNIQUE, and FK constraints', () => {
    const h = createSqliteDoHarness();
    const allMigrations = createDefaultAgentHeadMigrations().filter((m) => m.version <= 5);
    const preV5 = allMigrations.filter((m) => m.version < 5);
    expect(preV5.map((m) => m.version)).toEqual([1, 2, 3, 4]);

    // 1. Bootstrap existing pre-v5 DO database (including v4 v2_native_device_placement)
    const initRes = applyAgentHeadMigrations(h.storage, preV5, 1_000);
    expect(initRes.appliedVersions).toEqual([1, 2, 3, 4]);

    // Populate representative data across all rebuilt & indexed tables
    h.db.exec(`
      INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
      VALUES ('conv-1', 'main', 3, 0, 1000, 1000);

      INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
      VALUES ('msg-u1', 'conv-1', 1, 'user', 'hello', 'sub-1', 1000);

      INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, model_label, simulated, created_at_ms)
      VALUES ('msg-e1', 'conv-1', 2, 'ember', 'hi there', 'fake-1', 1, 1100);

      INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
      VALUES ('msg-u2', 'conv-1', 3, 'user', 'second turn', 'sub-2', 1200);

      INSERT INTO assistant_turns (
        id, conversation_id, source_message_id, response_message_id, status,
        execution_mode, deadline_at_ms, lease_epoch, claim_count, created_at_ms, updated_at_ms
      ) VALUES
        ('turn-1', 'conv-1', 'msg-u1', 'msg-e1', 'completed', 'durable_queue', 60000, 2, 1, 1000, 1100),
        ('turn-2', 'conv-1', 'msg-u2', NULL, 'running', 'durable_queue', 70000, 1, 0, 1200, 1200);

      INSERT INTO model_attempts (
        subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day,
        lease_epoch, provider_id, model_label, rate_version, budget_mode, state,
        reserved_micro_usd, applied_cost_micro_usd, observed_cost_micro_usd, started_at_ms, settled_at_ms
      ) VALUES
        ('turn', 'turn-1', 1, 'op-1', 'prin-1', '2026-11-20', 1, 'fake', 'fake-1', 'v1', 'simulated_full_protocol', 'settled', 250, 120, 120, 1000, 1100),
        ('turn', 'turn-2', 1, 'op-2', 'prin-1', '2026-11-20', 1, 'fake', 'fake-1', 'v1', 'simulated_full_protocol', 'reserved', 250, 0, NULL, 1200, NULL);

      INSERT INTO agent_spend_days (scope_kind, scope_id, utc_day, reserved_micro_usd, consumed_micro_usd, overage_micro_usd, turns_started, updated_at_ms)
      VALUES
        ('tenant', 'ten-1', '2026-11-20', 250, 120, 0, 0, 1200),
        ('principal', 'prin-1', '2026-11-20', 250, 120, 0, 2, 1200);

      INSERT INTO v2_dispatch_outbox (
        outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision,
        state, next_attempt_at_ms, publish_attempts, dlq_count, fence_epoch, created_at_ms, updated_at_ms
      ) VALUES
        ('turn:turn-2:epoch:1', 'turn', 'turn-2', 'durable_turn', '{}', NULL, 0, 'pending', 1200, 0, 0, 1, 1200, 1200),
        ('budget_sync:op-1:rev:0', 'budget_sync', 'op-1', NULL, '{}', 'op-1', 0, 'acked', 1100, 0, 0, 1, 1100, 1100);
    `);

    // 2. Run upgrade migration (v1..v5)
    const upgradeRes = applyAgentHeadMigrations(h.storage, allMigrations, 2_000);
    expect(upgradeRes.alreadyAppliedVersions).toEqual([1, 2, 3, 4]);
    expect(upgradeRes.appliedVersions).toEqual([5]);

    // Idempotent re-run
    const rerunRes = applyAgentHeadMigrations(h.storage, allMigrations, 3_000);
    expect(rerunRes.appliedVersions).toEqual([]);
    expect(rerunRes.alreadyAppliedVersions).toEqual([1, 2, 3, 4, 5]);

    // 3. Verify OPT-1: duplicate idx_messages_conv_seq is gone, UNIQUE(conversation_id, sequence) still enforces uniqueness
    const dupIdx = h.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_conv_seq'`,
      )
      .get();
    expect(dupIdx).toBeUndefined();
    expect(() =>
      h.db.exec(
        `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
         VALUES ('msg-dup', 'conv-1', 1, 'user', 'dup', 'sub-dup', 2000)`,
      ),
    ).toThrow(/UNIQUE/i);

    // 4. Verify OPT-2 & OPT-5: WITHOUT ROWID on all 4 tables + partial unique index on response_message_id
    for (const table of [
      'assistant_turns',
      'model_attempts',
      'agent_spend_days',
      'v2_dispatch_outbox',
    ]) {
      const row = h.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string };
      expect(row.sql).toMatch(/\bWITHOUT\s+ROWID\b/i);
    }
    const respIdx = h.db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_response_message'`,
      )
      .get() as { sql: string };
    expect(respIdx.sql).toMatch(/WHERE response_message_id IS NOT NULL/i);

    // OPT-6 intentionally NOT applied: idx_v2_outbox_budget_sync_op_rev remains intact
    const opRevIdx = h.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_v2_outbox_budget_sync_op_rev'`,
      )
      .get();
    expect(opRevIdx).toBeDefined();

    // 5. Verify all pre-existing rows survived intact
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM assistant_turns').get()).toEqual({ c: 2 });
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM model_attempts').get()).toEqual({ c: 2 });
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM agent_spend_days').get()).toEqual({ c: 2 });
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM v2_dispatch_outbox').get()).toEqual({ c: 2 });

    // 6. Verify partial UNIQUE allows multiple NULL response_message_id, rejects duplicate non-NULL
    h.db.exec(`
      INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
      VALUES ('msg-u3', 'conv-1', 4, 'user', 'third', 'sub-3', 2100);
      INSERT INTO assistant_turns (
        id, conversation_id, source_message_id, response_message_id, status,
        execution_mode, deadline_at_ms, lease_epoch, claim_count, created_at_ms, updated_at_ms
      ) VALUES ('turn-3', 'conv-1', 'msg-u3', NULL, 'running', 'durable_queue', 80000, 1, 0, 2100, 2100);
    `);
    expect(() =>
      h.db.exec(
        `UPDATE assistant_turns SET status = 'completed', response_message_id = 'msg-e1' WHERE id = 'turn-3'`,
      ),
    ).toThrow(/UNIQUE/i);

    // 7. Verify Foreign Key integrity & ON DELETE CASCADE
    expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() =>
      h.db.exec(`
        INSERT INTO assistant_turns (
          id, conversation_id, source_message_id, response_message_id, status,
          execution_mode, deadline_at_ms, lease_epoch, claim_count, created_at_ms, updated_at_ms
        ) VALUES ('turn-bad-fk', 'missing-conv', 'missing-msg', NULL, 'running', 'durable_queue', 80000, 1, 0, 2100, 2100)
      `),
    ).toThrow(/FOREIGN KEY/i);

    h.db.exec(`DELETE FROM conversations WHERE id = 'conv-1'`);
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM assistant_turns').get()).toEqual({ c: 0 });
    expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    h.db.close();
  });

  it('upgrades existing pre-OPT-5 GlobalBudgetDO database to WITHOUT ROWID preserving rows, UNIQUE, and FK integrity', () => {
    const h = createSqliteDoHarness();

    // 1. Create legacy pre-OPT-5 GlobalBudgetDO tables WITHOUT `WITHOUT ROWID`
    h.db.exec(`
      CREATE TABLE global_spend_days (
        utc_day TEXT PRIMARY KEY,
        ceiling_micro_usd INTEGER NOT NULL CHECK (ceiling_micro_usd >= 0),
        reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
        consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
        overage_micro_usd TEXT NOT NULL DEFAULT '0',
        CHECK (reserved_micro_usd + consumed_micro_usd <= ceiling_micro_usd)
      ) STRICT;
      CREATE TABLE global_budget_reservations (
        operation_id TEXT PRIMARY KEY,
        global_grant_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        utc_day TEXT NOT NULL REFERENCES global_spend_days (utc_day),
        amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
        request_ceiling_micro_usd INTEGER NOT NULL,
        initial_expires_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= initial_expires_at_ms),
        authorized_at_ms INTEGER,
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'expired_consumed', 'settled', 'conservative_billed', 'unknown_billed', 'released'
        )),
        cumulative_charge_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_charge_micro_usd >= 0),
        overage_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (overage_micro_usd >= 0)
      ) STRICT;
      CREATE INDEX idx_global_budget_expiry
        ON global_budget_reservations (expires_at_ms, operation_id) WHERE state = 'reserved';
      CREATE TABLE global_budget_settlements (
        operation_id TEXT NOT NULL REFERENCES global_budget_reservations (operation_id),
        settlement_revision INTEGER NOT NULL CHECK (settlement_revision >= 0),
        payload_json TEXT NOT NULL,
        cumulative_charge_micro_usd INTEGER NOT NULL,
        delta_micro_usd INTEGER NOT NULL,
        day_overage_delta_micro_usd INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY (operation_id, settlement_revision)
      ) STRICT;
      CREATE TABLE global_budget_incidents (
        incident_id INTEGER PRIMARY KEY,
        operation_id TEXT NOT NULL,
        settlement_revision INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'day_ceiling_exceeded', 'reservation_exceeded', 'usage_missing'
        )),
        opened_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        resolved_by TEXT,
        resolution_note TEXT,
        UNIQUE (operation_id, reason, settlement_revision),
        FOREIGN KEY (operation_id, settlement_revision)
          REFERENCES global_budget_settlements (operation_id, settlement_revision),
        CHECK (
          (resolved_at_ms IS NULL AND resolved_by IS NULL AND resolution_note IS NULL)
          OR (resolved_at_ms IS NOT NULL AND resolved_by IS NOT NULL AND resolution_note IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX idx_global_budget_halt
        ON global_budget_incidents (incident_id) WHERE resolved_at_ms IS NULL;

      INSERT INTO global_spend_days (utc_day, ceiling_micro_usd, reserved_micro_usd, consumed_micro_usd, overage_micro_usd)
      VALUES ('2026-11-20', 1000000, 0, 300, '0');
      INSERT INTO global_budget_reservations (
        operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
        utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
        expires_at_ms, authorized_at_ms, state, cumulative_charge_micro_usd, overage_micro_usd
      ) VALUES (
        'op-legacy-1', 'grant-legacy-1', 'ten-1', 'prin-1', 'ag-1', 1,
        '2026-11-20', 250, 1000000, 50000, 50000, 1000, 'settled', 300, 50
      );
      INSERT INTO global_budget_settlements (
        operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
        delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
      ) VALUES ('op-legacy-1', 0, '["settled",300,300,"reservation_exceeded"]', 300, 300, 0, 2000);
      INSERT INTO global_budget_incidents (
        incident_id, operation_id, settlement_revision, reason, opened_at_ms,
        resolved_at_ms, resolved_by, resolution_note
      ) VALUES (1, 'op-legacy-1', 0, 'reservation_exceeded', 2000, 2500, 'admin', 'verified');
    `);

    // 2. Construct GlobalBudgetLedger -> triggers automatic WITHOUT ROWID upgrade
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const ledger = new GlobalBudgetLedger(
      h.storage,
      () => nowMs,
      () => 'grant-new-1',
      1_000_000,
    );

    // Verify WITHOUT ROWID applied to reservations & settlements
    for (const table of ['global_budget_reservations', 'global_budget_settlements']) {
      const row = h.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string };
      expect(row.sql).toMatch(/\bWITHOUT\s+ROWID\b/i);
    }

    // Verify all rows preserved and FK check clean
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM global_budget_reservations').get()).toEqual({
      c: 1,
    });
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM global_budget_settlements').get()).toEqual({
      c: 1,
    });
    expect(h.db.prepare('SELECT COUNT(*) AS c FROM global_budget_incidents').get()).toEqual({
      c: 1,
    });
    expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Verify FK enforcement remains active (orphan settlement rejected)
    expect(() =>
      h.db.exec(`
        INSERT INTO global_budget_settlements (
          operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
          delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
        ) VALUES ('missing-op', 0, '[]', 0, 0, 0, 3000)
      `),
    ).toThrow(/FOREIGN KEY/i);

    // Verify OPT-7 intentionally NOT applied (global_grant_id UNIQUE still enforced)
    expect(() =>
      h.db.exec(`
        INSERT INTO global_budget_reservations (
          operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
          utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
          expires_at_ms, state
        ) VALUES (
          'op-dup-grant', 'grant-legacy-1', 'ten-1', 'prin-1', 'ag-1', 1,
          '2026-11-20', 100, 1000000, 50000, 50000, 'reserved'
        )
      `),
    ).toThrow(/UNIQUE/i);

    // Verify normal reserve -> authorize -> settle works post-upgrade
    const resv = ledger.reserveGlobal({
      tenantId: 'ten-1',
      principalId: 'prin-1',
      agentId: 'ag-1',
      operationId: 'op-post-1',
      leaseEpoch: 1,
      utcDay: '2026-11-20',
      amountMicroUsd: 200,
      ceilingMicroUsd: 1_000_000,
      expiresAtMs: nowMs + 60_000,
    });
    expect(resv).toEqual({ kind: 'reserved', globalGrantId: 'grant-new-1', replayed: false });
    const auth = ledger.authorizeGlobalSend({
      tenantId: 'ten-1',
      operationId: 'op-post-1',
      globalGrantId: 'grant-new-1',
    });
    expect(auth.authorized).toBe(true);
    const settled = ledger.settleGlobal({
      tenantId: 'ten-1',
      operationId: 'op-post-1',
      settlementRevision: 0,
      globalGrantId: 'grant-new-1',
      state: 'settled',
      observedCostMicroUsd: 120,
      chargeMicroUsd: 120,
      reservedMicroUsd: 200,
    });
    expect(settled).toMatchObject({ applied: true, conflict: false, effectiveState: 'settled' });
    expect(h.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    h.db.close();
  });

  it('OPT-3 & OPT-4: AlarmMultiplexer uses storage.getAlarm() with zero SQLite writes, guards alarm_fail_count=0, survives restart, and serializes concurrent updates', async () => {
    const h = createSqliteDoHarness();
    applyAgentHeadMigrations(
      h.storage,
      [createAgentHeadBusinessDoMigration(), createEventRecoveryDoMigration()],
      1_000,
    );

    const stubBusiness: AuthoritativeBusinessPort = {
      earliestRequiredDiscoveryAtMsSync: () => null,
      listDueBusinessActionsSync: () => [],
      inspectOutboxTargetSync: () => ({
        exists: false,
        targetKind: null,
        targetId: null,
        currentLeaseEpoch: 0,
        deadlineAtMs: 0,
        isTerminal: true,
        cancelRequested: false,
      }),
      convergeDueBusinessItemSync: () => {},
      materializeScheduleOccurrenceSync: () => {},
    };

    const makeMultiplexer = () => {
      const outbox = new OutboxCoordinator(h.storage.sql, {
        storage: h.storage,
        business: stubBusiness,
      });
      const schedules = new ScheduleRepository(h.storage.sql);
      const coverage = new RecoveryCoverageCoordinator({
        storage: h.storage,
        tenantId: 'ten-1',
        agentId: 'ag-1',
        business: stubBusiness,
      });
      return {
        coverage,
        multiplexer: new AlarmMultiplexer({
          storage: h.storage,
          business: stubBusiness,
          coordinator: outbox,
          schedules,
          coverage,
        }),
      };
    };

    const { coverage, multiplexer } = makeMultiplexer();
    coverage.inspectCoverageSync(50_000, 1_000);
    h.resetCounters();

    // 1. Normal syncPlatformAlarm -> 0 SQLite writes!
    expect(await multiplexer.syncPlatformAlarm(20_000, 1_000)).toBe(true);
    expect(h.getMetrics()).toMatchObject({
      armedAlarm: 20_000,
      setAlarmCalls: 1,
      sqlWriteStatements: 0,
      sqlChangesTotal: 0,
    });

    // 2. Deduplicated syncPlatformAlarm -> 0 setAlarm calls & 0 SQLite writes
    expect(await multiplexer.syncPlatformAlarm(20_000, 1_500)).toBe(false);
    expect(h.getMetrics().setAlarmCalls).toBe(1);
    expect(h.getMetrics().sqlWriteStatements).toBe(0);

    // 3. Consumed alarm (forceRearmConsumed: true when current <= nowMs) -> re-arms!
    expect(await multiplexer.syncPlatformAlarm(20_000, 20_000, { forceRearmConsumed: true })).toBe(
      true,
    );
    expect(h.getMetrics().setAlarmCalls).toBe(2);

    // 4. DO restart simulation (fresh AlarmMultiplexer instance on same storage)
    const restarted = makeMultiplexer().multiplexer;
    expect(await restarted.syncPlatformAlarm(20_000, 2_000)).toBe(false);
    expect(await restarted.syncPlatformAlarm(null, 2_000)).toBe(true);
    expect(h.getMetrics()).toMatchObject({
      armedAlarm: null,
      deleteAlarmCalls: 1,
      sqlWriteStatements: 0,
    });
    // Second delete when already null is a no-op
    expect(await restarted.syncPlatformAlarm(null, 2_500)).toBe(false);
    expect(h.getMetrics().deleteAlarmCalls).toBe(1);

    // 5. OPT-3: Healthy runAlarmCycle when alarm_fail_count === 0 performs 0 SQLite row updates
    const noopQueues = {
      durable_turn: { send: async () => Promise.resolve() },
      agent_task: { send: async () => Promise.resolve() },
    };
    const noopBudget = {
      settleGlobal: async () => Promise.resolve({ applied: true }),
    };
    h.resetCounters();
    await restarted.runAlarmCycle({ nowMs: 3_000, queues: noopQueues, globalBudget: noopBudget });
    expect(h.getMetrics().sqlChangesTotal).toBe(0);

    // After failure (alarm_fail_count = 1), next healthy cycle resets it back to 0 (1 change)
    expect(restarted.recordAlarmFailureSync(3_500)).toBe(1);
    h.resetCounters();
    await restarted.runAlarmCycle({ nowMs: 4_000, queues: noopQueues, globalBudget: noopBudget });
    expect(h.getMetrics().sqlChangesTotal).toBe(1);
    expect(coverage.getCoverageRowSync()?.alarm_fail_count).toBe(0);

    // 6. Concurrent syncPlatformAlarm calls serialize in FIFO order and recover after error
    h.setGetAlarmDelayMs(15);
    h.setFailNextSetAlarm(true);
    const p1 = restarted.syncPlatformAlarm(90_000, 5_000).catch((e: Error) => e.message);
    const p2 = restarted.syncPlatformAlarm(40_000, 5_000);
    const p3 = restarted.syncPlatformAlarm(15_000, 5_000);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('injected setAlarm failure');
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(h.getMetrics().armedAlarm).toBe(15_000);

    h.db.close();
  });

  it('OPT-4 deterministic concurrency: stale null or stale later syncPlatformAlarm never deletes or postpones a concurrently committed earlier alarm', async () => {
    const h = createSqliteDoHarness(10_000);
    applyAgentHeadMigrations(h.storage, createDefaultAgentHeadMigrations(), 1_000);

    let activeBusinessDueAtMs: number | null = null;
    const stubBusiness: AuthoritativeBusinessPort = {
      earliestRequiredDiscoveryAtMsSync: () => activeBusinessDueAtMs,
      listDueBusinessActionsSync: () =>
        activeBusinessDueAtMs === null
          ? []
          : [
              {
                targetKind: 'turn',
                targetId: 'turn-concurrent',
                actionKind: 'lease_expired',
                deadlineAtMs: activeBusinessDueAtMs,
              },
            ],
      inspectOutboxTargetSync: () => ({
        exists: false,
        targetKind: null,
        targetId: null,
        currentLeaseEpoch: 0,
        deadlineAtMs: 0,
        isTerminal: true,
        cancelRequested: false,
      }),
      convergeDueBusinessItemSync: () => {},
      materializeScheduleOccurrenceSync: () => {},
    };

    // Gate the first getAlarm() call deterministically so we can commit new work mid-flight
    let releaseGate!: () => void;
    let enteredGate!: () => void;
    const gateEntered = new Promise<void>((resolve) => {
      enteredGate = resolve;
    });
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateArmed = false;

    const gatedStorage: DurableObjectStorageLike = {
      ...h.storage,
      async getAlarm(): Promise<number | null> {
        if (gateArmed) {
          gateArmed = false;
          enteredGate();
          await gatePromise;
        }
        return h.storage.getAlarm();
      },
    };

    const outbox = new OutboxCoordinator(gatedStorage.sql, {
      storage: gatedStorage,
      business: stubBusiness,
    });
    const schedules = new ScheduleRepository(gatedStorage.sql);
    const coverage = new RecoveryCoverageCoordinator({
      storage: gatedStorage,
      tenantId: 'ten-1',
      agentId: 'ag-1',
      business: stubBusiness,
    });
    const multiplexer = new AlarmMultiplexer({
      storage: gatedStorage,
      business: stubBusiness,
      coordinator: outbox,
      schedules,
      coverage,
    });

    // Case A: Stale `null` target vs concurrently committed obligation at 10_000
    h.resetCounters();
    gateArmed = true;
    const staleDeleteCall = multiplexer.syncPlatformAlarm(null, 2_000);
    await gateEntered;

    // Concurrent task commits while stale caller is paused at getAlarm()
    activeBusinessDueAtMs = 10_000;
    const concurrentArmCall = multiplexer.syncPlatformAlarm(10_000, 2_000);
    releaseGate();

    await Promise.all([staleDeleteCall, concurrentArmCall]);
    expect(h.getMetrics().armedAlarm).toBe(10_000);
    expect(h.getMetrics().deleteAlarmCalls).toBe(0);

    // Case B: Stale later target (50_000) vs concurrently committed earlier obligation (10_000)
    const staleLaterChanged = await multiplexer.syncPlatformAlarm(50_000, 2_500);
    expect(staleLaterChanged).toBe(false);
    expect(h.getMetrics().armedAlarm).toBe(10_000);

    // Case C: Once the DB obligation clears, null deletes the alarm cleanly
    activeBusinessDueAtMs = null;
    expect(await multiplexer.syncPlatformAlarm(null, 3_000)).toBe(true);
    expect(h.getMetrics().armedAlarm).toBeNull();
    expect(h.getMetrics().deleteAlarmCalls).toBe(1);

    h.db.close();
  });
});
