import { DurableObject } from 'cloudflare:workers';
import type { B1MeResponse } from '@ember/contracts';
import {
  FAKE_MODEL_LABEL,
  FAKE_V2_RATE_VERSION,
  LoopbackFakeModelGateway,
  type FakeConversationJobStatus,
} from '../../../../packages/model-gateway/src/index.js';
import {
  createB1SessionRuntime,
  type B1SessionRuntime,
} from '../../../../apps/api/src/auth/b1-auth-runtime.js';
import type { DevProviderPolicy } from '../../../../apps/api/src/auth/dev-provider-policy.js';
import { createLocalV2EdgeWorker } from '../../../../apps/api/src/local-v2/edge-worker.js';
import type { EdgeAgentHeadRpc } from '../../../../apps/api/src/local-v2/rpc.js';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  D1RecoveryRegistry,
  RecoverySweeper,
  createAgentHeadGlobalBudgetOptions,
  executeRecoveredOrFreshDurableWork,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  parseClaimExecutionContext,
  resolveDeadLetterRetrySchedule,
  toAgentHeadDurableCommitOutcome,
  type AgentHeadEventRuntimeBindings,
  type AgentHeadRpc,
  type AgentRecoveryTargetPort,
  type BudgetSyncOutboxPayload,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DurableObjectStorageLike,
  type DurableProviderExecutorPort,
  type GlobalBudgetAuthority,
  type QueueLike,
  type QueueMessageLike,
  type RecoveryRegistryPort,
  type SqlStorageCursorLike,
  type SqlStorageLike,
  type SqlStorageRow,
  type V2DispatchEnvelope,
  type V2QueueName,
} from '../../../../packages/runtime-v2/src/index.js';
import { GlobalBudgetDO } from '../../../../packages/runtime-v2/src/global-budget/worker.js';

export { GlobalBudgetDO };

interface FaultControlSnapshot {
  readonly d1Mode:
    'healthy' | 'unavailable' | 'uncertain_timeout_committed' | 'uncertain_timeout_aborted';
  readonly d1DelayMs: number;
  readonly globalBudgetMode:
    | 'healthy'
    | 'unavailable'
    | 'timeout'
    | 'grant_expired'
    | 'halt_day_ceiling_exceeded'
    | 'halt_reservation_exceeded'
    | 'halt_usage_missing'
    | 'conflict_payload';
  readonly queueDuplicateCount: number;
  readonly queueForceDlq: boolean;
  readonly crashPoint: string;
  readonly alarmFailRemaining: number;
  readonly virtualNowMs: number | null;
  readonly effectiveNowMs: number;
}

export interface WorkerDurableObjectId {
  equals(other: WorkerDurableObjectId): boolean;
  readonly name?: string;
}

export interface WorkerDurableObjectStorage extends DurableObjectStorageLike {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface WorkerDurableObjectState {
  readonly id: WorkerDurableObjectId;
  readonly storage: WorkerDurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface WorkerDurableObjectNamespace<T> {
  idFromName(name: string): WorkerDurableObjectId;
  get(id: WorkerDurableObjectId): T;
  getByName(name: string): T;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerMessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: ReadonlyArray<QueueMessageLike<T>>;
}

export interface WorkerScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

export interface RuntimeWorkerEnv {
  readonly AGENT_HEAD: WorkerDurableObjectNamespace<AgentHeadDO>;
  readonly GLOBAL_BUDGET: WorkerDurableObjectNamespace<GlobalBudgetDO>;
  readonly AUTH_SESSION: WorkerDurableObjectNamespace<AuthSessionDO>;
  readonly D1_RECOVERY: D1DatabaseLike;
  readonly DURABLE_TURN_QUEUE: QueueLike<V2DispatchEnvelope>;
  readonly AGENT_TASK_QUEUE: QueueLike<V2DispatchEnvelope>;
  readonly EMBER_ENV?: string;
  readonly EMBER_MODEL_MODE?: string;
  readonly FAKE_MODEL_GATEWAY_URL: string;
  readonly V2_FAULT_CONTROL_URL: string;
  readonly GLOBAL_DAILY_CEILING_MICRO_USD?: string;
}

interface SqlTelemetryTotals {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  alarmSetCalls: number;
  alarmDeleteCalls: number;
}

function createInstrumentedStorage(
  rawStorage: WorkerDurableObjectStorage,
  totals: SqlTelemetryTotals,
): DurableObjectStorageLike {
  const sql: SqlStorageLike = {
    exec<T extends SqlStorageRow = SqlStorageRow>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const cursor = rawStorage.sql.exec<T>(query, ...bindings);
      totals.statements += 1;
      let recorded = false;
      const recordOnce = () => {
        if (!recorded) {
          recorded = true;
          totals.rowsRead += cursor.rowsRead;
          totals.rowsWritten += cursor.rowsWritten;
        }
      };
      const isRead = /^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(query);
      if (!isRead) {
        recordOnce();
      }
      return {
        toArray() {
          const rows = cursor.toArray();
          recordOnce();
          return rows;
        },
        one() {
          const row = cursor.one();
          recordOnce();
          return row;
        },
        get rowsRead() {
          return cursor.rowsRead;
        },
        get rowsWritten() {
          return cursor.rowsWritten;
        },
        [Symbol.iterator]() {
          const iter = cursor[Symbol.iterator]();
          return {
            next() {
              const res = iter.next();
              if (res.done) {
                recordOnce();
              }
              return res;
            },
          };
        },
      };
    },
  };

  return {
    sql,
    transactionSync<T>(closure: () => T): T {
      return rawStorage.transactionSync(closure);
    },
    getAlarm(): Promise<number | null> {
      return rawStorage.getAlarm();
    },
    setAlarm(scheduledTime: number | Date): Promise<void> {
      totals.alarmSetCalls += 1;
      return rawStorage.setAlarm(scheduledTime);
    },
    deleteAlarm(): Promise<void> {
      totals.alarmDeleteCalls += 1;
      return rawStorage.deleteAlarm();
    },
  };
}

async function fetchFaultState(faultUrl: string): Promise<FaultControlSnapshot> {
  const res = await fetch(`${faultUrl}/faults/state`);
  if (!res.ok) {
    throw new Error(`Fault control server returned ${res.status}`);
  }
  return (await res.json()) as FaultControlSnapshot;
}

async function consumeFaultCrash(faultUrl: string, hook: string): Promise<boolean> {
  const res = await fetch(`${faultUrl}/faults/consume-crash?hook=${encodeURIComponent(hook)}`, {
    method: 'POST',
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { shouldCrash?: boolean };
  return body.shouldCrash === true;
}

async function consumeFaultAlarmFailure(faultUrl: string): Promise<boolean> {
  const res = await fetch(`${faultUrl}/faults/consume-alarm`, { method: 'POST' });
  if (!res.ok) return false;
  const body = (await res.json()) as { shouldFail?: boolean };
  return body.shouldFail === true;
}

function createFaultInjectedD1(
  rawDb: D1DatabaseLike,
  getFault: () => FaultControlSnapshot,
  onSyncOp: (rows?: { readonly read?: number; readonly written?: number }) => void,
): D1DatabaseLike {
  const extractMeta = (res: unknown): { readonly read: number; readonly written: number } => {
    if (res !== null && typeof res === 'object' && 'meta' in res) {
      const meta = (res as { readonly meta?: { rows_read?: number; rows_written?: number } }).meta;
      return {
        read: typeof meta?.rows_read === 'number' ? meta.rows_read : 0,
        written: typeof meta?.rows_written === 'number' ? meta.rows_written : 0,
      };
    }
    return { read: 0, written: 0 };
  };

  const wrapStmt = (stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
    const runWithFault = async <T>(execFn: () => Promise<T>): Promise<T> => {
      onSyncOp();
      const fault = getFault();
      if (fault.d1DelayMs > 0) {
        await new Promise((r) => setTimeout(r, fault.d1DelayMs));
      }
      if (fault.d1Mode === 'unavailable') {
        throw new Error('D1_UNAVAILABLE_FAULT_INJECTED');
      }
      if (fault.d1Mode === 'uncertain_timeout_aborted') {
        throw new Error('D1_UNCERTAIN_TIMEOUT_ABORTED');
      }
      if (fault.d1Mode === 'uncertain_timeout_committed') {
        await execFn();
        throw new Error('D1_UNCERTAIN_TIMEOUT_COMMITTED');
      }
      const res = await execFn();
      const m = extractMeta(res);
      if (m.read > 0 || m.written > 0) {
        onSyncOp(m);
      }
      return res;
    };

    return {
      bind(...values: unknown[]) {
        return wrapStmt(stmt.bind(...values));
      },
      first<T = unknown>(colName?: string): Promise<T | null> {
        return runWithFault(() =>
          colName !== undefined ? stmt.first<T>(colName) : stmt.first<T>(),
        );
      },
      run<T = Record<string, unknown>>() {
        return runWithFault(() => stmt.run<T>());
      },
      all<T = Record<string, unknown>>() {
        return runWithFault(() => stmt.all<T>());
      },
    };
  };

  return {
    prepare(query: string) {
      return wrapStmt(rawDb.prepare(query));
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]) {
      onSyncOp();
      const fault = getFault();
      if (fault.d1Mode === 'unavailable') {
        throw new Error('D1_UNAVAILABLE_FAULT_INJECTED');
      }
      return rawDb.batch<T>(statements);
    },
  };
}

function createFaultInjectedGlobalBudget(
  rawBudget: GlobalBudgetAuthority,
  getFault: () => FaultControlSnapshot,
  counters: {
    reserveCalls: number;
    authorizeCalls: number;
    renewCalls: number;
    settleCalls: number;
  },
): GlobalBudgetAuthority {
  return {
    async reserveGlobal(req) {
      counters.reserveCalls += 1;
      const fault = getFault();
      if (fault.globalBudgetMode === 'unavailable' || fault.globalBudgetMode === 'timeout') {
        throw new Error('GLOBAL_BUDGET_UNAVAILABLE_FAULT_INJECTED');
      }
      if (fault.globalBudgetMode === 'halt_day_ceiling_exceeded') {
        return { kind: 'budget_halted', reason: 'day_ceiling_exceeded' };
      }
      if (fault.globalBudgetMode === 'halt_reservation_exceeded') {
        return { kind: 'budget_halted', reason: 'reservation_exceeded' };
      }
      if (fault.globalBudgetMode === 'halt_usage_missing') {
        return { kind: 'budget_halted', reason: 'usage_missing' };
      }
      return rawBudget.reserveGlobal(req);
    },
    async authorizeGlobalSend(req) {
      counters.authorizeCalls += 1;
      const fault = getFault();
      if (fault.globalBudgetMode === 'unavailable' || fault.globalBudgetMode === 'timeout') {
        throw new Error('GLOBAL_BUDGET_UNAVAILABLE_FAULT_INJECTED');
      }
      if (fault.globalBudgetMode === 'grant_expired') {
        return { authorized: false };
      }
      return rawBudget.authorizeGlobalSend(req);
    },
    async renewGlobalGrant(req) {
      counters.renewCalls += 1;
      const fault = getFault();
      if (fault.globalBudgetMode === 'unavailable' || fault.globalBudgetMode === 'timeout') {
        throw new Error('GLOBAL_BUDGET_UNAVAILABLE_FAULT_INJECTED');
      }
      return rawBudget.renewGlobalGrant(req);
    },
    async settleGlobal(req) {
      counters.settleCalls += 1;
      const fault = getFault();
      if (fault.globalBudgetMode === 'unavailable' || fault.globalBudgetMode === 'timeout') {
        throw new Error('GLOBAL_BUDGET_UNAVAILABLE_FAULT_INJECTED');
      }
      if (fault.globalBudgetMode === 'conflict_payload') {
        return rawBudget.settleGlobal({
          ...req,
          chargeMicroUsd: req.chargeMicroUsd + 777,
        });
      }
      return rawBudget.settleGlobal(req);
    },
  };
}

function createFaultInjectedRegistry(
  rawRegistry: RecoveryRegistryPort,
  faultUrl: string,
  getFault: () => FaultControlSnapshot,
): RecoveryRegistryPort {
  return {
    async upsertCoverage(cmd) {
      if (await consumeFaultCrash(faultUrl, 'after_do_pending_before_d1')) {
        throw new Error('CRASH_AFTER_DO_PENDING_BEFORE_D1');
      }
      const res = await rawRegistry.upsertCoverage(cmd);
      if (await consumeFaultCrash(faultUrl, 'after_d1_before_confirm')) {
        throw new Error('CRASH_AFTER_D1_BEFORE_CONFIRM');
      }
      return res;
    },
    async postponeCoverage(cmd) {
      if (await consumeFaultCrash(faultUrl, 'after_do_pending_before_d1')) {
        throw new Error('CRASH_AFTER_DO_PENDING_BEFORE_D1');
      }
      const res = await rawRegistry.postponeCoverage(cmd);
      if (await consumeFaultCrash(faultUrl, 'after_d1_before_confirm')) {
        throw new Error('CRASH_AFTER_D1_BEFORE_CONFIRM');
      }
      return res;
    },
    async retireCoverage(cmd) {
      if (await consumeFaultCrash(faultUrl, 'after_do_pending_before_d1')) {
        throw new Error('CRASH_AFTER_DO_PENDING_BEFORE_D1');
      }
      return rawRegistry.retireCoverage(cmd);
    },
    getCoverage(cmd) {
      // Allow getCoverage on healthy or uncertain_timeout_committed recovery reads
      void getFault();
      return rawRegistry.getCoverage(cmd);
    },
  };
}

function createFaultInjectedQueue(
  rawQueue: QueueLike<V2DispatchEnvelope>,
  faultUrl: string,
  getFault: () => FaultControlSnapshot,
  counter: { sends: number },
): QueueLike<V2DispatchEnvelope> {
  return {
    async send(message, options) {
      if (await consumeFaultCrash(faultUrl, 'after_do_commit_before_queue_send')) {
        throw new Error('CRASH_AFTER_DO_COMMIT_BEFORE_QUEUE_SEND');
      }
      const fault = getFault();
      const dupCount = Math.max(1, fault.queueDuplicateCount || 1);
      for (let i = 0; i < dupCount; i += 1) {
        counter.sends += 1;
        await rawQueue.send(message, options);
      }
      if (await consumeFaultCrash(faultUrl, 'after_queue_send_before_outbox_update')) {
        throw new Error('CRASH_AFTER_QUEUE_SEND_BEFORE_OUTBOX_UPDATE');
      }
    },
  };
}

// ============================================================================
// AuthSessionDO — B1 session/provisioning persistence inside workerd SQLite
// ============================================================================

export class AuthSessionDO extends DurableObject<RuntimeWorkerEnv> {
  constructor(ctx: WorkerDurableObjectState, env: RuntimeWorkerEnv) {
    super(ctx as never, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS b1_identities (
          provider TEXT NOT NULL,
          provider_subject TEXT NOT NULL,
          consumer_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          policy_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          PRIMARY KEY (provider, provider_subject)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_b1_identities_tenant ON b1_identities(tenant_id);
        CREATE TABLE IF NOT EXISTS b1_sessions (
          session_id TEXT PRIMARY KEY,
          family_id TEXT NOT NULL,
          consumer_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          policy_version INTEGER NOT NULL,
          token_digest_hex TEXT NOT NULL UNIQUE,
          replaced_by_hex TEXT,
          revoked_at_ms INTEGER,
          expires_at TEXT NOT NULL,
          idle_expires_at TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_b1_sessions_family ON b1_sessions(family_id);
        CREATE INDEX IF NOT EXISTS idx_b1_sessions_consumer ON b1_sessions(consumer_id);
      `);
      return Promise.resolve();
    });
  }

  async provisionIdentityAndCreateSession(cmd: {
    readonly provider: 'apple' | 'dev';
    readonly providerSubject: string;
    readonly tokenDigestHex: string;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }) {
    let identity = this.ctx.storage.sql
      .exec<{
        consumer_id: string;
        tenant_id: string;
        principal_id: string;
        agent_id: string;
        conversation_id: string;
        policy_version: number;
      }>(
        `SELECT consumer_id, tenant_id, principal_id, agent_id, conversation_id, policy_version
           FROM b1_identities WHERE provider = ? AND provider_subject = ?`,
        cmd.provider,
        cmd.providerSubject,
      )
      .toArray()[0];

    let isNew = false;
    if (identity === undefined) {
      isNew = true;
      identity = {
        consumer_id: crypto.randomUUID(),
        tenant_id: crypto.randomUUID(),
        principal_id: crypto.randomUUID(),
        agent_id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        policy_version: 1,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO b1_identities (
           provider, provider_subject, consumer_id, tenant_id, principal_id,
           agent_id, conversation_id, policy_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        cmd.provider,
        cmd.providerSubject,
        identity.consumer_id,
        identity.tenant_id,
        identity.principal_id,
        identity.agent_id,
        identity.conversation_id,
        identity.policy_version,
        new Date().toISOString(),
      );
    }

    if (isNew) {
      const head = this.env.AGENT_HEAD.get(
        this.env.AGENT_HEAD.idFromName(`${identity.tenant_id}:${identity.agent_id}`),
      );
      await head.bootstrapHead({
        tenantId: identity.tenant_id,
        agentId: identity.agent_id,
        conversationId: identity.conversation_id,
        policyVersion: identity.policy_version,
      });
    }

    const sessionId = crypto.randomUUID();
    const nowMs = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO b1_sessions (
         session_id, family_id, consumer_id, tenant_id, principal_id, policy_version,
         token_digest_hex, replaced_by_hex, revoked_at_ms, expires_at, idle_expires_at, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      sessionId,
      sessionId,
      identity.consumer_id,
      identity.tenant_id,
      identity.principal_id,
      identity.policy_version,
      cmd.tokenDigestHex,
      cmd.expiresAt,
      cmd.idleExpiresAt,
      nowMs,
    );

    return {
      identity: {
        consumerId: identity.consumer_id,
        tenantId: identity.tenant_id,
        principalId: identity.principal_id,
        agentId: identity.agent_id,
        conversationId: identity.conversation_id,
      },
      session: {
        sessionId,
        consumerId: identity.consumer_id,
        tenantId: identity.tenant_id,
        expiresAt: cmd.expiresAt,
        idleExpiresAt: cmd.idleExpiresAt,
        revokedAt: null,
      },
    };
  }

  findActiveSession(tokenDigestHex: string) {
    return Promise.resolve(
      this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql
          .exec<{
            session_id: string;
            family_id: string;
            consumer_id: string;
            tenant_id: string;
            principal_id: string;
            policy_version: number;
            replaced_by_hex: string | null;
            revoked_at_ms: number | null;
            expires_at: string;
            idle_expires_at: string;
          }>(`SELECT * FROM b1_sessions WHERE token_digest_hex = ?`, tokenDigestHex)
          .toArray()[0];
        if (row === undefined) return null;
        if (row.replaced_by_hex !== null) {
          // Reuse of a rotated token revokes the entire session family
          this.ctx.storage.sql.exec(
            `UPDATE b1_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE family_id = ?`,
            Date.now(),
            row.family_id,
          );
          return null;
        }
        if (row.revoked_at_ms !== null) return null;
        const now = Date.now();
        if (Date.parse(row.expires_at) <= now || Date.parse(row.idle_expires_at) <= now) {
          return null;
        }
        return {
          session: {
            sessionId: row.session_id,
            consumerId: row.consumer_id,
            tenantId: row.tenant_id,
            expiresAt: row.expires_at,
            idleExpiresAt: row.idle_expires_at,
            revokedAt: null,
          },
          principalId: row.principal_id,
          policyVersion: row.policy_version,
        };
      }),
    );
  }

  rotateSession(cmd: {
    readonly currentTokenDigestHex: string;
    readonly newTokenDigestHex: string;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
  }) {
    return Promise.resolve(
      this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql
          .exec<{
            session_id: string;
            family_id: string;
            consumer_id: string;
            tenant_id: string;
            principal_id: string;
            policy_version: number;
            replaced_by_hex: string | null;
            revoked_at_ms: number | null;
            expires_at: string;
            idle_expires_at: string;
          }>(`SELECT * FROM b1_sessions WHERE token_digest_hex = ?`, cmd.currentTokenDigestHex)
          .toArray()[0];
        if (row === undefined) return { kind: 'inactive' as const };
        if (row.replaced_by_hex !== null) {
          this.ctx.storage.sql.exec(
            `UPDATE b1_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE family_id = ?`,
            Date.now(),
            row.family_id,
          );
          return { kind: 'reuse_detected' as const };
        }
        if (row.revoked_at_ms !== null) return { kind: 'inactive' as const };
        const now = Date.now();
        if (Date.parse(row.expires_at) <= now || Date.parse(row.idle_expires_at) <= now) {
          return { kind: 'inactive' as const };
        }

        const newSessionId = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `UPDATE b1_sessions SET replaced_by_hex = ? WHERE session_id = ?`,
          cmd.newTokenDigestHex,
          row.session_id,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO b1_sessions (
           session_id, family_id, consumer_id, tenant_id, principal_id, policy_version,
           token_digest_hex, replaced_by_hex, revoked_at_ms, expires_at, idle_expires_at, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
          newSessionId,
          row.family_id,
          row.consumer_id,
          row.tenant_id,
          row.principal_id,
          row.policy_version,
          cmd.newTokenDigestHex,
          cmd.expiresAt,
          cmd.idleExpiresAt,
          now,
        );
        return {
          kind: 'rotated' as const,
          session: {
            sessionId: newSessionId,
            consumerId: row.consumer_id,
            tenantId: row.tenant_id,
            expiresAt: cmd.expiresAt,
            idleExpiresAt: cmd.idleExpiresAt,
            revokedAt: null,
          },
        };
      }),
    );
  }

  revokeSession(cmd: { readonly sessionId: string; readonly tenantId: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE b1_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE session_id = ? AND tenant_id = ?`,
      Date.now(),
      cmd.sessionId,
      cmd.tenantId,
    );
    return Promise.resolve();
  }

  async getIdentityByTokenDigestHex(tokenDigestHex: string) {
    const sess = this.ctx.storage.sql
      .exec<{ tenant_id: string }>(
        `SELECT tenant_id FROM b1_sessions WHERE token_digest_hex = ? AND revoked_at_ms IS NULL`,
        tokenDigestHex,
      )
      .toArray()[0];
    if (sess === undefined) return null;
    return this.getIdentityForTenant(sess.tenant_id);
  }

  getIdentityForTenant(tenantId: string) {
    return Promise.resolve(
      this.ctx.storage.sql
        .exec<{
          consumer_id: string;
          tenant_id: string;
          principal_id: string;
          agent_id: string;
          conversation_id: string;
          created_at: string;
        }>(
          `SELECT consumer_id, tenant_id, principal_id, agent_id, conversation_id, created_at
             FROM b1_identities WHERE tenant_id = ?`,
          tenantId,
        )
        .toArray()[0] ?? null,
    );
  }
}

// ============================================================================
// AgentHeadDO — Real A + B + E integration inside workerd DO SQLite
// ============================================================================

export class AgentHeadDO extends DurableObject<RuntimeWorkerEnv> {
  #core: AgentHeadCore | null = null;
  #facade: AgentEventRuntimeFacade | null = null;
  #faultSnapshot: FaultControlSnapshot = {
    d1Mode: 'healthy',
    d1DelayMs: 0,
    globalBudgetMode: 'healthy',
    queueDuplicateCount: 1,
    queueForceDlq: false,
    crashPoint: 'none',
    alarmFailRemaining: 0,
    virtualNowMs: null,
    effectiveNowMs: Date.now(),
  };
  #telemetry: {
    sql: SqlTelemetryTotals;
    d1Ops: number;
    d1RowsRead: number;
    d1RowsWritten: number;
    globalBudget: {
      reserveCalls: number;
      authorizeCalls: number;
      renewCalls: number;
      settleCalls: number;
    };
    queueSends: number;
    alarmFiresObserved: number;
    alarmSuccessCount: number;
    alarmFailureCount: number;
  } = {
    sql: { statements: 0, rowsRead: 0, rowsWritten: 0, alarmSetCalls: 0, alarmDeleteCalls: 0 },
    d1Ops: 0,
    d1RowsRead: 0,
    d1RowsWritten: 0,
    globalBudget: { reserveCalls: 0, authorizeCalls: 0, renewCalls: 0, settleCalls: 0 },
    queueSends: 0,
    alarmFiresObserved: 0,
    alarmSuccessCount: 0,
    alarmFailureCount: 0,
  };
  #identity: { tenantId: string; agentId: string } | null = null;

  constructor(ctx: WorkerDurableObjectState, env: RuntimeWorkerEnv) {
    super(ctx as never, env);
    void ctx.blockConcurrencyWhile(() => {
      const hasMeta =
        this.ctx.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_head_meta'`,
          )
          .toArray().length > 0;
      if (hasMeta) {
        const meta = this.ctx.storage.sql
          .exec<{ tenant_id: string; agent_id: string }>(
            `SELECT tenant_id, agent_id FROM agent_head_meta WHERE id = 1`,
          )
          .toArray()[0];
        if (meta !== undefined) {
          this.#identity = { tenantId: meta.tenant_id, agentId: meta.agent_id };
          this.#ensureCore(meta.tenant_id, meta.agent_id);
        }
      } else if (ctx.id.name !== undefined && ctx.id.name.includes(':')) {
        const [tenantId, agentId] = ctx.id.name.split(':');
        if (tenantId && agentId) {
          this.#identity = { tenantId, agentId };
          this.#ensureCore(tenantId, agentId);
        }
      }
      return Promise.resolve();
    });
  }

  async #refreshFaults(): Promise<FaultControlSnapshot> {
    this.#faultSnapshot = await fetchFaultState(this.env.V2_FAULT_CONTROL_URL);
    return this.#faultSnapshot;
  }

  #nowMs = (): number => {
    return this.#faultSnapshot.virtualNowMs ?? Date.now();
  };

  #recordD1Op = (rows?: { readonly read?: number; readonly written?: number }): void => {
    if (rows === undefined) {
      this.#telemetry.d1Ops += 1;
      return;
    }
    this.#telemetry.d1RowsRead += rows.read ?? 0;
    this.#telemetry.d1RowsWritten += rows.written ?? 0;
  };

  #ensureCore(
    tenantId: string,
    agentId: string,
  ): {
    core: AgentHeadCore;
    facade: AgentEventRuntimeFacade;
  } {
    if (this.#core !== null && this.#facade !== null) {
      return { core: this.#core, facade: this.#facade };
    }

    const storage = createInstrumentedStorage(this.ctx.storage, this.#telemetry.sql);
    const d1 = createFaultInjectedD1(
      this.env.D1_RECOVERY,
      () => this.#faultSnapshot,
      this.#recordD1Op,
    );
    const rawRegistry = new D1RecoveryRegistry(d1);
    const recoveryRegistry = createFaultInjectedRegistry(
      rawRegistry,
      this.env.V2_FAULT_CONTROL_URL,
      () => this.#faultSnapshot,
    );
    const globalOptions = createAgentHeadGlobalBudgetOptions(this.env);
    const globalBudget = createFaultInjectedGlobalBudget(
      globalOptions.globalBudget,
      () => this.#faultSnapshot,
      this.#telemetry.globalBudget,
    );

    let facade!: AgentEventRuntimeFacade;
    const core = new AgentHeadCore({
      storage,
      tenantId,
      agentId,
      recoveryRegistry,
      globalBudget,
      globalDailyCeilingMicroUsd: globalOptions.globalDailyCeilingMicroUsd,
      nowMs: this.#nowMs,
      eventRuntimeFactory: (business): AgentHeadEventRuntimeBindings => {
        facade = new AgentEventRuntimeFacade({
          storage,
          tenantId,
          agentId,
          business,
        });
        return {
          recoveryAdmission: facade.coverage,
          eventCoordinator: facade.outbox,
          recoveryHooks: facade.asTurnRecoveryHooks({
            globalBudget: {
              settleGlobal: (payload: BudgetSyncOutboxPayload) =>
                core.createGlobalBudgetSettlePort().settleGlobal(payload),
            },
          }),
        };
      },
    });

    this.#core = core;
    this.#facade = facade;
    this.#identity = { tenantId, agentId };
    return { core, facade };
  }

  #requireCore(): { core: AgentHeadCore; facade: AgentEventRuntimeFacade } {
    if (this.#core !== null && this.#facade !== null) {
      return { core: this.#core, facade: this.#facade };
    }
    if (this.#identity !== null) {
      return this.#ensureCore(this.#identity.tenantId, this.#identity.agentId);
    }
    throw new Error('AgentHeadDO is not bootstrapped');
  }

  async bootstrapHead(input: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly conversationId: string;
    readonly policyVersion?: number;
  }) {
    await this.#refreshFaults();
    const { core } = this.#ensureCore(input.tenantId, input.agentId);
    return core.bootstrapHead({
      conversationId: input.conversationId,
      policyVersion: input.policyVersion ?? 1,
    });
  }

  async prepareTurn(req: Parameters<AgentHeadRpc['prepareTurn']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.prepareTurn(req);
  }

  async markAttemptSent(req: Parameters<AgentHeadRpc['markAttemptSent']>[0]) {
    await this.#refreshFaults();
    if (await consumeFaultCrash(this.env.V2_FAULT_CONTROL_URL, 'after_prepare_before_mark_sent')) {
      throw new Error('CRASH_AFTER_PREPARE_BEFORE_MARK_SENT');
    }
    const { core } = this.#requireCore();
    const res = await core.markAttemptSent(req);
    if (
      res.authorized &&
      (await consumeFaultCrash(
        this.env.V2_FAULT_CONTROL_URL,
        'after_mark_sent_before_provider_fetch',
      ))
    ) {
      throw new Error('CRASH_AFTER_MARK_SENT_BEFORE_PROVIDER_FETCH');
    }
    return res;
  }

  async renewTurnLease(req: Parameters<AgentHeadRpc['renewTurnLease']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.renewTurnLease(req);
  }

  async handoffTurnToDurable(req: Parameters<AgentHeadRpc['handoffTurnToDurable']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.handoffTurnToDurable(req);
  }

  async commitTurn(req: Parameters<AgentHeadRpc['commitTurn']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.commitTurn(req);
  }

  async recordTurnUsage(req: {
    readonly scope: { readonly tenantId: string; readonly agentId: string };
    readonly turnId: string;
    readonly attemptNo: number;
    readonly operationId: string;
    readonly observedCostMicroUsd: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  }) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    await core.commitDurableResult({
      tenantId: req.scope.tenantId,
      agentId: req.scope.agentId,
      entityType: 'turn',
      entityId: req.turnId,
      leaseEpoch: 0,
      workerId: 'accounting-only',
      outcome: {
        attemptNo: req.attemptNo,
        operationId: req.operationId,
        settlement: {
          state: 'settled',
          outcomeCode: 'ok',
          observedCostMicroUsd: req.observedCostMicroUsd,
          ...(req.inputTokens !== undefined ? { inputTokens: req.inputTokens } : {}),
          ...(req.outputTokens !== undefined ? { outputTokens: req.outputTokens } : {}),
        },
        status: 'aborted_for_retry_or_reconcile',
      },
    });
  }

  async cancelTurn(req: Parameters<AgentHeadRpc['cancelTurn']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.cancelTurn(req);
  }

  async clearTranscript(req: Parameters<AgentHeadRpc['clearTranscript']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.clearTranscript(req);
  }

  async getMainConversation(req: Parameters<AgentHeadRpc['getMainConversation']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.getMainConversation(req);
  }

  async readMessages(req: Parameters<AgentHeadRpc['readMessages']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.readMessages(req);
  }

  async findSubmissionReceipt(req: Parameters<AgentHeadRpc['findSubmissionReceipt']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.findSubmissionReceipt(req);
  }

  async getTurn(req: Parameters<AgentHeadRpc['getTurn']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.getTurn(req);
  }

  async claimDurableWork(cmd: Parameters<AgentHeadCore['claimDurableWork']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.claimDurableWork(cmd);
  }

  async commitDurableResult(cmd: Parameters<AgentHeadCore['commitDurableResult']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.commitDurableResult(cmd);
  }

  async reconcileFromRegistry(cmd: Parameters<AgentHeadCore['reconcileFromRegistry']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.reconcileFromRegistry(cmd);
  }

  async confirmRegistryPlan(cmd: Parameters<AgentHeadCore['confirmRegistryPlan']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.confirmRegistryPlan(cmd);
  }

  async onDispatchDeadLetter(cmd: {
    readonly envelope: V2DispatchEnvelope;
    readonly errorCode: string;
    readonly nowMs: number;
    readonly graceMs?: number;
  }) {
    await this.#refreshFaults();
    const { core, facade } = this.#requireCore();
    const decision = this.ctx.storage.transactionSync(() => {
      const target = core.inspectOutboxTargetSync(cmd.envelope.entityKind, cmd.envelope.entityId);
      const schedule = resolveDeadLetterRetrySchedule({
        nowMs: cmd.nowMs,
        deadlineAtMs: target.deadlineAtMs || cmd.nowMs + 10_000,
        isTerminalOrCancelled: !target.exists || target.isTerminal || target.cancelRequested,
        graceMs: cmd.graceMs,
      });
      if (schedule.action === 'ignored_stale_or_terminal') {
        return { schedule, applied: false, nextAlarm: null as number | null };
      }
      const applied = facade.outbox.applyOutboxDeadLetterSync({
        outboxId: cmd.envelope.eventId,
        fenceEpoch: cmd.envelope.fenceEpoch,
        errorCode: cmd.errorCode,
        nextAttemptAtMs: schedule.alarmAtMs,
        nowMs: cmd.nowMs,
      });
      const nextAlarm = applied ? facade.outbox.recomputeAlarmSync(cmd.nowMs) : null;
      return { schedule, applied, nextAlarm };
    });
    if (decision.applied && decision.nextAlarm !== null) {
      await facade.alarm.syncPlatformAlarm(decision.nextAlarm, cmd.nowMs);
    }
    return {
      action: decision.schedule.action,
      alarmAtMs: decision.nextAlarm,
    };
  }

  async reserveTaskModelAttempt(cmd: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.reserveTaskModelAttempt(cmd);
  }

  async settleTaskModelAttempt(cmd: Parameters<AgentHeadCore['settleTaskModelAttempt']>[0]) {
    await this.#refreshFaults();
    const { core } = this.#requireCore();
    return core.settleTaskModelAttempt(cmd);
  }

  async createTestTask(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly kind: 'notes.action_items' | 'python.agent';
    readonly inputJson: string;
    readonly digest: string;
    readonly idempotencyKey: string;
    readonly deadlineAtMs: number | null;
  }) {
    await this.#refreshFaults();
    const { facade } = this.#requireCore();
    const nowMs = this.#nowMs();
    const d1 = createFaultInjectedD1(
      this.env.D1_RECOVERY,
      () => this.#faultSnapshot,
      this.#recordD1Op,
    );
    const registry = new D1RecoveryRegistry(d1);
    const bound = (cmd.deadlineAtMs ?? nowMs + 60_000) + 45_000;
    const plan = this.ctx.storage.transactionSync(() =>
      facade.coverage.inspectCoverageSync(bound, nowMs),
    );
    if (plan.kind === 'register') {
      const reg = await registry.upsertCoverage({
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        generation: plan.generation,
        recoveryAtMs: plan.targetAtMs,
        nowMs,
      });
      this.ctx.storage.transactionSync(() => {
        facade.coverage.confirmCoverageSync({
          generation: reg.currentGeneration,
          actualRecoveryAtMs: reg.actualRecoveryAtMs,
          applied: reg.accepted,
          earliestRequiredRecoveryMs: bound,
          nowMs,
        });
      });
    }
    const alarmAtMs = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO tasks (
           id, kind, title, input_json, digest, idempotency_key, status,
           execution_path, execution_target, attempt_count, max_attempts,
           lease_epoch, next_run_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 'test task', ?, ?, ?, 'queued', ?, 'cloud', 0, 4, 1, ?, ?, ?, ?)`,
        cmd.taskId,
        cmd.kind,
        cmd.inputJson,
        cmd.digest,
        cmd.idempotencyKey,
        cmd.kind === 'python.agent' ? 'heavy' : 'standard',
        nowMs,
        cmd.deadlineAtMs,
        nowMs,
        nowMs,
      );
      const outboxId = `task:${cmd.taskId}:epoch:1`;
      const env: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        entityKind: 'task',
        entityId: cmd.taskId,
        queueName: 'agent_task',
        fenceEpoch: 1,
      };
      facade.outbox.enqueueDurableOutboxSync({
        outboxId,
        entityKind: 'task',
        entityId: cmd.taskId,
        queueName: 'agent_task',
        payloadJson: JSON.stringify(env),
        fenceEpoch: 1,
        nextAttemptAtMs: nowMs,
      });
      return facade.outbox.recomputeAlarmSync(nowMs);
    });
    await facade.alarm.syncPlatformAlarm(alarmAtMs, nowMs);
    return { taskId: cmd.taskId, alarmAtMs };
  }

  async upsertSchedule(cmd: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly scheduleId: string;
    readonly sourceKind: 'commitment' | 'reminder' | 'deferred_task' | 'cleanup';
    readonly sourceId: string;
    readonly scheduleKind: 'once' | 'interval' | 'cron_tz';
    readonly intervalSeconds: number | null;
    readonly cronExpr: string | null;
    readonly timezone?: string;
    readonly firstFireAtMs: number;
    readonly misfirePolicy?: 'coalesce_latest' | 'fire_once' | 'skip_missed';
  }) {
    await this.#refreshFaults();
    const { facade } = this.#requireCore();
    const nowMs = this.#nowMs();
    const d1 = createFaultInjectedD1(
      this.env.D1_RECOVERY,
      () => this.#faultSnapshot,
      this.#recordD1Op,
    );
    const registry = new D1RecoveryRegistry(d1);
    const bound = cmd.firstFireAtMs + 45_000;
    const plan = this.ctx.storage.transactionSync(() =>
      facade.coverage.inspectCoverageSync(bound, nowMs),
    );
    if (plan.kind === 'register') {
      const reg = await registry.upsertCoverage({
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        generation: plan.generation,
        recoveryAtMs: plan.targetAtMs,
        nowMs,
      });
      this.ctx.storage.transactionSync(() => {
        facade.coverage.confirmCoverageSync({
          generation: reg.currentGeneration,
          actualRecoveryAtMs: reg.actualRecoveryAtMs,
          applied: reg.accepted,
          earliestRequiredRecoveryMs: bound,
          nowMs,
        });
      });
    }
    const alarmAtMs = this.ctx.storage.transactionSync(() => {
      facade.schedules.upsertScheduleSync({
        scheduleId: cmd.scheduleId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        sourceKind: cmd.sourceKind,
        sourceId: cmd.sourceId,
        scheduleKind: cmd.scheduleKind,
        intervalSeconds: cmd.intervalSeconds,
        cronExpr: cmd.cronExpr,
        timezone: cmd.timezone ?? 'UTC',
        firstFireAtMs: cmd.firstFireAtMs,
        misfirePolicy: cmd.misfirePolicy ?? 'coalesce_latest',
        nowMs,
      });
      return facade.outbox.recomputeAlarmSync(nowMs);
    });
    await facade.alarm.syncPlatformAlarm(alarmAtMs, nowMs);
    return { scheduleId: cmd.scheduleId, alarmAtMs };
  }

  async runRecoveryAlarmCycle(nowMs?: number): Promise<{ ok: boolean; error?: string }> {
    await this.#refreshFaults();
    const effectiveNow = nowMs ?? this.#nowMs();
    try {
      await this.#executeAlarmCycle(effectiveNow);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override async alarm(): Promise<void> {
    await this.#refreshFaults();
    await this.#executeAlarmCycle(this.#nowMs());
  }

  async #executeAlarmCycle(nowMs: number): Promise<void> {
    this.#telemetry.alarmFiresObserved += 1;
    const { core, facade } = this.#requireCore();
    if (await consumeFaultCrash(this.env.V2_FAULT_CONTROL_URL, 'alarm_exhaust_6_retries')) {
      this.#telemetry.alarmFailureCount += 1;
      facade.alarm.recordAlarmFailureSync(nowMs);
      throw new Error('SIMULATED_DO_ALARM_FAILURE');
    }
    if (await consumeFaultAlarmFailure(this.env.V2_FAULT_CONTROL_URL)) {
      this.#telemetry.alarmFailureCount += 1;
      facade.alarm.recordAlarmFailureSync(nowMs);
      throw new Error('SIMULATED_DO_ALARM_FAILURE');
    }

    const d1 = createFaultInjectedD1(
      this.env.D1_RECOVERY,
      () => this.#faultSnapshot,
      this.#recordD1Op,
    );
    const registry = createFaultInjectedRegistry(
      new D1RecoveryRegistry(d1),
      this.env.V2_FAULT_CONTROL_URL,
      () => this.#faultSnapshot,
    );
    const qCounter = { sends: 0 };
    const durableTurnQ = createFaultInjectedQueue(
      this.env.DURABLE_TURN_QUEUE,
      this.env.V2_FAULT_CONTROL_URL,
      () => this.#faultSnapshot,
      qCounter,
    );
    const agentTaskQ = createFaultInjectedQueue(
      this.env.AGENT_TASK_QUEUE,
      this.env.V2_FAULT_CONTROL_URL,
      () => this.#faultSnapshot,
      qCounter,
    );
    const globalOptions = createAgentHeadGlobalBudgetOptions(this.env);
    const faultBudget = createFaultInjectedGlobalBudget(
      globalOptions.globalBudget,
      () => this.#faultSnapshot,
      this.#telemetry.globalBudget,
    );
    const settlePort = {
      settleGlobal: async (payload: BudgetSyncOutboxPayload) => {
        const res = await faultBudget.settleGlobal({
          tenantId: payload.tenantId,
          operationId: payload.operationId,
          settlementRevision: payload.settlementRevision,
          globalGrantId: payload.globalGrantId,
          state: payload.state,
          observedCostMicroUsd: payload.observedCostMicroUsd,
          chargeMicroUsd: payload.chargeMicroUsd,
          reservedMicroUsd: payload.reservedMicroUsd,
          ...(payload.openIncidentReason !== null
            ? { openIncidentReason: payload.openIncidentReason }
            : {}),
        });
        const accepted = (res.applied || res.alreadySettled) && !res.conflict;
        if (accepted) {
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `UPDATE model_attempts
                  SET global_synced_at_ms = ?
                WHERE operation_id = ? AND settlement_revision <= ? AND global_synced_at_ms IS NULL`,
              nowMs,
              payload.operationId,
              payload.settlementRevision,
            );
          });
        }
        return { accepted, conflict: res.conflict, alreadySettled: res.alreadySettled };
      },
    };

    try {
      await facade.handleAlarm({
        nowMs,
        queues: { durable_turn: durableTurnQ, agent_task: agentTaskQ },
        globalBudget: settlePort,
        registry,
      });
      this.#telemetry.queueSends += qCounter.sends;
      this.#telemetry.alarmSuccessCount += 1;
    } catch (err) {
      this.#telemetry.queueSends += qCounter.sends;
      this.#telemetry.alarmFailureCount += 1;
      throw err;
    } finally {
      void core;
    }
  }

  async inspectState() {
    const sql = this.ctx.storage.sql;
    const safeRows = <T extends SqlStorageRow>(query: string): T[] => {
      try {
        return sql.exec<T>(query).toArray();
      } catch {
        return [];
      }
    };
    return {
      telemetry: this.#telemetry,
      alarmArmedAtMs: await this.ctx.storage.getAlarm(),
      headMeta: safeRows('SELECT * FROM agent_head_meta'),
      conversations: safeRows('SELECT * FROM conversations'),
      messages: safeRows('SELECT * FROM conversation_messages ORDER BY sequence ASC'),
      turns: safeRows('SELECT * FROM assistant_turns ORDER BY created_at_ms ASC'),
      attempts: safeRows('SELECT * FROM model_attempts ORDER BY started_at_ms ASC'),
      tasks: safeRows('SELECT * FROM tasks ORDER BY created_at_ms ASC'),
      runs: safeRows('SELECT * FROM runs ORDER BY started_at_ms ASC'),
      taskResults: safeRows('SELECT * FROM task_results'),
      outbox: safeRows('SELECT * FROM v2_dispatch_outbox ORDER BY created_at_ms ASC'),
      coverage: safeRows('SELECT * FROM v2_recovery_coverage'),
      schedules: safeRows('SELECT * FROM v2_schedules ORDER BY created_at_ms ASC'),
      localBuckets: safeRows('SELECT * FROM agent_spend_days'),
      localIncidents: safeRows('SELECT * FROM agent_budget_incidents'),
    };
  }

  resetTelemetry() {
    Object.assign(this.#telemetry.sql, {
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
      alarmSetCalls: 0,
      alarmDeleteCalls: 0,
    });
    this.#telemetry.d1Ops = 0;
    this.#telemetry.d1RowsRead = 0;
    this.#telemetry.d1RowsWritten = 0;
    Object.assign(this.#telemetry.globalBudget, {
      reserveCalls: 0,
      authorizeCalls: 0,
      renewCalls: 0,
      settleCalls: 0,
    });
    this.#telemetry.queueSends = 0;
    this.#telemetry.alarmFiresObserved = 0;
    this.#telemetry.alarmSuccessCount = 0;
    this.#telemetry.alarmFailureCount = 0;
    return Promise.resolve({ ok: true });
  }
}

// ============================================================================
// Worker Edge + Queue + Scheduled Entrypoint
// ============================================================================

const ALLOW_DEV_POLICY: DevProviderPolicy = Object.freeze({
  evaluate: () => ({ enabled: true, deniedBy: [] }),
});

function createSessionsAdapter(env: RuntimeWorkerEnv): B1SessionRuntime {
  const authDo = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName('global-auth'));
  const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  return createB1SessionRuntime({
    ports: {
      provisioning: {
        provisionIdentityAndCreateSession: (cmd) =>
          authDo.provisionIdentityAndCreateSession({
            provider: cmd.provider,
            providerSubject: cmd.providerSubject,
            tokenDigestHex: toHex(cmd.tokenDigest),
            expiresAt: cmd.expiresAt,
            idleExpiresAt: cmd.idleExpiresAt,
          }),
      },
      sessions: {
        findActiveSession: (digest) => authDo.findActiveSession(toHex(digest)),
        rotateSession: (cmd) =>
          authDo.rotateSession({
            currentTokenDigestHex: toHex(cmd.currentTokenDigest),
            newTokenDigestHex: toHex(cmd.newTokenDigest),
            expiresAt: cmd.expiresAt,
            idleExpiresAt: cmd.idleExpiresAt,
          }),
        revokeSession: (cmd) => authDo.revokeSession(cmd),
      },
      me: {
        async getMeForTenant(tenantId): Promise<B1MeResponse | null> {
          const identity = await authDo.getIdentityForTenant(tenantId);
          if (identity === null) return null;
          const head = env.AGENT_HEAD.get(
            env.AGENT_HEAD.idFromName(`${identity.tenant_id}:${identity.agent_id}`),
          );
          const conv = await head.getMainConversation({
            tenantId: identity.tenant_id,
            agentId: identity.agent_id,
          });
          return {
            consumer_id: identity.consumer_id,
            agent: {
              agent_id: identity.agent_id,
              display_name: 'Ember',
            },
            conversation: {
              conversation_id: identity.conversation_id,
              transcript_epoch: conv?.transcriptEpoch ?? 0,
              created_at: identity.created_at,
              updated_at: identity.created_at,
            },
          };
        },
      },
    },
    apple: { audience: 'com.ember.mobile' },
    devProvider: ALLOW_DEV_POLICY,
  });
}

function makeEdgeRpcAdapter(stub: AgentHeadDO): EdgeAgentHeadRpc {
  return {
    prepareTurn: (req) => stub.prepareTurn(req),
    markAttemptSent: (req) => stub.markAttemptSent(req),
    renewTurnLease: (req) => stub.renewTurnLease(req),
    handoffTurnToDurable: (req) => stub.handoffTurnToDurable(req),
    commitTurn: (req) => stub.commitTurn(req),
    readMessages: (req) => stub.readMessages(req),
    findSubmissionReceipt: (req) => stub.findSubmissionReceipt(req),
    getTurn: (req) => stub.getTurn(req),
    cancelTurn: (req) => stub.cancelTurn(req),
    clearTranscript: (req) => stub.clearTranscript(req),
  };
}

function createProviderExecutor(env: RuntimeWorkerEnv): DurableProviderExecutorPort {
  const gateway = new LoopbackFakeModelGateway(env.FAKE_MODEL_GATEWAY_URL, (input, init) =>
    fetch(input, init),
  );
  return {
    async pollProviderJob(cmd) {
      const status: FakeConversationJobStatus = await gateway.queryConversationJob(
        cmd.operationId,
        cmd.providerJobHandle,
        cmd.signal ?? AbortSignal.timeout(10_000),
      );
      if (status.state === 'pending') {
        throw new Error('PROVIDER_JOB_PENDING_RETRY');
      }
      if (status.state === 'unavailable') {
        const usageStatus = await gateway.queryConversationUsage(
          cmd.operationId,
          cmd.signal ?? AbortSignal.timeout(10_000),
        );
        return {
          status: 'unknown_billed',
          operationId: cmd.operationId,
          providerJobHandle: cmd.providerJobHandle,
          outputJson: null,
          errorCode: 'PROVIDER_HANDLE_UNAVAILABLE',
          usage: usageStatus.state === 'completed' ? usageStatus.usage : null,
        };
      }
      return {
        status: 'succeeded',
        operationId: cmd.operationId,
        providerJobHandle: cmd.providerJobHandle,
        outputJson: JSON.stringify({ text: status.result.output.text }),
        errorCode: null,
        usage: status.result.usage,
      };
    },

    async startProviderJob(cmd) {
      let prompt = 'durable turn';
      if (cmd.inputJson) {
        try {
          const parsed = JSON.parse(cmd.inputJson) as
            Array<{ text?: string }> | { prompt?: string };
          if (Array.isArray(parsed)) {
            prompt = parsed.at(-1)?.text ?? prompt;
          } else if (typeof parsed?.prompt === 'string') {
            prompt = parsed.prompt;
          }
        } catch {
          // fallback
        }
      }

      const res = await fetch(`${env.FAKE_MODEL_GATEWAY_URL}/v2/fake-model/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ember-operation-id': cmd.operationId,
          'x-ember-turn-id': cmd.entityId,
        },
        body: JSON.stringify({ prompt }),
        signal: cmd.signal ?? AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          status: res.status === 503 || res.status === 429 ? 'retryable_failed' : 'failed',
          operationId: cmd.operationId,
          providerJobHandle: null,
          outputJson: null,
          errorCode: res.status === 504 ? 'TIMEOUT' : `HTTP_${res.status}`,
          usage: null,
        };
      }
      const data = (await res.json()) as {
        providerJobHandle?: string | null;
        text?: string;
        usage?: { inputTokens: number; outputTokens: number; costMicroUsd: number } | null;
      };
      return {
        status: 'succeeded',
        operationId: cmd.operationId,
        providerJobHandle: data.providerJobHandle ?? null,
        outputJson: JSON.stringify({ text: data.text ?? 'Simulated durable reply.' }),
        errorCode: null,
        usage: data.usage ?? null,
      };
    },
  };
}

export default {
  async fetch(
    request: Request,
    env: RuntimeWorkerEnv,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/health') {
      return Response.json({ ok: true, runtime: 'v2-m1-full-runtime', env: env.EMBER_ENV });
    }

    if (url.pathname.startsWith('/_test/')) {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const payload = body as Record<string, unknown>;

      if (url.pathname === '/_test/auth/identity') {
        const authHeader = request.headers.get('authorization') ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!token) return Response.json({ error: 'MISSING_TOKEN' }, { status: 401 });
        const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
        const digestHex = Array.from(new Uint8Array(digestBuf), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
        const authDo = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName('global-auth'));
        const identity = await authDo.getIdentityByTokenDigestHex(digestHex);
        if (identity === null) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
        return Response.json({
          consumerId: identity.consumer_id,
          tenantId: identity.tenant_id,
          principalId: identity.principal_id,
          agentId: identity.agent_id,
          conversationId: identity.conversation_id,
        });
      }
      if (url.pathname === '/_test/agent/inspect') {
        const stub = env.AGENT_HEAD.get(
          env.AGENT_HEAD.idFromName(`${String(payload.tenantId)}:${String(payload.agentId)}`),
        );
        return Response.json(await stub.inspectState());
      }
      if (url.pathname === '/_test/agent/reset-telemetry') {
        const stub = env.AGENT_HEAD.get(
          env.AGENT_HEAD.idFromName(`${String(payload.tenantId)}:${String(payload.agentId)}`),
        );
        return Response.json(await stub.resetTelemetry());
      }
      if (url.pathname === '/_test/agent/alarm') {
        const stub = env.AGENT_HEAD.get(
          env.AGENT_HEAD.idFromName(`${String(payload.tenantId)}:${String(payload.agentId)}`),
        );
        return Response.json(
          await stub.runRecoveryAlarmCycle(
            typeof payload.nowMs === 'number' ? payload.nowMs : undefined,
          ),
        );
      }
      if (url.pathname === '/_test/agent/rpc') {
        const stub = env.AGENT_HEAD.get(
          env.AGENT_HEAD.idFromName(`${String(payload.tenantId)}:${String(payload.agentId)}`),
        );
        const method = String(payload.method);
        const arg = payload.arg;
        try {
          let result: unknown;
          switch (method) {
            case 'prepareTurn':
              result = await stub.prepareTurn(arg as Parameters<AgentHeadDO['prepareTurn']>[0]);
              break;
            case 'markAttemptSent':
              result = await stub.markAttemptSent(
                arg as Parameters<AgentHeadDO['markAttemptSent']>[0],
              );
              break;
            case 'renewTurnLease':
              result = await stub.renewTurnLease(
                arg as Parameters<AgentHeadDO['renewTurnLease']>[0],
              );
              break;
            case 'handoffTurnToDurable':
              result = await stub.handoffTurnToDurable(
                arg as Parameters<AgentHeadDO['handoffTurnToDurable']>[0],
              );
              break;
            case 'commitTurn':
              result = await stub.commitTurn(arg as Parameters<AgentHeadDO['commitTurn']>[0]);
              break;
            case 'recordTurnUsage':
              result = await stub.recordTurnUsage(
                arg as Parameters<AgentHeadDO['recordTurnUsage']>[0],
              );
              break;
            case 'cancelTurn':
              result = await stub.cancelTurn(arg as Parameters<AgentHeadDO['cancelTurn']>[0]);
              break;
            case 'clearTranscript':
              result = await stub.clearTranscript(
                arg as Parameters<AgentHeadDO['clearTranscript']>[0],
              );
              break;
            case 'reconcileFromRegistry':
              result = await stub.reconcileFromRegistry(
                arg as Parameters<AgentHeadDO['reconcileFromRegistry']>[0],
              );
              break;
            case 'claimDurableWork':
              result = await stub.claimDurableWork(
                arg as Parameters<AgentHeadDO['claimDurableWork']>[0],
              );
              break;
            case 'reserveTaskModelAttempt':
              result = await stub.reserveTaskModelAttempt(
                arg as Parameters<AgentHeadDO['reserveTaskModelAttempt']>[0],
              );
              break;
            case 'settleTaskModelAttempt':
              result = await stub.settleTaskModelAttempt(
                arg as Parameters<AgentHeadDO['settleTaskModelAttempt']>[0],
              );
              break;
            case 'createTestTask':
              result = await stub.createTestTask(
                arg as Parameters<AgentHeadDO['createTestTask']>[0],
              );
              break;
            case 'upsertSchedule':
              result = await stub.upsertSchedule(
                arg as Parameters<AgentHeadDO['upsertSchedule']>[0],
              );
              break;
            default:
              return Response.json(
                { ok: false, error: `Unknown RPC method ${method}` },
                { status: 400 },
              );
          }
          return Response.json({ ok: true, result });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              code:
                err !== null && typeof err === 'object' && 'code' in err
                  ? String(err.code)
                  : undefined,
            },
            { status: 500 },
          );
        }
      }
      if (url.pathname === '/_test/d1/inspect') {
        const rows = await env.D1_RECOVERY.prepare('SELECT * FROM v2_recovery_registry').all();
        return Response.json({ results: rows.results });
      }
      if (url.pathname === '/_test/d1/exec') {
        const sql = String(payload.sql);
        const bindings: unknown[] = Array.isArray(payload.bindings) ? payload.bindings : [];
        const res = await env.D1_RECOVERY.prepare(sql)
          .bind(...bindings)
          .all();
        return Response.json(res);
      }
      if (url.pathname === '/_test/global-budget/rpc') {
        const gb = createAgentHeadGlobalBudgetOptions(env).globalBudget;
        const method = String(payload.method);
        const arg = payload.arg;
        let res: unknown;
        switch (method) {
          case 'reserveGlobal':
            res = await gb.reserveGlobal(
              arg as Parameters<GlobalBudgetAuthority['reserveGlobal']>[0],
            );
            break;
          case 'authorizeGlobalSend':
            res = await gb.authorizeGlobalSend(
              arg as Parameters<GlobalBudgetAuthority['authorizeGlobalSend']>[0],
            );
            break;
          case 'renewGlobalGrant':
            res = await gb.renewGlobalGrant(
              arg as Parameters<GlobalBudgetAuthority['renewGlobalGrant']>[0],
            );
            break;
          case 'settleGlobal':
            res = await gb.settleGlobal(
              arg as Parameters<GlobalBudgetAuthority['settleGlobal']>[0],
            );
            break;
          default:
            return Response.json(
              { ok: false, error: `Unknown GlobalBudget method ${method}` },
              { status: 400 },
            );
        }
        return Response.json({ ok: true, result: res });
      }
      if (url.pathname === '/_test/queue/send') {
        const queueName = String(payload.queueName) as V2QueueName;
        const q = queueName === 'agent_task' ? env.AGENT_TASK_QUEUE : env.DURABLE_TURN_QUEUE;
        await q.send(payload.envelope as V2DispatchEnvelope);
        return Response.json({ ok: true });
      }
      if (url.pathname === '/_test/sweeper/run') {
        const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
        const d1 = createFaultInjectedD1(
          env.D1_RECOVERY,
          () => fault,
          () => {},
        );
        const registry = new D1RecoveryRegistry(d1);
        const sweeper = new RecoverySweeper({
          db: d1,
          registry,
          targets: {
            getRecoveryTarget(tenantId, agentId): AgentRecoveryTargetPort {
              const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(`${tenantId}:${agentId}`));
              return {
                reconcileFromRegistry: (req) => stub.reconcileFromRegistry(req),
                confirmRegistryPlan: (req) => stub.confirmRegistryPlan(req),
                runRecoveryAlarmCycle: async (ts) => {
                  const res = await stub.runRecoveryAlarmCycle(ts);
                  if (!res.ok) throw new Error(res.error ?? 'alarm cycle failed');
                },
              };
            },
          },
        });
        const nowMs = typeof payload.nowMs === 'number' ? payload.nowMs : fault.effectiveNowMs;
        const res = await sweeper.sweepDueAgents({
          sweeperId:
            typeof payload.sweeperId === 'string'
              ? payload.sweeperId
              : `sweeper-${crypto.randomUUID()}`,
          nowMs,
        });
        return Response.json(res);
      }
      return Response.json({ error: 'UNKNOWN_TEST_ROUTE' }, { status: 404 });
    }

    const sessions = createSessionsAdapter(env);
    const authDo = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName('global-auth'));
    const gateway = new LoopbackFakeModelGateway(env.FAKE_MODEL_GATEWAY_URL, (input, init) =>
      fetch(input, init),
    );

    const edge = createLocalV2EdgeWorker({
      sessions,
      async resolveAgentHead(auth) {
        const identity = await authDo.getIdentityForTenant(auth.tenantId);
        if (identity === null) return null;
        const stub = env.AGENT_HEAD.get(
          env.AGENT_HEAD.idFromName(`${identity.tenant_id}:${identity.agent_id}`),
        );
        return {
          agentId: identity.agent_id,
          conversationId: identity.conversation_id,
          rpc: makeEdgeRpcAdapter(stub),
        };
      },
      stream: {
        gateway,
        async reportObservedUsage(receipt) {
          const stub = env.AGENT_HEAD.get(
            env.AGENT_HEAD.idFromName(`${receipt.scope.tenantId}:${receipt.scope.agentId}`),
          );
          await stub.recordTurnUsage(receipt);
        },
      },
    });

    return edge.fetch(request, env, ctx);
  },

  async queue(batch: WorkerMessageBatch<unknown>, env: RuntimeWorkerEnv): Promise<void> {
    const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
    const nowMs = () => fault.virtualNowMs ?? Date.now();
    const workerId = `queue-worker-${crypto.randomUUID()}`;
    const router = {
      getAgentHeadRecoveryPort: (tenantId: string, agentId: string) =>
        env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(`${tenantId}:${agentId}`)),
      getDeadLetterPort: (tenantId: string, agentId: string) =>
        env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(`${tenantId}:${agentId}`)),
    };
    const messages = batch.messages;

    if (batch.queue === 'durable_turn_dlq' || batch.queue === 'agent_task_dlq') {
      const expectedQueueName: V2QueueName =
        batch.queue === 'durable_turn_dlq' ? 'durable_turn' : 'agent_task';
      await handleDurableDeadLetterBatch({
        expectedQueueName,
        messages,
        router,
        nowMs,
      });
      return;
    }

    const queueName: V2QueueName = batch.queue === 'agent_task' ? 'agent_task' : 'durable_turn';
    if (fault.queueForceDlq) {
      for (const msg of messages) {
        msg.retry({ delaySeconds: 0 });
      }
      return;
    }

    const provider = createProviderExecutor(env);
    await handleDurableQueueBatch({
      queueName,
      messages,
      router,
      workerId,
      retryDelaySeconds: 1,
      executor: {
        async executeDurableWork(cmd) {
          const context = parseClaimExecutionContext({
            targetKind: cmd.targetKind,
            targetId: cmd.targetId,
            leaseEpoch: cmd.leaseEpoch,
            contextJson: cmd.contextJson,
          });
          const head = env.AGENT_HEAD.get(
            env.AGENT_HEAD.idFromName(`${cmd.tenantId}:${cmd.agentId}`),
          );
          if (cmd.targetKind === 'task') {
            const principalId =
              (
                await env.AUTH_SESSION.get(
                  env.AUTH_SESSION.idFromName('global-auth'),
                ).getIdentityForTenant(cmd.tenantId)
              )?.principal_id ?? crypto.randomUUID();
            const parsedCtx = JSON.parse(cmd.contextJson) as { runId?: string };
            const reserved = await head.reserveTaskModelAttempt({
              tenantId: cmd.tenantId,
              principalId,
              agentId: cmd.agentId,
              taskId: cmd.targetId,
              runId: parsedCtx.runId ?? crypto.randomUUID(),
              leaseEpoch: cmd.leaseEpoch,
              providerId: 'fake',
              modelLabel: FAKE_MODEL_LABEL,
              rateVersion: FAKE_V2_RATE_VERSION,
              budgetMode: 'simulated_full_protocol',
              estimatedMicroUsd: 250,
            });
            if (reserved.kind !== 'reserved') {
              return { status: 'failed', reasonCode: reserved.reason };
            }
            const taskCtx = {
              ...context,
              attemptNo: reserved.attemptNo,
              operationId: reserved.operationId,
            };
            const outcome = await executeRecoveredOrFreshDurableWork({
              context: taskCtx,
              provider,
              nowMs,
              sendGate: {
                scope: { tenantId: cmd.tenantId, agentId: cmd.agentId },
                leaseEpoch: cmd.leaseEpoch,
                leaseOwner: cmd.workerId,
                leaseExpiresAtMs: cmd.leaseExpiresAtMs,
                markAttemptSent: (req) => head.markAttemptSent(req),
              },
            });
            return toAgentHeadDurableCommitOutcome({
              targetKind: 'task',
              context: taskCtx,
              outcome,
              modelLabel: FAKE_MODEL_LABEL,
              simulated: true,
            });
          }

          const outcome = await executeRecoveredOrFreshDurableWork({
            context,
            provider,
            nowMs,
            sendGate: {
              scope: { tenantId: cmd.tenantId, agentId: cmd.agentId },
              leaseEpoch: cmd.leaseEpoch,
              leaseOwner: cmd.workerId,
              leaseExpiresAtMs: cmd.leaseExpiresAtMs,
              markAttemptSent: (req) => head.markAttemptSent(req),
            },
          });
          if (outcome.status === 'retryable_failed') {
            throw new Error(`DURABLE_RETRYABLE_PROVIDER_ERROR:${outcome.errorCode ?? 'unknown'}`);
          }
          return toAgentHeadDurableCommitOutcome({
            targetKind: 'turn',
            context,
            outcome,
            modelLabel: FAKE_MODEL_LABEL,
            simulated: true,
          });
        },
      },
    });
  },

  async scheduled(controller: WorkerScheduledController, env: RuntimeWorkerEnv): Promise<void> {
    const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
    const d1 = createFaultInjectedD1(
      env.D1_RECOVERY,
      () => fault,
      () => {},
    );
    const registry = new D1RecoveryRegistry(d1);
    const sweeper = new RecoverySweeper({
      db: d1,
      registry,
      targets: {
        getRecoveryTarget(tenantId, agentId): AgentRecoveryTargetPort {
          const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(`${tenantId}:${agentId}`));
          return {
            reconcileFromRegistry: (req) => stub.reconcileFromRegistry(req),
            confirmRegistryPlan: (req) => stub.confirmRegistryPlan(req),
            runRecoveryAlarmCycle: async (ts) => {
              const res = await stub.runRecoveryAlarmCycle(ts);
              if (!res.ok) throw new Error(res.error ?? 'alarm cycle failed');
            },
          };
        },
      },
    });
    const nowMs = fault.virtualNowMs ?? controller.scheduledTime;
    await sweeper.sweepDueAgents({
      sweeperId: `cron-${crypto.randomUUID()}`,
      nowMs,
    });
  },
};
