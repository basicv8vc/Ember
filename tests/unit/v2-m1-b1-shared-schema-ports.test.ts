import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applyAgentHeadMigrations,
  applyD1RecoveryMigrations,
  assertValidDispatchEnvelope,
  computeMigrationChecksumSync,
  computePreDeadlineRetryAtMs,
  createEventRecoveryDoMigration,
  EVENT_RECOVERY_DO_MIGRATION,
  MAX_FENCE_EPOCH,
  MigrationChecksumMismatchError,
  OutboxConstraintError,
  validateBudgetSyncOutboxPayload,
  validateDispatchEnvelope,
  validateOutboxEnqueueCommand,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type DurableObjectStorageLike,
  type SqlStorageCursorLike,
  type SqlStorageRow,
  type SqlStorageValue,
  type V2DispatchEnvelope,
} from '@ember/runtime-v2';

function createNodeSqliteDoStorage(): { db: DatabaseSync; storage: DurableObjectStorageLike } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  const execSql = <T extends SqlStorageRow = SqlStorageRow>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> => {
    const stmt = db.prepare(query);
    const params = bindings as Array<string | number | Uint8Array | null>;
    const isRead = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query);
    const rows = (isRead ? stmt.all(...params) : []) as T[];
    if (!isRead) {
      stmt.run(...params);
    }
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`Expected exactly 1 row, got ${rows.length}`);
        }
        return rows[0]!;
      },
      rowsRead: rows.length,
      rowsWritten: isRead ? 0 : 1,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };

  let inTx = false;
  const storage: DurableObjectStorageLike = {
    sql: { exec: execSql },
    transactionSync<T>(closure: () => T): T {
      if (inTx) {
        return closure();
      }
      inTx = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTx = false;
      }
    },
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };

  return { db, storage };
}

function createNodeSqliteD1(): { db: DatabaseSync; d1: D1DatabaseLike } {
  const db = new DatabaseSync(':memory:');

  const makeStatement = (query: string, bound: unknown[] = []): D1PreparedStatementLike => ({
    bind: (...values: unknown[]) => makeStatement(query, values),
    first: <T = Record<string, unknown>>(colName?: string): Promise<T | null> => {
      const row = db
        .prepare(query)
        .get(...(bound as Array<string | number | Uint8Array | null>)) as
        Record<string, unknown> | undefined;
      if (!row) {
        return Promise.resolve(null);
      }
      if (colName !== undefined) {
        return Promise.resolve((row[colName] as T | undefined) ?? null);
      }
      return Promise.resolve(row as T);
    },
    run: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const info = db.prepare(query).run(...(bound as Array<string | number | Uint8Array | null>));
      return Promise.resolve({
        results: [],
        success: true,
        meta: { changes: Number(info.changes) },
      });
    },
    all: <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => {
      const rows = db
        .prepare(query)
        .all(...(bound as Array<string | number | Uint8Array | null>)) as T[];
      return Promise.resolve({ results: rows, success: true });
    },
  });

  const d1: D1DatabaseLike = {
    prepare: (query: string) => makeStatement(query),
    batch: async <T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) => {
      const results: Array<D1ResultLike<T>> = [];
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      return results;
    },
  };

  return { db, d1 };
}

describe('V2-M1-B1 shared schema, migrations, envelope, and ports', () => {
  it('applies Agent A and Agent B migrations through a single idempotent AgentHeadDO entrypoint and fails closed on checksum drift', () => {
    const { db, storage } = createNodeSqliteDoStorage();
    const agentAMigration = {
      version: 1,
      name: 'agent_a_business_core',
      statements: [
        `CREATE TABLE IF NOT EXISTS agent_head_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant_id TEXT NOT NULL,
          agent_id TEXT NOT NULL
        );`,
      ],
    };

    // Pass unsorted to confirm deterministic ascending version ordering
    const firstRun = applyAgentHeadMigrations(
      storage,
      [EVENT_RECOVERY_DO_MIGRATION, agentAMigration],
      1_700_000_000_000,
    );
    expect(firstRun.appliedVersions).toEqual([1, 2]);
    expect(firstRun.alreadyAppliedVersions).toEqual([]);

    const secondRun = applyAgentHeadMigrations(
      storage,
      [agentAMigration, EVENT_RECOVERY_DO_MIGRATION],
      1_700_000_005_000,
    );
    expect(secondRun.appliedVersions).toEqual([]);
    expect(secondRun.alreadyAppliedVersions).toEqual([1, 2]);

    const recorded = db
      .prepare(
        'SELECT version, applied_at_ms, checksum FROM schema_migrations ORDER BY version ASC',
      )
      .all() as Array<{ version: number; applied_at_ms: number; checksum: string }>;
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.applied_at_ms).toBe(1_700_000_000_000);
    expect(recorded[1]?.checksum).toBe(
      computeMigrationChecksumSync(createEventRecoveryDoMigration().statements),
    );

    const driftedMigration = {
      ...agentAMigration,
      statements: ['CREATE TABLE agent_head_meta (id INTEGER PRIMARY KEY);'],
    };
    expect(() =>
      applyAgentHeadMigrations(
        storage,
        [driftedMigration, EVENT_RECOVERY_DO_MIGRATION],
        1_700_000_010_000,
      ),
    ).toThrow(MigrationChecksumMismatchError);

    db.close();
  });

  it('enforces initial revision=0, ordinary non-null queue_name, and budget_sync SQLite CHECK constraints', () => {
    const { db, storage } = createNodeSqliteDoStorage();
    applyAgentHeadMigrations(storage, [EVENT_RECOVERY_DO_MIGRATION], 1_700_000_000_000);

    // Ordinary dispatch defaults revision to 0 and rejects queue_name IS NULL or unknown queue
    storage.sql.exec(
      `INSERT INTO v2_dispatch_outbox (
        outbox_id, entity_kind, entity_id, queue_name, payload_json, state,
        next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'out-turn-1',
      'turn',
      'turn-1',
      'durable_turn',
      '{}',
      'pending',
      1_000,
      1,
      1_000,
      1_000,
    );
    const revRow = db
      .prepare('SELECT revision FROM v2_dispatch_outbox WHERE outbox_id = ?')
      .get('out-turn-1') as { revision: number };
    expect(revRow.revision).toBe(0);

    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_dispatch_outbox (
          outbox_id, entity_kind, entity_id, queue_name, payload_json, state,
          next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'out-turn-null-q',
        'turn',
        'turn-2',
        null,
        '{}',
        'pending',
        1_000,
        1,
        1_000,
        1_000,
      ),
    ).toThrow(/CHECK constraint failed/);

    // budget_sync rejects non-null queue_name, missing operation_id, negative revision, and duplicate (operation_id, revision)
    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_dispatch_outbox (
          outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
          revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'out-budget-on-queue',
        'budget_sync',
        'op-1',
        'durable_turn',
        '{}',
        'op-1',
        0,
        'pending',
        1_000,
        0,
        1_000,
        1_000,
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_dispatch_outbox (
          outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
          revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'out-budget-no-op',
        'budget_sync',
        'op-1',
        null,
        '{}',
        null,
        0,
        'pending',
        1_000,
        0,
        1_000,
        1_000,
      ),
    ).toThrow(/CHECK constraint failed/);

    storage.sql.exec(
      `INSERT INTO v2_dispatch_outbox (
        outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
        revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'out-budget-rev0',
      'budget_sync',
      'op-1',
      null,
      '{}',
      'op-1',
      0,
      'pending',
      1_000,
      0,
      1_000,
      1_000,
    );

    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_dispatch_outbox (
          outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
          revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'out-budget-rev0-dup',
        'budget_sync',
        'op-1',
        null,
        '{}',
        'op-1',
        0,
        'pending',
        1_000,
        0,
        1_000,
        1_000,
      ),
    ).toThrow(/UNIQUE constraint failed/);

    // Late cumulative correction uses revision >= 1 for the same operation_id
    storage.sql.exec(
      `INSERT INTO v2_dispatch_outbox (
        outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id,
        revision, state, next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'out-budget-rev1',
      'budget_sync',
      'op-1',
      null,
      '{}',
      'op-1',
      1,
      'pending',
      1_000,
      0,
      1_000,
      1_000,
    );

    // Recovery coverage singleton and pending invariants
    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_recovery_coverage (
          id, tenant_id, agent_id, generation, coverage_state, covered_recovery_at_ms, updated_at_ms
        ) VALUES (2, 't1', 'a1', 1, 'covered', 5000, 1000)`,
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      storage.sql.exec(
        `INSERT INTO v2_recovery_coverage (
          id, tenant_id, agent_id, generation, coverage_state, covered_recovery_at_ms, updated_at_ms
        ) VALUES (1, 't1', 'a1', 1, 'covered', NULL, 1000)`,
      ),
    ).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('initializes D1 v2_recovery_registry and keeps quarantined entries in idx_v2_recovery_due', async () => {
    const { db, d1 } = createNodeSqliteD1();
    const res1 = await applyD1RecoveryMigrations(d1, 1_700_000_000_000);
    expect(res1.appliedVersions).toEqual([1]);
    const res2 = await applyD1RecoveryMigrations(d1, 1_700_000_001_000);
    expect(res2.alreadyAppliedVersions).toEqual([1]);

    await d1
      .prepare(
        `INSERT INTO v2_recovery_registry (
          agent_key, tenant_id, agent_id, generation, next_recovery_at_ms,
          retry_not_before_ms, status, recovery_attempts, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('t1:a1', 't1', 'a1', 3, 2_000, 9_000, 'quarantined', 6, 1_500)
      .run();

    const dueRow = await d1
      .prepare(
        `SELECT agent_key, status, next_recovery_at_ms, retry_not_before_ms
         FROM v2_recovery_registry
         WHERE status IN ('armed', 'backoff', 'quarantined') AND next_recovery_at_ms <= ?`,
      )
      .bind(3_000)
      .first<{
        agent_key: string;
        status: string;
        next_recovery_at_ms: number;
        retry_not_before_ms: number;
      }>();

    expect(dueRow).toEqual({
      agent_key: 't1:a1',
      status: 'quarantined',
      next_recovery_at_ms: 2_000,
      retry_not_before_ms: 9_000,
    });
    db.close();
  });

  it('enforces closed V2DispatchEnvelope and outbox enqueue validation rules', () => {
    const validEnvelope: V2DispatchEnvelope = {
      schemaVersion: 2,
      eventId: 'out-1',
      tenantId: 'tenant-a',
      agentId: 'agent-1',
      entityKind: 'turn',
      entityId: 'turn-1',
      queueName: 'durable_turn',
      fenceEpoch: 3,
    };

    expect(assertValidDispatchEnvelope(validEnvelope)).toEqual(validEnvelope);

    expect(
      validateDispatchEnvelope({
        ...validEnvelope,
        prompt: 'secret prompt must never traverse queue',
      }),
    ).toMatchObject({ ok: false, code: 'ENVELOPE_UNKNOWN_FIELD' });

    expect(
      validateDispatchEnvelope({
        ...validEnvelope,
        entityKind: 'budget_sync',
      }),
    ).toMatchObject({ ok: false, code: 'BUDGET_SYNC_FORBIDDEN_ON_QUEUE' });

    expect(
      validateDispatchEnvelope({
        ...validEnvelope,
        queueName: null,
      }),
    ).toMatchObject({ ok: false, code: 'ENVELOPE_INVALID_QUEUE_NAME' });

    expect(
      validateDispatchEnvelope({
        ...validEnvelope,
        fenceEpoch: MAX_FENCE_EPOCH + 1,
      }),
    ).toMatchObject({ ok: false, code: 'ENVELOPE_INVALID_FENCE_EPOCH' });

    const validatedOrdinary = validateOutboxEnqueueCommand({
      outboxId: 'out-1',
      entityKind: 'turn',
      entityId: 'turn-1',
      queueName: 'durable_turn',
      payloadJson: JSON.stringify(validEnvelope),
      fenceEpoch: 3,
      nextAttemptAtMs: 1_000,
    });
    expect(validatedOrdinary.revision).toBe(0);

    expect(() =>
      validateOutboxEnqueueCommand({
        outboxId: 'out-1',
        entityKind: 'turn',
        entityId: 'turn-1',
        queueName: null,
        payloadJson: JSON.stringify(validEnvelope),
        fenceEpoch: 3,
        nextAttemptAtMs: 1_000,
      }),
    ).toThrow(OutboxConstraintError);

    const validBudgetPayload = {
      schemaVersion: 1 as const,
      tenantId: 'tenant-a',
      principalId: 'principal-1',
      agentId: 'agent-1',
      utcDay: '2026-11-19',
      globalGrantId: 'grant-1',
      operationId: 'op-99',
      settlementRevision: 0,
      state: 'settled' as const,
      reservedMicroUsd: 5_000,
      chargeMicroUsd: 3_200,
      observedCostMicroUsd: 3_200,
      overageMicroUsd: 0,
      openIncidentReason: null,
    };
    expect(validateBudgetSyncOutboxPayload(validBudgetPayload).ok).toBe(true);

    const validatedBudget = validateOutboxEnqueueCommand({
      outboxId: 'out-budget-0',
      entityKind: 'budget_sync',
      entityId: 'op-99',
      queueName: null,
      payloadJson: JSON.stringify(validBudgetPayload),
      operationId: 'op-99',
      fenceEpoch: 0,
      nextAttemptAtMs: 1_000,
    });
    expect(validatedBudget.revision).toBe(0);

    expect(() =>
      validateOutboxEnqueueCommand({
        outboxId: 'out-budget-bad',
        entityKind: 'budget_sync',
        entityId: 'op-99',
        queueName: 'agent_task',
        payloadJson: JSON.stringify(validBudgetPayload),
        operationId: 'op-99',
        fenceEpoch: 0,
        nextAttemptAtMs: 1_000,
      }),
    ).toThrow(/BUDGET_SYNC|internal routing/i);

    expect(() =>
      validateOutboxEnqueueCommand({
        outboxId: 'out-budget-bad-rev',
        entityKind: 'budget_sync',
        entityId: 'op-99',
        queueName: null,
        payloadJson: JSON.stringify({ ...validBudgetPayload, settlementRevision: 1 }),
        operationId: 'op-99',
        revision: 0,
        fenceEpoch: 0,
        nextAttemptAtMs: 1_000,
      }),
    ).toThrow(/settlementRevision/i);
  });

  it('computes 0/500/1000/1001ms pre-deadline retry boundaries accurately', () => {
    const now = 100_000;
    expect(computePreDeadlineRetryAtMs(now, now)).toEqual({
      shouldRetry: false,
      alarmAtMs: now,
      remainingMs: 0,
    });
    expect(computePreDeadlineRetryAtMs(now, now + 500)).toEqual({
      shouldRetry: false,
      alarmAtMs: now + 500,
      remainingMs: 500,
    });
    expect(computePreDeadlineRetryAtMs(now, now + 1_000)).toEqual({
      shouldRetry: false,
      alarmAtMs: now + 1_000,
      remainingMs: 1_000,
    });
    expect(computePreDeadlineRetryAtMs(now, now + 1_001)).toEqual({
      shouldRetry: true,
      nextAttemptAtMs: now + 1_000,
      remainingMs: 1_001,
    });
    expect(computePreDeadlineRetryAtMs(now, now + 10_000)).toEqual({
      shouldRetry: true,
      nextAttemptAtMs: now + 5_000,
      remainingMs: 10_000,
    });
    expect(computePreDeadlineRetryAtMs(now, now + 120_000)).toEqual({
      shouldRetry: true,
      nextAttemptAtMs: now + 60_000,
      remainingMs: 120_000,
    });
  });

  it('exports SqlStorageValue type cleanly', () => {
    const val: SqlStorageValue = null;
    expect(val).toBeNull();
  });
});
