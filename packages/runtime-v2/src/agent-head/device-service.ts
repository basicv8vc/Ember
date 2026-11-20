import { DomainError, isTerminalTaskStatus } from '@ember/domain';
import { V2_TIMING_LIMITS } from '../contracts/constants.js';
import {
  DEVICE_CAPABILITY,
  DEVICE_CAPABILITY_VERSION,
  DEVICE_LEASE_MS,
  DEVICE_READY_TTL_MS,
  DEVICE_TEXT_CAPABILITY,
  DEVICE_TEXT_LEASE_MS,
  deviceTextInputSchema,
  deviceTextStatsSchema,
  type DeviceCapability,
  type DeviceClaim,
  type DeviceExecutionCommand,
  type DeviceExecutionResponse,
  type DeviceTaskSnapshot,
} from '../contracts/device-execution.js';
import type { EventRuntimeCoordinatorPort } from '../recovery/ports.js';
import {
  assertHeadScopeSync,
  getLatestRunForTaskSync,
  sha256Hex,
  sqlExecMaybe,
} from './queries.js';
import type { AgentHeadRecoveryService } from './recovery-service.js';
import type { RunRow, TaskResultRow, TaskRow } from './schema.js';
import {
  appendTaskEventSync,
  finishTaskRunSync,
  hasLiveTaskLease,
  startTaskRunSync,
} from './task-execution.js';
import {
  confirmOrVerifyCoverageInTxSync,
  prepareObligationCoverageAsync,
  type CoverageHelperDeps,
} from './turn-commit.js';

interface RegisteredDevice {
  readonly token_digest: string;
  readonly capability: DeviceCapability;
  readonly capability_version: number;
  readonly ready_until_ms: number;
  readonly revoked_at_ms: number | null;
}

interface PlacedTask extends TaskRow {
  readonly device_id: string;
  readonly capability: DeviceCapability;
  readonly capability_version: typeof DEVICE_CAPABILITY_VERSION;
  readonly deadline_at_ms: number;
}

const PLACED_TASK = `SELECT t.*, p.device_id, p.capability, p.capability_version
  FROM tasks t JOIN device_task_placements p ON p.task_id = t.id
 WHERE t.execution_target = 'device' AND p.principal_id = ?`;
const DEVICE_OPERATION_PREFIX = 'device:';
type DeviceRunCommand = Extract<DeviceExecutionCommand, { kind: 'renew' | 'result' }>;

function dispatchDigestInput(cmd: Extract<DeviceExecutionCommand, { kind: 'dispatch' }>) {
  // Preserve the digest of previously accepted mock operations across the placement migration.
  return cmd.capability === DEVICE_CAPABILITY
    ? [cmd.deviceId, cmd.input.text, cmd.deadlineMs]
    : [
        cmd.deviceId,
        cmd.capability,
        cmd.version,
        cmd.input.operation,
        cmd.input.text,
        cmd.deadlineMs,
      ];
}

function operationId(task: TaskRow): string {
  return task.idempotency_key.slice(task.idempotency_key.lastIndexOf(':') + 1);
}

function sameCredential(stored: string, supplied: string): boolean {
  if (stored.length !== supplied.length) return false;
  let difference = 0;
  for (let i = 0; i < stored.length; i++) {
    difference |= stored.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return difference === 0;
}

function isReady(
  device: RegisteredDevice | null,
  nowMs: number,
  capability?: DeviceCapability,
): device is RegisteredDevice {
  return (
    device !== null &&
    device.revoked_at_ms === null &&
    device.ready_until_ms > nowMs &&
    (capability === undefined || device.capability === capability) &&
    device.capability_version === DEVICE_CAPABILITY_VERSION
  );
}

export class AgentHeadDeviceService {
  constructor(
    private readonly deps: CoverageHelperDeps & {
      readonly recovery: AgentHeadRecoveryService;
      readonly eventCoordinator: EventRuntimeCoordinatorPort;
      readonly newId: () => string;
    },
  ) {}

  private get sql() {
    return this.deps.storage.sql;
  }

  async execute(cmd: DeviceExecutionCommand): Promise<DeviceExecutionResponse> {
    const { storage, eventCoordinator, recoveryHooks, nowMs } = this.deps;
    assertHeadScopeSync(this.sql, cmd.tenantId, cmd.agentId);
    const dispatchDigest =
      cmd.kind === 'dispatch'
        ? await sha256Hex(JSON.stringify(dispatchDigestInput(cmd)))
        : undefined;
    const coverage =
      cmd.kind === 'dispatch' || cmd.kind === 'claim'
        ? await prepareObligationCoverageAsync(this.deps, {
            tenantId: cmd.tenantId,
            agentId: cmd.agentId,
            shouldCoverSync: () => {
              if (cmd.kind === 'dispatch') return this.findOperation(cmd) === null;
              const device = this.requireDevice(cmd);
              const now = nowMs();
              if (!isReady(device, now)) return false;
              const active = this.findActive(cmd);
              return active === null
                ? this.findClaimable(cmd, now, device.capability) !== null
                : active.lease_expires_at_ms !== null && active.lease_expires_at_ms <= now;
            },
          })
        : null;

    const tx = storage.transactionSync(() => {
      const now = nowMs();
      const verifyCoverage = () =>
        confirmOrVerifyCoverageInTxSync(
          this.deps,
          coverage,
          now + V2_TIMING_LIMITS.d1RecoveryGraceMs,
          now,
          'device task recovery coverage unavailable',
        );

      const executeSync = () => {
        switch (cmd.kind) {
          case 'register':
            return this.register(cmd, now);
          case 'revoke':
            if (this.getDevice(cmd.principalId, cmd.deviceId) === null) {
              throw new DomainError('NOT_FOUND', 'device is not registered');
            }
            this.sql.exec(
              `UPDATE device_registrations SET revoked_at_ms = ?, ready_until_ms = 0
                WHERE id = ? AND principal_id = ? AND revoked_at_ms IS NULL`,
              now,
              cmd.deviceId,
              cmd.principalId,
            );
            return { status: 'revoked' } as const;
          case 'dispatch':
            return this.dispatch(cmd, now, dispatchDigest!, verifyCoverage);
          case 'claim':
            return this.claim(cmd, now, verifyCoverage);
          case 'renew':
            return this.renew(cmd, now);
          case 'result':
            return this.commit(cmd, now);
          case 'status':
          case 'cancel': {
            const task = this.getTask(cmd.principalId, cmd.taskId);
            if (cmd.kind === 'cancel' && !isTerminalTaskStatus(task.status)) {
              this.sql.exec(
                `UPDATE tasks SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?)
                  WHERE id = ?`,
                now,
                task.id,
              );
            }
            return this.refresh(task, cmd.principalId, now);
          }
        }
      };

      const response = executeSync();
      return { response, now, alarm: eventCoordinator.recomputeAlarmSync(now) };
    });
    await recoveryHooks.syncPlatformAlarm?.(tx.alarm, tx.now);
    return tx.response;
  }

  private getDevice(principalId: string, deviceId: string): RegisteredDevice | null {
    return sqlExecMaybe<RegisteredDevice>(
      this.sql,
      'SELECT * FROM device_registrations WHERE id = ? AND principal_id = ?',
      deviceId,
      principalId,
    );
  }

  private requireDevice(cmd: {
    principalId: string;
    deviceId: string;
    tokenDigest: string;
  }): RegisteredDevice {
    const device = this.getDevice(cmd.principalId, cmd.deviceId);
    if (
      device === null ||
      device.revoked_at_ms !== null ||
      !sameCredential(device.token_digest, cmd.tokenDigest)
    ) {
      throw new DomainError('POLICY_DENIED', 'device credential is unavailable');
    }
    return device;
  }

  private register(cmd: Extract<DeviceExecutionCommand, { kind: 'register' }>, now: number) {
    const existing = sqlExecMaybe<RegisteredDevice>(
      this.sql,
      'SELECT * FROM device_registrations WHERE id = ?',
      cmd.deviceId,
    );
    if (existing !== null) {
      const device = this.requireDevice(cmd);
      if (device.capability !== cmd.capability || device.capability_version !== cmd.version) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'device registration capability changed');
      }
    }
    const readyUntilMs = now + DEVICE_READY_TTL_MS;
    this.sql.exec(
      `INSERT INTO device_registrations
        (id, principal_id, token_digest, capability, capability_version, ready_until_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET ready_until_ms = excluded.ready_until_ms`,
      cmd.deviceId,
      cmd.principalId,
      cmd.tokenDigest,
      cmd.capability,
      cmd.version,
      readyUntilMs,
    );
    return {
      deviceId: cmd.deviceId,
      capability: cmd.capability,
      version: cmd.version,
      readyUntilMs,
    };
  }

  private key(cmd: { principalId: string; operationId: string }): string {
    return DEVICE_OPERATION_PREFIX + cmd.principalId + ':' + cmd.operationId;
  }

  private findOperation(cmd: { principalId: string; operationId: string }): PlacedTask | null {
    return sqlExecMaybe<PlacedTask>(
      this.sql,
      PLACED_TASK + ' AND t.idempotency_key = ?',
      cmd.principalId,
      this.key(cmd),
    );
  }

  private getTask(principalId: string, taskId: string, deviceId?: string): PlacedTask {
    const task = sqlExecMaybe<PlacedTask>(
      this.sql,
      PLACED_TASK + ' AND t.id = ?',
      principalId,
      taskId,
    );
    if (task === null || (deviceId !== undefined && task.device_id !== deviceId)) {
      throw new DomainError('NOT_FOUND', 'device task is not visible');
    }
    return task;
  }

  private getResult(taskId: string): TaskResultRow | null {
    return sqlExecMaybe<TaskResultRow>(
      this.sql,
      'SELECT * FROM task_results WHERE task_id = ?',
      taskId,
    );
  }

  private dispatch(
    cmd: Extract<DeviceExecutionCommand, { kind: 'dispatch' }>,
    now: number,
    digest: string,
    verifyCoverage: () => void,
  ): DeviceTaskSnapshot {
    const existing = this.findOperation(cmd);
    const inputJson = JSON.stringify(cmd.input);
    if (existing !== null) {
      if (existing.digest !== digest) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'device operation payload changed');
      }
      return { ...this.refresh(existing, cmd.principalId, now), replayed: true };
    }
    verifyCoverage();
    const taskId = this.deps.newId();
    const key = this.key(cmd);
    this.sql.exec(
      `INSERT INTO tasks (
         id, kind, input_json, digest, idempotency_key, execution_path, execution_target,
         next_run_at_ms, deadline_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'standard', 'device', ?, ?, ?, ?)`,
      taskId,
      DEVICE_CAPABILITY,
      inputJson,
      digest,
      key,
      now,
      now + cmd.deadlineMs,
      now,
      now,
    );
    this.sql.exec(
      `INSERT INTO device_task_placements (task_id, principal_id, device_id, capability, capability_version)
       VALUES (?, ?, ?, ?, ?)`,
      taskId,
      cmd.principalId,
      cmd.deviceId,
      cmd.capability,
      cmd.version,
    );
    this.event(cmd, taskId, now, 'accepted', {
      executionTarget: 'device',
      capability: cmd.capability,
    });
    return {
      ...this.snapshot(this.getTask(cmd.principalId, taskId), cmd.principalId, now),
      replayed: false,
    };
  }

  private findActive(cmd: { principalId: string; deviceId: string }): PlacedTask | null {
    return sqlExecMaybe<PlacedTask>(
      this.sql,
      PLACED_TASK + " AND p.device_id = ? AND t.status = 'running' LIMIT 1",
      cmd.principalId,
      cmd.deviceId,
    );
  }

  private findClaimable(
    cmd: { principalId: string; deviceId: string },
    now: number,
    capability: DeviceCapability,
  ): PlacedTask | null {
    return sqlExecMaybe<PlacedTask>(
      this.sql,
      PLACED_TASK +
        ` AND p.device_id = ? AND p.capability = ? AND p.capability_version = ?
            AND t.status = 'queued' AND t.deadline_at_ms > ?
            AND t.next_run_at_ms <= ? AND t.cancel_requested_at_ms IS NULL
          ORDER BY t.created_at_ms, t.id LIMIT 1`,
      cmd.principalId,
      cmd.deviceId,
      capability,
      DEVICE_CAPABILITY_VERSION,
      now,
      now,
    );
  }

  private claim(
    cmd: Extract<DeviceExecutionCommand, { kind: 'claim' }>,
    now: number,
    verifyCoverage: () => void,
  ): DeviceClaim {
    const device = this.requireDevice(cmd);
    if (!isReady(device, now)) return { kind: 'idle' };

    const active = this.findActive(cmd);
    if (active !== null) {
      const run = getLatestRunForTaskSync(this.sql, active.id);
      if (
        run !== null &&
        hasLiveTaskLease(active, run, now, {
          leaseEpoch: active.lease_epoch,
          workerId: cmd.deviceId,
          executorKind: 'device',
        })
      ) {
        return this.offer(active, run.id, run.lease_epoch, run.leased_until_ms);
      }
      this.deps.recovery.convergeDueBusinessItemSync('task', active.id, now);
    }

    const task = this.findClaimable(cmd, now, device.capability);
    if (task === null) return { kind: 'idle' };
    verifyCoverage();
    const runId = this.deps.newId();
    const lease = startTaskRunSync(this.sql, task, {
      runId,
      workerId: cmd.deviceId,
      executorKind: 'device',
      nowMs: now,
      leaseMs: task.capability === DEVICE_TEXT_CAPABILITY ? DEVICE_TEXT_LEASE_MS : DEVICE_LEASE_MS,
    });
    this.event(cmd, task.id, now, 'leased', { runId, leaseEpoch: lease.nextEpoch });
    return this.offer(task, runId, lease.nextEpoch, lease.leaseExpiresAtMs);
  }

  private offer(
    task: PlacedTask,
    runId: string,
    leaseEpoch: number,
    leaseExpiresAtMs: number,
  ): DeviceClaim {
    const offer = {
      kind: 'claimed' as const,
      taskId: task.id,
      operationId: operationId(task),
      runId,
      leaseEpoch,
      leaseExpiresAtMs,
      deadlineAtMs: task.deadline_at_ms,
      version: task.capability_version,
    };
    const input: unknown = JSON.parse(task.input_json);
    if (task.capability === DEVICE_TEXT_CAPABILITY) {
      return { ...offer, capability: task.capability, input: deviceTextInputSchema.parse(input) };
    }
    return { ...offer, capability: task.capability, input: input as { text: string } };
  }

  private findFencedRun(cmd: DeviceRunCommand): { task: PlacedTask; run: RunRow } | null {
    const device = this.requireDevice(cmd);
    const task = this.getTask(cmd.principalId, cmd.taskId, cmd.deviceId);
    const run = getLatestRunForTaskSync(this.sql, task.id);
    if (
      task.capability !== device.capability ||
      task.capability_version !== device.capability_version ||
      task.idempotency_key !== this.key(cmd) ||
      run === null ||
      task.current_run_id !== cmd.runId ||
      run.id !== cmd.runId ||
      run.worker_id !== cmd.deviceId ||
      run.executor_kind !== 'device' ||
      run.lease_epoch !== cmd.leaseEpoch ||
      task.lease_epoch !== cmd.leaseEpoch
    ) {
      return null;
    }
    return { task, run };
  }

  private renew(cmd: Extract<DeviceExecutionCommand, { kind: 'renew' }>, now: number) {
    const execution = this.findFencedRun(cmd);
    if (
      execution === null ||
      execution.task.capability !== DEVICE_TEXT_CAPABILITY ||
      !hasLiveTaskLease(execution.task, execution.run, now, {
        executorKind: 'device',
        workerId: cmd.deviceId,
        leaseEpoch: cmd.leaseEpoch,
      })
    ) {
      return { kind: 'fenced' } as const;
    }

    const { task, run } = execution;
    const leaseExpiresAtMs = Math.max(
      run.leased_until_ms,
      Math.min(now + DEVICE_TEXT_LEASE_MS, task.deadline_at_ms),
    );
    if (leaseExpiresAtMs > run.leased_until_ms) {
      this.sql.exec(
        'UPDATE runs SET leased_until_ms = ?, updated_at_ms = ? WHERE id = ?',
        leaseExpiresAtMs,
        now,
        run.id,
      );
      this.sql.exec(
        'UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ?',
        leaseExpiresAtMs,
        now,
        task.id,
      );
    }
    return { kind: 'renewed', leaseExpiresAtMs } as const;
  }

  private commit(cmd: Extract<DeviceExecutionCommand, { kind: 'result' }>, now: number) {
    const execution = this.findFencedRun(cmd);
    if (execution === null) return { kind: 'fenced' } as const;
    const { task, run } = execution;
    const detail = this.resultDetail(task.capability, cmd);
    const result = this.getResult(task.id);
    if (result !== null) {
      if (task.status !== cmd.status || result.detail_text !== detail) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'device result payload changed');
      }
      return { kind: 'committed', replayed: true } as const;
    }
    if (
      !hasLiveTaskLease(task, run, now, {
        executorKind: 'device',
        workerId: cmd.deviceId,
        leaseEpoch: cmd.leaseEpoch,
      })
    ) {
      return { kind: 'fenced' } as const;
    }

    const reasonCode = cmd.status === 'completed' ? 'ok' : 'executor_failed';
    finishTaskRunSync(this.sql, task, run, now, {
      status: cmd.status,
      summaryText: null,
      detailText: detail,
      modelLabel: task.capability,
      simulated: task.capability === DEVICE_CAPABILITY,
      truncated: false,
      reasonCode,
    });
    this.event(cmd, task.id, now, cmd.status, { runId: run.id, reasonCode });
    return { kind: 'committed', replayed: false } as const;
  }

  private resultDetail(
    capability: DeviceCapability,
    cmd: Extract<DeviceExecutionCommand, { kind: 'result' }>,
  ): string | null {
    if (cmd.status === 'failed') return null;
    if (capability === DEVICE_TEXT_CAPABILITY) {
      const stats = deviceTextStatsSchema.safeParse(cmd.output);
      if (stats.success) return JSON.stringify(stats.data);
    } else if ('text' in cmd.output) {
      return cmd.output.text;
    }
    throw new DomainError('INVALID_ARGUMENT', 'device result does not match task capability');
  }

  private refresh(task: PlacedTask, principalId: string, now: number): DeviceTaskSnapshot {
    this.deps.recovery.convergeDueBusinessItemSync('task', task.id, now);
    return this.snapshot(this.getTask(principalId, task.id), principalId, now);
  }

  private snapshot(task: PlacedTask, principalId: string, now: number): DeviceTaskSnapshot {
    const ready = isReady(this.getDevice(principalId, task.device_id), now, task.capability);
    const result = this.getResult(task.id);
    const status =
      task.status === 'waiting_approval' || task.status === 'retryable_failed'
        ? 'queued'
        : task.status;
    let reason: DeviceTaskSnapshot['reason'] = null;
    if (status === 'cancelled') reason = 'cancelled';
    else if (status === 'failed') {
      if (result !== null) reason = 'executor_failed';
      else
        reason =
          task.updated_at_ms >= task.deadline_at_ms
            ? 'deadline_exceeded'
            : 'lease_attempts_exhausted';
    } else if (!ready && (status === 'queued' || status === 'running')) {
      reason = 'device_unavailable';
    }
    return {
      taskId: task.id,
      operationId: operationId(task),
      deviceId: task.device_id,
      status,
      availability: ready ? 'ready' : 'device_unavailable',
      reason,
      result:
        result?.detail_text == null
          ? null
          : task.capability === DEVICE_TEXT_CAPABILITY
            ? deviceTextStatsSchema.parse(JSON.parse(result.detail_text))
            : { text: result.detail_text },
    };
  }

  private event(
    cmd: DeviceExecutionCommand,
    taskId: string,
    nowMs: number,
    phase: 'accepted' | 'leased' | 'completed' | 'failed',
    payload: Record<string, unknown>,
  ): void {
    appendTaskEventSync(this.sql, {
      id: this.deps.newId(),
      taskId,
      phase,
      traceId: cmd.requestId,
      nowMs,
      payload,
    });
  }
}
