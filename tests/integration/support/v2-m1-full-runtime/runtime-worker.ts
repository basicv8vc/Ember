// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Share minimal Cloudflare Workers ambient types without DOM collisions.
/// <reference path="../../../../packages/runtime-v2/src/global-budget/cloudflare-workers.d.ts" />

import { DomainError } from '@ember/domain';
import {
  AgentEventRuntimeFacade,
  AgentHeadCore,
  D1RecoveryRegistry,
  RecoverySweeper,
  createAgentHeadGlobalBudgetOptions,
  getHeadMetaSync,
  type AgentHeadRpc,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DurableObjectStorageLike,
  type GlobalBudgetAuthority,
  type QueueLike,
  type QueueMessageLike,
  type SqlStorageCursorLike,
  type SqlStorageLike,
  type SqlStorageRow,
} from '@ember/runtime-v2';
import {
  AgentHeadDO as OfficialAgentHeadDO,
  getHead,
  type LocalRuntimeEnv,
} from '../../../../apps/api/src/local-v2/runtime-head.js';
import officialWorker from '../../../../apps/api/src/local-v2/runtime-worker.js';

type DurableObjectState = ConstructorParameters<typeof OfficialAgentHeadDO>[0];

export { GlobalBudgetDO } from '../../../../apps/api/src/local-v2/runtime-worker.js';

export interface FaultRuntimeEnv extends LocalRuntimeEnv {
  readonly V2_FAULT_CONTROL_URL?: string;
  readonly GLOBAL_DAILY_CEILING_MICRO_USD?: string;
}

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

interface AgentTelemetry {
  readonly sql: {
    statements: number;
    rowsRead: number;
    rowsWritten: number;
    alarmSetCalls: number;
    alarmDeleteCalls: number;
  };
  d1Ops: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  readonly globalBudget: {
    reserveCalls: number;
    authorizeCalls: number;
    renewCalls: number;
    settleCalls: number;
  };
  queueSends: number;
  alarmFiresObserved: number;
  alarmSuccessCount: number;
  alarmFailureCount: number;
}

const DEFAULT_FAULT: FaultControlSnapshot = {
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

const NATIVE_DATE_NOW = Date.now.bind(Date);
let activeVirtualNowMs: number | null = null;

function applyVirtualClock(virtualNowMs: number | null): void {
  activeVirtualNowMs = virtualNowMs;
  Date.now =
    virtualNowMs !== null ? () => activeVirtualNowMs ?? NATIVE_DATE_NOW() : NATIVE_DATE_NOW;
}

async function fetchFaultState(faultUrl: string | undefined): Promise<FaultControlSnapshot> {
  if (!faultUrl) return { ...DEFAULT_FAULT, effectiveNowMs: NATIVE_DATE_NOW() };
  try {
    const res = await fetch(`${faultUrl}/faults/state`, { redirect: 'manual' });
    if (!res.ok) return { ...DEFAULT_FAULT, effectiveNowMs: NATIVE_DATE_NOW() };
    const snap = (await res.json()) as FaultControlSnapshot;
    applyVirtualClock(snap.virtualNowMs ?? null);
    return snap;
  } catch {
    return { ...DEFAULT_FAULT, effectiveNowMs: NATIVE_DATE_NOW() };
  }
}

async function consumeFaultCrash(faultUrl: string | undefined, hook: string): Promise<boolean> {
  if (!faultUrl) return false;
  const res = await fetch(`${faultUrl}/faults/consume-crash?hook=${encodeURIComponent(hook)}`, {
    method: 'POST',
    redirect: 'manual',
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { shouldCrash?: boolean };
  return data.shouldCrash === true;
}

async function consumeFaultAlarmFailure(faultUrl: string | undefined): Promise<boolean> {
  if (!faultUrl) return false;
  const res = await fetch(`${faultUrl}/faults/consume-alarm`, {
    method: 'POST',
    redirect: 'manual',
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { shouldFail?: boolean };
  return data.shouldFail === true;
}

function createEmptyTelemetry(): AgentTelemetry {
  return {
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
}

function wrapStorageWithTelemetry(
  rawState: DurableObjectState,
  telemetry: AgentTelemetry,
): DurableObjectState {
  const rawStorage = rawState.storage;
  const sqlProxy: SqlStorageLike = {
    exec<T extends SqlStorageRow = SqlStorageRow>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const cursor = rawStorage.sql.exec<T>(query, ...bindings);
      telemetry.sql.statements += 1;
      let recorded = false;
      const recordOnce = () => {
        if (!recorded) {
          recorded = true;
          telemetry.sql.rowsRead += cursor.rowsRead;
          telemetry.sql.rowsWritten += cursor.rowsWritten;
        }
      };
      if (!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(query)) {
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
          const rows = cursor.toArray();
          recordOnce();
          return rows[Symbol.iterator]();
        },
      };
    },
  };

  const storageProxy = new Proxy(rawStorage, {
    get(target, prop, receiver) {
      if (prop === 'sql') return sqlProxy;
      if (prop === 'setAlarm') {
        return async (scheduledTime: number | Date) => {
          telemetry.sql.alarmSetCalls += 1;
          return target.setAlarm(scheduledTime);
        };
      }
      if (prop === 'deleteAlarm') {
        return async () => {
          telemetry.sql.alarmDeleteCalls += 1;
          return target.deleteAlarm();
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return bindMember(target, val);
    },
  });

  return new Proxy(rawState, {
    get(target, prop, receiver) {
      if (prop === 'storage') return storageProxy;
      const val = Reflect.get(target, prop, receiver) as unknown;
      return bindMember(target, val);
    },
  });
}

function bindMember(target: object, val: unknown): unknown {
  return typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(target) : val;
}

function createFaultInjectedD1(
  rawDb: D1DatabaseLike,
  faultUrl: string | undefined,
  getFault: () => FaultControlSnapshot,
  onSyncOp: (meta?: { readonly read: number; readonly written: number }) => void,
): D1DatabaseLike {
  const extractMeta = (res: unknown): { readonly read: number; readonly written: number } => {
    if (res !== null && typeof res === 'object' && 'meta' in res) {
      const m = (res as { meta?: { rows_read?: unknown; rows_written?: unknown } }).meta;
      return {
        read: typeof m?.rows_read === 'number' ? m.rows_read : 0,
        written: typeof m?.rows_written === 'number' ? m.rows_written : 0,
      };
    }
    return { read: 0, written: 0 };
  };

  const wrapStmt = (query: string, stmt: D1PreparedStatementLike): D1PreparedStatementLike => {
    const isRegistryMutation =
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+v2_recovery_registry\b/i.test(query);

    const runWithFault = async <T>(execFn: () => Promise<T>): Promise<T> => {
      if (isRegistryMutation && (await consumeFaultCrash(faultUrl, 'after_do_pending_before_d1'))) {
        throw new Error('CRASH_AFTER_DO_PENDING_BEFORE_D1');
      }
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
      const meta = extractMeta(res);
      if (meta.read > 0 || meta.written > 0) {
        onSyncOp(meta);
      }
      if (isRegistryMutation && (await consumeFaultCrash(faultUrl, 'after_d1_before_confirm'))) {
        throw new Error('CRASH_AFTER_D1_BEFORE_CONFIRM');
      }
      return res;
    };

    return {
      bind(...values: unknown[]) {
        return wrapStmt(query, stmt.bind(...values));
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
      return wrapStmt(query, rawDb.prepare(query));
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
  counters: AgentTelemetry['globalBudget'],
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
          state: req.state === 'released' ? 'settled' : 'released',
          chargeMicroUsd: req.state === 'released' ? 999 : 0,
          ...(req.state === 'released' ? { observedCostMicroUsd: 999 } : {}),
        });
      }
      return rawBudget.settleGlobal(req);
    },
  };
}

function createFaultInjectedQueue<T>(
  rawQueue: QueueLike<T>,
  faultUrl: string | undefined,
  getFault: () => FaultControlSnapshot,
  onSend: () => void,
): QueueLike<T> {
  return {
    async send(message, options) {
      if (await consumeFaultCrash(faultUrl, 'after_do_commit_before_queue_send')) {
        throw new Error('CRASH_AFTER_DO_COMMIT_BEFORE_QUEUE_SEND');
      }
      const fault = getFault();
      const dupCount = Math.max(1, fault.queueDuplicateCount || 1);
      for (let i = 0; i < dupCount; i += 1) {
        onSend();
        await rawQueue.send(message, options);
      }
      if (await consumeFaultCrash(faultUrl, 'after_queue_send_before_outbox_update')) {
        throw new Error('CRASH_AFTER_QUEUE_SEND_BEFORE_OUTBOX_UPDATE');
      }
    },
  };
}

interface DoContext {
  readonly rawState: DurableObjectState;
  readonly wrappedState: DurableObjectState;
  readonly rawBindings: FaultRuntimeEnv;
  readonly faultBindings: FaultRuntimeEnv;
  readonly telemetry: AgentTelemetry;
  fault: FaultControlSnapshot;
}

const DO_CONTEXTS = new WeakMap<AgentHeadDO, DoContext>();

function buildFaultContext(rawState: DurableObjectState, rawBindings: FaultRuntimeEnv) {
  const telemetry = createEmptyTelemetry();
  let fault: FaultControlSnapshot = { ...DEFAULT_FAULT, effectiveNowMs: NATIVE_DATE_NOW() };
  const recordD1Op = (meta?: { readonly read: number; readonly written: number }) => {
    telemetry.d1Ops += 1;
    telemetry.d1RowsRead += meta?.read ?? 0;
    telemetry.d1RowsWritten += meta?.written ?? 0;
  };
  const wrappedState = wrapStorageWithTelemetry(rawState, telemetry);
  const faultD1 = createFaultInjectedD1(
    rawBindings.D1_RECOVERY,
    rawBindings.V2_FAULT_CONTROL_URL,
    () => fault,
    recordD1Op,
  );
  const faultBindings: FaultRuntimeEnv = {
    ...rawBindings,
    D1_RECOVERY: faultD1,
    GLOBAL_BUDGET: {
      getByName: (name: string) =>
        createFaultInjectedGlobalBudget(
          rawBindings.GLOBAL_BUDGET.getByName(name),
          () => fault,
          telemetry.globalBudget,
        ),
    },
    DURABLE_TURN_QUEUE: createFaultInjectedQueue(
      rawBindings.DURABLE_TURN_QUEUE,
      rawBindings.V2_FAULT_CONTROL_URL,
      () => fault,
      () => {
        telemetry.queueSends += 1;
      },
    ),
    AGENT_TASK_QUEUE: createFaultInjectedQueue(
      rawBindings.AGENT_TASK_QUEUE,
      rawBindings.V2_FAULT_CONTROL_URL,
      () => fault,
      () => {
        telemetry.queueSends += 1;
      },
    ),
  };

  const ctx: DoContext = {
    rawState,
    wrappedState,
    rawBindings,
    faultBindings,
    telemetry,
    get fault() {
      return fault;
    },
    set fault(next: FaultControlSnapshot) {
      fault = next;
    },
  };
  return { wrappedState, faultBindings, ctx };
}

/**
 * Thin fault-injection & telemetry wrapper directly subclassing #184's official `AgentHeadDO`.
 * All conversation, turn, queue, budget, and recovery logic executes inside #184 untouched.
 */
export class AgentHeadDO extends OfficialAgentHeadDO {
  constructor(state: DurableObjectState, env: FaultRuntimeEnv) {
    const built = buildFaultContext(state, env);
    super(state, built.faultBindings);
    (this as unknown as { state: DurableObjectState }).state = built.wrappedState;
    DO_CONTEXTS.set(this, built.ctx);
  }

  #ctx(): DoContext {
    const found = DO_CONTEXTS.get(this);
    if (found === undefined) throw new Error('AgentHeadDO context not initialized');
    return found;
  }

  async #refreshFaults(): Promise<FaultControlSnapshot> {
    const c = this.#ctx();
    c.fault = await fetchFaultState(c.rawBindings.V2_FAULT_CONTROL_URL);
    return c.fault;
  }

  #taskHarness(): { readonly core: AgentHeadCore; readonly facade: AgentEventRuntimeFacade } {
    const c = this.#ctx();
    const meta = getHeadMetaSync(c.rawState.storage.sql);
    if (meta === null)
      throw new Error('AgentHeadDO is not bootstrapped for task/schedule test helper');
    const scope = { tenantId: meta.tenant_id, agentId: meta.agent_id };
    let events!: AgentEventRuntimeFacade;
    const core: AgentHeadCore = new AgentHeadCore({
      ...scope,
      storage: c.wrappedState.storage as unknown as DurableObjectStorageLike,
      recoveryRegistry: new D1RecoveryRegistry(c.faultBindings.D1_RECOVERY),
      ...createAgentHeadGlobalBudgetOptions(c.faultBindings),
      eventRuntimeFactory: (business) => {
        events = new AgentEventRuntimeFacade({
          ...scope,
          storage: c.wrappedState.storage,
          business,
        });
        return {
          recoveryAdmission: events.coverage,
          eventCoordinator: events.outbox,
          recoveryHooks: events.asTurnRecoveryHooks({
            globalBudget: { settleGlobal: (payload) => settlePort.settleGlobal(payload) },
          }),
        };
      },
    });
    const settlePort = core.createGlobalBudgetSettlePort();
    return { core, facade: events };
  }

  override async edgeRpc<K extends Parameters<OfficialAgentHeadDO['edgeRpc']>[0]>(
    method: K,
    req: Parameters<OfficialAgentHeadDO['edgeRpc']>[1],
  ) {
    const c = this.#ctx();
    await this.#refreshFaults();
    if (
      method === 'markAttemptSent' &&
      (await consumeFaultCrash(
        c.rawBindings.V2_FAULT_CONTROL_URL,
        'after_prepare_before_mark_sent',
      ))
    ) {
      throw new Error('CRASH_AFTER_PREPARE_BEFORE_MARK_SENT');
    }
    const res = await super.edgeRpc(method, req);
    if (
      method === 'markAttemptSent' &&
      'value' in res &&
      typeof res.value === 'object' &&
      res.value !== null &&
      'authorized' in res.value &&
      res.value.authorized === true &&
      (await consumeFaultCrash(
        c.rawBindings.V2_FAULT_CONTROL_URL,
        'after_mark_sent_before_provider_fetch',
      ))
    ) {
      throw new Error('CRASH_AFTER_MARK_SENT_BEFORE_PROVIDER_FETCH');
    }
    return res;
  }

  override async recordTurnUsage(req: Parameters<OfficialAgentHeadDO['recordTurnUsage']>[0]) {
    await this.#refreshFaults();
    return super.recordTurnUsage(req);
  }

  override async markAttemptSent(req: Parameters<OfficialAgentHeadDO['markAttemptSent']>[0]) {
    const c = this.#ctx();
    await this.#refreshFaults();
    if (
      await consumeFaultCrash(c.rawBindings.V2_FAULT_CONTROL_URL, 'after_prepare_before_mark_sent')
    ) {
      throw new Error('CRASH_AFTER_PREPARE_BEFORE_MARK_SENT');
    }
    const res = await super.markAttemptSent(req);
    if (
      res.authorized &&
      (await consumeFaultCrash(
        c.rawBindings.V2_FAULT_CONTROL_URL,
        'after_mark_sent_before_provider_fetch',
      ))
    ) {
      throw new Error('CRASH_AFTER_MARK_SENT_BEFORE_PROVIDER_FETCH');
    }
    return res;
  }

  override async claimDurableWork(req: Parameters<OfficialAgentHeadDO['claimDurableWork']>[0]) {
    const c = this.#ctx();
    await this.#refreshFaults();
    const res = await super.claimDurableWork(req);
    if (
      res.kind === 'claimed' &&
      (await consumeFaultCrash(c.rawBindings.V2_FAULT_CONTROL_URL, 'after_claim_before_send'))
    ) {
      throw new Error('CRASH_AFTER_CLAIM_BEFORE_SEND');
    }
    return res;
  }

  override async commitDurableResult(
    req: Parameters<OfficialAgentHeadDO['commitDurableResult']>[0],
  ) {
    const c = this.#ctx();
    await this.#refreshFaults();
    if (await consumeFaultCrash(c.rawBindings.V2_FAULT_CONTROL_URL, 'after_claim_before_commit')) {
      throw new Error('CRASH_AFTER_CLAIM_BEFORE_COMMIT');
    }
    const res = await super.commitDurableResult(req);
    if (
      await consumeFaultCrash(c.rawBindings.V2_FAULT_CONTROL_URL, 'after_commit_before_queue_ack')
    ) {
      throw new Error('CRASH_AFTER_COMMIT_BEFORE_QUEUE_ACK');
    }
    return res;
  }

  override async reconcileFromRegistry(
    req: Parameters<OfficialAgentHeadDO['reconcileFromRegistry']>[0],
  ) {
    await this.#refreshFaults();
    return super.reconcileFromRegistry(req);
  }

  override async confirmRegistryPlan(
    req: Parameters<OfficialAgentHeadDO['confirmRegistryPlan']>[0],
  ) {
    await this.#refreshFaults();
    return super.confirmRegistryPlan(req);
  }

  override async runRecoveryAlarmCycle(nowMs: number) {
    const c = this.#ctx();
    const snap = await this.#refreshFaults();
    const effectiveNow = snap.virtualNowMs ?? nowMs;
    c.telemetry.alarmFiresObserved += 1;
    const recordFailure = () => {
      c.telemetry.alarmFailureCount += 1;
      c.rawState.storage.transactionSync(() => {
        c.rawState.storage.sql.exec(
          `UPDATE v2_recovery_coverage
           SET alarm_fail_count = alarm_fail_count + 1, updated_at_ms = ?
           WHERE id = 1`,
          effectiveNow,
        );
      });
    };

    if (await consumeFaultCrash(c.rawBindings.V2_FAULT_CONTROL_URL, 'alarm_exhaust_6_retries')) {
      recordFailure();
      throw new Error('SIMULATED_DO_ALARM_FAILURE');
    }
    if (await consumeFaultAlarmFailure(c.rawBindings.V2_FAULT_CONTROL_URL)) {
      recordFailure();
      throw new Error('SIMULATED_DO_ALARM_FAILURE');
    }
    try {
      await super.runRecoveryAlarmCycle(effectiveNow);
      c.telemetry.alarmSuccessCount += 1;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  async runTestRecoveryAlarmCycle(nowMs?: number): Promise<{ ok: boolean; error?: string }> {
    const snap = await this.#refreshFaults();
    const effectiveNow = nowMs ?? snap.virtualNowMs ?? NATIVE_DATE_NOW();
    try {
      await this.runRecoveryAlarmCycle(effectiveNow);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override async alarm() {
    const snap = await this.#refreshFaults();
    await this.runRecoveryAlarmCycle(snap.virtualNowMs ?? NATIVE_DATE_NOW());
  }

  // Test-only schedule & task helpers sharing the exact #184 SQLite storage (local HTTP worker lacks task/schedule routes).
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
    const c = this.#ctx();
    await this.#refreshFaults();
    const nowMs = c.fault.virtualNowMs ?? NATIVE_DATE_NOW();
    const { facade } = this.#taskHarness();
    const registry = new D1RecoveryRegistry(c.faultBindings.D1_RECOVERY);
    const bound = (cmd.deadlineAtMs ?? nowMs + 60_000) + 45_000;
    const plan = c.rawState.storage.transactionSync(() =>
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
      c.rawState.storage.transactionSync(() => {
        facade.coverage.confirmCoverageSync({
          generation: reg.currentGeneration,
          actualRecoveryAtMs: reg.actualRecoveryAtMs,
          applied: reg.accepted,
          earliestRequiredRecoveryMs: bound,
          nowMs,
        });
      });
    }
    const alarmAtMs = c.rawState.storage.transactionSync(() => {
      c.rawState.storage.sql.exec(
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
      const envPayload = {
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
        payloadJson: JSON.stringify(envPayload),
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
    readonly sourceKind: Parameters<
      AgentEventRuntimeFacade['schedules']['upsertScheduleSync']
    >[0]['sourceKind'];
    readonly sourceId: string;
    readonly scheduleKind: Parameters<
      AgentEventRuntimeFacade['schedules']['upsertScheduleSync']
    >[0]['scheduleKind'];
    readonly intervalSeconds?: number | null;
    readonly cronExpr?: string | null;
    readonly timezone?: string;
    readonly firstFireAtMs: number;
    readonly misfirePolicy?: Parameters<
      AgentEventRuntimeFacade['schedules']['upsertScheduleSync']
    >[0]['misfirePolicy'];
  }) {
    const c = this.#ctx();
    await this.#refreshFaults();
    const nowMs = c.fault.virtualNowMs ?? NATIVE_DATE_NOW();
    const { facade } = this.#taskHarness();
    const registry = new D1RecoveryRegistry(c.faultBindings.D1_RECOVERY);
    const bound = cmd.firstFireAtMs + 45_000;
    const plan = c.rawState.storage.transactionSync(() =>
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
      c.rawState.storage.transactionSync(() => {
        facade.coverage.confirmCoverageSync({
          generation: reg.currentGeneration,
          actualRecoveryAtMs: reg.actualRecoveryAtMs,
          applied: reg.accepted,
          earliestRequiredRecoveryMs: bound,
          nowMs,
        });
      });
    }
    const alarmAtMs = c.rawState.storage.transactionSync(() => {
      facade.schedules.upsertScheduleSync({
        scheduleId: cmd.scheduleId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        sourceKind: cmd.sourceKind,
        sourceId: cmd.sourceId,
        scheduleKind: cmd.scheduleKind,
        intervalSeconds: cmd.intervalSeconds ?? null,
        cronExpr: cmd.cronExpr ?? null,
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

  async reserveTaskModelAttempt(cmd: Parameters<AgentHeadCore['reserveTaskModelAttempt']>[0]) {
    await this.#refreshFaults();
    return this.#taskHarness().core.reserveTaskModelAttempt(cmd);
  }

  async settleTaskModelAttempt(cmd: Parameters<AgentHeadCore['settleTaskModelAttempt']>[0]) {
    await this.#refreshFaults();
    return this.#taskHarness().core.settleTaskModelAttempt(cmd);
  }

  async inspectState() {
    const c = this.#ctx();
    const sql = c.rawState.storage.sql;
    const safeRows = <T extends Record<string, SqlStorageValue>>(query: string): T[] => {
      try {
        return sql.exec<T>(query).toArray();
      } catch {
        return [];
      }
    };
    return {
      telemetry: c.telemetry,
      alarmArmedAtMs: await c.rawState.storage.getAlarm(),
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
    const c = this.#ctx();
    Object.assign(c.telemetry.sql, {
      statements: 0,
      rowsRead: 0,
      rowsWritten: 0,
      alarmSetCalls: 0,
      alarmDeleteCalls: 0,
    });
    c.telemetry.d1Ops = 0;
    c.telemetry.d1RowsRead = 0;
    c.telemetry.d1RowsWritten = 0;
    Object.assign(c.telemetry.globalBudget, {
      reserveCalls: 0,
      authorizeCalls: 0,
      renewCalls: 0,
      settleCalls: 0,
    });
    c.telemetry.queueSends = 0;
    c.telemetry.alarmFiresObserved = 0;
    c.telemetry.alarmSuccessCount = 0;
    c.telemetry.alarmFailureCount = 0;
    return Promise.resolve({ ok: true });
  }
}

type SqlStorageValue = string | number | ArrayBuffer | null;

function unwrapEdgeRpc<T>(
  res: { readonly value: T } | { readonly code: ConstructorParameters<typeof DomainError>[0] },
): T {
  if ('code' in res) {
    throw new DomainError(res.code);
  }
  return res.value;
}

export default {
  async fetch(
    request: Request,
    env: FaultRuntimeEnv,
    ctx: { waitUntil(work: Promise<unknown>): void },
  ): Promise<Response> {
    const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
    const url = new URL(request.url);

    if (url.pathname === '/v1/health') {
      return Response.json({ ok: true, runtime: 'v2-m1-full-runtime-aligned', env: env.EMBER_ENV });
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
        const row = await env.D1_RECOVERY.prepare(
          `SELECT consumerId, tenantId, principalId, agentId FROM local_v2_sessions WHERE digest = ?`,
        )
          .bind(digestHex)
          .first<{ consumerId: string; tenantId: string; principalId: string; agentId: string }>();
        if (row === null) return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
        const conv = await getHead(env, row.tenantId, row.agentId).projectConversation({
          tenantId: row.tenantId,
          agentId: row.agentId,
        });
        return Response.json({
          consumerId: row.consumerId,
          tenantId: row.tenantId,
          principalId: row.principalId,
          agentId: row.agentId,
          conversationId: conv?.conversation_id ?? null,
        });
      }

      if (url.pathname === '/_test/agent/inspect') {
        const stub = getHead(env, String(payload.tenantId), String(payload.agentId)) as AgentHeadDO;
        return Response.json(await stub.inspectState());
      }

      if (url.pathname === '/_test/agent/reset-telemetry') {
        const stub = getHead(env, String(payload.tenantId), String(payload.agentId)) as AgentHeadDO;
        return Response.json(await stub.resetTelemetry());
      }

      if (url.pathname === '/_test/agent/alarm') {
        const stub = getHead(env, String(payload.tenantId), String(payload.agentId)) as AgentHeadDO;
        return Response.json(
          await stub.runTestRecoveryAlarmCycle(
            typeof payload.nowMs === 'number' ? payload.nowMs : undefined,
          ),
        );
      }

      if (url.pathname === '/_test/agent/rpc') {
        const stub = getHead(env, String(payload.tenantId), String(payload.agentId)) as AgentHeadDO;
        const method = String(payload.method);
        const arg = payload.arg;
        try {
          let result: unknown;
          switch (method) {
            case 'prepareTurn':
              result = unwrapEdgeRpc(
                await stub.edgeRpc(
                  'prepareTurn',
                  arg as Parameters<AgentHeadRpc['prepareTurn']>[0],
                ),
              );
              break;
            case 'renewTurnLease':
              result = unwrapEdgeRpc(
                await stub.edgeRpc(
                  'renewTurnLease',
                  arg as Parameters<AgentHeadRpc['renewTurnLease']>[0],
                ),
              );
              break;
            case 'handoffTurnToDurable':
              result = unwrapEdgeRpc(
                await stub.edgeRpc(
                  'handoffTurnToDurable',
                  arg as Parameters<AgentHeadRpc['handoffTurnToDurable']>[0],
                ),
              );
              break;
            case 'commitTurn':
              result = unwrapEdgeRpc(
                await stub.edgeRpc('commitTurn', arg as Parameters<AgentHeadRpc['commitTurn']>[0]),
              );
              break;
            case 'cancelTurn':
              result = unwrapEdgeRpc(
                await stub.edgeRpc('cancelTurn', arg as Parameters<AgentHeadRpc['cancelTurn']>[0]),
              );
              break;
            case 'clearTranscript':
              result = unwrapEdgeRpc(
                await stub.edgeRpc(
                  'clearTranscript',
                  arg as Parameters<AgentHeadRpc['clearTranscript']>[0],
                ),
              );
              break;
            case 'markAttemptSent':
              result = await stub.markAttemptSent(
                arg as Parameters<OfficialAgentHeadDO['markAttemptSent']>[0],
              );
              break;
            case 'recordTurnUsage':
              result = await stub.recordTurnUsage(
                arg as Parameters<OfficialAgentHeadDO['recordTurnUsage']>[0],
              );
              break;
            case 'reconcileFromRegistry':
              result = await stub.reconcileFromRegistry(
                arg as Parameters<OfficialAgentHeadDO['reconcileFromRegistry']>[0],
              );
              break;
            case 'claimDurableWork':
              result = await stub.claimDurableWork(
                arg as Parameters<OfficialAgentHeadDO['claimDurableWork']>[0],
              );
              break;
            case 'commitDurableResult':
              result = await stub.commitDurableResult(
                arg as Parameters<OfficialAgentHeadDO['commitDurableResult']>[0],
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
            return Response.json({ ok: false, error: `Unknown ${method}` }, { status: 400 });
        }
        return Response.json({ ok: true, result: res });
      }

      if (url.pathname === '/_test/sweeper/run') {
        const faultD1 = createFaultInjectedD1(
          env.D1_RECOVERY,
          env.V2_FAULT_CONTROL_URL,
          () => fault,
          () => {},
        );
        const sweeper = new RecoverySweeper({
          db: faultD1,
          registry: new D1RecoveryRegistry(faultD1),
          targets: {
            getRecoveryTarget(tenantId, agentId) {
              const stub = getHead(env, tenantId, agentId) as AgentHeadDO;
              return {
                reconcileFromRegistry: (req) => stub.reconcileFromRegistry(req),
                confirmRegistryPlan: (req) => stub.confirmRegistryPlan(req),
                runRecoveryAlarmCycle: async (ts) => {
                  const r = await stub.runTestRecoveryAlarmCycle(ts);
                  if (!r.ok) throw new Error(r.error ?? 'alarm cycle failed');
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

    // Delegate all /v1/* and /v2/* endpoints directly to #184's official runtime worker!
    return officialWorker.fetch(request, env, ctx);
  },

  async queue(
    batch: { readonly queue: string; readonly messages: readonly QueueMessageLike[] },
    env: FaultRuntimeEnv,
  ): Promise<void> {
    const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
    if (fault.queueForceDlq && (batch.queue === 'durable_turn' || batch.queue === 'agent_task')) {
      for (const msg of batch.messages) {
        msg.retry({ delaySeconds: 0 });
      }
      return;
    }
    return officialWorker.queue(batch, env);
  },

  async scheduled(event: { readonly scheduledTime: number }, env: FaultRuntimeEnv): Promise<void> {
    const fault = await fetchFaultState(env.V2_FAULT_CONTROL_URL);
    const faultD1 = createFaultInjectedD1(
      env.D1_RECOVERY,
      env.V2_FAULT_CONTROL_URL,
      () => fault,
      () => {},
    );
    const envWithFaultD1: FaultRuntimeEnv = { ...env, D1_RECOVERY: faultD1 };
    const effectiveNow = fault.virtualNowMs ?? event.scheduledTime;
    await new RecoverySweeper({
      db: faultD1,
      registry: new D1RecoveryRegistry(faultD1),
      targets: {
        getRecoveryTarget: (tenantId, agentId) => {
          const stub = getHead(envWithFaultD1, tenantId, agentId) as AgentHeadDO;
          return {
            reconcileFromRegistry: (req) => stub.reconcileFromRegistry(req),
            confirmRegistryPlan: (req) => stub.confirmRegistryPlan(req),
            runRecoveryAlarmCycle: async (ts) => {
              const r = await stub.runTestRecoveryAlarmCycle(ts);
              if (!r.ok) throw new Error(r.error ?? 'alarm cycle failed');
            },
          };
        },
      },
    }).sweepDueAgents({ sweeperId: `cron-${crypto.randomUUID()}`, nowMs: effectiveNow });
  },
};
