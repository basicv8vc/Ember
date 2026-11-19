import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { resolveBenchmarkGitSha } from './evidence.js';
import { calculateDistribution } from './metrics.js';
import type {
  SqliteProbeReport,
  SqlOperationProbeMetrics,
  StorageGrowthPoint,
} from './v2-types.js';

interface WranglerStartedWorker {
  readonly ready: Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

interface WranglerModule {
  unstable_startWorker(options: Record<string, unknown>): Promise<WranglerStartedWorker>;
}

interface ProbeOpRawResponse {
  readonly logicalStatements: number;
  readonly logicalMutations: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly setAlarmCalls: number;
  readonly sqlDurationMs?: number;
  readonly dbSizeBeforeBytes: number;
  readonly dbSizeAfterBytes: number;
  readonly approved?: boolean;
  readonly remainingMicroUsd?: number;
}

export interface LocalWorkerdProbeHandle {
  readonly wranglerVersion: string;
  fetch(pathname: string, body?: unknown): Promise<Response>;
  dispose(): Promise<void>;
}

const PROBE_WORKER_SOURCE = `
import { DurableObject } from 'cloudflare:workers';

function sumCursor(acc, cursor) {
  acc.rowsRead += Number(cursor?.rowsRead ?? 0);
  acc.rowsWritten += Number(cursor?.rowsWritten ?? 0);
  acc.statements += 1;
}

function sumD1(acc, res) {
  const m = res?.meta ?? {};
  acc.rowsRead += Number(m.rows_read ?? 0);
  acc.rowsWritten += Number(m.rows_written ?? 0);
  acc.sqlDurationMs += Number(m.timings?.sql_duration_ms ?? m.duration ?? 0);
  acc.statements += 1;
}

export class AgentHeadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.initialized = false;
  }

  ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(\`
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        transcript_epoch INTEGER NOT NULL,
        next_seq INTEGER NOT NULL,
        budget_micro_usd INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        client_submission_id TEXT NOT NULL,
        body_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sub ON messages(client_submission_id);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_status_lease ON turns(status, lease_expires_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        next_retry_at INTEGER,
        result_summary TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_retry ON tasks(status, next_retry_at);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        next_due_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status_due ON outbox(status, next_due_at);
      CREATE TABLE IF NOT EXISTS usage_reservations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        reserved_micro_usd INTEGER NOT NULL,
        settled_micro_usd INTEGER,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS probe_meta (
        key TEXT PRIMARY KEY,
        val TEXT NOT NULL
      );
    \`);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO agent_state (agent_id, transcript_epoch, next_seq, budget_micro_usd, updated_at) VALUES ('agent-1', 1, 1, 1000000, ?)",
      Date.now(),
    );
    this.initialized = true;
  }

  async alarm() {
    this.ensureSchema();
    const now = Date.now();
    const due = [...this.ctx.storage.sql.exec(
      "SELECT id FROM outbox WHERE status = 'pending' AND next_due_at <= ? ORDER BY next_due_at ASC LIMIT 10",
      now + 1000,
    )];
    for (const row of due) {
      this.ctx.storage.sql.exec(
        "UPDATE outbox SET status = 'dispatched' WHERE id = ?",
        row.id,
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO probe_meta (key, val) VALUES ('last_alarm_fired_at', ?)",
      String(now),
    );
  }

  async fetch(req) {
    this.ensureSchema();
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const now = Date.now();
    const sizeBefore = this.ctx.storage.sql.databaseSize;
    const acc = { rowsRead: 0, rowsWritten: 0, statements: 0 };
    let logicalMutations = 0;
    let setAlarmCalls = 0;

    if (url.pathname === '/op/normal_turn_prepare') {
      const id = String(body.id ?? crypto.randomUUID());
      const msgId = 'm_' + id;
      const turnId = 't_' + id;
      const runId = 'r_' + id;
      const resId = 'u_' + id;
      const outId = 'o_' + id;

      this.ctx.storage.transactionSync(() => {
        const cState = this.ctx.storage.sql.exec("SELECT transcript_epoch, next_seq, budget_micro_usd FROM agent_state WHERE agent_id = 'agent-1'");
        const st = [...cState][0];
        sumCursor(acc, cState);

        const cHist = this.ctx.storage.sql.exec("SELECT id, role, body_text FROM messages WHERE conversation_id = 'conv-1' ORDER BY seq DESC LIMIT 8");
        [...cHist];
        sumCursor(acc, cHist);

        const cInsMsg = this.ctx.storage.sql.exec(
          "INSERT INTO messages (id, conversation_id, seq, role, client_submission_id, body_text, created_at) VALUES (?, 'conv-1', ?, 'user', ?, ?, ?)",
          msgId, Number(st.next_seq), 'sub_' + id, body.text ?? 'Hello V2 fast path turn payload', now,
        );
        sumCursor(acc, cInsMsg);
        logicalMutations += 1;

        const cInsTurn = this.ctx.storage.sql.exec(
          "INSERT INTO turns (id, conversation_id, user_message_id, status, run_id, lease_expires_at, attempt, updated_at) VALUES (?, 'conv-1', ?, 'running', ?, ?, 1, ?)",
          turnId, msgId, runId, now + 45000, now,
        );
        sumCursor(acc, cInsTurn);
        logicalMutations += 1;

        const cInsRes = this.ctx.storage.sql.exec(
          "INSERT INTO usage_reservations (id, run_id, reserved_micro_usd, status, updated_at) VALUES (?, ?, 5000, 'reserved', ?)",
          resId, runId, now,
        );
        sumCursor(acc, cInsRes);
        logicalMutations += 1;

        const cUpdState = this.ctx.storage.sql.exec(
          "UPDATE agent_state SET next_seq = next_seq + 1, budget_micro_usd = budget_micro_usd - 5000, updated_at = ? WHERE agent_id = 'agent-1'",
          now,
        );
        sumCursor(acc, cUpdState);
        logicalMutations += 1;

        const cInsOut = this.ctx.storage.sql.exec(
          "INSERT INTO outbox (id, kind, status, payload_json, next_due_at) VALUES (?, 'turn.recovery', 'pending', ?, ?)",
          outId, JSON.stringify({ turnId, runId }), now + 45000,
        );
        sumCursor(acc, cInsOut);
        logicalMutations += 1;
      });
      await this.ctx.storage.setAlarm(now + 45000);
      setAlarmCalls += 1;
    } else if (url.pathname === '/op/normal_turn_commit') {
      const id = String(body.id ?? 'default');
      const replyId = 'ma_' + id;
      const turnId = 't_' + id;
      const resId = 'u_' + id;
      const outId = 'o_' + id;

      this.ctx.storage.transactionSync(() => {
        const cState = this.ctx.storage.sql.exec("SELECT next_seq FROM agent_state WHERE agent_id = 'agent-1'");
        const st = [...cState][0];
        sumCursor(acc, cState);

        const cInsMsg = this.ctx.storage.sql.exec(
          "INSERT INTO messages (id, conversation_id, seq, role, client_submission_id, body_text, created_at) VALUES (?, 'conv-1', ?, 'assistant', ?, ?, ?)",
          replyId, Number(st.next_seq), 'sub_a_' + id, body.reply ?? 'Simulated assistant response text for V2 probe', now,
        );
        sumCursor(acc, cInsMsg);
        logicalMutations += 1;

        const cUpdTurn = this.ctx.storage.sql.exec(
          "UPDATE turns SET status = 'completed', updated_at = ? WHERE id = ?",
          now, turnId,
        );
        sumCursor(acc, cUpdTurn);
        logicalMutations += 1;

        const cUpdRes = this.ctx.storage.sql.exec(
          "UPDATE usage_reservations SET settled_micro_usd = 1200, status = 'settled', updated_at = ? WHERE id = ?",
          now, resId,
        );
        sumCursor(acc, cUpdRes);
        logicalMutations += 1;

        const cUpdState = this.ctx.storage.sql.exec(
          "UPDATE agent_state SET next_seq = next_seq + 1, budget_micro_usd = budget_micro_usd + 3800, updated_at = ? WHERE agent_id = 'agent-1'",
          now,
        );
        sumCursor(acc, cUpdState);
        logicalMutations += 1;

        const cDelOut = this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", outId);
        sumCursor(acc, cDelOut);
        logicalMutations += 1;
      });
    } else if (url.pathname === '/op/task_submit') {
      const id = String(body.id ?? crypto.randomUUID());
      const taskId = 'tk_' + id;
      const outId = 'to_' + id;
      this.ctx.storage.transactionSync(() => {
        const cTask = this.ctx.storage.sql.exec(
          "INSERT INTO tasks (id, kind, status, attempt, next_retry_at, updated_at) VALUES (?, 'mock.compute', 'queued', 0, ?, ?)",
          taskId, now + 60000, now,
        );
        sumCursor(acc, cTask);
        logicalMutations += 1;

        const cOut = this.ctx.storage.sql.exec(
          "INSERT INTO outbox (id, kind, status, payload_json, next_due_at) VALUES (?, 'queue.dispatch', 'pending', ?, ?)",
          outId, JSON.stringify({ taskId }), now,
        );
        sumCursor(acc, cOut);
        logicalMutations += 1;
      });
      await this.ctx.storage.setAlarm(now + 60000);
      setAlarmCalls += 1;
    } else if (url.pathname === '/op/task_claim_complete') {
      const id = String(body.id ?? 'default');
      const taskId = 'tk_' + id;
      const outId = 'to_' + id;
      const runId = 'run_' + id;
      this.ctx.storage.transactionSync(() => {
        const cRead = this.ctx.storage.sql.exec("SELECT id, status, attempt FROM tasks WHERE id = ?", taskId);
        [...cRead];
        sumCursor(acc, cRead);

        const cClaim = this.ctx.storage.sql.exec(
          "UPDATE tasks SET status = 'running', run_id = ?, attempt = attempt + 1, lease_expires_at = ?, updated_at = ? WHERE id = ?",
          runId, now + 45000, now, taskId,
        );
        sumCursor(acc, cClaim);
        logicalMutations += 1;

        const cFinish = this.ctx.storage.sql.exec(
          "UPDATE tasks SET status = 'completed', result_summary = 'sha256 verified', updated_at = ? WHERE id = ?",
          now, taskId,
        );
        sumCursor(acc, cFinish);
        logicalMutations += 1;

        const cDelOut = this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", outId);
        sumCursor(acc, cDelOut);
        logicalMutations += 1;
      });
    } else if (url.pathname === '/op/lease_renewal') {
      const id = String(body.id ?? 'default');
      const turnId = 't_' + id;
      this.ctx.storage.transactionSync(() => {
        const cRead = this.ctx.storage.sql.exec("SELECT status, lease_expires_at FROM turns WHERE id = ?", turnId);
        [...cRead];
        sumCursor(acc, cRead);

        const cUpd = this.ctx.storage.sql.exec(
          "UPDATE turns SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
          now + 45000, now, turnId,
        );
        sumCursor(acc, cUpd);
        logicalMutations += 1;
      });
      await this.ctx.storage.setAlarm(now + 45000);
      setAlarmCalls += 1;
    } else if (url.pathname === '/op/alarm_batch_dispatch') {
      // Seed 5 due items then execute the exact alarm batch logic
      const batchPrefix = String(body.id ?? 'batch');
      for (let k = 0; k < 5; k++) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO outbox (id, kind, status, payload_json, next_due_at) VALUES (?, 'schedule.tick', 'pending', '{}', ?)",
          batchPrefix + '_' + k, now - 10,
        );
      }
      this.ctx.storage.transactionSync(() => {
        const cDue = this.ctx.storage.sql.exec(
          "SELECT id FROM outbox WHERE status = 'pending' AND next_due_at <= ? ORDER BY next_due_at ASC LIMIT 5",
          now,
        );
        const rows = [...cDue];
        sumCursor(acc, cDue);
        for (const r of rows) {
          const cUpd = this.ctx.storage.sql.exec(
            "UPDATE outbox SET status = 'dispatched' WHERE id = ?",
            r.id,
          );
          sumCursor(acc, cUpd);
          logicalMutations += 1;
        }
        const cNext = this.ctx.storage.sql.exec(
          "SELECT MIN(next_due_at) AS next_at FROM outbox WHERE status = 'pending'",
        );
        [...cNext];
        sumCursor(acc, cNext);
      });
      await this.ctx.storage.setAlarm(now + 60000);
      setAlarmCalls += 1;
    } else if (url.pathname === '/op/retry_schedule') {
      const id = String(body.id ?? 'default');
      const taskId = 'tk_' + id;
      this.ctx.storage.transactionSync(() => {
        const cRead = this.ctx.storage.sql.exec("SELECT attempt FROM tasks WHERE id = ?", taskId);
        [...cRead];
        sumCursor(acc, cRead);

        const cUpd = this.ctx.storage.sql.exec(
          "UPDATE tasks SET status = 'retryable_failed', attempt = attempt + 1, next_retry_at = ?, updated_at = ? WHERE id = ?",
          now + 5000, now, taskId,
        );
        sumCursor(acc, cUpd);
        logicalMutations += 1;
      });
      await this.ctx.storage.setAlarm(now + 5000);
      setAlarmCalls += 1;
    } else if (url.pathname === '/op/trigger_real_alarm') {
      await this.ctx.storage.setAlarm(now + 10);
      setAlarmCalls += 1;
      return Response.json({ scheduledAt: now + 10 });
    } else if (url.pathname === '/op/check_real_alarm') {
      const row = [...this.ctx.storage.sql.exec("SELECT val FROM probe_meta WHERE key = 'last_alarm_fired_at'")][0];
      return Response.json({ firedAt: row ? Number(row.val) : null });
    } else if (url.pathname === '/op/db_size') {
      return Response.json({ dbSizeBytes: this.ctx.storage.sql.databaseSize });
    } else {
      return new Response('Unknown DO probe operation: ' + url.pathname, { status: 404 });
    }

    const sizeAfter = this.ctx.storage.sql.databaseSize;
    return Response.json({
      logicalStatements: acc.statements,
      logicalMutations,
      rowsRead: acc.rowsRead,
      rowsWritten: acc.rowsWritten,
      setAlarmCalls,
      dbSizeBeforeBytes: sizeBefore,
      dbSizeAfterBytes: sizeAfter,
    });
  }
}

let d1Initialized = false;
async function ensureD1Schema(db) {
  if (d1Initialized) return;
  await db.batch([
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_agent_state (
      agent_id TEXT PRIMARY KEY,
      transcript_epoch INTEGER NOT NULL,
      next_seq INTEGER NOT NULL,
      budget_micro_usd INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      client_submission_id TEXT NOT NULL,
      body_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE UNIQUE INDEX IF NOT EXISTS idx_d1_messages_conv_seq ON d1_messages(agent_id, conversation_id, seq)\`),
    db.prepare(\`CREATE UNIQUE INDEX IF NOT EXISTS idx_d1_messages_sub ON d1_messages(agent_id, client_submission_id)\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_turns (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE INDEX IF NOT EXISTS idx_d1_turns_status_lease ON d1_turns(agent_id, status, lease_expires_at)\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER,
      next_retry_at INTEGER,
      result_summary TEXT,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE INDEX IF NOT EXISTS idx_d1_tasks_status_retry ON d1_tasks(agent_id, status, next_retry_at)\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_outbox (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      next_due_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE INDEX IF NOT EXISTS idx_d1_outbox_status_due ON d1_outbox(status, next_due_at)\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_usage_reservations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      reserved_micro_usd INTEGER NOT NULL,
      settled_micro_usd INTEGER,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_recovery_registry (
      agent_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      next_recovery_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare(\`CREATE INDEX IF NOT EXISTS idx_d1_recovery_due ON d1_recovery_registry(next_recovery_at)\`),
    db.prepare(\`CREATE TABLE IF NOT EXISTS d1_global_budget (
      budget_key TEXT PRIMARY KEY,
      cap_micro_usd INTEGER NOT NULL,
      spent_micro_usd INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )\`),
    db.prepare("INSERT OR IGNORE INTO d1_agent_state (agent_id, transcript_epoch, next_seq, budget_micro_usd, updated_at) VALUES ('agent-1', 1, 1, 1000000, 0)"),
    db.prepare("INSERT OR IGNORE INTO d1_global_budget (budget_key, cap_micro_usd, spent_micro_usd, updated_at) VALUES ('global-default', 1000000, 0, 0)"),
  ]);
  d1Initialized = true;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    if (url.pathname.startsWith('/do/')) {
      const doPath = url.pathname.slice(3);
      const agentKey = String(body.agentKey ?? 'agent-1');
      const stub = env.AGENT.get(env.AGENT.idFromName(agentKey));
      return stub.fetch('https://do.local/op' + doPath, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'POST' ? JSON.stringify(body) : undefined,
      });
    }

    if (url.pathname.startsWith('/d1/')) {
      await ensureD1Schema(env.D1_CONTROL);
      const now = Date.now();
      const acc = { rowsRead: 0, rowsWritten: 0, sqlDurationMs: 0, statements: 0 };
      let logicalMutations = 0;
      let sizeBefore = 0;
      let sizeAfter = 0;

      if (url.pathname === '/d1/budget_reset') {
        const cap = Number(body.capMicroUsd ?? 1000000);
        const key = String(body.budgetKey ?? 'global-default');
        await env.D1_CONTROL.prepare(
          "INSERT OR REPLACE INTO d1_global_budget (budget_key, cap_micro_usd, spent_micro_usd, updated_at) VALUES (?, ?, 0, ?)",
        ).bind(key, cap, now).run();
        return Response.json({ ok: true });
      }

      if (url.pathname === '/d1/budget_check') {
        const key = String(body.budgetKey ?? 'global-default');
        const reserve = Number(body.reserveMicroUsd ?? 5000);
        const res = await env.D1_CONTROL.prepare(
          "UPDATE d1_global_budget SET spent_micro_usd = spent_micro_usd + ?, updated_at = ? WHERE budget_key = ? AND spent_micro_usd + ? <= cap_micro_usd RETURNING cap_micro_usd - spent_micro_usd AS remaining_micro_usd",
        ).bind(reserve, now, key, reserve).all();
        sumD1(acc, res);
        const approved = (res.results?.length ?? 0) === 1;
        if (approved) logicalMutations += 1;
        sizeAfter = Number(res.meta?.size_after ?? 0);
        return Response.json({
          approved,
          remainingMicroUsd: approved ? Number(res.results[0].remaining_micro_usd) : 0,
          logicalStatements: acc.statements,
          logicalMutations,
          rowsRead: acc.rowsRead,
          rowsWritten: acc.rowsWritten,
          sqlDurationMs: acc.sqlDurationMs,
          setAlarmCalls: 0,
          dbSizeBeforeBytes: sizeAfter,
          dbSizeAfterBytes: sizeAfter,
        });
      }

      if (url.pathname === '/d1/recovery_lookup') {
        const agentKey = String(body.agentKey ?? 'agent-1');
        const res = await env.D1_CONTROL.prepare(
          "SELECT agent_id, generation, next_recovery_at FROM d1_recovery_registry WHERE agent_id = ?",
        ).bind(agentKey).all();
        sumD1(acc, res);
        sizeAfter = Number(res.meta?.size_after ?? 0);
        return Response.json({
          logicalStatements: acc.statements,
          logicalMutations: 0,
          rowsRead: acc.rowsRead,
          rowsWritten: acc.rowsWritten,
          sqlDurationMs: acc.sqlDurationMs,
          setAlarmCalls: 0,
          dbSizeBeforeBytes: sizeAfter,
          dbSizeAfterBytes: sizeAfter,
        });
      }

      if (url.pathname === '/d1/normal_turn_prepare') {
        const id = String(body.id ?? crypto.randomUUID());
        const msgId = 'm_' + id;
        const turnId = 't_' + id;
        const runId = 'r_' + id;
        const resId = 'u_' + id;
        const outId = 'o_' + id;

        const stRes = await env.D1_CONTROL.prepare("SELECT next_seq FROM d1_agent_state WHERE agent_id = 'agent-1'").all();
        sumD1(acc, stRes);
        sizeBefore = Number(stRes.meta?.size_after ?? 0);
        const seq = Number(stRes.results?.[0]?.next_seq ?? 1);

        const histRes = await env.D1_CONTROL.prepare("SELECT id, role, body_text FROM d1_messages WHERE agent_id = 'agent-1' AND conversation_id = 'conv-1' ORDER BY seq DESC LIMIT 8").all();
        sumD1(acc, histRes);

        const batchRes = await env.D1_CONTROL.batch([
          env.D1_CONTROL.prepare("INSERT INTO d1_messages (id, agent_id, conversation_id, seq, role, client_submission_id, body_text, created_at) VALUES (?, 'agent-1', 'conv-1', ?, 'user', ?, ?, ?)").bind(msgId, seq, 'sub_' + id, body.text ?? 'Hello V2 fast path turn payload', now),
          env.D1_CONTROL.prepare("INSERT INTO d1_turns (id, agent_id, conversation_id, user_message_id, status, run_id, lease_expires_at, attempt, updated_at) VALUES (?, 'agent-1', 'conv-1', ?, 'running', ?, ?, 1, ?)").bind(turnId, msgId, runId, now + 45000, now),
          env.D1_CONTROL.prepare("INSERT INTO d1_usage_reservations (id, agent_id, run_id, reserved_micro_usd, status, updated_at) VALUES (?, 'agent-1', ?, 5000, 'reserved', ?)").bind(resId, runId, now),
          env.D1_CONTROL.prepare("UPDATE d1_agent_state SET next_seq = next_seq + 1, budget_micro_usd = budget_micro_usd - 5000, updated_at = ? WHERE agent_id = 'agent-1'").bind(now),
          env.D1_CONTROL.prepare("INSERT INTO d1_outbox (id, agent_id, kind, status, payload_json, next_due_at) VALUES (?, 'agent-1', 'turn.recovery', 'pending', ?, ?)").bind(outId, JSON.stringify({ turnId, runId }), now + 45000),
          env.D1_CONTROL.prepare("INSERT OR REPLACE INTO d1_recovery_registry (agent_id, generation, next_recovery_at, updated_at) VALUES ('agent-1', ?, ?, ?)").bind(seq, now + 45000, now),
        ]);
        for (const r of batchRes) sumD1(acc, r);
        logicalMutations += 6;
        sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? sizeBefore);
      } else if (url.pathname === '/d1/normal_turn_commit') {
        const id = String(body.id ?? 'default');
        const stRes = await env.D1_CONTROL.prepare("SELECT next_seq FROM d1_agent_state WHERE agent_id = 'agent-1'").all();
        sumD1(acc, stRes);
        sizeBefore = Number(stRes.meta?.size_after ?? 0);
        const seq = Number(stRes.results?.[0]?.next_seq ?? 1);

        const batchRes = await env.D1_CONTROL.batch([
          env.D1_CONTROL.prepare("INSERT INTO d1_messages (id, agent_id, conversation_id, seq, role, client_submission_id, body_text, created_at) VALUES (?, 'agent-1', 'conv-1', ?, 'assistant', ?, ?, ?)").bind('ma_' + id, seq, 'sub_a_' + id, body.reply ?? 'Simulated assistant response text for V2 probe', now),
          env.D1_CONTROL.prepare("UPDATE d1_turns SET status = 'completed', updated_at = ? WHERE id = ?").bind(now, 't_' + id),
          env.D1_CONTROL.prepare("UPDATE d1_usage_reservations SET settled_micro_usd = 1200, status = 'settled', updated_at = ? WHERE id = ?").bind(now, 'u_' + id),
          env.D1_CONTROL.prepare("UPDATE d1_agent_state SET next_seq = next_seq + 1, budget_micro_usd = budget_micro_usd + 3800, updated_at = ? WHERE agent_id = 'agent-1'").bind(now),
          env.D1_CONTROL.prepare("DELETE FROM d1_outbox WHERE id = ?").bind('o_' + id),
          env.D1_CONTROL.prepare("DELETE FROM d1_recovery_registry WHERE agent_id = 'agent-1'"),
        ]);
        for (const r of batchRes) sumD1(acc, r);
        logicalMutations += 6;
        sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? sizeBefore);
      } else if (url.pathname === '/d1/task_submit') {
        const id = String(body.id ?? crypto.randomUUID());
        const batchRes = await env.D1_CONTROL.batch([
          env.D1_CONTROL.prepare("INSERT INTO d1_tasks (id, agent_id, kind, status, attempt, next_retry_at, updated_at) VALUES (?, 'agent-1', 'mock.compute', 'queued', 0, ?, ?)").bind('tk_' + id, now + 60000, now),
          env.D1_CONTROL.prepare("INSERT INTO d1_outbox (id, agent_id, kind, status, payload_json, next_due_at) VALUES (?, 'agent-1', 'queue.dispatch', 'pending', ?, ?)").bind('to_' + id, JSON.stringify({ taskId: 'tk_' + id }), now),
          env.D1_CONTROL.prepare("INSERT OR REPLACE INTO d1_recovery_registry (agent_id, generation, next_recovery_at, updated_at) VALUES ('agent-1', 1, ?, ?)").bind(now + 60000, now),
        ]);
        for (const r of batchRes) sumD1(acc, r);
        logicalMutations += 3;
        sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? 0);
        sizeBefore = sizeAfter;
      } else if (url.pathname === '/d1/task_claim_complete') {
        const id = String(body.id ?? 'default');
        const readRes = await env.D1_CONTROL.prepare("SELECT id, status, attempt FROM d1_tasks WHERE id = ?").bind('tk_' + id).all();
        sumD1(acc, readRes);
        sizeBefore = Number(readRes.meta?.size_after ?? 0);
        const batchRes = await env.D1_CONTROL.batch([
          env.D1_CONTROL.prepare("UPDATE d1_tasks SET status = 'running', run_id = ?, attempt = attempt + 1, lease_expires_at = ?, updated_at = ? WHERE id = ?").bind('run_' + id, now + 45000, now, 'tk_' + id),
          env.D1_CONTROL.prepare("UPDATE d1_tasks SET status = 'completed', result_summary = 'sha256 verified', updated_at = ? WHERE id = ?").bind(now, 'tk_' + id),
          env.D1_CONTROL.prepare("DELETE FROM d1_outbox WHERE id = ?").bind('to_' + id),
        ]);
        for (const r of batchRes) sumD1(acc, r);
        logicalMutations += 3;
        sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? sizeBefore);
      } else if (url.pathname === '/d1/lease_renewal') {
        const id = String(body.id ?? 'default');
        const r1 = await env.D1_CONTROL.prepare("SELECT status, lease_expires_at FROM d1_turns WHERE id = ?").bind('t_' + id).all();
        sumD1(acc, r1);
        sizeBefore = Number(r1.meta?.size_after ?? 0);
        const r2 = await env.D1_CONTROL.prepare("UPDATE d1_turns SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(now + 45000, now, 't_' + id).run();
        sumD1(acc, r2);
        logicalMutations += 1;
        sizeAfter = Number(r2.meta?.size_after ?? sizeBefore);
      } else if (url.pathname === '/d1/alarm_batch_dispatch') {
        const batchPrefix = String(body.id ?? 'batch');
        const seedStmts = [];
        for (let k = 0; k < 5; k++) {
          seedStmts.push(
            env.D1_CONTROL.prepare("INSERT OR REPLACE INTO d1_outbox (id, agent_id, kind, status, payload_json, next_due_at) VALUES (?, 'agent-1', 'schedule.tick', 'pending', '{}', ?)").bind(batchPrefix + '_' + k, now - 10),
          );
        }
        await env.D1_CONTROL.batch(seedStmts);
        const dueRes = await env.D1_CONTROL.prepare("SELECT id FROM d1_outbox WHERE status = 'pending' AND next_due_at <= ? ORDER BY next_due_at ASC LIMIT 5").bind(now).all();
        sumD1(acc, dueRes);
        sizeBefore = Number(dueRes.meta?.size_after ?? 0);
        const updStmts = (dueRes.results ?? []).map((r) =>
          env.D1_CONTROL.prepare("UPDATE d1_outbox SET status = 'dispatched' WHERE id = ?").bind(r.id),
        );
        if (updStmts.length > 0) {
          const batchRes = await env.D1_CONTROL.batch(updStmts);
          for (const r of batchRes) sumD1(acc, r);
          logicalMutations += updStmts.length;
          sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? sizeBefore);
        } else {
          sizeAfter = sizeBefore;
        }
      } else if (url.pathname === '/d1/retry_schedule') {
        const id = String(body.id ?? 'default');
        const r1 = await env.D1_CONTROL.prepare("SELECT attempt FROM d1_tasks WHERE id = ?").bind('tk_' + id).all();
        sumD1(acc, r1);
        sizeBefore = Number(r1.meta?.size_after ?? 0);
        const batchRes = await env.D1_CONTROL.batch([
          env.D1_CONTROL.prepare("UPDATE d1_tasks SET status = 'retryable_failed', attempt = attempt + 1, next_retry_at = ?, updated_at = ? WHERE id = ?").bind(now + 5000, now, 'tk_' + id),
          env.D1_CONTROL.prepare("INSERT OR REPLACE INTO d1_recovery_registry (agent_id, generation, next_recovery_at, updated_at) VALUES ('agent-1', 2, ?, ?)").bind(now + 5000, now),
        ]);
        for (const r of batchRes) sumD1(acc, r);
        logicalMutations += 2;
        sizeAfter = Number(batchRes[batchRes.length - 1]?.meta?.size_after ?? sizeBefore);
      } else if (url.pathname === '/d1/db_size') {
        const r = await env.D1_CONTROL.prepare("SELECT COUNT(*) AS cnt FROM d1_messages").all();
        return Response.json({ dbSizeBytes: Number(r.meta?.size_after ?? 0) });
      }

      return Response.json({
        logicalStatements: acc.statements,
        logicalMutations,
        rowsRead: acc.rowsRead,
        rowsWritten: acc.rowsWritten,
        sqlDurationMs: acc.sqlDurationMs,
        setAlarmCalls: 0,
        dbSizeBeforeBytes: sizeBefore,
        dbSizeAfterBytes: sizeAfter,
      });
    }

    return new Response('not found', { status: 404 });
  },
};
`;

/**
 * Boot an isolated local Cloudflare `workerd` instance via Wrangler containing
 * a SQLite-backed `AgentHeadDO` and a local D1 database (`D1_CONTROL`).
 */
export async function startLocalWorkerdProbe(): Promise<LocalWorkerdProbeHandle> {
  const apiPkgUrl = new URL('../../api/package.json', import.meta.url);
  const req = createRequire(apiPkgUrl);
  const wranglerEntry = req.resolve('wrangler');
  const wranglerPkgPath = path.resolve(path.dirname(wranglerEntry), '../package.json');
  let wranglerVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(wranglerPkgPath, 'utf8')) as { version?: string };
    wranglerVersion = pkg.version ?? 'unknown';
  } catch {
    // ignore
  }

  const wranglerMod = (await import(wranglerEntry)) as WranglerModule;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ember-v2-sqlite-probe-'));
  const workerPath = path.join(tempDir, 'probe-worker.mjs');
  writeFileSync(workerPath, PROBE_WORKER_SOURCE, 'utf8');

  const worker = await wranglerMod.unstable_startWorker({
    name: 'ember-v2-m0-probe',
    entrypoint: workerPath,
    compatibilityDate: '2026-11-01',
    dev: {
      persist: path.join(tempDir, '.wrangler/state'),
      liveReload: false,
      logLevel: 'error',
      server: { port: 0 },
    },
    bindings: {
      AGENT: { type: 'durable_object_namespace', class_name: 'AgentHeadDO' },
      D1_CONTROL: {
        type: 'd1',
        database_id: '00000000-0000-0000-0000-000000000002',
        database_name: 'ember-v2-probe-d1',
      },
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['AgentHeadDO'] }],
  });

  await worker.ready;

  return {
    wranglerVersion,
    fetch: async (pathname: string, body?: unknown): Promise<Response> => {
      return worker.fetch(`http://localhost${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    dispose: async (): Promise<void> => {
      await worker.dispose().catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function runProbeIterations(
  probe: LocalWorkerdProbeHandle,
  engine: 'do_sqlite' | 'd1_local',
  operation: string,
  iterations: number,
  execFn: (iter: number) => Promise<ProbeOpRawResponse>,
): Promise<SqlOperationProbeMetrics> {
  const latencies: number[] = [];
  const sqlDurations: number[] = [];
  const reads: number[] = [];
  const writes: number[] = [];
  let logicalStatements = 0;
  let logicalMutations = 0;
  let setAlarmCalls = 0;
  let dbSizeBeforeBytes = 0;
  let dbSizeAfterBytes = 0;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const res = await execFn(i);
    latencies.push(performance.now() - t0);
    if (typeof res.sqlDurationMs === 'number') {
      sqlDurations.push(res.sqlDurationMs);
    }
    reads.push(res.rowsRead);
    writes.push(res.rowsWritten);
    logicalStatements = res.logicalStatements;
    logicalMutations = res.logicalMutations;
    setAlarmCalls = res.setAlarmCalls;
    if (i === 0) {
      dbSizeBeforeBytes = res.dbSizeBeforeBytes;
    }
    dbSizeAfterBytes = res.dbSizeAfterBytes;
  }

  const mean = (arr: readonly number[]): number =>
    arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : 0;
  const readsDist = calculateDistribution(reads);
  const writesDist = calculateDistribution(writes);
  const storageDeltaBytesTotal = Math.max(0, dbSizeAfterBytes - dbSizeBeforeBytes);

  return {
    engine,
    operation,
    iterations,
    logicalStatementsPerOp: logicalStatements,
    logicalMutationsPerOp: logicalMutations,
    observedRowsReadMean: mean(reads),
    observedRowsReadP95: readsDist.p95Ms,
    observedRowsWrittenMean: mean(writes),
    observedRowsWrittenP95: writesDist.p95Ms,
    setAlarmCallsPerOp: setAlarmCalls,
    latencyMs: calculateDistribution(latencies),
    ...(sqlDurations.length > 0 ? { sqlDurationMs: calculateDistribution(sqlDurations) } : {}),
    dbSizeBeforeBytes,
    dbSizeAfterBytes,
    storageDeltaBytesTotal,
    storageDeltaBytesPerOp: Number((storageDeltaBytesTotal / Math.max(1, iterations)).toFixed(1)),
  };
}

async function callProbeOp(
  probe: LocalWorkerdProbeHandle,
  pathname: string,
  body: Record<string, unknown>,
): Promise<ProbeOpRawResponse> {
  const resp = await probe.fetch(pathname, body);
  if (!resp.ok) {
    throw new Error(`Probe operation ${pathname} failed: HTTP ${resp.status}`);
  }
  return (await resp.json()) as ProbeOpRawResponse;
}

export interface SqliteProbeOptions {
  readonly iterations?: number;
  readonly storageTurnsMax?: number;
  readonly log?: (message: string) => void;
}

/**
 * Run the isolated local DO SQLite vs D1 comparison probe across V2 operations
 * (normal chat turn, task lifecycle, lease renewal, alarm batch dispatch, retry, and storage growth).
 */
export async function runSqliteProbe(options: SqliteProbeOptions = {}): Promise<SqliteProbeReport> {
  const iterations = options.iterations ?? 30;
  const storageTurnsMax = options.storageTurnsMax ?? 300;
  const log = options.log ?? ((msg: string) => console.log(msg));

  log(`[SQLite Probe] Starting isolated local workerd DO SQLite + D1 probe...`);
  const probe = await startLocalWorkerdProbe();

  try {
    // Warmup both engines so schema initialization is excluded from steady-state measurements
    await callProbeOp(probe, '/do/normal_turn_prepare', { agentKey: 'warmup', id: 'w0' });
    await callProbeOp(probe, '/do/normal_turn_commit', { agentKey: 'warmup', id: 'w0' });
    await callProbeOp(probe, '/d1/normal_turn_prepare', { id: 'w0' });
    await callProbeOp(probe, '/d1/normal_turn_commit', { id: 'w0' });

    const operations: SqlOperationProbeMetrics[] = [];

    const runEngineSuite = async (engine: 'do_sqlite' | 'd1_local'): Promise<void> => {
      const prefix = engine === 'do_sqlite' ? '/do' : '/d1';
      const agentKey = `agent-bench-${engine}`;

      // 1. Normal conversation prepare + commit (paired on same turn IDs)
      operations.push(
        await runProbeIterations(probe, engine, 'normal_turn_prepare', iterations, (i) =>
          callProbeOp(probe, `${prefix}/normal_turn_prepare`, {
            agentKey,
            id: `${engine}_turn_${i}`,
            text: `Benchmark user message #${i} asking for quick response.`,
          }),
        ),
      );

      operations.push(
        await runProbeIterations(probe, engine, 'lease_renewal', iterations, (i) =>
          callProbeOp(probe, `${prefix}/lease_renewal`, {
            agentKey,
            id: `${engine}_turn_${i}`,
          }),
        ),
      );

      operations.push(
        await runProbeIterations(probe, engine, 'normal_turn_commit', iterations, (i) =>
          callProbeOp(probe, `${prefix}/normal_turn_commit`, {
            agentKey,
            id: `${engine}_turn_${i}`,
            reply: `Simulated assistant response #${i} committed under fence.`,
          }),
        ),
      );

      // 2. Task submit -> retry -> claim & complete
      operations.push(
        await runProbeIterations(probe, engine, 'task_submit', iterations, (i) =>
          callProbeOp(probe, `${prefix}/task_submit`, {
            agentKey,
            id: `${engine}_task_${i}`,
          }),
        ),
      );

      operations.push(
        await runProbeIterations(probe, engine, 'retry_schedule', iterations, (i) =>
          callProbeOp(probe, `${prefix}/retry_schedule`, {
            agentKey,
            id: `${engine}_task_${i}`,
          }),
        ),
      );

      operations.push(
        await runProbeIterations(probe, engine, 'task_claim_complete', iterations, (i) =>
          callProbeOp(probe, `${prefix}/task_claim_complete`, {
            agentKey,
            id: `${engine}_task_${i}`,
          }),
        ),
      );

      // 3. Alarm batch dispatch (5 due items per invocation)
      operations.push(
        await runProbeIterations(probe, engine, 'alarm_batch_dispatch', iterations, (i) =>
          callProbeOp(probe, `${prefix}/alarm_batch_dispatch`, {
            agentKey,
            id: `${engine}_alarm_${i}`,
          }),
        ),
      );
    };

    await runEngineSuite('do_sqlite');
    await runEngineSuite('d1_local');

    // Verify real DO Alarm firing in workerd
    const trigResp = await probe.fetch('/do/trigger_real_alarm', { agentKey: 'alarm-check' });
    const { scheduledAt } = (await trigResp.json()) as { scheduledAt: number };
    let alarmRealFireVerified = false;
    let alarmRealFireDelayMs: number | null = null;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const checkResp = await probe.fetch('/do/check_real_alarm', { agentKey: 'alarm-check' });
      const checkData = (await checkResp.json()) as { firedAt: number | null };
      if (checkData.firedAt !== null) {
        alarmRealFireVerified = true;
        alarmRealFireDelayMs = Math.max(0, checkData.firedAt - scheduledAt);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // Measure storage growth curve on fresh DO & D1 keys
    const checkpoints = [
      0,
      Math.round(storageTurnsMax / 6),
      Math.round(storageTurnsMax / 2),
      storageTurnsMax,
    ];
    const growthPoints: StorageGrowthPoint[] = [];
    const doGrowthKey = 'growth-agent';

    // Initialize growth DO
    await callProbeOp(probe, '/do/db_size', { agentKey: doGrowthKey });
    let executedTurns = 0;

    for (const target of checkpoints) {
      while (executedTurns < target) {
        const turnId = `g_${executedTurns}`;
        await callProbeOp(probe, '/do/normal_turn_prepare', {
          agentKey: doGrowthKey,
          id: turnId,
          text: 'User prompt text (~120 bytes) for measuring steady-state DO SQLite and D1 storage growth per turn.',
        });
        await callProbeOp(probe, '/do/normal_turn_commit', {
          agentKey: doGrowthKey,
          id: turnId,
          reply:
            'Assistant reply (~280 bytes) simulating typical personal agent turn persisted with indexes and metadata in SQLite.',
        });
        await callProbeOp(probe, '/d1/normal_turn_prepare', {
          id: turnId,
          text: 'User prompt text (~120 bytes) for measuring steady-state DO SQLite and D1 storage growth per turn.',
        });
        await callProbeOp(probe, '/d1/normal_turn_commit', {
          id: turnId,
          reply:
            'Assistant reply (~280 bytes) simulating typical personal agent turn persisted with indexes and metadata in SQLite.',
        });
        executedTurns++;
      }
      const doSize = (await (
        await probe.fetch('/do/db_size', { agentKey: doGrowthKey })
      ).json()) as {
        dbSizeBytes: number;
      };
      const d1Size = (await (await probe.fetch('/d1/db_size', {})).json()) as {
        dbSizeBytes: number;
      };
      growthPoints.push({
        turnCount: executedTurns,
        doSqliteBytes: doSize.dbSizeBytes,
        d1Bytes: d1Size.dbSizeBytes,
      });
    }

    const firstPt = growthPoints[0]!;
    const lastPt = growthPoints[growthPoints.length - 1]!;
    const spanTurns = Math.max(1, lastPt.turnCount - firstPt.turnCount);

    // Build side-by-side comparison summary
    const opNames = [
      'normal_turn_prepare',
      'normal_turn_commit',
      'task_submit',
      'task_claim_complete',
      'lease_renewal',
      'alarm_batch_dispatch',
      'retry_schedule',
    ];
    const comparisonSummary = opNames.map((op) => {
      const doOp = operations.find((o) => o.engine === 'do_sqlite' && o.operation === op)!;
      const d1Op = operations.find((o) => o.engine === 'd1_local' && o.operation === op)!;
      return {
        operation: op,
        doRowsReadMean: doOp.observedRowsReadMean,
        doRowsWrittenMean: doOp.observedRowsWrittenMean,
        doLatencyP50Ms: doOp.latencyMs.p50Ms,
        doLatencyP95Ms: doOp.latencyMs.p95Ms,
        d1RowsReadMean: d1Op.observedRowsReadMean,
        d1RowsWrittenMean: d1Op.observedRowsWrittenMean,
        d1LatencyP50Ms: d1Op.latencyMs.p50Ms,
        d1LatencyP95Ms: d1Op.latencyMs.p95Ms,
        doSetAlarmCalls: doOp.setAlarmCallsPerOp,
      };
    });

    return {
      scenarioId: 'ember-v2-m0-sqlite-d1-probe',
      evidenceKind: 'measured_local_workerd',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      wranglerVersion: probe.wranglerVersion,
      probeIterations: iterations,
      operations,
      comparisonSummary,
      alarmRealFireVerified,
      alarmRealFireDelayMs,
      storageGrowth: {
        points: growthPoints,
        doStartingBytes: firstPt.doSqliteBytes,
        doNetBytesPerTurn: Number(
          ((lastPt.doSqliteBytes - firstPt.doSqliteBytes) / spanTurns).toFixed(1),
        ),
        d1StartingBytes: firstPt.d1Bytes,
        d1NetBytesPerTurn: Number(((lastPt.d1Bytes - firstPt.d1Bytes) / spanTurns).toFixed(1)),
      },
      caveats: [
        'Measured in local Wrangler/workerd Miniflare SQLite runtime, NOT Cloudflare production billing invoices.',
        'SqlStorageCursor.rowsWritten / D1.meta.rows_written reflect physical SQLite B-tree row/index writes (1 logical INSERT with 1 PK + 2 secondary indexes writes up to 3-4 rows).',
        'setAlarm() calls incur an additional DO request / storage operation in Cloudflare billing that is tracked separately in setAlarmCallsPerOp.',
        'SQLite databaseSize grows in 4 KiB page increments; small turn deltas show step changes until a page boundary fills.',
      ],
    };
  } finally {
    await probe.dispose();
  }
}
