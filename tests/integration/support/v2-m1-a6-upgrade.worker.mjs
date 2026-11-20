import { DurableObject } from 'cloudflare:workers';
import {
  applyAgentHeadMigrations,
  createDefaultAgentHeadMigrations,
} from '../../../packages/runtime-v2/dist/index.js';
import { GlobalBudgetLedger } from '../../../packages/runtime-v2/dist/global-budget/ledger.js';
import { GLOBAL_BUDGET_WITHOUT_ROWID_UPGRADE_STATEMENTS } from '../../../packages/runtime-v2/dist/global-budget/schema.js';

const LEGACY_GLOBAL_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_spend_days (
  utc_day TEXT PRIMARY KEY,
  ceiling_micro_usd INTEGER NOT NULL CHECK (ceiling_micro_usd >= 0),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  consumed_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (consumed_micro_usd >= 0),
  overage_micro_usd TEXT NOT NULL DEFAULT '0',
  CHECK (reserved_micro_usd + consumed_micro_usd <= ceiling_micro_usd)
) STRICT;

CREATE TABLE IF NOT EXISTS global_budget_reservations (
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

CREATE INDEX IF NOT EXISTS idx_global_budget_expiry
  ON global_budget_reservations (expires_at_ms, operation_id) WHERE state = 'reserved';

CREATE TABLE IF NOT EXISTS global_budget_settlements (
  operation_id TEXT NOT NULL REFERENCES global_budget_reservations (operation_id),
  settlement_revision INTEGER NOT NULL CHECK (settlement_revision >= 0),
  payload_json TEXT NOT NULL,
  cumulative_charge_micro_usd INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,
  day_overage_delta_micro_usd INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (operation_id, settlement_revision)
) STRICT;

CREATE TABLE IF NOT EXISTS global_budget_incidents (
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

CREATE INDEX IF NOT EXISTS idx_global_budget_halt
  ON global_budget_incidents (incident_id) WHERE resolved_at_ms IS NULL;
`;

export class UpgradeTestAgentHeadDO extends DurableObject {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get('mode') ?? this.env.UPGRADE_MODE;
    const storage = this.ctx.storage;
    const sql = storage.sql;
    const allMigrations = createDefaultAgentHeadMigrations();
    const preV5 = allMigrations.filter((m) => m.version < 5);

    if (mode === 'seed_legacy') {
      const res = applyAgentHeadMigrations(storage, preV5, 1_000);
      storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO conversations (id, kind, last_sequence, transcript_epoch, created_at_ms, updated_at_ms)
           VALUES ('conv-1', 'main', 3, 0, 1000, 1000)`,
        );
        sql.exec(
          `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
           VALUES ('msg-u1', 'conv-1', 1, 'user', 'hello', 'sub-1', 1000)`,
        );
        sql.exec(
          `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, model_label, simulated, created_at_ms)
           VALUES ('msg-e1', 'conv-1', 2, 'ember', 'hi there', 'fake-1', 1, 1100)`,
        );
        sql.exec(
          `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
           VALUES ('msg-u2', 'conv-1', 3, 'user', 'active turn', 'sub-2', 1200)`,
        );
        sql.exec(
          `INSERT INTO assistant_turns (
             id, conversation_id, source_message_id, response_message_id, status,
             execution_mode, deadline_at_ms, lease_epoch, lease_owner, lease_expires_at_ms,
             claim_count, created_at_ms, updated_at_ms
           ) VALUES
             ('turn-done', 'conv-1', 'msg-u1', 'msg-e1', 'completed', 'durable_queue', 60000, 2, NULL, NULL, 1, 1000, 1100),
             ('turn-active', 'conv-1', 'msg-u2', NULL, 'running', 'durable_queue', 120000, 1, 'worker-live', 90000, 1, 1200, 1200)`,
        );
        sql.exec(
          `INSERT INTO model_attempts (
             subject_type, subject_id, attempt_no, operation_id, principal_id, utc_day,
             lease_epoch, provider_id, model_label, rate_version, budget_mode, state,
             reserved_micro_usd, applied_cost_micro_usd, observed_cost_micro_usd, started_at_ms, settled_at_ms
           ) VALUES
             ('turn', 'turn-done', 1, 'op-settled', 'prin-1', '2026-11-20', 1, 'fake', 'fake-1', 'v1', 'simulated_full_protocol', 'settled', 250, 300, 300, 1000, 1100),
             ('turn', 'turn-active', 1, 'op-active', 'prin-1', '2026-11-20', 1, 'fake', 'fake-1', 'v1', 'simulated_full_protocol', 'reserved', 250, 0, NULL, 1200, NULL)`,
        );
        sql.exec(
          `INSERT INTO agent_spend_days (
             scope_kind, scope_id, utc_day, reserved_micro_usd, consumed_micro_usd,
             overage_micro_usd, turns_started, updated_at_ms
           ) VALUES
             ('tenant', 'ten-1', '2026-11-20', 250, 300, 50, 0, 1200),
             ('principal', 'prin-1', '2026-11-20', 250, 300, 50, 2, 1200)`,
        );
        sql.exec(
          `INSERT INTO agent_budget_incidents (
             id, scope_kind, scope_id, utc_day, reason, subject_type, subject_id, attempt_no,
             observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd, detected_at_ms
           ) VALUES
             ('inc-1', 'tenant', 'ten-1', '2026-11-20', 'reservation_exceeded', 'turn', 'turn-done', 1, 300, 300, 50, 250, 1100)`,
        );
        sql.exec(
          `INSERT INTO v2_dispatch_outbox (
             outbox_id, entity_kind, entity_id, queue_name, payload_json, operation_id, revision,
             state, next_attempt_at_ms, publish_attempts, dlq_count, fence_epoch, created_at_ms, updated_at_ms
           ) VALUES
             ('turn:turn-active:epoch:1', 'turn', 'turn-active', 'durable_turn', '{}', NULL, 0, 'pending', 1200, 0, 0, 1, 1200, 1200),
             ('budget_sync:op-settled:rev:0', 'budget_sync', 'op-settled', NULL, '{}', 'op-settled', 0, 'pending', 1100, 0, 0, 1, 1100, 1100)`,
        );
        sql.exec(
          `INSERT INTO tasks (
             id, kind, input_json, digest, idempotency_key, status, execution_path,
             execution_target, next_run_at_ms, created_at_ms, updated_at_ms
           ) VALUES ('task-dev-1', 'mock.compute', '{}', 'dig-1', 'idem-1', 'queued', 'standard', 'device', 1200, 1200, 1200)`,
        );
        sql.exec(
          `INSERT INTO device_registrations (id, principal_id, token_digest, capability, capability_version, ready_until_ms)
           VALUES ('dev-1', 'prin-1', 'tok-1', 'ios.native', 1, 900000)`,
        );
        sql.exec(
          `INSERT INTO device_task_placements (task_id, principal_id, device_id, capability, capability_version)
           VALUES ('task-dev-1', 'prin-1', 'dev-1', 'device.text.process', 1)`,
        );
      });

      return Response.json({
        ok: true,
        appliedVersions: res.appliedVersions,
        turnsCount: sql.exec('SELECT COUNT(*) AS c FROM assistant_turns').one().c,
        outboxCount: sql.exec('SELECT COUNT(*) AS c FROM v2_dispatch_outbox').one().c,
        attemptsCount: sql.exec('SELECT COUNT(*) AS c FROM model_attempts').one().c,
        incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM agent_budget_incidents').one().c,
        devicePlacementsCount: sql.exec('SELECT COUNT(*) AS c FROM device_task_placements').one().c,
      });
    }

    if (mode === 'fail_upgrade') {
      const v5 = allMigrations.find((m) => m.version === 5);
      const failingV5 = {
        ...v5,
        statements: [
          ...v5.statements.slice(0, 8),
          'INSERT INTO nonexistent_rollback_trigger VALUES (1);',
        ],
        checksum: undefined,
      };
      let threw = false;
      try {
        applyAgentHeadMigrations(storage, [...preV5, failingV5], 2_000);
      } catch {
        threw = true;
      }
      const appliedVersionsInDb = sql
        .exec('SELECT version FROM schema_migrations ORDER BY version ASC')
        .toArray()
        .map((r) => r.version);
      const tempTables = sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v4'`)
        .toArray();
      const turnDdl = sql
        .exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assistant_turns'`)
        .one().sql;
      const fkViolations = sql.exec('PRAGMA foreign_key_check').toArray().length;

      return Response.json({
        threw,
        appliedVersionsInDb,
        hasLeftoverV4TempTables: tempTables.length > 0,
        assistantTurnsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(turnDdl)),
        turnsCount: sql.exec('SELECT COUNT(*) AS c FROM assistant_turns').one().c,
        outboxCount: sql.exec('SELECT COUNT(*) AS c FROM v2_dispatch_outbox').one().c,
        attemptsCount: sql.exec('SELECT COUNT(*) AS c FROM model_attempts').one().c,
        incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM agent_budget_incidents').one().c,
        fkViolations,
      });
    }

    // upgrade_v4
    const upRes = applyAgentHeadMigrations(storage, allMigrations, 3_000);
    const replayRes = applyAgentHeadMigrations(storage, allMigrations, 3_500);
    const withoutRowidTables = {};
    for (const table of [
      'assistant_turns',
      'model_attempts',
      'agent_spend_days',
      'v2_dispatch_outbox',
    ]) {
      const ddl = sql
        .exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
        .one().sql;
      withoutRowidTables[table] = /\bWITHOUT\s+ROWID\b/i.test(String(ddl));
    }

    let rejectsDupRespMsg = false;
    try {
      storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO conversation_messages (id, conversation_id, sequence, kind, text, client_submission_id, created_at_ms)
           VALUES ('msg-u3', 'conv-1', 4, 'user', 'dup test', 'sub-3', 3100)`,
        );
        sql.exec(
          `INSERT INTO assistant_turns (
             id, conversation_id, source_message_id, response_message_id, status,
             execution_mode, deadline_at_ms, lease_epoch, claim_count, created_at_ms, updated_at_ms
           ) VALUES ('turn-dup', 'conv-1', 'msg-u3', 'msg-e1', 'completed', 'durable_queue', 150000, 1, 0, 3100, 3100)`,
        );
      });
    } catch {
      rejectsDupRespMsg = true;
    }

    let rejectsOrphanFk = false;
    try {
      sql.exec(
        `INSERT INTO assistant_turns (
           id, conversation_id, source_message_id, response_message_id, status,
           execution_mode, deadline_at_ms, lease_epoch, claim_count, created_at_ms, updated_at_ms
         ) VALUES ('turn-fk', 'missing-conv', 'missing-msg', NULL, 'running', 'durable_queue', 150000, 1, 0, 3100, 3100)`,
      );
    } catch {
      rejectsOrphanFk = true;
    }

    const activeLeaseTurn =
      sql
        .exec(
          `SELECT id, status, lease_owner, lease_expires_at_ms FROM assistant_turns WHERE id = 'turn-active'`,
        )
        .toArray()[0] ?? null;
    const pendingOutboxIds = sql
      .exec(
        `SELECT outbox_id FROM v2_dispatch_outbox WHERE state = 'pending' ORDER BY outbox_id ASC`,
      )
      .toArray()
      .map((r) => r.outbox_id);
    const unsettledAttempt =
      sql
        .exec(
          `SELECT operation_id, state, reserved_micro_usd FROM model_attempts WHERE operation_id = 'op-active'`,
        )
        .toArray()[0] ?? null;

    return Response.json({
      ok: true,
      appliedVersions: upRes.appliedVersions,
      alreadyAppliedVersions: upRes.alreadyAppliedVersions,
      replayAppliedVersions: replayRes.appliedVersions,
      hasDupMsgIndex:
        sql
          .exec(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_conv_seq'`,
          )
          .toArray().length > 0,
      hasPartialRespIndex:
        sql
          .exec(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_turns_response_message'`,
          )
          .toArray().length > 0,
      hasOpRevIndex:
        sql
          .exec(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_v2_outbox_budget_sync_op_rev'`,
          )
          .toArray().length > 0,
      withoutRowidTables,
      historicalMessagesCount: sql.exec('SELECT COUNT(*) AS c FROM conversation_messages').one().c,
      activeLeaseTurn,
      pendingOutboxIds,
      unsettledAttempt,
      spendDayCount: sql.exec('SELECT COUNT(*) AS c FROM agent_spend_days').one().c,
      incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM agent_budget_incidents').one().c,
      devicePlacementsCount: sql.exec('SELECT COUNT(*) AS c FROM device_task_placements').one().c,
      nativeDevicePlacement:
        sql
          .exec(
            `SELECT task_id, capability, capability_version FROM device_task_placements WHERE task_id = 'task-dev-1'`,
          )
          .toArray()[0] ?? null,
      fkViolations: sql.exec('PRAGMA foreign_key_check').toArray().length,
      rejectsDupRespMsg,
      rejectsOrphanFk,
    });
  }
}

export class UpgradeTestGlobalBudgetDO extends DurableObject {
  async fetch(request) {
    const mode = new URL(request.url).searchParams.get('mode') ?? this.env.UPGRADE_MODE;
    const storage = this.ctx.storage;
    const sql = storage.sql;

    if (mode === 'seed_legacy') {
      storage.transactionSync(() => {
        sql.exec(LEGACY_GLOBAL_BUDGET_SCHEMA);
        sql.exec(
          `INSERT INTO global_spend_days (utc_day, ceiling_micro_usd, reserved_micro_usd, consumed_micro_usd, overage_micro_usd)
           VALUES ('2026-11-20', 1000000, 250, 300, '0')`,
        );
        sql.exec(
          `INSERT INTO global_budget_reservations (
             operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
             utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
             expires_at_ms, authorized_at_ms, state, cumulative_charge_micro_usd, overage_micro_usd
           ) VALUES
             ('op-settled', 'grant-settled', 'ten-1', 'prin-1', 'ag-1', 1, '2026-11-20', 250, 1000000, 50000, 50000, 1000, 'settled', 300, 50),
             ('op-active', 'grant-active', 'ten-1', 'prin-1', 'ag-1', 1, '2026-11-20', 250, 1000000, 9999999999999, 9999999999999, NULL, 'reserved', 0, 0)`,
        );
        sql.exec(
          `INSERT INTO global_budget_settlements (
             operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
             delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
           ) VALUES ('op-settled', 0, '["settled",300,300,"reservation_exceeded"]', 300, 300, 0, 2000)`,
        );
        sql.exec(
          `INSERT INTO global_budget_incidents (
             incident_id, operation_id, settlement_revision, reason, opened_at_ms
           ) VALUES (1, 'op-settled', 0, 'reservation_exceeded', 2000)`,
        );
      });

      const ddl = sql
        .exec(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'global_budget_reservations'`,
        )
        .one().sql;
      return Response.json({
        ok: true,
        reservationsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(ddl)),
        reservationsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_reservations').one().c,
        settlementsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_settlements').one().c,
        incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_incidents').one().c,
      });
    }

    if (mode === 'fail_upgrade') {
      let threw = false;
      sql.exec('PRAGMA foreign_keys = OFF');
      try {
        storage.transactionSync(() => {
          for (const stmt of GLOBAL_BUDGET_WITHOUT_ROWID_UPGRADE_STATEMENTS.slice(0, 6)) {
            sql.exec(stmt);
          }
          sql.exec('INSERT INTO nonexistent_gb_rollback_trigger VALUES (1)');
        });
      } catch {
        threw = true;
      } finally {
        sql.exec('PRAGMA foreign_keys = ON');
      }

      const ddl = sql
        .exec(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'global_budget_reservations'`,
        )
        .one().sql;
      const tempTables = sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v2'`)
        .toArray();
      return Response.json({
        threw,
        reservationsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(ddl)),
        hasLeftoverV2TempTables: tempTables.length > 0,
        reservationsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_reservations').one().c,
        settlementsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_settlements').one().c,
        incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_incidents').one().c,
        fkViolations: sql.exec('PRAGMA foreign_key_check').toArray().length,
      });
    }

    // upgrade_v4: instantiate real production GlobalBudgetLedger -> upgrades in place!
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    const ledger = new GlobalBudgetLedger(
      storage,
      () => nowMs,
      () => 'grant-post-upgrade',
      1_000_000,
    );

    const haltedRes = ledger.reserveGlobal({
      tenantId: 'ten-1',
      principalId: 'prin-1',
      agentId: 'ag-1',
      operationId: 'op-halted',
      leaseEpoch: 1,
      utcDay: '2026-11-20',
      amountMicroUsd: 100,
      ceilingMicroUsd: 1_000_000,
      expiresAtMs: nowMs + 60_000,
    });
    const haltedBeforeResolve = haltedRes.kind === 'budget_halted';

    ledger.resolveIncident(1, 'admin-test', 'resolved after upgrade');

    const resv = ledger.reserveGlobal({
      tenantId: 'ten-1',
      principalId: 'prin-1',
      agentId: 'ag-1',
      operationId: 'op-post-upgrade',
      leaseEpoch: 1,
      utcDay: '2026-11-20',
      amountMicroUsd: 200,
      ceilingMicroUsd: 1_000_000,
      expiresAtMs: nowMs + 60_000,
    });
    const auth =
      resv.kind === 'reserved'
        ? ledger.authorizeGlobalSend({
            tenantId: 'ten-1',
            operationId: 'op-post-upgrade',
            globalGrantId: resv.globalGrantId,
          })
        : { authorized: false };
    const settled =
      resv.kind === 'reserved' && auth.authorized
        ? ledger.settleGlobal({
            tenantId: 'ten-1',
            operationId: 'op-post-upgrade',
            settlementRevision: 0,
            globalGrantId: resv.globalGrantId,
            state: 'settled',
            observedCostMicroUsd: 120,
            chargeMicroUsd: 120,
            reservedMicroUsd: 200,
          })
        : { applied: false };

    let rejectsDupGrantId = false;
    try {
      sql.exec(
        `INSERT INTO global_budget_reservations (
           operation_id, global_grant_id, tenant_id, principal_id, agent_id, lease_epoch,
           utc_day, amount_micro_usd, request_ceiling_micro_usd, initial_expires_at_ms,
           expires_at_ms, state
         ) VALUES (
           'op-dup-grant', 'grant-settled', 'ten-1', 'prin-1', 'ag-1', 1,
           '2026-11-20', 100, 1000000, 50000, 50000, 'reserved'
         )`,
      );
    } catch {
      rejectsDupGrantId = true;
    }

    let rejectsOrphanSettlementFk = false;
    try {
      sql.exec(
        `INSERT INTO global_budget_settlements (
           operation_id, settlement_revision, payload_json, cumulative_charge_micro_usd,
           delta_micro_usd, day_overage_delta_micro_usd, received_at_ms
         ) VALUES ('missing-op', 0, '[]', 0, 0, 0, 5000)`,
      );
    } catch {
      rejectsOrphanSettlementFk = true;
    }

    const resDdl = sql
      .exec(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'global_budget_reservations'`,
      )
      .one().sql;
    const setDdl = sql
      .exec(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'global_budget_settlements'`,
      )
      .one().sql;
    const unsettledRow = sql
      .exec(`SELECT state FROM global_budget_reservations WHERE operation_id = 'op-active'`)
      .toArray()[0];

    return Response.json({
      ok: true,
      reservationsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(resDdl)),
      settlementsWithoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(setDdl)),
      reservationsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_reservations').one().c,
      settlementsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_settlements').one().c,
      incidentsCount: sql.exec('SELECT COUNT(*) AS c FROM global_budget_incidents').one().c,
      unsettledReservationState: unsettledRow?.state ?? null,
      haltedBeforeResolve,
      postResolveSettled: settled.applied === true,
      rejectsDupGrantId,
      rejectsOrphanSettlementFk,
      fkViolations: sql.exec('PRAGMA foreign_key_check').toArray().length,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/agent/run') {
      const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('upgrade-agent-1'));
      return stub.fetch(request);
    }
    if (url.pathname === '/gb/run') {
      const stub = env.GLOBAL_BUDGET.get(env.GLOBAL_BUDGET.idFromName('global'));
      return stub.fetch(request);
    }
    return new Response('not-found', { status: 404 });
  },
};
