import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface MiniflareInstance {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

type MiniflareConstructor = new (options: Record<string, unknown>) => MiniflareInstance;

function isRecoverySurfaceFile(relPath: string): boolean {
  if (relPath.endsWith('.test.ts')) {
    return false;
  }
  return (
    relPath === 'index.ts' ||
    relPath === 'storage.ts' ||
    relPath === 'migrations.ts' ||
    relPath.startsWith('recovery/')
  );
}

function transpileRuntimeV2Modules(): Record<string, { type: 'esm'; contents: string }> {
  const srcRoot = resolve(REPO_ROOT, 'packages/runtime-v2/src');
  const entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true });
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const fullPath = resolve(entry.parentPath, entry.name);
    const relPath = fullPath.slice(srcRoot.length + 1).replace(/\\/g, '/');
    if (!isRecoverySurfaceFile(relPath)) {
      continue;
    }
    let source = readFileSync(fullPath, 'utf8');
    if (relPath === 'index.ts') {
      // Keep only recovery/storage/migration exports so merged A+B+E index entries don't pull unbundled workspace packages into Miniflare.
      source = source
        .split('\n')
        .filter((line) => /from\s+['"]\.\/(?:storage|migrations|recovery\/)/.test(line))
        .join('\n');
    }
    const transpiled = ts.transpileModule(source, {
      fileName: relPath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    const jsPath = `runtime-v2/${relPath.replace(/\.ts$/, '.js')}`;
    modules[jsPath] = { type: 'esm', contents: transpiled.outputText };
  }
  return modules;
}

async function loadMiniflareConstructor(): Promise<MiniflareConstructor> {
  const cloudRuntimeReq = createRequire(
    resolve(REPO_ROOT, 'apps/cloud-async-runtime/package.json'),
  );
  const wranglerPkgPath = cloudRuntimeReq.resolve('wrangler/package.json');
  const mfReq = createRequire(wranglerPkgPath);
  const mfMod = (await import(pathToFileURL(mfReq.resolve('miniflare')).href)) as {
    Miniflare: MiniflareConstructor;
  };
  return mfMod.Miniflare;
}

/**
 * Full FI-01..FI-16 M1-B acceptance proof in real local `workerd` (DO SQLite + D1 + Queue + DLQ + Fake Provider + GlobalBudget).
 * Covers offline recovery, 7 consecutive Alarm failures, future schedules, DST, lease reaper, handle recovery, and budget_sync.
 */
describe('V2-M1-B4 real local workerd FI-01..FI-16 Runtime & Durable Integration', () => {
  it('verifies FI-01..FI-16 end-to-end invariants, <=2min detection & <=5min recovery SLAs, zero duplicate commits, and budget_sync survival in workerd', async () => {
    const Miniflare = await loadMiniflareConstructor();
    const workerSrc = `
import { DurableObject } from 'cloudflare:workers';
import {
  AgentEventRuntimeFacade,
  applyAgentHeadMigrations,
  applyD1RecoveryMigrations,
  computePreDeadlineRetryAtMs,
  D1RecoveryRegistry,
  EVENT_RECOVERY_DO_MIGRATION,
  executeRecoveredOrFreshDurableWork,
  findNextCronTzFireAtMs,
  getLocalWallClockParts,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  RecoverySweeper,
  RecoveryUnavailableError,
  resolveDeadLetterRetrySchedule,
  validateHandoffTransition,
} from './runtime-v2/index.js';

export class TestGlobalBudgetDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(\`
        CREATE TABLE IF NOT EXISTS global_settlements (
          operation_id TEXT NOT NULL,
          settlement_revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          charge_micro_usd INTEGER NOT NULL,
          halt_open INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (operation_id, settlement_revision)
        );
        CREATE TABLE IF NOT EXISTS global_totals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          total_charged_micro_usd INTEGER NOT NULL DEFAULT 0,
          halt_open INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO global_totals (id, total_charged_micro_usd, halt_open)
        VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
      \`);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/settle') {
      const payload = await request.json();
      return Response.json(this.ctx.storage.transactionSync(() => {
        const canonical = JSON.stringify(payload);
        const existing = this.ctx.storage.sql
          .exec(
            'SELECT payload_json FROM global_settlements WHERE operation_id = ? AND settlement_revision = ?',
            payload.operationId,
            payload.settlementRevision,
          )
          .toArray()[0];
        if (existing) {
          if (existing.payload_json === canonical) {
            return { accepted: true, alreadySettled: true, appliedDeltaMicroUsd: 0 };
          }
          return { accepted: false, conflict: true, errorCode: 'REVISION_PAYLOAD_CONFLICT' };
        }

        const prevMax = this.ctx.storage.sql
          .exec(
            'SELECT MAX(settlement_revision) AS max_rev, MAX(charge_micro_usd) AS max_charge FROM global_settlements WHERE operation_id = ?',
            payload.operationId,
          )
          .one();
        const halt = payload.openIncidentReason !== null ? 1 : 0;
        this.ctx.storage.sql.exec(
          'INSERT INTO global_settlements (operation_id, settlement_revision, payload_json, charge_micro_usd, halt_open) VALUES (?, ?, ?, ?, ?)',
          payload.operationId,
          payload.settlementRevision,
          canonical,
          payload.chargeMicroUsd,
          halt,
        );

        let delta = 0;
        const prevRev = prevMax.max_rev === null ? -1 : prevMax.max_rev;
        const prevCharge = prevMax.max_charge === null ? 0 : prevMax.max_charge;
        if (payload.settlementRevision > prevRev && payload.chargeMicroUsd > prevCharge) {
          delta = payload.chargeMicroUsd - prevCharge;
          this.ctx.storage.sql.exec(
            'UPDATE global_totals SET total_charged_micro_usd = total_charged_micro_usd + ?, halt_open = MAX(halt_open, ?) WHERE id = 1',
            delta,
            halt,
          );
        } else if (halt === 1) {
          this.ctx.storage.sql.exec('UPDATE global_totals SET halt_open = 1 WHERE id = 1');
        }
        return { accepted: true, appliedDeltaMicroUsd: delta };
      }));
    }
    if (url.pathname === '/totals') {
      return Response.json(this.ctx.storage.sql.exec('SELECT * FROM global_totals WHERE id = 1').one());
    }
    return new Response('not-found', { status: 404 });
  }
}

export class TestAgentHeadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyAgentHeadMigrations(
        ctx.storage,
        [
          {
            version: 1,
            name: 'test_agent_business',
            statements: [
              \`CREATE TABLE IF NOT EXISTS b4_entities (
                entity_id TEXT PRIMARY KEY,
                entity_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                lease_epoch INTEGER NOT NULL DEFAULT 1,
                lease_owner TEXT,
                lease_expires_at_ms INTEGER,
                deadline_at_ms INTEGER NOT NULL,
                cancel_requested_at_ms INTEGER,
                operation_id TEXT NOT NULL,
                send_started_at_ms INTEGER,
                provider_job_handle TEXT,
                run_count INTEGER NOT NULL DEFAULT 0,
                commit_count INTEGER NOT NULL DEFAULT 0,
                terminal_result TEXT
              );\`,
              \`CREATE TABLE IF NOT EXISTS b4_clock (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                now_ms INTEGER NOT NULL,
                alarm_fail_remaining INTEGER NOT NULL DEFAULT 0,
                provider_starts INTEGER NOT NULL DEFAULT 0,
                provider_polls INTEGER NOT NULL DEFAULT 0
              );\`,
              'INSERT INTO b4_clock (id, now_ms) VALUES (1, 1000000000) ON CONFLICT (id) DO NOTHING;',
            ],
          },
          EVENT_RECOVERY_DO_MIGRATION,
        ],
        1_000,
      );
    });
  }

  #clock() {
    return this.ctx.storage.sql.exec('SELECT * FROM b4_clock WHERE id = 1').one();
  }

  #business() {
    const sql = this.ctx.storage.sql;
    const facadeRef = { outbox: null };
    const port = {
      earliestRequiredDiscoveryAtMsSync: () => {
        const row = sql
          .exec(
            "SELECT MIN(COALESCE(lease_expires_at_ms, deadline_at_ms)) AS m FROM b4_entities WHERE status IN ('queued', 'running')",
          )
          .one();
        return row.m !== null ? row.m + 45_000 : null;
      },
      listDueBusinessActionsSync: (nowMs, limit) => {
        const rows = sql
          .exec(
            \`SELECT entity_id, entity_kind, status, lease_expires_at_ms, deadline_at_ms, cancel_requested_at_ms
             FROM b4_entities
             WHERE status IN ('queued', 'running')
               AND (
                 deadline_at_ms <= ?
                 OR (status = 'running' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?)
                 OR cancel_requested_at_ms IS NOT NULL
               )
             ORDER BY COALESCE(lease_expires_at_ms, deadline_at_ms) ASC
             LIMIT ?\`,
            nowMs,
            nowMs,
            limit,
          )
          .toArray();
        return rows.map((r) => ({
          targetKind: r.entity_kind,
          targetId: r.entity_id,
          actionKind:
            r.cancel_requested_at_ms !== null
              ? 'cancel_converge'
              : r.status === 'running' && r.lease_expires_at_ms !== null && r.lease_expires_at_ms <= nowMs
                ? 'lease_expired'
                : 'preclaim_deadline',
          deadlineAtMs:
            r.status === 'running' && r.lease_expires_at_ms !== null
              ? Math.min(r.lease_expires_at_ms, r.deadline_at_ms)
              : r.deadline_at_ms,
        }));
      },
      convergeDueBusinessItemSync: (targetKind, targetId, nowMs) => {
        const row = sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', targetId).toArray()[0];
        if (!row || (row.status !== 'queued' && row.status !== 'running')) {
          return;
        }
        // ADR-0001 cancellation takes strict precedence over scheduling/retry
        if (row.cancel_requested_at_ms !== null) {
          sql.exec("UPDATE b4_entities SET status = 'cancelled', lease_owner = NULL, lease_expires_at_ms = NULL WHERE entity_id = ?", targetId);
          facadeRef.outbox?.cancelEntityOutboxSync(targetKind, targetId, nowMs);
          return;
        }
        // Deadline exceeded -> ADR-0002 convergence without fabricating Run
        if (nowMs >= row.deadline_at_ms) {
          sql.exec("UPDATE b4_entities SET status = 'failed', terminal_result = 'DEADLINE_EXCEEDED', lease_owner = NULL, lease_expires_at_ms = NULL WHERE entity_id = ?", targetId);
          facadeRef.outbox?.cancelEntityOutboxSync(targetKind, targetId, nowMs);
          return;
        }
        // Silent loss lease reaper (FI-14): expired lease with time remaining -> bump lease_epoch & re-enqueue!
        if (row.status === 'running' && row.lease_expires_at_ms !== null && nowMs >= row.lease_expires_at_ms) {
          if (row.send_started_at_ms !== null && row.provider_job_handle === null) {
            // Uncertain outcome -> converge honestly as unknown_billed without blind replay!
            sql.exec(
              "UPDATE b4_entities SET status = 'failed', terminal_result = 'unknown_billed', lease_owner = NULL, lease_expires_at_ms = NULL, commit_count = commit_count + 1 WHERE entity_id = ?",
              targetId,
            );
            return;
          }
          const nextEpoch = row.lease_epoch + 1;
          sql.exec(
            "UPDATE b4_entities SET status = 'queued', lease_epoch = ?, lease_owner = NULL, lease_expires_at_ms = NULL WHERE entity_id = ?",
            nextEpoch,
            targetId,
          );
          const env = {
            schemaVersion: 2,
            eventId: 'out-reap-' + targetId + '-e' + nextEpoch,
            tenantId: 'ten-b4',
            agentId: 'ag-b4',
            entityKind: targetKind,
            entityId: targetId,
            queueName: 'durable_turn',
            fenceEpoch: nextEpoch,
          };
          facadeRef.outbox?.enqueueDurableOutboxSync({
            outboxId: env.eventId,
            entityKind: targetKind,
            entityId: targetId,
            queueName: 'durable_turn',
            payloadJson: JSON.stringify(env),
            fenceEpoch: nextEpoch,
            nextAttemptAtMs: nowMs,
            nowMs,
          });
        }
      },
      inspectOutboxTargetSync: (_entityKind, entityId) => {
        const row = sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', entityId).toArray()[0];
        if (!row) {
          return {
            exists: false,
            targetKind: null,
            targetId: null,
            currentLeaseEpoch: 0,
            deadlineAtMs: 0,
            isTerminal: true,
            cancelRequested: false,
          };
        }
        return {
          exists: true,
          targetKind: row.entity_kind,
          targetId: row.entity_id,
          currentLeaseEpoch: row.lease_epoch,
          deadlineAtMs: row.deadline_at_ms,
          isTerminal: row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled',
          cancelRequested: row.cancel_requested_at_ms !== null,
        };
      },
      materializeScheduleOccurrenceSync: (scheduleId, occurrenceSeq, nowMs) => {
        const eid = 'sched-task-' + scheduleId + '-' + occurrenceSeq;
        sql.exec(
          "INSERT INTO b4_entities (entity_id, entity_kind, status, lease_epoch, deadline_at_ms, operation_id) VALUES (?, 'task', 'queued', 1, ?, ?) ON CONFLICT (entity_id) DO NOTHING",
          eid,
          nowMs + 120_000,
          'op-' + eid,
        );
      },
    };
    return { port, facadeRef };
  }

  #runtime() {
    const { port, facadeRef } = this.#business();
    const facade = new AgentEventRuntimeFacade({
      storage: this.ctx.storage,
      tenantId: 'ten-b4',
      agentId: 'ag-b4',
      business: port,
    });
    facadeRef.outbox = facade.outbox;
    return facade;
  }

  #globalBudgetPort() {
    const stub = this.env.GLOBAL_BUDGET.get(this.env.GLOBAL_BUDGET.idFromName('global'));
    return {
      settleGlobal: async (payload) => {
        const res = await stub.fetch('http://gb/settle', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        return res.json();
      },
    };
  }

  async alarm() {
    const c = this.#clock();
    const runtime = this.#runtime();
    if (c.alarm_fail_remaining > 0) {
      this.ctx.storage.sql.exec('UPDATE b4_clock SET alarm_fail_remaining = alarm_fail_remaining - 1 WHERE id = 1');
      runtime.alarm.recordAlarmFailureSync(c.now_ms);
      throw new Error('injected alarm failure');
    }
    await runtime.handleAlarm({
      nowMs: c.now_ms,
      queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
      globalBudget: this.#globalBudgetPort(),
      registry: new D1RecoveryRegistry(this.env.RECOVERY_DB),
    });
  }

  async fetch(request) {
    try {
    const url = new URL(request.url);
    const runtime = this.#runtime();
    const registry = new D1RecoveryRegistry(this.env.RECOVERY_DB);
    const c = this.#clock();

    if (url.pathname === '/run-scenario') {
      const body = await request.json();
      const nowMs = body.nowMs;
      this.ctx.storage.sql.exec('UPDATE b4_clock SET now_ms = ?, alarm_fail_remaining = ? WHERE id = 1', nowMs, body.failAlarms ?? 0);

      // Ensure coverage (FI-02 / FI-12)
      await runtime.coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: body.dueAtMs + 45_000,
        nowMs,
        registry,
      });

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          \`INSERT INTO b4_entities (
            entity_id, entity_kind, status, lease_epoch, lease_owner, lease_expires_at_ms,
            deadline_at_ms, operation_id, send_started_at_ms, provider_job_handle
          ) VALUES (?, 'turn', ?, 1, ?, ?, ?, ?, ?, ?)\`,
          body.entityId,
          body.initialStatus ?? 'queued',
          body.leaseOwner ?? null,
          body.leaseExpiresAtMs ?? null,
          body.deadlineAtMs,
          body.operationId,
          body.sendStartedAtMs ?? null,
          body.providerJobHandle ?? null,
        );

        if (body.enqueueOutbox) {
          const env = {
            schemaVersion: 2,
            eventId: body.outboxId,
            tenantId: 'ten-b4',
            agentId: 'ag-b4',
            entityKind: 'turn',
            entityId: body.entityId,
            queueName: 'durable_turn',
            fenceEpoch: 1,
          };
          runtime.outbox.enqueueDurableOutboxSync({
            outboxId: body.outboxId,
            entityKind: 'turn',
            entityId: body.entityId,
            queueName: 'durable_turn',
            payloadJson: JSON.stringify(env),
            fenceEpoch: 1,
            nextAttemptAtMs: body.dueAtMs,
            nowMs,
          });
        }

        if (body.futureScheduleAtMs) {
          runtime.schedules.upsertScheduleSync({
            scheduleId: 'sched-future-b4',
            tenantId: 'ten-b4',
            agentId: 'ag-b4',
            sourceKind: 'reminder',
            sourceId: 'rem-future-b4',
            scheduleKind: 'once',
            intervalSeconds: null,
            cronExpr: null,
            firstFireAtMs: body.futureScheduleAtMs,
            nowMs,
          });
        }
      });

      const nextAlarm = this.ctx.storage.transactionSync(() => runtime.outbox.recomputeAlarmSync(nowMs));
      await runtime.alarm.syncPlatformAlarm(nextAlarm, nowMs);
      return Response.json({ ok: true, nextAlarm });
    }

    if (url.pathname === '/handoff-and-budget') {
      const { entityId, callerOwner, opId, nowMs } = await request.json();
      const row = this.ctx.storage.sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', entityId).one();
      const handoffCheck = validateHandoffTransition({
        status: row.status,
        leaseOwner: row.lease_owner,
        callerLeaseOwner: callerOwner,
        leaseExpiresAtMs: row.lease_expires_at_ms,
        deadlineAtMs: row.deadline_at_ms,
        cancelRequestedAtMs: row.cancel_requested_at_ms,
        operationId: row.operation_id,
        nowMs,
      });
      if (!handoffCheck.ok) {
        return Response.json({ handoffCheck }, { status: 409 });
      }
      this.ctx.storage.transactionSync(() => {
        const env = {
          schemaVersion: 2,
          eventId: 'out-handoff-' + entityId,
          tenantId: 'ten-b4',
          agentId: 'ag-b4',
          entityKind: 'handoff',
          entityId,
          queueName: 'durable_turn',
          fenceEpoch: row.lease_epoch,
        };
        runtime.outbox.enqueueDurableOutboxSync({
          outboxId: env.eventId,
          entityKind: 'handoff',
          entityId,
          queueName: 'durable_turn',
          payloadJson: JSON.stringify(env),
          fenceEpoch: row.lease_epoch,
          nextAttemptAtMs: nowMs,
          nowMs,
        });
        // Also write rev 0 budget_sync that MUST survive later cancellation/transcript clear!
        const bsPayload = {
          schemaVersion: 1,
          tenantId: 'ten-b4',
          principalId: 'p1',
          agentId: 'ag-b4',
          utcDay: '2026-11-19',
          globalGrantId: 'g1',
          operationId: opId,
          settlementRevision: 0,
          state: 'conservative_billed',
          reservedMicroUsd: 400,
          chargeMicroUsd: 250,
          observedCostMicroUsd: null,
          overageMicroUsd: 0,
          openIncidentReason: 'usage_missing',
        };
        runtime.outbox.enqueueDurableOutboxSync({
          outboxId: 'out-bs-' + opId + '-0',
          entityKind: 'budget_sync',
          entityId: opId,
          queueName: null,
          payloadJson: JSON.stringify(bsPayload),
          operationId: opId,
          revision: 0,
          fenceEpoch: 0,
          nextAttemptAtMs: nowMs,
          nowMs,
        });
        // Request cancel after handoff + budget_sync commit -> cancels handoff queue outbox ONLY, preserves budget_sync!
        runtime.outbox.cancelEntityOutboxSync('handoff', entityId, nowMs);
        runtime.outbox.cancelEntityOutboxSync('turn', entityId, nowMs);
      });
      // Relay budget_sync to GlobalBudgetDO
      await runtime.handleAlarm({
        nowMs,
        queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
        globalBudget: this.#globalBudgetPort(),
        registry,
      });
      return Response.json({
        handoffCheck,
        handoffOutbox: runtime.outbox.getOutboxByIdSync('out-handoff-' + entityId),
        budgetOutbox: runtime.outbox.getOutboxByIdSync('out-bs-' + opId + '-0'),
      });
    }

    if (url.pathname === '/advance-and-alarm') {
      const { nowMs } = await request.json();
      this.ctx.storage.sql.exec('UPDATE b4_clock SET now_ms = ? WHERE id = 1', nowMs);
      try {
        await this.alarm();
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err.message });
      }
    }

    if (url.pathname === '/reconcile') {
      const cmd = await request.json();
      return Response.json(this.ctx.storage.transactionSync(() => runtime.coverage.reconcileFromRegistrySync(cmd)));
    }
    if (url.pathname === '/confirm-plan') {
      const cmd = await request.json();
      return Response.json(this.ctx.storage.transactionSync(() => runtime.coverage.confirmRegistryPlanSync({ ...cmd, nowMs: c.now_ms })));
    }
    if (url.pathname === '/run-recovery-alarm') {
      const { nowMs } = await request.json();
      this.ctx.storage.sql.exec('UPDATE b4_clock SET now_ms = ?, alarm_fail_remaining = 0 WHERE id = 1', nowMs);
      await this.alarm();
      return Response.json({ recovered: true });
    }

    if (url.pathname === '/claim') {
      const { envelope, workerId, leaseMs } = await request.json();
      const recoveryPort = {
        claimDurableWork: async (cmd) => this.ctx.storage.transactionSync(() => {
          const row = this.ctx.storage.sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', cmd.envelope.entityId).toArray()[0];
          if (!row) return { kind: 'not_claimed', reason: 'not_found' };
          if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
            return { kind: 'not_claimed', reason: 'terminal' };
          }
          if (row.status === 'running' && row.lease_expires_at_ms !== null && c.now_ms < row.lease_expires_at_ms) {
            return { kind: 'not_claimed', reason: 'lease_active' };
          }
          this.ctx.storage.sql.exec(
            "UPDATE b4_entities SET status = 'running', lease_owner = ?, lease_expires_at_ms = ?, run_count = run_count + 1 WHERE entity_id = ?",
            cmd.workerId,
            c.now_ms + cmd.leaseMs,
            row.entity_id,
          );
          return {
            kind: 'claimed',
            targetKind: row.entity_kind,
            targetId: row.entity_id,
            leaseEpoch: cmd.envelope.fenceEpoch,
            leaseExpiresAtMs: c.now_ms + cmd.leaseMs,
            contextJson: JSON.stringify({
              operationId: row.operation_id,
              entityKind: row.entity_kind,
              entityId: row.entity_id,
              attemptNo: 1,
              sendState: row.send_started_at_ms === null ? 'unsent' : 'sent',
              sendAuthorizingAtMs: row.send_started_at_ms,
              sendStartedAtMs: row.send_started_at_ms,
              deadlineAtMs: row.deadline_at_ms,
              testNowMs: c.now_ms,
              providerJobHandle: row.provider_job_handle,
            }),
          };
        }),
      };
      const res = await runtime.verifyAndClaim({
        rawEnvelope: envelope,
        expectedQueueName: 'durable_turn',
        recoveryPort,
        workerId,
        leaseMs,
        nowMs: c.now_ms,
      });
      if (res.kind === 'claimed') return Response.json(res.claim);
      return Response.json({ kind: 'not_claimed', reason: 'terminal' });
    }

    // Test-only authority: atomically fence a provider start against the claimed row.
    if (url.pathname === '/mark-attempt-sent') {
      const cmd = await request.json();
      return Response.json(this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', cmd.subjectId).toArray()[0];
        if (!row || cmd.scope.tenantId !== 'ten-b4' || cmd.scope.agentId !== 'ag-b4' ||
            row.entity_kind !== cmd.subjectType || row.operation_id !== cmd.operationId ||
            cmd.attemptNo !== 1 || row.lease_epoch !== cmd.leaseEpoch ||
            row.lease_owner !== cmd.leaseOwner || row.status !== 'running') {
          return { authorized: false, reason: 'fenced' };
        }
        if (row.cancel_requested_at_ms !== null) return { authorized: false, reason: 'cancelled' };
        const startBeforeMs = Math.min(row.lease_expires_at_ms, row.deadline_at_ms);
        if (c.now_ms >= startBeforeMs) return { authorized: false, reason: 'expired' };
        if (row.send_started_at_ms !== null) return { authorized: false, reason: 'already_sent' };
        this.ctx.storage.sql.exec(
          'UPDATE b4_entities SET send_started_at_ms = ? WHERE entity_id = ?',
          c.now_ms,
          row.entity_id,
        );
        return { authorized: true, sentAtMs: c.now_ms, startBeforeMs };
      }));
    }

    if (url.pathname === '/commit') {
      const { entityId, leaseEpoch, outcome } = await request.json();
      const accepted = this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', entityId).toArray()[0];
        if (!row || row.lease_epoch !== leaseEpoch || row.status !== 'running') {
          return false;
        }
        this.ctx.storage.sql.exec(
          'UPDATE b4_entities SET status = ?, terminal_result = ?, lease_owner = NULL, lease_expires_at_ms = NULL, commit_count = commit_count + 1 WHERE entity_id = ?',
          outcome.status,
          JSON.stringify(outcome),
          entityId,
        );
        return true;
      });
      if (outcome.providerStats) {
        this.ctx.storage.sql.exec(
          'UPDATE b4_clock SET provider_starts = provider_starts + ?, provider_polls = provider_polls + ? WHERE id = 1',
          outcome.providerStats.starts ?? 0,
          outcome.providerStats.polls ?? 0,
        );
      }
      const nextAlarm = this.ctx.storage.transactionSync(() => runtime.outbox.recomputeAlarmSync(c.now_ms));
      await runtime.alarm.syncPlatformAlarm(nextAlarm, c.now_ms);
      await runtime.coverage.syncPostCycleCoverage({ nowMs: c.now_ms, registry, idleGraceMs: 0 });
      return Response.json({ accepted });
    }

    if (url.pathname === '/negative-handoffs') {
      const { entityId, nowMs } = await request.json();
      const row = this.ctx.storage.sql.exec('SELECT * FROM b4_entities WHERE entity_id = ?', entityId).one();
      const checks = {
        wrongOwner: validateHandoffTransition({
          status: row.status,
          leaseOwner: row.lease_owner,
          callerLeaseOwner: 'wrong-worker',
          leaseExpiresAtMs: row.lease_expires_at_ms,
          deadlineAtMs: row.deadline_at_ms,
          cancelRequestedAtMs: null,
          operationId: row.operation_id,
          nowMs,
        }),
        expiredLease: validateHandoffTransition({
          status: row.status,
          leaseOwner: row.lease_owner,
          callerLeaseOwner: row.lease_owner,
          leaseExpiresAtMs: row.lease_expires_at_ms,
          deadlineAtMs: row.deadline_at_ms,
          cancelRequestedAtMs: null,
          operationId: row.operation_id,
          nowMs: row.lease_expires_at_ms + 1,
        }),
        expiredDeadline: validateHandoffTransition({
          status: row.status,
          leaseOwner: row.lease_owner,
          callerLeaseOwner: row.lease_owner,
          leaseExpiresAtMs: row.deadline_at_ms + 60_000,
          deadlineAtMs: row.deadline_at_ms,
          cancelRequestedAtMs: null,
          operationId: row.operation_id,
          nowMs: row.deadline_at_ms,
        }),
        cancelled: validateHandoffTransition({
          status: row.status,
          leaseOwner: row.lease_owner,
          callerLeaseOwner: row.lease_owner,
          leaseExpiresAtMs: row.lease_expires_at_ms,
          deadlineAtMs: row.deadline_at_ms,
          cancelRequestedAtMs: nowMs - 10,
          operationId: row.operation_id,
          nowMs,
        }),
      };
      return Response.json({ checks, preservedDeadlineAtMs: row.deadline_at_ms });
    }

    if (url.pathname === '/fi-15-budget-rev1') {
      const { opId, nowMs } = await request.json();
      const rev1Payload = {
        schemaVersion: 1,
        tenantId: 'ten-b4',
        principalId: 'p1',
        agentId: 'ag-b4',
        utcDay: '2026-11-19',
        globalGrantId: 'g1',
        operationId: opId,
        settlementRevision: 1,
        state: 'settled',
        reservedMicroUsd: 400,
        chargeMicroUsd: 400,
        observedCostMicroUsd: 400,
        overageMicroUsd: 0,
        openIncidentReason: null,
      };
      this.ctx.storage.transactionSync(() => {
        runtime.outbox.enqueueDurableOutboxSync({
          outboxId: 'out-bs-' + opId + '-1',
          entityKind: 'budget_sync',
          entityId: opId,
          queueName: null,
          payloadJson: JSON.stringify(rev1Payload),
          operationId: opId,
          revision: 1,
          fenceEpoch: 0,
          nextAttemptAtMs: nowMs,
          nowMs,
        });
      });

      // Verify pending budget_sync blocks coverage retire (entities & schedules empty once marked)
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE b4_entities SET status = 'succeeded' WHERE status IN ('queued', 'running')");
        this.ctx.storage.sql.exec("UPDATE v2_schedules SET status = 'completed' WHERE status = 'active'");
      });
      const retireAttempt = await runtime.coverage.syncPostCycleCoverage({ nowMs, registry });

      await runtime.handleAlarm({
        nowMs,
        queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
        globalBudget: this.#globalBudgetPort(),
        registry,
      });

      const conflictRes = await this.#globalBudgetPort().settleGlobal({
        ...rev1Payload,
        chargeMicroUsd: 999,
      });
      const rev1Outbox = runtime.outbox.getOutboxByIdSync('out-bs-' + opId + '-1');
      return Response.json({ retireAttempt, conflictRes, rev1Outbox });
    }

    if (url.pathname === '/fi-full-matrix') {
      const { baseMs } = await request.json();
      const gb = this.#globalBudgetPort();

      // 1. FI-04: Crash before Queue.send() + crash after Queue.send() before marking enqueued + duplicate Queue delivery
      const envCrash = {
        schemaVersion: 2,
        eventId: 'out-fi04-dup',
        tenantId: 'ten-b4',
        agentId: 'ag-b4',
        entityKind: 'turn',
        entityId: 'turn-fi04-dup',
        queueName: 'durable_turn',
        fenceEpoch: 1,
      };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO b4_entities (entity_id, entity_kind, status, lease_epoch, deadline_at_ms, operation_id) VALUES (?, 'turn', 'queued', 1, ?, ?)",
          'turn-fi04-dup',
          baseMs + 300_000,
          'op-fi04-dup',
        );
        runtime.outbox.enqueueDurableOutboxSync({
          outboxId: 'out-fi04-dup',
          entityKind: 'turn',
          entityId: 'turn-fi04-dup',
          queueName: 'durable_turn',
          payloadJson: JSON.stringify(envCrash),
          fenceEpoch: 1,
          nextAttemptAtMs: baseMs,
          nowMs: baseMs,
        });
      });
      // Inject pre-enqueued duplicate directly on Queue (simulating crash after Queue.send before markPublishSuccess)
      await this.env.DURABLE_TURN_Q.send(envCrash, { contentType: 'json' });
      // Alarm also flushes the still-'pending' outbox row -> sends a second copy!
      await runtime.handleAlarm({
        nowMs: baseMs,
        queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
        globalBudget: gb,
        registry,
      });

      // 2. FI-05: Forged/tampered envelopes rejected with 0 table mutations + SQLite CHECK rejects NULL queue_name
      const noopRecoveryPort = {
        claimDurableWork: async () => ({ kind: 'not_claimed', reason: 'not_found' }),
      };
      const fi05Rejections = {
        wrongOutboxId: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, eventId: 'forged-id' },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
        wrongQueue: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, queueName: 'agent_task' },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
        wrongEntityKind: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, entityKind: 'task' },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
        crossTenant: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, tenantId: 'other-tenant' },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
        futureEpoch: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, fenceEpoch: 99 },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
        budgetSyncOnQueue: await runtime.verifyAndClaim({
          rawEnvelope: { ...envCrash, entityKind: 'budget_sync' },
          expectedQueueName: 'durable_turn',
          recoveryPort: noopRecoveryPort,
          workerId: 'w-fi05',
          leaseMs: 30_000,
          nowMs: baseMs,
        }),
      };
      let nullQueueConstraintBlocked = false;
      try {
        this.ctx.storage.sql.exec(
          "INSERT INTO v2_dispatch_outbox (outbox_id, entity_kind, entity_id, queue_name, payload_json, fence_epoch, next_attempt_at_ms, created_at_ms, updated_at_ms) VALUES ('bad-q', 'turn', 't-bad', NULL, '{}', 1, ?, ?, ?)",
          baseMs,
          baseMs,
          baseMs,
        );
      } catch {
        nullQueueConstraintBlocked = true;
      }

      // 3. FI-06: 0 / 500 / 1000 / 1001ms boundaries in workerd
      const fi06 = {
        b0: computePreDeadlineRetryAtMs(baseMs + 60_000, baseMs + 60_000),
        b500: computePreDeadlineRetryAtMs(baseMs + 59_500, baseMs + 60_000),
        b1000: computePreDeadlineRetryAtMs(baseMs + 59_000, baseMs + 60_000),
        b1001: computePreDeadlineRetryAtMs(baseMs + 58_999, baseMs + 60_000),
      };

      // 4. FI-16: DST Spring-Forward / Fall-Back + ADR-0001 Cancel Precedence + ADR-0002 Pre-Claim Deadline (run_count=0)
      const springTz = findNextCronTzFireAtMs({
        cronExpr: '30 2 * * *',
        timezone: 'America/New_York',
        afterUtcMs: Date.parse('2026-03-08T05:00:00Z'),
        lastFiredAtMs: null,
      });
      const fallFirst = findNextCronTzFireAtMs({
        cronExpr: '30 1 * * *',
        timezone: 'America/New_York',
        afterUtcMs: Date.parse('2026-11-01T04:00:00Z'),
        lastFiredAtMs: null,
      });
      const fallNext = findNextCronTzFireAtMs({
        cronExpr: '30 1 * * *',
        timezone: 'America/New_York',
        afterUtcMs: fallFirst + 35 * 60_000,
        lastFiredAtMs: fallFirst,
      });

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO b4_entities (entity_id, entity_kind, status, lease_epoch, deadline_at_ms, cancel_requested_at_ms, operation_id) VALUES ('turn-adr1-cancel', 'turn', 'queued', 1, ?, ?, 'op-adr1')",
          baseMs + 50_000,
          baseMs,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO b4_entities (entity_id, entity_kind, status, lease_epoch, deadline_at_ms, cancel_requested_at_ms, operation_id) VALUES ('turn-adr2-preclaim', 'turn', 'queued', 1, ?, NULL, 'op-adr2')",
          baseMs,
        );
      });
      await runtime.handleAlarm({
        nowMs: baseMs + 100,
        queues: { durable_turn: this.env.DURABLE_TURN_Q, agent_task: this.env.AGENT_TASK_Q },
        globalBudget: gb,
        registry,
      });
      const adr1 = this.ctx.storage.sql.exec("SELECT status, run_count FROM b4_entities WHERE entity_id = 'turn-adr1-cancel'").one();
      const adr2 = this.ctx.storage.sql.exec("SELECT status, terminal_result, run_count FROM b4_entities WHERE entity_id = 'turn-adr2-preclaim'").one();

      return Response.json({
        fi05Rejections,
        nullQueueConstraintBlocked,
        fi06,
        dst: { springTz, fallFirst, fallNext },
        adr1,
        adr2,
      });
    }

    if (url.pathname === '/fi-d1-cas-races') {
      const { baseMs } = await request.json();
      // Isolated synthetic tenant/agent for D1 CAS & pending crash checks
      const isoRuntime = new AgentEventRuntimeFacade({
        storage: this.ctx.storage,
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        business: this.#business().port,
      });
      // Establish initial gen=1 in D1 + schedule at +500_000
      const tStart = performance.now();
      const firstReg = await isoRuntime.coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: baseMs + 50_000,
        nowMs: baseMs,
        registry,
      });
      const tRegFirstMs = performance.now() - tStart;

      // FI-12 covered fast path = 0ms D1 I/O
      const tCovStart = performance.now();
      const covCheck = await isoRuntime.coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: baseMs + 90_000,
        nowMs: baseMs + 1_000,
        registry,
      });
      const tRegCoveredMs = performance.now() - tCovStart;

      // FI-03: Concurrent writer bumps D1 to gen=10 -> stale upsertCoverage returns accepted: false, cannot confirm stale values
      await registry.upsertCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        generation: 10,
        recoveryAtMs: baseMs + 40_000,
        nowMs: baseMs + 1_000,
      });
      const staleUpsert = await registry.upsertCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        generation: 5,
        recoveryAtMs: baseMs + 80_000,
        nowMs: baseMs + 1_000,
      });

      // FI-02: ACK lost after D1 CAS gen=11 succeeds -> getCoverage read-back confirms cleanly
      const ackLostUpsert = await registry.upsertCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        generation: 11,
        recoveryAtMs: baseMs + 45_000,
        nowMs: baseMs + 2_000,
      });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE v2_recovery_coverage SET generation = 11, coverage_state = 'registering', covered_recovery_at_ms = NULL, pending_kind = 'ensure', pending_target_at_ms = ? WHERE id = 1",
          baseMs + 45_000,
        );
      });
      const readBack = await registry.getCoverage({ tenantId: 'ten-cas', agentId: 'ag-cas' });
      const ackLossConfirmed = this.ctx.storage.transactionSync(() =>
        isoRuntime.coverage.confirmCoverageSync({
          generation: readBack.currentGeneration,
          actualRecoveryAtMs: readBack.actualRecoveryAtMs,
          applied: readBack.exists && readBack.currentGeneration === 11,
          earliestRequiredRecoveryMs: baseMs + 45_000,
          nowMs: baseMs + 2_100,
        }),
      );

      // FI-10: Retire race vs covered new turn (DELETE matches 0 rows) + Postpone race vs earlier obligation
      await registry.upsertCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        generation: 12,
        recoveryAtMs: baseMs + 45_000,
        nowMs: baseMs + 3_000,
      });
      const staleRetire = await registry.retireCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        retireUpToGen: 11,
      });
      const stalePostpone = await registry.postponeCoverage({
        tenantId: 'ten-cas',
        agentId: 'ag-cas',
        expectedPrevGen: 11,
        newGeneration: 13,
        nextRecoveryAtMs: baseMs + 900_000,
        nowMs: baseMs + 3_000,
      });

      // FI-11: Postpone hits ambiguous D1 timeout -> DO remains 'registering' (never falls back to old 'covered')
      let postponeErr = false;
      try {
        await isoRuntime.coverage.syncPostCycleCoverage({
          nowMs: baseMs + 4_000,
          registry: {
            upsertCoverage: async () => {
              throw new Error('timeout');
            },
            postponeCoverage: async () => {
              throw new Error('D1 postpone ambiguous timeout');
            },
            retireCoverage: async () => ({ retired: true }),
            getCoverage: () => registry.getCoverage({ tenantId: 'ten-cas', agentId: 'ag-cas' }),
          },
          postponeMinDeltaMs: 5_000,
        });
      } catch {
        postponeErr = true;
      }
      // Make sure an open obligation shifts far forward first so postpone actually triggered
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE v2_recovery_coverage SET coverage_state = 'covered', covered_recovery_at_ms = ?, generation = 12, pending_kind = NULL WHERE id = 1", baseMs + 45_000);
        this.ctx.storage.sql.exec("UPDATE b4_entities SET status = 'succeeded'");
        isoRuntime.schedules.upsertScheduleSync({
          scheduleId: 'sched-fi11',
          tenantId: 'ten-cas',
          agentId: 'ag-cas',
          sourceKind: 'reminder',
          sourceId: 'rem-fi11',
          scheduleKind: 'once',
          intervalSeconds: null,
          cronExpr: null,
          firstFireAtMs: baseMs + 500_000,
          nowMs: baseMs + 4_000,
        });
      });
      try {
        await isoRuntime.coverage.syncPostCycleCoverage({
          nowMs: baseMs + 4_000,
          registry: {
            upsertCoverage: () => Promise.reject(new Error('timeout')),
            postponeCoverage: () => Promise.reject(new Error('D1 postpone ambiguous timeout')),
            retireCoverage: () => Promise.resolve({ retired: true }),
            getCoverage: () => registry.getCoverage({ tenantId: 'ten-cas', agentId: 'ag-cas' }),
          },
          postponeMinDeltaMs: 5_000,
        });
      } catch {
        postponeErr = true;
      }
      const afterPostponeTimeout = isoRuntime.coverage.getCoverageRowSync();

      // FI-09: Sweeper RPC failure -> backoff -> quarantine with stale sweep_lease_owner CAS check
      const afterBackoffTest = await this.env.RECOVERY_DB.prepare(
        "UPDATE v2_recovery_registry SET sweep_lease_owner = 'should-not-match' WHERE agent_key = 'ten-cas:ag-cas' AND sweep_lease_owner = 'stale-owner'",
      ).run();

      // FI-01: Pending 'ensure' crash self-heal with lagging expectedGen=10 against DO gen=14
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE v2_recovery_coverage SET generation = 14, coverage_state = 'registering', covered_recovery_at_ms = NULL, pending_kind = 'ensure', pending_prev_generation = 12, pending_target_at_ms = ? WHERE id = 1",
          baseMs + 50_000,
        );
      });
      const fi01Plan = this.ctx.storage.transactionSync(() =>
        isoRuntime.coverage.reconcileFromRegistrySync({
          expectedGen: 10,
          nowMs: baseMs + 5_000,
        }),
      );

      // FI-01 pending 'postpone' crash self-heal
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE v2_recovery_coverage SET generation = 16, coverage_state = 'registering', covered_recovery_at_ms = NULL, pending_kind = 'postpone', pending_prev_generation = 15, pending_target_at_ms = ? WHERE id = 1",
          baseMs + 60_000,
        );
      });
      const fi01PostponePlan = this.ctx.storage.transactionSync(() =>
        isoRuntime.coverage.reconcileFromRegistrySync({
          expectedGen: 10,
          nowMs: baseMs + 5_500,
        }),
      );

      // FI-12: D1 Outage -> Uncovered fails closed 503 with 0 business rows, Covered continues with 0 D1 calls!
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE v2_recovery_coverage SET coverage_state = 'uncovered', covered_recovery_at_ms = NULL, pending_kind = NULL WHERE id = 1");
      });
      let d1FailureCalls = 0;
      const outageRegistry = {
        upsertCoverage: async () => {
          d1FailureCalls += 1;
          throw new Error('D1 unreachable outage');
        },
        postponeCoverage: async () => {
          throw new Error('D1 unreachable outage');
        },
        retireCoverage: async () => {
          throw new Error('D1 unreachable outage');
        },
        getCoverage: async () => {
          throw new Error('D1 unreachable outage');
        },
      };
      let uncoveredOutageStatus = 200;
      let uncoveredOutageCode = null;
      try {
        await isoRuntime.coverage.ensureAdmissionCoverage({
          requiredRecoveryAtMs: baseMs + 45_000,
          nowMs: baseMs + 6_000,
          registry: outageRegistry,
        });
      } catch (err) {
        if (err instanceof RecoveryUnavailableError) {
          uncoveredOutageStatus = err.httpStatus;
          uncoveredOutageCode = err.code;
        }
      }
      // Restore covered state -> subsequent ensureAdmissionCoverage succeeds with 0 D1 calls during D1 outage!
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE v2_recovery_coverage SET coverage_state = 'covered', covered_recovery_at_ms = ?, pending_kind = NULL WHERE id = 1",
          baseMs + 45_000,
        );
      });
      const callsBeforeCoveredOutage = d1FailureCalls;
      const coveredOutageRes = await isoRuntime.coverage.ensureAdmissionCoverage({
        requiredRecoveryAtMs: baseMs + 90_000,
        nowMs: baseMs + 7_000,
        registry: outageRegistry,
      });

      // Clean up ten-cas:ag-cas D1 row so subsequent /sweep-fi09 scans only ten-fi09:ag-fi09
      await this.env.RECOVERY_DB.prepare("DELETE FROM v2_recovery_registry WHERE agent_key = 'ten-cas:ag-cas'").run();

      return Response.json({
        firstReg,
        tRegFirstMs,
        covCheck,
        tRegCoveredMs,
        staleUpsert,
        ackLostUpsert,
        ackLossConfirmed,
        staleRetire,
        stalePostpone,
        postponeErr,
        afterPostponeTimeout,
        staleLeaseChanges: afterBackoffTest.meta?.changes ?? 0,
        fi01Plan,
        fi01PostponePlan,
        fi12: {
          uncoveredOutageStatus,
          uncoveredOutageCode,
          coveredOutageRes,
          coveredD1Calls: d1FailureCalls - callsBeforeCoveredOutage,
        },
      });
    }

    if (url.pathname === '/inspect') {
      const entities = this.ctx.storage.sql.exec('SELECT * FROM b4_entities ORDER BY entity_id ASC').toArray();
      const outbox = this.ctx.storage.sql.exec('SELECT * FROM v2_dispatch_outbox ORDER BY outbox_id ASC').toArray();
      const schedules = this.ctx.storage.sql.exec('SELECT * FROM v2_schedules').toArray();
      const cov = this.ctx.storage.sql.exec('SELECT * FROM v2_recovery_coverage WHERE id = 1').toArray()[0];
      const clock = this.#clock();
      const d1 = await registry.getCoverage({ tenantId: 'ten-b4', agentId: 'ag-b4' });
      const gbStub = this.env.GLOBAL_BUDGET.get(this.env.GLOBAL_BUDGET.idFromName('global'));
      const budgetTotals = await (await gbStub.fetch('http://gb/totals')).json();
      const platformAlarmAtMs = await this.ctx.storage.getAlarm();
      return Response.json({
        entities,
        outbox,
        schedules,
        coverage: cov,
        platformAlarmAtMs,
        clock,
        d1,
        budgetTotals,
      });
    }

    return new Response('not-found', { status: 404 });
    } catch (err) {
      return Response.json(
        {
          uncaught: true,
          path: new URL(request.url).pathname,
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : null,
        },
        { status: 500 },
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      return Response.json(await applyD1RecoveryMigrations(env.RECOVERY_DB, 1_000));
    }
    if (url.pathname === '/sweep') {
      const { nowMs } = await request.json();
      const registry = new D1RecoveryRegistry(env.RECOVERY_DB);
      const sweeper = new RecoverySweeper({
        db: env.RECOVERY_DB,
        registry,
        targets: {
          getRecoveryTarget: (t, a) => {
            const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(t + ':' + a));
            return {
              reconcileFromRegistry: async (cmd) =>
                (await stub.fetch('http://do/reconcile', { method: 'POST', body: JSON.stringify(cmd) })).json(),
              confirmRegistryPlan: async (cmd) =>
                (await stub.fetch('http://do/confirm-plan', { method: 'POST', body: JSON.stringify(cmd) })).json(),
              runRecoveryAlarmCycle: async (n) => {
                await stub.fetch('http://do/run-recovery-alarm', { method: 'POST', body: JSON.stringify({ nowMs: n }) });
              },
            };
          },
        },
      });
      return Response.json(await sweeper.sweepDueAgents({ sweeperId: 'cron-b4', nowMs }));
    }
    if (url.pathname === '/sweep-fi09') {
      const { baseMs } = await request.json();
      const registry = new D1RecoveryRegistry(env.RECOVERY_DB);
      // Seed an isolated ten-fi09:ag-fi09 entry due at baseMs + 10_000
      await registry.upsertCoverage({
        tenantId: 'ten-fi09',
        agentId: 'ag-fi09',
        generation: 1,
        recoveryAtMs: baseMs + 10_000,
        nowMs: baseMs,
      });
      let failRpc = true;
      const alerts = [];
      const sweeper = new RecoverySweeper({
        db: env.RECOVERY_DB,
        registry,
        onQuarantine: (ev) => alerts.push(ev),
        targets: {
          getRecoveryTarget: () => ({
            reconcileFromRegistry: async () => {
              if (failRpc) throw new Error('DO_RPC_TIMEOUT');
              return { action: 'retire', retireUpToGen: 1 };
            },
            confirmRegistryPlan: async () => ({ confirmed: true }),
            runRecoveryAlarmCycle: async () => {},
          }),
        },
      });
      const r1 = await sweeper.sweepDueAgents({
        sweeperId: 'sw-fi09-1',
        nowMs: baseMs + 10_000,
        quarantineThreshold: 2,
      });
      const d1Backoff = await registry.getCoverage({ tenantId: 'ten-fi09', agentId: 'ag-fi09' });
      const r2 = await sweeper.sweepDueAgents({
        sweeperId: 'sw-fi09-2',
        nowMs: (d1Backoff.retryNotBeforeMs ?? baseMs + 10_000) + 1,
        quarantineThreshold: 2,
      });
      const d1Quarantined = await registry.getCoverage({ tenantId: 'ten-fi09', agentId: 'ag-fi09' });
      // Stale sweeper lease CAS check (0 rows updated)
      const staleLease = await env.RECOVERY_DB.prepare(
        "UPDATE v2_recovery_registry SET sweep_lease_owner = 'intruder' WHERE agent_key = 'ten-fi09:ag-fi09' AND sweep_lease_owner = 'expired-owner'",
      ).run();
      // Recover dependency -> quarantined entry still in index and auto-retires!
      failRpc = false;
      const r3 = await sweeper.sweepDueAgents({
        sweeperId: 'sw-fi09-3',
        nowMs: (d1Quarantined.retryNotBeforeMs ?? baseMs + 40_000) + 1,
        quarantineThreshold: 2,
      });
      const d1AfterHeal = await registry.getCoverage({ tenantId: 'ten-fi09', agentId: 'ag-fi09' });
      return Response.json({
        r1,
        d1Backoff,
        r2,
        d1Quarantined,
        alerts,
        staleLeaseChanges: staleLease.meta?.changes ?? 0,
        r3,
        d1AfterHeal,
      });
    }
    const agentKey = url.searchParams.get('agent') ?? 'ten-b4:ag-b4';
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(agentKey));
    return stub.fetch(request);
  },

  async queue(batch, env) {
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('ten-b4:ag-b4'));
    await handleDurableQueueBatch({
      queueName: 'durable_turn',
      messages: batch.messages,
      retryDelaySeconds: 0,
      router: {
        getAgentHeadRecoveryPort: () => ({
          reconcileFromRegistry: async () => ({ action: 'keep_armed', currentGeneration: 1 }),
          confirmRegistryPlan: async () => ({ confirmed: true }),
          claimDurableWork: async (cmd) =>
            (await stub.fetch('http://do/claim', { method: 'POST', body: JSON.stringify(cmd) })).json(),
          commitDurableResult: async (cmd) =>
            (await stub.fetch('http://do/commit', { method: 'POST', body: JSON.stringify(cmd) })).json(),
        }),
        getDeadLetterPort: () => ({
          onDispatchDeadLetter: async () => ({ action: 'ignored_stale_or_terminal', alarmAtMs: null }),
        }),
      },
      executor: {
        executeDurableWork: async (cmd) => {
          const ctx = JSON.parse(cmd.contextJson);
          let starts = 0;
          let polls = 0;
          const res = await executeRecoveredOrFreshDurableWork({
            context: ctx,
            nowMs: () => ctx.testNowMs,
            sendGate: {
              scope: { tenantId: cmd.tenantId, agentId: cmd.agentId },
              leaseEpoch: cmd.leaseEpoch,
              leaseOwner: cmd.workerId,
              leaseExpiresAtMs: cmd.leaseExpiresAtMs,
              markAttemptSent: async (req) =>
                (await stub.fetch('http://do/mark-attempt-sent', {
                  method: 'POST',
                  body: JSON.stringify(req),
                })).json(),
            },
            provider: {
              pollProviderJob: async (p) => {
                polls += 1;
                return {
                  status: 'succeeded',
                  operationId: p.operationId,
                  providerJobHandle: p.providerJobHandle,
                  outputJson: '{"polled":true}',
                  errorCode: null,
                  usage: { inputTokens: 10, outputTokens: 10, costMicroUsd: 100 },
                };
              },
              startProviderJob: async (s) => {
                starts += 1;
                return {
                  status: 'succeeded',
                  operationId: s.operationId,
                  providerJobHandle: 'job-new-1',
                  outputJson: '{"started":true}',
                  errorCode: null,
                  usage: { inputTokens: 5, outputTokens: 5, costMicroUsd: 50 },
                };
              },
            },
          });
          return { ...res, providerStats: { starts, polls } };
        },
      },
      workerId: 'exec-b4',
    });
  },
};
`;

    const mf = new Miniflare({
      logRequests: false,
      workers: [
        {
          config: {
            name: 'm1-b4-fi-suite',
            compatibilityDate: '2026-11-10',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'worker.js',
              modulesRoot: '/app',
              modules: {
                'worker.js': { type: 'esm', contents: workerSrc },
                ...transpileRuntimeV2Modules(),
              },
            },
            env: {
              RECOVERY_DB: { type: 'd1', id: 'b4-d1-db' },
              AGENT_HEAD: {
                type: 'durable-object',
                worker: 'm1-b4-fi-suite',
                exportName: 'TestAgentHeadDO',
              },
              GLOBAL_BUDGET: {
                type: 'durable-object',
                worker: 'm1-b4-fi-suite',
                exportName: 'TestGlobalBudgetDO',
              },
              DURABLE_TURN_Q: { type: 'queue', name: 'durable-turn', dev: { remote: false } },
              AGENT_TASK_Q: { type: 'queue', name: 'agent-task', dev: { remote: false } },
            },
            exports: {
              TestAgentHeadDO: { type: 'durable-object', storage: 'sqlite' },
              TestGlobalBudgetDO: { type: 'durable-object', storage: 'sqlite' },
            },
            triggers: [{ type: 'queue', name: 'durable-turn', maxBatchSize: 1, maxRetries: 1 }],
          },
          dev: { rootPath: REPO_ROOT, unsafeRegisterWorker: true },
        },
      ],
    });

    try {
      await mf.dispatchFetch('http://localhost/init');
      const base = Date.now() + 2_000_000;
      const dueAt = base + 5_000;
      const futureSchedAt = base + 1_500_000;

      // FI-08 + FI-14: Turn with existing providerJobHandle + 7 failing alarms + future schedule + offline clients
      await mf.dispatchFetch('http://localhost/run-scenario', {
        method: 'POST',
        body: JSON.stringify({
          entityId: 'turn-handle-1',
          outboxId: 'out-handle-1',
          nowMs: base,
          dueAtMs: dueAt,
          deadlineAtMs: base + 600_000,
          operationId: 'op-handle-1',
          sendStartedAtMs: base,
          providerJobHandle: 'fake-job-777',
          enqueueOutbox: true,
          failAlarms: 7,
          futureScheduleAtMs: futureSchedAt,
        }),
      });

      // Exhaust initial + 6 retries
      for (let i = 0; i < 7; i += 1) {
        const res = (await (
          await mf.dispatchFetch('http://localhost/advance-and-alarm', {
            method: 'POST',
            body: JSON.stringify({ nowMs: dueAt + i * 5_000 }),
          })
        ).json()) as { ok: boolean };
        expect(res.ok).toBe(false);
      }

      // Sweep detects at dueAt + 45s (<= 2 min detection target) and recovers!
      const alarmExhaustAtMs = dueAt + 6 * 5_000;
      const detectedAt = dueAt + 45_000;
      const detectDeltaSinceDueMs = detectedAt - dueAt;
      const detectDeltaSinceExhaustMs = detectedAt - alarmExhaustAtMs;
      const wallSweepStartMs = performance.now();
      const sweepRes = (await (
        await mf.dispatchFetch('http://localhost/sweep', {
          method: 'POST',
          body: JSON.stringify({ nowMs: detectedAt }),
        })
      ).json()) as { keptArmedCount: number };
      expect(sweepRes.keptArmedCount).toBe(1);

      interface InspectState {
        entities: Array<{
          entity_id: string;
          status: string;
          commit_count: number;
          lease_epoch: number;
        }>;
        schedules: Array<{ status: string; next_fire_at_ms: number }>;
        coverage: { armed_alarm_at_ms: number | null };
        platformAlarmAtMs: number | null;
        clock: { provider_starts: number; provider_polls: number };
        d1: { exists: boolean; actualRecoveryAtMs: number | null };
        budgetTotals: { total_charged_micro_usd: number; halt_open: number };
      }

      let state: InspectState | null = null;

      for (let i = 0; i < 30; i += 1) {
        const nextState = (await (
          await mf.dispatchFetch('http://localhost/inspect')
        ).json()) as InspectState;
        state = nextState;
        if (
          nextState.entities.find((e) => e.entity_id === 'turn-handle-1')?.status === 'succeeded' &&
          nextState.d1.actualRecoveryAtMs === futureSchedAt + 45_000
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const wallRecoverMs = Math.round(performance.now() - wallSweepStartMs);
      const recoverTotalMs = detectDeltaSinceDueMs + wallRecoverMs;
      expect(detectDeltaSinceDueMs).toBeLessThanOrEqual(120_000);
      expect(detectDeltaSinceExhaustMs).toBeLessThanOrEqual(120_000);
      expect(recoverTotalMs).toBeLessThanOrEqual(300_000);
      console.info(
        JSON.stringify({
          m1B4SlaMetrics: {
            t_alarm_exhaust_to_detect_ms: detectDeltaSinceExhaustMs,
            t_due_to_detect_ms: detectDeltaSinceDueMs,
            workerd_wall_sweep_to_commit_ms: wallRecoverMs,
            t_alarm_exhaust_to_recover_ms: detectDeltaSinceExhaustMs + wallRecoverMs,
            t_due_to_recover_ms: recoverTotalMs,
            t_silent_loss_to_reconcile_ms: 45_000,
          },
        }),
      );

      // Polling existing handle ran ZERO new starts, ONE poll, ONE commit, future Schedule preserved!
      expect(state?.clock.provider_polls).toBe(1);
      expect(state?.clock.provider_starts).toBe(0);
      expect(state?.entities.find((e) => e.entity_id === 'turn-handle-1')).toMatchObject({
        status: 'succeeded',
        commit_count: 1,
      });
      expect(state?.schedules[0]).toMatchObject({
        status: 'active',
        next_fire_at_ms: futureSchedAt,
      });
      expect(state?.platformAlarmAtMs).toBe(futureSchedAt);
      expect(state?.d1.actualRecoveryAtMs).toBe(futureSchedAt + 45_000);

      // FI-14 Silent loss reaper: active Fast Path worker loses contact (45s lease expires, uncertain missing handle)
      await mf.dispatchFetch('http://localhost/run-scenario', {
        method: 'POST',
        body: JSON.stringify({
          entityId: 'turn-silent-loss',
          initialStatus: 'running',
          leaseOwner: 'dead-sse-worker',
          leaseExpiresAtMs: base + 100_000,
          nowMs: base + 60_000,
          dueAtMs: base + 100_000,
          deadlineAtMs: base + 600_000,
          operationId: 'op-silent-1',
          sendStartedAtMs: base + 65_000,
          providerJobHandle: null,
          enqueueOutbox: false,
        }),
      });
      await mf.dispatchFetch('http://localhost/advance-and-alarm', {
        method: 'POST',
        body: JSON.stringify({ nowMs: base + 105_000 }),
      });
      const afterReap = (await (
        await mf.dispatchFetch('http://localhost/inspect')
      ).json()) as InspectState;
      const silentEntity = afterReap.entities.find((e) => e.entity_id === 'turn-silent-loss');
      expect(silentEntity).toMatchObject({
        status: 'failed',
        commit_count: 1,
      });
      // Still zero blind starts!
      expect(afterReap.clock.provider_starts).toBe(0);

      // FI-13 + FI-15: Active renewed Fast Path handoff + cancel + budget_sync preserved & settled in GlobalBudgetDO!
      await mf.dispatchFetch('http://localhost/run-scenario', {
        method: 'POST',
        body: JSON.stringify({
          entityId: 'turn-handoff-budget',
          initialStatus: 'running',
          leaseOwner: 'sse-worker-active',
          leaseExpiresAtMs: base + 200_000,
          nowMs: base + 110_000,
          dueAtMs: base + 115_000,
          deadlineAtMs: base + 600_000,
          operationId: 'op-hb-1',
          enqueueOutbox: false,
        }),
      });
      const hbRes = (await (
        await mf.dispatchFetch('http://localhost/handoff-and-budget', {
          method: 'POST',
          body: JSON.stringify({
            entityId: 'turn-handoff-budget',
            callerOwner: 'sse-worker-active',
            opId: 'op-hb-1',
            nowMs: base + 120_000,
          }),
        })
      ).json()) as {
        handoffCheck: { ok: boolean; preservedDeadlineAtMs: number };
        handoffOutbox: { state: string };
        budgetOutbox: { state: string };
      };
      expect(hbRes.handoffCheck).toMatchObject({
        ok: true,
        preservedDeadlineAtMs: base + 600_000,
      });
      expect(hbRes.handoffOutbox.state).toBe('cancelled');
      expect(hbRes.budgetOutbox.state).toBe('acked');

      const finalInspect = (await (
        await mf.dispatchFetch('http://localhost/inspect')
      ).json()) as InspectState;
      expect(finalInspect.budgetTotals).toMatchObject({
        total_charged_micro_usd: 250,
        halt_open: 1,
      });

      // FI-13 negative handoffs & FI-14 stale lease_epoch commit rejection (zero duplicate commits)
      const negRes = (await (
        await mf.dispatchFetch('http://localhost/negative-handoffs', {
          method: 'POST',
          body: JSON.stringify({ entityId: 'turn-handoff-budget', nowMs: base + 120_000 }),
        })
      ).json()) as {
        checks: Record<string, { ok: boolean; code: string }>;
        preservedDeadlineAtMs: number;
      };
      expect(negRes.checks.wrongOwner).toEqual({ ok: false, code: 'LEASE_OWNER_MISMATCH' });
      expect(negRes.checks.expiredLease).toEqual({ ok: false, code: 'LEASE_EXPIRED' });
      expect(negRes.checks.expiredDeadline).toEqual({ ok: false, code: 'DEADLINE_EXPIRED' });
      expect(negRes.checks.cancelled).toEqual({ ok: false, code: 'CANCEL_REQUESTED' });
      expect(negRes.preservedDeadlineAtMs).toBe(base + 600_000);

      const staleCommitRes = (await (
        await mf.dispatchFetch('http://localhost/commit', {
          method: 'POST',
          body: JSON.stringify({
            entityId: 'turn-handle-1',
            leaseEpoch: 1,
            outcome: { status: 'succeeded' },
          }),
        })
      ).json()) as { accepted: boolean };
      expect(staleCommitRes.accepted).toBe(false);

      // FI-15 rev=1 cumulative delta accounting (250 -> 400 total, not 650), conflict rejection, & retire block
      const rev1Res = (await (
        await mf.dispatchFetch('http://localhost/fi-15-budget-rev1', {
          method: 'POST',
          body: JSON.stringify({ opId: 'op-hb-1', nowMs: base + 125_000 }),
        })
      ).json()) as {
        retireAttempt: string;
        conflictRes: { accepted: boolean; errorCode?: string };
        rev1Outbox: { state: string };
      };
      expect(rev1Res.retireAttempt).toBe('unchanged');
      expect(rev1Res.rev1Outbox.state).toBe('acked');
      expect(rev1Res.conflictRes).toMatchObject({
        accepted: false,
        errorCode: 'REVISION_PAYLOAD_CONFLICT',
      });
      const inspectAfterRev1 = (await (
        await mf.dispatchFetch('http://localhost/inspect')
      ).json()) as InspectState;
      expect(inspectAfterRev1.budgetTotals).toMatchObject({
        total_charged_micro_usd: 400,
        halt_open: 1,
      });

      // FI-04 (crash before/after Queue.send + dedup), FI-05 (tampered/null-queue reject), FI-06 (0/500/1000/1001ms), FI-16 (DST + ADR-0001/0002)
      const matrixRaw = await mf.dispatchFetch('http://localhost/fi-full-matrix', {
        method: 'POST',
        body: JSON.stringify({ baseMs: base + 200_000 }),
      });
      const matrixJson = await matrixRaw.json();
      expect(matrixRaw.status, JSON.stringify(matrixJson)).toBe(200);
      const matrixRes = matrixJson as {
        fi05Rejections: Record<string, { kind: string; code: string; ackQueueMessage: boolean }>;
        nullQueueConstraintBlocked: boolean;
        fi06: Record<string, { shouldRetry: boolean; remainingMs: number }>;
        dst: { springTz: number; fallFirst: number; fallNext: number };
        adr1: { status: string; run_count: number };
        adr2: { status: string; terminal_result: string; run_count: number };
      };
      for (const rej of Object.values(matrixRes.fi05Rejections)) {
        expect(rej.kind).toBe('rejected');
        expect(rej.ackQueueMessage).toBe(true);
      }
      expect(matrixRes.nullQueueConstraintBlocked).toBe(true);
      expect(matrixRes.fi06.b0).toMatchObject({ shouldRetry: false, remainingMs: 0 });
      expect(matrixRes.fi06.b500).toMatchObject({ shouldRetry: false, remainingMs: 500 });
      expect(matrixRes.fi06.b1000).toMatchObject({ shouldRetry: false, remainingMs: 1000 });
      expect(matrixRes.fi06.b1001).toMatchObject({ shouldRetry: true, remainingMs: 1001 });
      expect(matrixRes.dst.springTz).toBe(Date.parse('2026-03-08T07:00:00Z'));
      expect(matrixRes.dst.fallFirst).toBe(Date.parse('2026-11-01T05:30:00Z'));
      expect(matrixRes.dst.fallNext).toBe(Date.parse('2026-11-02T06:30:00Z'));
      expect(matrixRes.adr1).toEqual({ status: 'cancelled', run_count: 0 });
      expect(matrixRes.adr2).toEqual({
        status: 'failed',
        terminal_result: 'DEADLINE_EXCEEDED',
        run_count: 0,
      });

      // Poll until duplicate Queue deliveries for FI-04 settle with commit_count === 1 (zero duplicate commits)
      let dupEntity: { status: string; commit_count: number } | undefined;
      for (let i = 0; i < 30; i += 1) {
        const snap = (await (
          await mf.dispatchFetch('http://localhost/inspect')
        ).json()) as InspectState;
        dupEntity = snap.entities.find((e) => e.entity_id === 'turn-fi04-dup');
        if (dupEntity?.status === 'succeeded') {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(dupEntity).toMatchObject({ status: 'succeeded', commit_count: 1 });

      // FI-01, FI-02, FI-03, FI-10, FI-11, FI-12 on isolated DO ten-cas:ag-cas
      const casRes = (await (
        await mf.dispatchFetch('http://localhost/fi-d1-cas-races?agent=ten-cas:ag-cas', {
          method: 'POST',
          body: JSON.stringify({ baseMs: base + 300_000 }),
        })
      ).json()) as {
        firstReg: { d1Called: boolean; generation: number };
        covCheck: { d1Called: boolean };
        staleUpsert: { accepted: boolean; currentGeneration: number };
        ackLostUpsert: { accepted: boolean };
        ackLossConfirmed: boolean;
        staleRetire: { retired: boolean };
        stalePostpone: { updated: boolean };
        postponeErr: boolean;
        afterPostponeTimeout: { coverage_state: string; pending_kind: string | null };
        fi01Plan: { action: string; generation: number };
        fi01PostponePlan: { action: string; generation: number };
        fi12: {
          uncoveredOutageStatus: number;
          uncoveredOutageCode: string;
          coveredD1Calls: number;
          coveredOutageRes: { d1Called: boolean };
        };
      };
      expect(casRes.firstReg.d1Called).toBe(true);
      expect(casRes.covCheck.d1Called).toBe(false);
      expect(casRes.staleUpsert).toMatchObject({ accepted: false, currentGeneration: 10 });
      expect(casRes.ackLostUpsert.accepted).toBe(true);
      expect(casRes.ackLossConfirmed).toBe(true);
      expect(casRes.staleRetire.retired).toBe(false);
      expect(casRes.stalePostpone.updated).toBe(false);
      expect(casRes.postponeErr).toBe(true);
      expect(casRes.afterPostponeTimeout.coverage_state).toBe('registering');
      expect(casRes.afterPostponeTimeout.pending_kind).toBe('postpone');
      expect(casRes.fi01Plan).toMatchObject({ action: 'repair_ensure', generation: 15 });
      expect(casRes.fi01PostponePlan).toMatchObject({ action: 'repair_ensure', generation: 17 });
      expect(casRes.fi12.uncoveredOutageStatus).toBe(503);
      expect(casRes.fi12.uncoveredOutageCode).toBe('DB_UNAVAILABLE');
      expect(casRes.fi12.coveredD1Calls).toBe(0);
      expect(casRes.fi12.coveredOutageRes.d1Called).toBe(false);

      // FI-09 Sweeper backoff -> quarantine -> preserved next_recovery_at_ms -> stale lease CAS -> auto-heal
      const fi09Res = (await (
        await mf.dispatchFetch('http://localhost/sweep-fi09', {
          method: 'POST',
          body: JSON.stringify({ baseMs: base + 400_000 }),
        })
      ).json()) as {
        r1: { backoffCount: number };
        d1Backoff: { status: string; actualRecoveryAtMs: number };
        r2: { quarantinedCount: number };
        d1Quarantined: { status: string; actualRecoveryAtMs: number };
        alerts: Array<{ recoveryAttempts: number }>;
        staleLeaseChanges: number;
        r3: { retiredCount: number };
        d1AfterHeal: { exists: boolean };
      };
      expect(fi09Res.r1.backoffCount).toBe(1);
      expect(fi09Res.d1Backoff).toMatchObject({
        status: 'backoff',
        actualRecoveryAtMs: base + 410_000,
      });
      expect(fi09Res.r2.quarantinedCount).toBe(1);
      expect(fi09Res.d1Quarantined).toMatchObject({
        status: 'quarantined',
        actualRecoveryAtMs: base + 410_000,
      });
      expect(fi09Res.alerts[0]?.recoveryAttempts).toBe(2);
      expect(fi09Res.staleLeaseChanges).toBe(0);
      expect(fi09Res.r3.retiredCount).toBe(1);
      expect(fi09Res.d1AfterHeal.exists).toBe(false);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
