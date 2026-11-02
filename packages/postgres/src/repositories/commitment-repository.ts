import { createHash, randomUUID } from 'node:crypto';
import type {
  AppendOutcomeCommand,
  CommitmentDto,
  CommitmentOutcomeDto,
  CommitmentRepository,
  CommitmentStatus,
  CreateCommitmentCommand,
  DueCommitment,
  DueCommitmentStore,
  ListCommitmentsOptions,
  ListOutcomesOptions,
  OutcomeResultStatus,
  ReservedSlot,
  ScheduleKind,
  StalledPendingOccurrence,
  StateTransitionOptions,
  WorkerLeaseGrant,
} from '@ember/contracts';
import { deriveTaskCreationIdempotencyKey } from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import type pg from 'pg';
import { asDomainError, toIsoTimestamp, withTransaction } from './support.js';

interface CommitmentRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  title: string;
  status: string;
  schedule_kind: string;
  interval_seconds: number | null;
  next_due_at: Date | string | null;
  source_profile_id: string;
  version: number;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OutcomeRow {
  id: string;
  tenant_id: string;
  commitment_id: string;
  occurrence_id: string;
  task_id: string;
  summary: string;
  result_status: string;
  created_at: Date | string;
}

interface StalledOccurrenceRow {
  id: string;
  tenant_id: string;
  commitment_id: string;
  scheduled_for: Date | string;
  created_at: Date | string;
  agent_id: string;
  source_profile_id: string;
  schedule_kind: string;
  interval_seconds: number | null;
}

const COMMITMENT_COLUMNS = `
  id, tenant_id, agent_id, title, status, schedule_kind, interval_seconds,
  next_due_at, source_profile_id, version, idempotency_key, request_fingerprint,
  created_at, updated_at
`;

const OUTCOME_COLUMNS = `
  id, tenant_id, commitment_id, occurrence_id, task_id, summary,
  result_status, created_at
`;

function mapCommitmentRow(row: CommitmentRow): CommitmentDto {
  return {
    commitment_id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    title: row.title,
    status: row.status as CommitmentStatus,
    schedule_kind: row.schedule_kind as ScheduleKind,
    interval_seconds: row.interval_seconds,
    next_due_at: row.next_due_at ? toIsoTimestamp(row.next_due_at) : null,
    source_profile_id: row.source_profile_id,
    version: row.version,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

function mapOutcomeRow(row: OutcomeRow): CommitmentOutcomeDto {
  return {
    outcome_id: row.id,
    commitment_id: row.commitment_id,
    occurrence_id: row.occurrence_id,
    task_id: row.task_id,
    summary: row.summary,
    result_status: row.result_status as OutcomeResultStatus,
    created_at: toIsoTimestamp(row.created_at),
  };
}

function computeCommitmentFingerprint(cmd: CreateCommitmentCommand): string {
  const canonical = {
    agentId: cmd.agentId,
    title: cmd.title,
    scheduleKind: cmd.scheduleKind,
    intervalSeconds: cmd.intervalSeconds ?? null,
    dueAt: cmd.dueAt ? cmd.dueAt.toISOString() : null,
    sourceProfileId: cmd.sourceProfileId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

interface CursorData {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: Date | string, id: string): string {
  const data: CursorData = {
    createdAt: toIsoTimestamp(createdAt),
    id,
  };
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorData | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as { createdAt: unknown }).createdAt === 'string' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      return parsed as CursorData;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class PostgresCommitmentRepository implements CommitmentRepository, DueCommitmentStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(
    ctx: AuthContext,
    cmd: CreateCommitmentCommand,
  ): Promise<{ readonly commitment: CommitmentDto; readonly replayed: boolean }> {
    const fingerprint = computeCommitmentFingerprint(cmd);
    const commitmentId = randomUUID();
    // `null` defers the initial due instant to PostgreSQL's `clock_timestamp()`; the
    // application clock is never the scheduling authority.
    const initialDueAt = cmd.dueAt ? cmd.dueAt.toISOString() : null;

    const insertSql = `
      INSERT INTO commitments (
        id, tenant_id, agent_id, title, status, schedule_kind, interval_seconds,
        next_due_at, source_profile_id, version, idempotency_key, request_fingerprint,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, 'active', $5, $6, COALESCE($7::timestamptz, clock_timestamp()), $8, 1, $9, $10, clock_timestamp(), clock_timestamp())
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING ${COMMITMENT_COLUMNS}
    `;

    try {
      const result = await this.pool.query<CommitmentRow>(insertSql, [
        commitmentId,
        ctx.tenantId,
        cmd.agentId,
        cmd.title,
        cmd.scheduleKind,
        cmd.intervalSeconds ?? null,
        initialDueAt,
        cmd.sourceProfileId,
        cmd.idempotencyKey,
        fingerprint,
      ]);

      const insertedRow = result.rows[0];
      if (insertedRow !== undefined) {
        return {
          commitment: mapCommitmentRow(insertedRow),
          replayed: false,
        };
      }

      // Conflict occurred: fetch existing row for this idempotency key
      const selectSql = `
        SELECT ${COMMITMENT_COLUMNS}
        FROM commitments
        WHERE tenant_id = $1 AND idempotency_key = $2
      `;
      const existing = await this.pool.query<CommitmentRow>(selectSql, [
        ctx.tenantId,
        cmd.idempotencyKey,
      ]);

      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'Idempotency conflict reconciliation failed');
      }

      if (existingRow.request_fingerprint === fingerprint) {
        return {
          commitment: mapCommitmentRow(existingRow),
          replayed: true,
        };
      }

      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key conflicts with an existing commitment',
      );
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async get(ctx: AuthContext, commitmentId: Id): Promise<CommitmentDto | null> {
    const sql = `
      SELECT ${COMMITMENT_COLUMNS}
      FROM commitments
      WHERE tenant_id = $1 AND id = $2
    `;

    try {
      const result = await this.pool.query<CommitmentRow>(sql, [ctx.tenantId, commitmentId]);
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return mapCommitmentRow(row);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async list(
    ctx: AuthContext,
    options?: ListCommitmentsOptions,
  ): Promise<{ readonly commitments: readonly CommitmentDto[]; readonly nextCursor?: string }> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const cursor = decodeCursor(options?.cursor);

    const conditions: string[] = ['tenant_id = $1'];
    const values: unknown[] = [ctx.tenantId];
    let paramIndex = 2;

    if (options?.status !== undefined) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }

    if (cursor !== undefined) {
      conditions.push(`(created_at, id) < ($${paramIndex++}, $${paramIndex++})`);
      values.push(cursor.createdAt, cursor.id);
    }

    values.push(limit + 1);
    const limitParamIndex = paramIndex;

    const sql = `
      SELECT ${COMMITMENT_COLUMNS}
      FROM commitments
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParamIndex}
    `;

    try {
      const result = await this.pool.query<CommitmentRow>(sql, values);
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const commitments = rows.map(mapCommitmentRow);
      let nextCursor: string | undefined;

      if (hasMore) {
        const lastRow = rows[rows.length - 1];
        if (lastRow !== undefined) {
          nextCursor = encodeCursor(lastRow.created_at, lastRow.id);
        }
      }

      return { commitments, nextCursor };
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async pause(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    return withTransaction(this.pool, async (client) => {
      const selectSql = `
        SELECT ${COMMITMENT_COLUMNS}
        FROM commitments
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const res = await client.query<CommitmentRow>(selectSql, [ctx.tenantId, commitmentId]);
      const row = res.rows[0];
      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'Commitment not found');
      }

      if (options?.expectedVersion !== undefined && row.version !== options.expectedVersion) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Commitment version conflict (CAS mismatch)',
        );
      }

      if (row.status === 'paused') {
        return mapCommitmentRow(row);
      }

      if (row.status === 'completed' || row.status === 'cancelled') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `Cannot pause a commitment in '${row.status}' status`,
        );
      }

      const updateSql = `
        UPDATE commitments
        SET status = 'paused', version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COMMITMENT_COLUMNS}
      `;
      const updateRes = await client.query<CommitmentRow>(updateSql, [ctx.tenantId, commitmentId]);
      const updatedRow = updateRes.rows[0];
      if (updatedRow === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'Failed to update commitment status');
      }
      return mapCommitmentRow(updatedRow);
    });
  }

  async resume(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    return withTransaction(this.pool, async (client) => {
      const selectSql = `
        SELECT ${COMMITMENT_COLUMNS}
        FROM commitments
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const res = await client.query<CommitmentRow>(selectSql, [ctx.tenantId, commitmentId]);
      const row = res.rows[0];
      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'Commitment not found');
      }

      if (options?.expectedVersion !== undefined && row.version !== options.expectedVersion) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Commitment version conflict (CAS mismatch)',
        );
      }

      if (row.status === 'active') {
        return mapCommitmentRow(row);
      }

      if (row.status === 'completed' || row.status === 'cancelled') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `Cannot resume a commitment in '${row.status}' status`,
        );
      }

      // If next_due_at is in the past, update it to now so it is due immediately
      const updateSql = `
        UPDATE commitments
        SET status = 'active',
            next_due_at = CASE
              WHEN next_due_at IS NOT NULL AND next_due_at < clock_timestamp() THEN clock_timestamp()
              ELSE next_due_at
            END,
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COMMITMENT_COLUMNS}
      `;
      const updateRes = await client.query<CommitmentRow>(updateSql, [ctx.tenantId, commitmentId]);
      const updatedRow = updateRes.rows[0];
      if (updatedRow === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'Failed to update commitment status');
      }
      return mapCommitmentRow(updatedRow);
    });
  }

  async cancel(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    return withTransaction(this.pool, async (client) => {
      const selectSql = `
        SELECT ${COMMITMENT_COLUMNS}
        FROM commitments
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const res = await client.query<CommitmentRow>(selectSql, [ctx.tenantId, commitmentId]);
      const row = res.rows[0];
      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'Commitment not found');
      }

      if (options?.expectedVersion !== undefined && row.version !== options.expectedVersion) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Commitment version conflict (CAS mismatch)',
        );
      }

      if (row.status === 'cancelled') {
        return mapCommitmentRow(row);
      }

      if (row.status === 'completed') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Cannot cancel a commitment in completed status',
        );
      }

      // Cancellation is irreversible: clears next_due_at immediately
      const updateSql = `
        UPDATE commitments
        SET status = 'cancelled', next_due_at = NULL, version = version + 1, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COMMITMENT_COLUMNS}
      `;
      const updateRes = await client.query<CommitmentRow>(updateSql, [ctx.tenantId, commitmentId]);
      const updatedRow = updateRes.rows[0];
      if (updatedRow === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'Failed to update commitment status');
      }

      // Cancel any in-flight pending occurrences for this commitment
      await client.query(
        `UPDATE commitment_occurrences
         SET status = 'cancelled', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND commitment_id = $2 AND status = 'pending'`,
        [ctx.tenantId, commitmentId],
      );

      return mapCommitmentRow(updatedRow);
    });
  }

  async listOutcomes(
    ctx: AuthContext,
    commitmentId: Id,
    options?: ListOutcomesOptions,
  ): Promise<{
    readonly outcomes: readonly CommitmentOutcomeDto[];
    readonly nextCursor?: string;
  } | null> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const cursor = decodeCursor(options?.cursor);

    // Verify commitment existence and tenant isolation
    const verifySql = `SELECT id FROM commitments WHERE tenant_id = $1 AND id = $2`;
    const verifyRes = await this.pool.query(verifySql, [ctx.tenantId, commitmentId]);
    if (verifyRes.rows.length === 0) {
      return null;
    }

    const conditions: string[] = ['tenant_id = $1', 'commitment_id = $2'];
    const values: unknown[] = [ctx.tenantId, commitmentId];
    let paramIndex = 3;

    if (cursor !== undefined) {
      conditions.push(`(created_at, id) < ($${paramIndex++}, $${paramIndex++})`);
      values.push(cursor.createdAt, cursor.id);
    }

    values.push(limit + 1);
    const limitParamIndex = paramIndex;

    const sql = `
      SELECT ${OUTCOME_COLUMNS}
      FROM commitment_outcomes
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParamIndex}
    `;

    try {
      const result = await this.pool.query<OutcomeRow>(sql, values);
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const outcomes = rows.map(mapOutcomeRow);
      let nextCursor: string | undefined;

      if (hasMore) {
        const lastRow = rows[rows.length - 1];
        if (lastRow !== undefined) {
          nextCursor = encodeCursor(lastRow.created_at, lastRow.id);
        }
      }

      return { outcomes, nextCursor };
    } catch (error) {
      throw asDomainError(error);
    }
  }

  // -------------------------------------------------------------------------
  // DueCommitmentStore (Lane B Integration Interface)
  // -------------------------------------------------------------------------

  async findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const sql = `
      SELECT id, tenant_id, agent_id, title, source_profile_id, schedule_kind,
             interval_seconds, next_due_at, version
      FROM commitments
      WHERE status = 'active'
        AND next_due_at IS NOT NULL
        AND next_due_at <= ${asOfOverride ? '$1' : 'clock_timestamp()'}
      ORDER BY next_due_at ASC
      LIMIT ${asOfOverride ? '$2' : '$1'}
    `;

    const values = asOfOverride ? [asOfOverride.toISOString(), cappedLimit] : [cappedLimit];

    try {
      const result = await this.pool.query<{
        id: string;
        tenant_id: string;
        agent_id: string;
        title: string;
        source_profile_id: string;
        schedule_kind: string;
        interval_seconds: number | null;
        next_due_at: Date | string;
        version: number;
      }>(sql, values);

      return result.rows.map((row) => ({
        commitmentId: row.id,
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        title: row.title,
        sourceProfileId: row.source_profile_id,
        scheduleKind: row.schedule_kind as ScheduleKind,
        intervalSeconds: row.interval_seconds,
        nextDueAt: new Date(row.next_due_at),
        version: row.version,
      }));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async reserveOccurrence(
    commitmentId: Id,
    expectedVersion: number,
    slotTimeOverride?: Date,
  ): Promise<ReservedSlot | null> {
    return withTransaction(this.pool, async (client) => {
      // 1. Lock commitment row
      const selectSql = `
        SELECT id, tenant_id, status, schedule_kind, interval_seconds, next_due_at, version
        FROM commitments
        WHERE id = $1
        FOR UPDATE
      `;
      const res = await client.query<{
        id: string;
        tenant_id: string;
        status: string;
        schedule_kind: string;
        interval_seconds: number | null;
        next_due_at: Date | string | null;
        version: number;
      }>(selectSql, [commitmentId]);

      const row = res.rows[0];
      if (row === undefined) {
        return null;
      }

      // Verifications: must be active, version must match, next_due_at must exist
      if (row.status !== 'active' || row.version !== expectedVersion || row.next_due_at === null) {
        return null;
      }

      const scheduledForDate = slotTimeOverride ?? new Date(row.next_due_at);
      const scheduledForIso = scheduledForDate.toISOString();

      // Check slot time is due unless override was explicitly passed in tests
      if (slotTimeOverride === undefined) {
        const timeCheck = await client.query<{ is_due: boolean }>(
          `SELECT ($1::timestamptz <= clock_timestamp()) AS is_due`,
          [scheduledForIso],
        );
        const checkRow = timeCheck.rows[0];
        if (checkRow === undefined || !checkRow.is_due) {
          return null;
        }
      }

      // 2. Try to insert occurrence for (commitment_id, scheduled_for)
      const occurrenceId = randomUUID();
      const insertOccSql = `
        INSERT INTO commitment_occurrences (
          id, tenant_id, commitment_id, scheduled_for, status, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending', clock_timestamp(), clock_timestamp())
        ON CONFLICT (commitment_id, scheduled_for) DO NOTHING
        RETURNING id
      `;

      const occRes = await client.query(insertOccSql, [
        occurrenceId,
        row.tenant_id,
        commitmentId,
        scheduledForIso,
      ]);

      if (occRes.rows.length === 0) {
        // Slot was already reserved by another transaction
        return null;
      }

      // 3. Advance commitment schedule with single-period compensation
      let nextDueUpdateSql: string;
      let nextDueValues: unknown[];

      if (row.schedule_kind === 'interval' && row.interval_seconds !== null) {
        // Compensate at most one historical interval:
        // Set next_due_at to GREATEST(scheduled_for + interval, clock_timestamp() + interval)
        nextDueUpdateSql = `
          UPDATE commitments
          SET next_due_at = GREATEST(
                $2::timestamptz + ($3 || ' seconds')::interval,
                clock_timestamp() + ($3 || ' seconds')::interval
              ),
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING version
        `;
        nextDueValues = [commitmentId, scheduledForIso, row.interval_seconds];
      } else {
        // One-shot schedule: no further due time
        nextDueUpdateSql = `
          UPDATE commitments
          SET next_due_at = NULL,
              version = version + 1,
              updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING version
        `;
        nextDueValues = [commitmentId];
      }

      const updateRes = await client.query<{ version: number }>(nextDueUpdateSql, nextDueValues);
      const updateRow = updateRes.rows[0];
      if (updateRow === undefined) {
        throw new DomainError('DB_UNAVAILABLE', 'Failed to advance commitment version');
      }

      return {
        occurrenceId,
        commitmentId,
        scheduledFor: scheduledForDate,
        commitmentVersion: updateRow.version,
      };
    });
  }

  async markDispatched(occurrenceId: Id, taskId: Id): Promise<void> {
    const sql = `
      UPDATE commitment_occurrences
      SET task_id = $2, status = 'dispatched', updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'pending'
    `;

    try {
      const res = await this.pool.query(sql, [occurrenceId, taskId]);
      if ((res.rowCount ?? 0) === 0) {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Occurrence was not in pending status or does not exist',
        );
      }
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async appendOutcomeIfAbsent(
    grant: WorkerLeaseGrant,
    cmd: AppendOutcomeCommand,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      // Lock order for every commitment writer in this repository:
      //   commitments -> commitment_occurrences -> tasks -> runs
      //
      // Taking the commitment row lock FIRST serialises publication against `cancel()` and
      // `pause()` (which acquire the same lock), so a cancellation that wins the lock is
      // always observed by the publisher instead of being raced past. Task -> run matches the
      // order used by `ResultCommitter` and `PostgresLeaseQueue`, so no two writers can form a
      // wait cycle.
      //
      // 1. Lock the commitment and require it to still accept outcomes.
      const commitSql = `
        SELECT status
        FROM commitments
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const commitRes = await client.query<{ status: string }>(commitSql, [
        grant.tenantId,
        cmd.commitmentId,
      ]);

      const commitRow = commitRes.rows[0];
      if (commitRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Commitment not found');
      }

      if (commitRow.status !== 'active') {
        throw new DomainError(
          'POLICY_DENIED',
          `Cannot publish outcome for commitment in '${commitRow.status}' status`,
        );
      }

      // 2. Lock and verify occurrence
      const occSql = `
        SELECT id, status, task_id
        FROM commitment_occurrences
        WHERE tenant_id = $1 AND commitment_id = $2 AND id = $3
        FOR UPDATE
      `;
      const occRes = await client.query<{
        id: string;
        status: string;
        task_id: string | null;
      }>(occSql, [grant.tenantId, cmd.commitmentId, cmd.occurrenceId]);

      const occRow = occRes.rows[0];
      if (occRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Occurrence not found');
      }

      if (occRow.status === 'cancelled') {
        throw new DomainError('POLICY_DENIED', 'Cannot publish outcome for cancelled occurrence');
      }

      if (occRow.task_id !== grant.taskId) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Occurrence task_id does not match grant task_id',
        );
      }

      // 3. Lock the Task and require it to still be executing. A cancelled, failed or
      //    completed Task can never publish an outcome, even if its Run row still looks live.
      const taskSql = `
        SELECT status
        FROM tasks
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const taskRes = await client.query<{ status: string }>(taskSql, [
        grant.tenantId,
        grant.taskId,
      ]);

      const taskRow = taskRes.rows[0];
      if (taskRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Task not found in this tenant');
      }

      if (taskRow.status !== 'running') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `Task is in '${taskRow.status}' status and no longer executing; outcome publication is rejected`,
        );
      }

      // 4. Lock the Run and let PostgreSQL decide the whole fencing verdict. Worker ownership,
      //    the lease epoch and lease expiry are all compared in SQL; freshness uses
      //    clock_timestamp(), so a skewed application clock can neither extend nor shorten a
      //    lease.
      const leaseCheckSql = `
        SELECT
          r.status AS run_status,
          (r.worker_id = $4) AS is_worker_match,
          (r.lease_epoch = $5::bigint) AS is_epoch_match,
          (r.leased_until IS NOT NULL AND r.leased_until > clock_timestamp()) AS is_lease_active
        FROM runs r
        WHERE r.tenant_id = $1 AND r.task_id = $2 AND r.id = $3
        FOR UPDATE
      `;

      const leaseRes = await client.query<{
        run_status: string;
        is_worker_match: boolean;
        is_epoch_match: boolean;
        is_lease_active: boolean;
      }>(leaseCheckSql, [
        grant.tenantId,
        grant.taskId,
        grant.runId,
        grant.workerId,
        grant.leaseEpoch,
      ]);

      const runRow = leaseRes.rows[0];
      if (runRow === undefined) {
        throw new DomainError('STALE_LEASE', 'Task run not found or does not belong to tenant');
      }

      if (runRow.run_status !== 'running') {
        throw new DomainError(
          'STALE_LEASE',
          `Run is in '${runRow.run_status}' status and not running`,
        );
      }

      if (!runRow.is_worker_match || !runRow.is_epoch_match) {
        throw new DomainError(
          'STALE_LEASE',
          'Worker or lease epoch does not match current run owner',
        );
      }

      if (!runRow.is_lease_active) {
        throw new DomainError(
          'STALE_LEASE',
          'Worker lease is expired according to PostgreSQL clock_timestamp()',
        );
      }

      // 5. Insert outcome
      const outcomeId = randomUUID();
      const insertOutcomeSql = `
        INSERT INTO commitment_outcomes (
          id, tenant_id, commitment_id, occurrence_id, task_id, summary, result_status, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
        ON CONFLICT (occurrence_id) DO NOTHING
        RETURNING id
      `;

      const insertRes = await client.query(insertOutcomeSql, [
        outcomeId,
        grant.tenantId,
        cmd.commitmentId,
        cmd.occurrenceId,
        cmd.taskId,
        cmd.summary,
        cmd.resultStatus,
      ]);

      if (insertRes.rows.length === 0) {
        // Duplicate outcome append -> idempotent return false
        return false;
      }

      // 6. Update occurrence status
      const terminalOccStatus =
        cmd.resultStatus === 'failed' || cmd.resultStatus === 'denied' ? 'failed' : 'completed';

      await client.query(
        `UPDATE commitment_occurrences SET status = $1, updated_at = clock_timestamp() WHERE id = $2`,
        [terminalOccStatus, cmd.occurrenceId],
      );

      return true;
    });
  }

  async markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean> {
    const sql = `
      UPDATE commitments
      SET status = 'completed',
          next_due_at = NULL,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'active'
        ${expectedVersion !== undefined ? 'AND version = $2' : ''}
      RETURNING id
    `;

    const values = expectedVersion !== undefined ? [commitmentId, expectedVersion] : [commitmentId];

    try {
      const res = await this.pool.query(sql, values);
      return (res.rowCount ?? 0) > 0;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const sql = `
      SELECT o.id, o.tenant_id, o.commitment_id, o.scheduled_for, o.created_at,
             c.agent_id, c.source_profile_id, c.schedule_kind, c.interval_seconds
      FROM commitment_occurrences o
      JOIN commitments c ON c.tenant_id = o.tenant_id AND c.id = o.commitment_id
      WHERE o.status = 'pending'
        AND o.created_at <= clock_timestamp() - ($1 || ' seconds')::interval
      ORDER BY o.created_at ASC
      LIMIT $2
    `;

    try {
      const result = await this.pool.query<StalledOccurrenceRow>(sql, [
        timeoutSeconds,
        cappedLimit,
      ]);

      return result.rows.map((row) => ({
        occurrenceId: row.id,
        tenantId: row.tenant_id,
        commitmentId: row.commitment_id,
        agentId: row.agent_id,
        sourceProfileId: row.source_profile_id,
        scheduleKind: row.schedule_kind as ScheduleKind,
        intervalSeconds: row.interval_seconds,
        scheduledFor: new Date(row.scheduled_for),
        createdAt: new Date(row.created_at),
        taskCreationIdempotencyKey: deriveTaskCreationIdempotencyKey(row.id),
      }));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean> {
    const sql = `
      UPDATE commitment_occurrences
      SET task_id = $2, status = 'dispatched', updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'pending'
      RETURNING id
    `;

    try {
      const res = await this.pool.query(sql, [occurrenceId, taskId]);
      return (res.rowCount ?? 0) > 0;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async markOccurrenceFailed(occurrenceId: Id, _reasonCode: string): Promise<void> {
    const sql = `
      UPDATE commitment_occurrences
      SET status = 'failed', updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'pending'
    `;

    try {
      await this.pool.query(sql, [occurrenceId]);
    } catch (error) {
      throw asDomainError(error);
    }
  }
}
