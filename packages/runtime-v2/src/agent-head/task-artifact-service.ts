import {
  PYTHON_AGENT_LIMITS,
  TaskEventPayloadSchema,
  isSafeArtifactFilename,
  type B1TaskCancelDto,
  type B1TaskDetailDto,
  type B1TaskEventPageDto,
  type B1TaskListDto,
  type B1TaskResultDto,
  type B3StagedUploadReceiptDto,
  type B3TaskArtifactsListDto,
} from '@ember/contracts';
import { DomainError, isTerminalTaskStatus } from '@ember/domain';
import { V2_TIMING_LIMITS } from '../contracts/constants.js';
import {
  V2_MAX_INLINE_ARTIFACT_BYTES,
  submitPythonTaskRequestSchema,
  v2StageUploadInputSchema,
  v2TaskIdSchema,
  type TaskArtifactCommand,
  type TaskArtifactResponse,
  type V2PublishTaskOutputsResultDto,
  type V2PythonTaskSubmitResultDto,
  type V2TaskArtifactDownloadDto,
  type V2TaskInputFileDto,
} from '../contracts/task-artifacts.js';
import type { V2DispatchEnvelope } from '../recovery/envelope.js';
import type { EventRuntimeCoordinatorPort } from '../recovery/ports.js';
import type { DurableObjectStorageLike, SqlStorageLike } from '../storage.js';
import {
  assertHeadScopeSync,
  getLatestRunForTaskSync,
  getMainConversationSync,
  sha256Hex,
  sqlExecAll,
  sqlExecMaybe,
} from './queries.js';
import type { TaskEventRow, TaskResultRow, TaskRow } from './schema.js';
import { toIsoTimestamp } from './state-machine.js';
import { appendTaskEventSync, hasLiveTaskLease } from './task-execution.js';
import {
  confirmOrVerifyCoverageInTxSync,
  prepareObligationCoverageAsync,
  type CoverageHelperDeps,
} from './turn-commit.js';

const DEFAULT_PYTHON_TASK_DEADLINE_MS = 120_000;
const PYTHON_TASK_IDEMPOTENCY_PREFIX = 'v2-python:';
const TASK_LIST_CURSOR_DELIMITER = '|';
const TASK_LIST_CURSOR_REGEX = /^[A-Za-z0-9_-]{1,256}$/;

export interface V2TaskArtifactRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly committed: number;
  readonly created_by: 'user' | 'run';
  readonly filename: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly content_b64: string;
  readonly created_at_ms: number;
}

function decodeBase64Strict(encoded: string): Uint8Array {
  const normalized = encoded.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', 'artifact content must be valid base64');
  }
  try {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'artifact content must be valid base64');
  }
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeTaskListCursor(createdAtMs: number, taskId: string): string {
  const base64 = globalThis.btoa(
    `${toIsoTimestamp(createdAtMs)}${TASK_LIST_CURSOR_DELIMITER}${taskId}`,
  );
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeTaskListCursor(raw: string): {
  readonly createdAtMs: number;
  readonly taskId: string;
} {
  if (!TASK_LIST_CURSOR_REGEX.test(raw) || raw.length % 4 === 1) {
    throw new DomainError('INVALID_ARGUMENT', 'after cursor is malformed');
  }
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;
  let decoded: string;
  try {
    decoded = globalThis.atob(`${base64}${'='.repeat(paddingLength)}`);
  } catch {
    throw new DomainError('INVALID_ARGUMENT', 'after cursor is malformed');
  }
  const parts = decoded.split(TASK_LIST_CURSOR_DELIMITER);
  if (parts.length !== 2) {
    throw new DomainError('INVALID_ARGUMENT', 'after cursor is malformed');
  }
  const [isoTs, rawId] = parts;
  const parsedMs = Date.parse(isoTs ?? '');
  const parsedId = v2TaskIdSchema.safeParse(rawId);
  if (!Number.isFinite(parsedMs) || !parsedId.success) {
    throw new DomainError('INVALID_ARGUMENT', 'after cursor is malformed');
  }
  return { createdAtMs: parsedMs, taskId: parsedId.data };
}

function toTaskSummaryDto(row: TaskRow, agentId: string): B1TaskDetailDto {
  return {
    task_id: row.id,
    agent_id: agentId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    current_run_id: row.current_run_id,
    attempt_count: row.attempt_count,
    cancel_requested: row.cancel_requested_at_ms !== null,
    created_at: toIsoTimestamp(row.created_at_ms),
    updated_at: toIsoTimestamp(row.updated_at_ms),
    deadline_at: row.deadline_at_ms === null ? null : toIsoTimestamp(row.deadline_at_ms),
  };
}

function parseSafeTaskEventPayload(rawJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const validated = TaskEventPayloadSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data as Record<string, unknown>;
    }
  } catch {
    // Fall back to empty allowlisted payload when an internal event has non-public keys.
  }
  return {};
}

export type AgentHeadTaskArtifactServiceDeps = CoverageHelperDeps & {
  readonly storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>;
  readonly eventCoordinator: EventRuntimeCoordinatorPort;
  readonly nowMs: () => number;
  readonly newId: () => string;
};

/**
 * V2 AgentHeadDO service for bounded `python.agent` task submission, B1-compatible
 * task inspection/cancellation, and B3-compatible staged uploads & downloadable artifacts.
 */
export class AgentHeadTaskArtifactService {
  constructor(private readonly deps: AgentHeadTaskArtifactServiceDeps) {}

  private get sql(): SqlStorageLike {
    return this.deps.storage.sql;
  }

  async execute(cmd: TaskArtifactCommand): Promise<TaskArtifactResponse> {
    assertHeadScopeSync(this.sql, cmd.tenantId, cmd.agentId);

    switch (cmd.kind) {
      case 'stage_upload':
        return this.stageUpload(cmd);
      case 'submit_python_task':
        return this.submitPythonTask(cmd);
      case 'list_tasks':
        return this.listTasksSync(cmd);
      case 'get_task':
        return this.getTaskSync(cmd.agentId, cmd.taskId);
      case 'list_task_events':
        return this.listTaskEventsSync(cmd.taskId, cmd.after);
      case 'get_task_result':
        return this.getTaskResultSync(cmd.taskId);
      case 'cancel_task':
        return this.cancelTask(cmd);
      case 'list_task_artifacts':
        return this.listTaskArtifactsSync(cmd.tenantId, cmd.principalId, cmd.taskId);
      case 'download_artifact':
        return this.downloadArtifact(cmd.tenantId, cmd.principalId, cmd.artifactId);
      case 'load_task_inputs':
        return this.loadTaskInputs(cmd);
      case 'publish_task_outputs':
        return this.publishTaskOutputs(cmd);
    }
  }

  private async stageUpload(
    cmd: Extract<TaskArtifactCommand, { kind: 'stage_upload' }>,
  ): Promise<B3StagedUploadReceiptDto> {
    const parsed = v2StageUploadInputSchema.safeParse({
      filename: cmd.filename,
      mediaType: cmd.mediaType,
      contentBase64: cmd.contentBase64,
    });
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid staged upload payload');
    }

    const bytes = decodeBase64Strict(parsed.data.contentBase64);
    if (bytes.byteLength > V2_MAX_INLINE_ARTIFACT_BYTES) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `uploaded file exceeds ${V2_MAX_INLINE_ARTIFACT_BYTES} byte V2 inline limit`,
      );
    }

    const sha256 = await sha256BytesHex(bytes);
    const now = this.deps.nowMs();
    const uploadId = this.deps.newId();
    const normalizedB64 = parsed.data.contentBase64.replace(/\s+/g, '');
    const expiryCutoffMs = now - PYTHON_AGENT_LIMITS.maxUploadTtlMs;

    return this.deps.storage.transactionSync(() => {
      // Lazily prune expired unbound uploads before enforcing quota; never touch bound inputs.
      this.sql.exec(
        `DELETE FROM v2_task_artifacts
          WHERE tenant_id = ? AND principal_id = ? AND task_id IS NULL AND created_at_ms <= ?`,
        cmd.tenantId,
        cmd.principalId,
        expiryCutoffMs,
      );

      const unboundRow = sqlExecMaybe<{ readonly cnt: number }>(
        this.sql,
        `SELECT COUNT(*) AS cnt
           FROM v2_task_artifacts
          WHERE tenant_id = ? AND principal_id = ? AND task_id IS NULL`,
        cmd.tenantId,
        cmd.principalId,
      );
      if ((unboundRow?.cnt ?? 0) >= PYTHON_AGENT_LIMITS.maxUnboundUploadsPerUser) {
        throw new DomainError('BUDGET_EXCEEDED', 'too many unbound staged uploads');
      }

      this.sql.exec(
        `INSERT INTO v2_task_artifacts (
          id, tenant_id, principal_id, task_id, run_id, committed, created_by,
          filename, media_type, size_bytes, sha256, content_b64, created_at_ms
        ) VALUES (?, ?, ?, NULL, NULL, 1, 'user', ?, ?, ?, ?, ?, ?)`,
        uploadId,
        cmd.tenantId,
        cmd.principalId,
        parsed.data.filename,
        parsed.data.mediaType,
        bytes.byteLength,
        sha256,
        normalizedB64,
        now,
      );

      return {
        upload_id: uploadId,
        filename: parsed.data.filename,
        media_type: parsed.data.mediaType,
        size: bytes.byteLength,
        sha256,
        expires_at: toIsoTimestamp(now + PYTHON_AGENT_LIMITS.maxUploadTtlMs),
        created_at: toIsoTimestamp(now),
      };
    });
  }

  private async submitPythonTask(
    cmd: Extract<TaskArtifactCommand, { kind: 'submit_python_task' }>,
  ): Promise<V2PythonTaskSubmitResultDto> {
    const parsed = submitPythonTaskRequestSchema.safeParse(cmd.input);
    if (!parsed.success) {
      throw new DomainError('INVALID_ARGUMENT', 'invalid python task submission');
    }

    const input = parsed.data;
    const clientRequestId = input.client_request_id ?? this.deps.newId();
    const idempotencyKey = `${PYTHON_TASK_IDEMPOTENCY_PREFIX}${cmd.principalId}:${clientRequestId}`;
    const attachmentIds = input.attachment_ids ?? [];
    const canonicalInput = {
      prompt: input.prompt,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(attachmentIds.length === 0 ? {} : { attachment_ids: attachmentIds }),
    };
    const inputJson = JSON.stringify(canonicalInput);
    const digest = await sha256Hex(
      JSON.stringify([
        input.title ?? null,
        input.prompt,
        input.instructions ?? null,
        attachmentIds,
      ]),
    );

    const coverage = await prepareObligationCoverageAsync(this.deps, {
      tenantId: cmd.tenantId,
      agentId: cmd.agentId,
      shouldCoverSync: () => true,
    });

    const tx = this.deps.storage.transactionSync(() => {
      const now = this.deps.nowMs();
      const expiryCutoffMs = now - PYTHON_AGENT_LIMITS.maxUploadTtlMs;
      const existing = sqlExecMaybe<TaskRow>(
        this.sql,
        'SELECT * FROM tasks WHERE idempotency_key = ?',
        idempotencyKey,
      );
      if (existing !== null) {
        if (existing.digest !== digest) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'client_request_id reused with different input',
          );
        }
        return {
          result: { task: toTaskSummaryDto(existing, cmd.agentId), created: false },
          now,
          alarmAtMs: null as number | null,
        };
      }

      confirmOrVerifyCoverageInTxSync(
        this.deps,
        coverage,
        now + V2_TIMING_LIMITS.d1RecoveryGraceMs,
        now,
        'python task recovery coverage unavailable',
      );

      // Verify all referenced uploads belong to this account, are unbound, and have not expired.
      let totalAttachmentBytes = 0;
      for (const uploadId of attachmentIds) {
        const upload = sqlExecMaybe<
          Pick<V2TaskArtifactRow, 'id' | 'task_id' | 'size_bytes' | 'created_at_ms'>
        >(
          this.sql,
          `SELECT id, task_id, size_bytes, created_at_ms
             FROM v2_task_artifacts
            WHERE id = ? AND tenant_id = ? AND principal_id = ?`,
          uploadId,
          cmd.tenantId,
          cmd.principalId,
        );
        if (upload === null || upload.task_id !== null || upload.created_at_ms <= expiryCutoffMs) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'attachment_id is missing, expired, or already bound',
          );
        }
        totalAttachmentBytes += upload.size_bytes;
      }
      if (totalAttachmentBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
        throw new DomainError('INVALID_ARGUMENT', 'attachments exceed task file budget');
      }

      const taskId = this.deps.newId();
      const deadlineAtMs = now + DEFAULT_PYTHON_TASK_DEADLINE_MS;
      const title = input.title ?? 'Data analysis task';
      let linkedMessageId: string | null = null;

      // Link a `task_reference` card into the main conversation if initialized so iOS surfaces it.
      const conversation = getMainConversationSync(this.sql);
      if (conversation !== null) {
        const nextSequence = conversation.last_sequence + 1;
        linkedMessageId = this.deps.newId();
        this.sql.exec(
          `UPDATE conversations SET last_sequence = ?, updated_at_ms = ? WHERE id = ?`,
          nextSequence,
          now,
          conversation.id,
        );
        this.sql.exec(
          `INSERT INTO conversation_messages (
            id, conversation_id, sequence, kind, task_id, created_at_ms
          ) VALUES (?, ?, ?, 'task_reference', ?, ?)`,
          linkedMessageId,
          conversation.id,
          nextSequence,
          taskId,
          now,
        );
      }

      this.sql.exec(
        `INSERT INTO tasks (
          id, kind, title, input_json, digest, idempotency_key,
          status, execution_path, execution_target, attempt_count, max_attempts,
          lease_epoch, next_run_at_ms, deadline_at_ms, linked_message_id,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'python.agent', ?, ?, ?, ?, 'queued', 'heavy', 'cloud', 0, 3, 0, ?, ?, ?, ?, ?)`,
        taskId,
        title,
        inputJson,
        digest,
        idempotencyKey,
        now,
        deadlineAtMs,
        linkedMessageId,
        now,
        now,
      );

      for (const uploadId of attachmentIds) {
        this.sql.exec(
          `UPDATE v2_task_artifacts
              SET task_id = ?
            WHERE id = ? AND tenant_id = ? AND principal_id = ? AND task_id IS NULL`,
          taskId,
          uploadId,
          cmd.tenantId,
          cmd.principalId,
        );
      }

      appendTaskEventSync(this.sql, {
        id: this.deps.newId(),
        taskId,
        phase: 'accepted',
        traceId: this.deps.newId(),
        nowMs: now,
        payload: {
          taskKind: 'python.agent',
          route: 'heavy',
          toStatus: 'queued',
        },
      });

      const outboxId = `task:${taskId}:epoch:0`;
      const envelope: V2DispatchEnvelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: cmd.tenantId,
        agentId: cmd.agentId,
        entityKind: 'task',
        entityId: taskId,
        queueName: 'agent_task',
        fenceEpoch: 0,
      };
      this.deps.eventCoordinator.enqueueDurableOutboxSync({
        outboxId,
        queueName: 'agent_task',
        entityKind: 'task',
        entityId: taskId,
        fenceEpoch: 0,
        payloadJson: JSON.stringify(envelope),
        nextAttemptAtMs: now,
      });

      const inserted = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', taskId)!;
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(now);
      return {
        result: { task: toTaskSummaryDto(inserted, cmd.agentId), created: true },
        now,
        alarmAtMs,
      };
    });

    if (tx.alarmAtMs !== null) {
      await this.deps.recoveryHooks.syncPlatformAlarm?.(tx.alarmAtMs, tx.now);
    }

    return tx.result;
  }

  private listTasksSync(cmd: Extract<TaskArtifactCommand, { kind: 'list_tasks' }>): B1TaskListDto {
    const limit = Math.max(1, Math.min(50, cmd.limit ?? 20));
    const cursor = cmd.after === undefined ? undefined : decodeTaskListCursor(cmd.after);

    let rows: readonly TaskRow[];
    if (cmd.status !== undefined && cursor !== undefined) {
      rows = sqlExecAll<TaskRow>(
        this.sql,
        `SELECT * FROM tasks
          WHERE status = ?
            AND (created_at_ms < ? OR (created_at_ms = ? AND id < ?))
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ?`,
        cmd.status,
        cursor.createdAtMs,
        cursor.createdAtMs,
        cursor.taskId,
        limit + 1,
      );
    } else if (cmd.status !== undefined) {
      rows = sqlExecAll<TaskRow>(
        this.sql,
        `SELECT * FROM tasks
          WHERE status = ?
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ?`,
        cmd.status,
        limit + 1,
      );
    } else if (cursor !== undefined) {
      rows = sqlExecAll<TaskRow>(
        this.sql,
        `SELECT * FROM tasks
          WHERE created_at_ms < ? OR (created_at_ms = ? AND id < ?)
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ?`,
        cursor.createdAtMs,
        cursor.createdAtMs,
        cursor.taskId,
        limit + 1,
      );
    } else {
      rows = sqlExecAll<TaskRow>(
        this.sql,
        `SELECT * FROM tasks ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        limit + 1,
      );
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    return {
      tasks: pageRows.map((row) => toTaskSummaryDto(row, cmd.agentId)),
      next_after:
        hasMore && lastRow !== undefined
          ? encodeTaskListCursor(lastRow.created_at_ms, lastRow.id)
          : null,
      has_more: hasMore,
    };
  }

  private getTaskSync(agentId: string, taskId: string): B1TaskDetailDto | null {
    const parsedId = v2TaskIdSchema.safeParse(taskId);
    if (!parsedId.success) return null;
    const row = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', parsedId.data);
    return row === null ? null : toTaskSummaryDto(row, agentId);
  }

  private listTaskEventsSync(taskId: string, after = 0): B1TaskEventPageDto | null {
    const parsedId = v2TaskIdSchema.safeParse(taskId);
    if (!parsedId.success) return null;
    const task = sqlExecMaybe<Pick<TaskRow, 'id'>>(
      this.sql,
      'SELECT id FROM tasks WHERE id = ?',
      parsedId.data,
    );
    if (task === null) return null;

    const rows = sqlExecAll<TaskEventRow>(
      this.sql,
      `SELECT *
         FROM task_events
        WHERE task_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT 100`,
      parsedId.data,
      Math.max(0, Math.trunc(after)),
    );

    return {
      task_id: parsedId.data,
      events: rows.map((row) => ({
        task_id: row.task_id,
        sequence: row.sequence,
        phase: row.phase,
        occurred_at: toIsoTimestamp(row.occurred_at_ms),
        trace_id: row.trace_id,
        payload: parseSafeTaskEventPayload(row.payload_json),
      })),
    };
  }

  private getTaskResultSync(taskId: string): B1TaskResultDto | null {
    const parsedId = v2TaskIdSchema.safeParse(taskId);
    if (!parsedId.success) return null;
    const task = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', parsedId.data);
    if (task === null) return null;

    if (!isTerminalTaskStatus(task.status)) {
      return {
        task_id: task.id,
        task_status: task.status,
        result_state: 'pending',
        result: null,
      };
    }

    const row = sqlExecMaybe<TaskResultRow>(
      this.sql,
      'SELECT * FROM task_results WHERE task_id = ?',
      task.id,
    );
    if (
      row === null ||
      row.summary_text === null ||
      row.summary_text.trim().length === 0 ||
      row.detail_text === null ||
      row.detail_text.trim().length === 0
    ) {
      return {
        task_id: task.id,
        task_status: task.status,
        result_state: 'unavailable',
        result: null,
      };
    }

    return {
      task_id: task.id,
      task_status: task.status,
      result_state: 'available',
      result: {
        summary_text: row.summary_text,
        detail_text: row.detail_text,
        model_label: row.model_label,
        simulated: row.simulated === 1,
        produced_at: toIsoTimestamp(row.produced_at_ms),
      },
    };
  }

  private async cancelTask(
    cmd: Extract<TaskArtifactCommand, { kind: 'cancel_task' }>,
  ): Promise<B1TaskCancelDto | null> {
    const parsedId = v2TaskIdSchema.safeParse(cmd.taskId);
    if (!parsedId.success) return null;

    const tx = this.deps.storage.transactionSync(() => {
      const now = this.deps.nowMs();
      const task = sqlExecMaybe<TaskRow>(
        this.sql,
        'SELECT * FROM tasks WHERE id = ?',
        parsedId.data,
      );
      if (task === null) {
        return { result: null as B1TaskCancelDto | null, now, alarmAtMs: null as number | null };
      }

      if (isTerminalTaskStatus(task.status)) {
        return {
          result: {
            task_id: task.id,
            status: task.status,
            cancel_requested: task.cancel_requested_at_ms !== null,
            cancel_requested_at:
              task.cancel_requested_at_ms === null
                ? null
                : toIsoTimestamp(task.cancel_requested_at_ms),
            terminal: true,
            updated_at: toIsoTimestamp(task.updated_at_ms),
          },
          now,
          alarmAtMs: null as number | null,
        };
      }

      const cancelAt = task.cancel_requested_at_ms ?? now;
      if (task.status === 'queued' || task.status === 'retryable_failed') {
        this.sql.exec(
          `UPDATE tasks
              SET status = 'cancelled',
                  cancel_requested_at_ms = ?,
                  lease_expires_at_ms = NULL,
                  updated_at_ms = ?
            WHERE id = ?`,
          cancelAt,
          now,
          task.id,
        );
        this.sql.exec(
          `DELETE FROM v2_task_artifacts
            WHERE task_id = ? AND created_by = 'run' AND committed = 0`,
          task.id,
        );
        this.deps.eventCoordinator.cancelEntityOutboxSync('task', task.id, now);
        appendTaskEventSync(this.sql, {
          id: this.deps.newId(),
          taskId: task.id,
          phase: 'cancelled',
          traceId: this.deps.newId(),
          nowMs: now,
          payload: { fromStatus: task.status, toStatus: 'cancelled', cancelRequested: true },
        });
      } else {
        this.sql.exec(
          `UPDATE tasks
              SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?),
                  updated_at_ms = ?
            WHERE id = ?`,
          cancelAt,
          now,
          task.id,
        );
        this.sql.exec(
          `DELETE FROM v2_task_artifacts
            WHERE task_id = ? AND created_by = 'run' AND committed = 0`,
          task.id,
        );
      }

      const updated = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', task.id)!;
      const alarmAtMs = this.deps.eventCoordinator.recomputeAlarmSync(now);
      return {
        result: {
          task_id: updated.id,
          status: updated.status,
          cancel_requested: true,
          cancel_requested_at: toIsoTimestamp(updated.cancel_requested_at_ms ?? cancelAt),
          terminal: isTerminalTaskStatus(updated.status),
          updated_at: toIsoTimestamp(updated.updated_at_ms),
        },
        now,
        alarmAtMs,
      };
    });

    if (tx.alarmAtMs !== null) {
      await this.deps.recoveryHooks.syncPlatformAlarm?.(tx.alarmAtMs, tx.now);
    }
    return tx.result;
  }

  private listTaskArtifactsSync(
    tenantId: string,
    principalId: string,
    taskId: string,
  ): B3TaskArtifactsListDto | null {
    const parsedId = v2TaskIdSchema.safeParse(taskId);
    if (!parsedId.success) return null;
    const task = sqlExecMaybe<Pick<TaskRow, 'id'>>(
      this.sql,
      'SELECT id FROM tasks WHERE id = ?',
      parsedId.data,
    );
    if (task === null) return null;

    // Only expose committed artifacts (bound user uploads + winning committed run outputs).
    const rows = sqlExecAll<
      Pick<
        V2TaskArtifactRow,
        'id' | 'filename' | 'media_type' | 'size_bytes' | 'sha256' | 'created_by' | 'created_at_ms'
      >
    >(
      this.sql,
      `SELECT id, filename, media_type, size_bytes, sha256, created_by, created_at_ms
         FROM v2_task_artifacts
        WHERE tenant_id = ? AND principal_id = ? AND task_id = ? AND committed = 1
        ORDER BY created_at_ms ASC, id ASC`,
      tenantId,
      principalId,
      parsedId.data,
    );

    return {
      task_id: parsedId.data,
      artifacts: rows.map((row) => ({
        artifact_id: row.id,
        filename: row.filename,
        media_type: row.media_type,
        size: row.size_bytes,
        sha256: row.sha256,
        created_by: row.created_by,
        created_at: toIsoTimestamp(row.created_at_ms),
      })),
    };
  }

  private async downloadArtifact(
    tenantId: string,
    principalId: string,
    artifactId: string,
  ): Promise<V2TaskArtifactDownloadDto | null> {
    const parsedId = v2TaskIdSchema.safeParse(artifactId);
    if (!parsedId.success) return null;
    const row = sqlExecMaybe<V2TaskArtifactRow>(
      this.sql,
      `SELECT *
         FROM v2_task_artifacts
        WHERE id = ? AND tenant_id = ? AND principal_id = ?
          AND task_id IS NOT NULL AND committed = 1`,
      parsedId.data,
      tenantId,
      principalId,
    );
    if (row === null) return null;

    const bytes = decodeBase64Strict(row.content_b64);
    const verifiedSha = await sha256BytesHex(bytes);
    if (verifiedSha !== row.sha256 || bytes.byteLength !== row.size_bytes) {
      throw new DomainError('DB_UNAVAILABLE', 'persisted artifact integrity check failed');
    }

    return {
      artifactId: row.id,
      filename: row.filename,
      mediaType: row.media_type,
      sha256: row.sha256,
      size: row.size_bytes,
      contentBase64: row.content_b64,
    };
  }

  private async loadTaskInputs(
    cmd: Extract<TaskArtifactCommand, { kind: 'load_task_inputs' }>,
  ): Promise<readonly V2TaskInputFileDto[]> {
    const now = this.deps.nowMs();
    const task = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', cmd.taskId);
    const run = task === null ? null : getLatestRunForTaskSync(this.sql, task.id);
    if (
      task === null ||
      run === null ||
      run.id !== cmd.runId ||
      !hasLiveTaskLease(task, run, now, {
        leaseEpoch: cmd.leaseEpoch,
        workerId: cmd.workerId,
        executorKind: 'queue_worker',
      })
    ) {
      throw new DomainError('STALE_LEASE', 'task lease fence rejected input load');
    }

    const rows = sqlExecAll<V2TaskArtifactRow>(
      this.sql,
      `SELECT *
         FROM v2_task_artifacts
        WHERE tenant_id = ? AND task_id = ? AND created_by = 'user' AND committed = 1
        ORDER BY created_at_ms ASC, id ASC`,
      cmd.tenantId,
      cmd.taskId,
    );

    const verified: V2TaskInputFileDto[] = [];
    for (const row of rows) {
      const bytes = decodeBase64Strict(row.content_b64);
      const actualSha = await sha256BytesHex(bytes);
      if (bytes.byteLength !== row.size_bytes || actualSha !== row.sha256) {
        throw new DomainError('DB_UNAVAILABLE', 'persisted input artifact integrity check failed');
      }
      verified.push({
        artifactId: row.id,
        filename: row.filename,
        mediaType: row.media_type,
        size: row.size_bytes,
        sha256: row.sha256,
        contentBase64: row.content_b64,
      });
    }

    return verified;
  }

  private async publishTaskOutputs(
    cmd: Extract<TaskArtifactCommand, { kind: 'publish_task_outputs' }>,
  ): Promise<V2PublishTaskOutputsResultDto> {
    if (cmd.outputs.length > PYTHON_AGENT_LIMITS.maxOutputArtifactsPerTask) {
      throw new DomainError('POLICY_DENIED', 'too many output artifacts');
    }

    const prepared: Array<{
      readonly filename: string;
      readonly mediaType: string;
      readonly size: number;
      readonly sha256: string;
      readonly contentBase64: string;
    }> = [];
    let totalOutputBytes = 0;

    for (const output of cmd.outputs) {
      if (!isSafeArtifactFilename(output.filename)) {
        throw new DomainError('POLICY_DENIED', 'invalid output artifact filename');
      }
      const parsed = v2StageUploadInputSchema.safeParse(output);
      if (!parsed.success) {
        throw new DomainError('POLICY_DENIED', 'invalid output artifact metadata');
      }
      const bytes = decodeBase64Strict(parsed.data.contentBase64);
      if (bytes.byteLength > V2_MAX_INLINE_ARTIFACT_BYTES) {
        throw new DomainError('POLICY_DENIED', 'output artifact exceeds V2 inline limit');
      }
      totalOutputBytes += bytes.byteLength;
      const sha256 = await sha256BytesHex(bytes);
      prepared.push({
        filename: parsed.data.filename,
        mediaType: parsed.data.mediaType,
        size: bytes.byteLength,
        sha256,
        contentBase64: parsed.data.contentBase64.replace(/\s+/g, ''),
      });
    }

    return this.deps.storage.transactionSync(() => {
      const now = this.deps.nowMs();
      const task = sqlExecMaybe<TaskRow>(this.sql, 'SELECT * FROM tasks WHERE id = ?', cmd.taskId);
      const run = task === null ? null : getLatestRunForTaskSync(this.sql, task.id);
      if (
        task === null ||
        run === null ||
        run.id !== cmd.runId ||
        !hasLiveTaskLease(task, run, now, {
          leaseEpoch: cmd.leaseEpoch,
          workerId: cmd.workerId,
          executorKind: 'queue_worker',
        })
      ) {
        return { accepted: false, artifactIds: [] };
      }

      // Enforce aggregate per-task file budget (bound inputs + staged outputs for this run).
      const inputBytesRow = sqlExecMaybe<{ readonly total: number | null }>(
        this.sql,
        `SELECT SUM(size_bytes) AS total
           FROM v2_task_artifacts
          WHERE tenant_id = ? AND task_id = ? AND created_by = 'user' AND committed = 1`,
        cmd.tenantId,
        task.id,
      );
      const inputBytes = inputBytesRow?.total ?? 0;
      if (inputBytes + totalOutputBytes > PYTHON_AGENT_LIMITS.maxTaskTotalFileBytes) {
        throw new DomainError('POLICY_DENIED', 'task file budget exceeded');
      }

      // Resolve owning principal from bound input artifacts or idempotency key.
      const boundInput = sqlExecMaybe<{ readonly principal_id: string }>(
        this.sql,
        `SELECT principal_id FROM v2_task_artifacts WHERE task_id = ? AND created_by = 'user' LIMIT 1`,
        task.id,
      );
      const keyParts = task.idempotency_key.startsWith(PYTHON_TASK_IDEMPOTENCY_PREFIX)
        ? task.idempotency_key.slice(PYTHON_TASK_IDEMPOTENCY_PREFIX.length).split(':')
        : [];
      const ownerPrincipalId = boundInput?.principal_id ?? keyParts[0] ?? cmd.principalId;

      // Replace any prior uncommitted staging rows for this specific run (idempotent re-stage).
      // Rows stay `committed = 0` until `commitDurableResult` atomically commits this winning run.
      this.sql.exec(
        `DELETE FROM v2_task_artifacts
          WHERE tenant_id = ? AND task_id = ? AND created_by = 'run' AND run_id = ? AND committed = 0`,
        cmd.tenantId,
        task.id,
        run.id,
      );

      const artifactIds: string[] = [];
      for (const item of prepared) {
        const artifactId = this.deps.newId();
        this.sql.exec(
          `INSERT INTO v2_task_artifacts (
            id, tenant_id, principal_id, task_id, run_id, committed, created_by,
            filename, media_type, size_bytes, sha256, content_b64, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, 0, 'run', ?, ?, ?, ?, ?, ?)`,
          artifactId,
          cmd.tenantId,
          ownerPrincipalId,
          task.id,
          run.id,
          item.filename,
          item.mediaType,
          item.size,
          item.sha256,
          item.contentBase64,
          now,
        );
        artifactIds.push(artifactId);
        appendTaskEventSync(this.sql, {
          id: this.deps.newId(),
          taskId: task.id,
          phase: 'progress',
          traceId: this.deps.newId(),
          nowMs: now,
          payload: {
            taskKind: task.kind,
            runId: run.id,
            attempt: run.attempt,
            artifactId,
            simulated: true,
          },
        });
      }

      return { accepted: true, artifactIds };
    });
  }
}
