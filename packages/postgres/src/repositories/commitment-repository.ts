import { createHash, randomUUID } from 'node:crypto';
import type {
  AppendOutcomeCommand,
  AuthoritativeOutcome,
  AuthoritativeOutcomeQuery,
  CommitmentDto,
  CommitmentOutcomeDto,
  CommitmentRepository,
  CommitmentStatus,
  CreateCommitmentCommand,
  DueCommitment,
  DueCommitmentStore,
  FinalizeOccurrenceCommand,
  ListCommitmentsOptions,
  ListOutcomesOptions,
  OccurrenceExecutionIdentity,
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

/**
 * Generation identity recorded when an occurrence is dispatched, and re-checked when an Outcome is
 * published (P0-C3D).
 *
 * It is deliberately a PAIR: `version` alone cannot distinguish "the same grant is still current"
 * from "the grant was revoked and re-granted", because a re-grant restarts the lineage's identity.
 */
export interface ConsentDispatchFence {
  readonly grantId: string;
  readonly version: number;
}

/**
 * Transaction-scoped Consent dependency for dispatch, publication and replay lookup.
 *
 * Both methods receive the repository's own `client`, so the consent read happens inside the
 * transaction that writes the occurrence or the Outcome. An adapter must lock the authoritative
 * consent row on that same client and must never consult caller-supplied status, cached state or
 * process-local memory.
 *
 * There is deliberately no boolean `assertActive`: a verdict cannot prove WHICH generation
 * authorized a read, and publication without that proof is exactly the bypass this port removes.
 */
export interface ConsentPublicationGuard {
  /** Dispatch gate: resolve the authoritative generation, or reject with `POLICY_DENIED`. */
  authorizeFence(
    client: pg.PoolClient,
    params: { readonly tenantId: Id; readonly sourceProfileId: string },
  ): Promise<ConsentDispatchFence>;

  /**
   * Publication gate: require `fence` to still be the authoritative generation.
   *
   * `fence === null` means the occurrence recorded no generation; implementations MUST deny it.
   */
  assertFenceCurrent(
    client: pg.PoolClient,
    params: {
      readonly tenantId: Id;
      readonly sourceProfileId: string;
      readonly fence: ConsentDispatchFence | null;
    },
  ): Promise<void>;
}

export interface PostgresCommitmentRepositoryOptions {
  readonly consentPublicationGuard?: ConsentPublicationGuard;
}

const MISSING_CONSENT_PUBLICATION_GUARD: ConsentPublicationGuard = Object.freeze({
  authorizeFence(): Promise<never> {
    return Promise.reject(
      new DomainError(
        'POLICY_DENIED',
        'Durable source consent publication authority is not configured',
      ),
    );
  },
  assertFenceCurrent(): Promise<never> {
    return Promise.reject(
      new DomainError(
        'POLICY_DENIED',
        'Durable source consent publication authority is not configured',
      ),
    );
  },
});

/**
 * Read the persisted authorization fence of an occurrence.
 *
 * A partially recorded fence (one half `NULL`) is treated as no fence at all: it cannot name a
 * generation, so it can never authorize a publication.
 */
function readConsentFence(row: {
  readonly consent_grant_id: string | null;
  readonly consent_version: number | null;
}): ConsentDispatchFence | null {
  if (row.consent_grant_id === null || row.consent_version === null) {
    return null;
  }

  return Object.freeze({ grantId: row.consent_grant_id, version: row.consent_version });
}

type DispatchOutcome =
  | { readonly kind: 'dispatched' }
  | { readonly kind: 'already_dispatched' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'bound_to_other_task' }
  | { readonly kind: 'not_dispatched'; readonly status: string };

/**
 * The ONE place an occurrence becomes `dispatched` (P0-C3D).
 *
 * Runs inside the caller's transaction and applies the repository's shared lock order,
 * `commitments -> commitment_occurrences -> consent_grants`:
 *
 * 1. Resolve the occurrence's tenant and commitment, then lock the commitment row. Every
 *    commitment writer (cancel, pause, reserve, publish, terminalize) takes this lock first, so no
 *    two writers can form a wait cycle.
 * 2. Lock the occurrence.
 * 3. Lock the source profile's consent grant and require an effective `read_snapshot` authorization
 *    that carries the `source.readonly` scope. A revoked, expired, scoped-out or missing grant fails
 *    closed inside the same transaction, so an occurrence can never be bound to a Task without
 *    consent.
 * 4. Record the generation identity AND version, which publication later compares.
 *
 * An occurrence that is already `dispatched` is re-bound idempotently ONLY when it carries a
 * fence. A dispatched occurrence without one predates the fence and cannot be repaired: nothing
 * records which consent authorized the read that may already have happened, so it is refused here
 * and terminalized by {@link PostgresCommitmentRepository.failUnverifiableOccurrences}.
 */
async function dispatchOccurrence(
  client: pg.PoolClient,
  guard: ConsentPublicationGuard,
  occurrenceId: Id,
  taskId: Id,
): Promise<DispatchOutcome> {
  const locate = await client.query<{ tenant_id: string; commitment_id: string }>(
    'SELECT tenant_id, commitment_id FROM commitment_occurrences WHERE id = $1',
    [occurrenceId],
  );
  const located = locate.rows[0];

  if (located === undefined) {
    return { kind: 'missing' };
  }

  const commit = await client.query<{ source_profile_id: string }>(
    `SELECT source_profile_id
       FROM commitments
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [located.tenant_id, located.commitment_id],
  );
  const commitmentRow = commit.rows[0];

  if (commitmentRow === undefined) {
    return { kind: 'missing' };
  }

  const occurrence = await client.query<{
    status: string;
    task_id: string | null;
    consent_grant_id: string | null;
    consent_version: number | null;
  }>(
    `SELECT status, task_id, consent_grant_id, consent_version
       FROM commitment_occurrences
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [located.tenant_id, occurrenceId],
  );
  const row = occurrence.rows[0];

  if (row === undefined) {
    return { kind: 'missing' };
  }

  const task = await client.query('SELECT 1 FROM tasks WHERE tenant_id = $1 AND id = $2', [
    located.tenant_id,
    taskId,
  ]);

  if ((task.rowCount ?? 0) === 0) {
    return { kind: 'not_dispatched', status: row.status };
  }

  if (row.task_id !== null && row.task_id !== taskId) {
    return { kind: 'bound_to_other_task' };
  }

  if (row.status === 'dispatched') {
    if (readConsentFence(row) === null) {
      throw new DomainError(
        'POLICY_DENIED',
        'Occurrence was dispatched without a consent generation fence and cannot be re-dispatched',
      );
    }

    return { kind: 'already_dispatched' };
  }

  if (row.status !== 'pending') {
    return { kind: 'not_dispatched', status: row.status };
  }

  const fence = await guard.authorizeFence(client, {
    tenantId: located.tenant_id,
    sourceProfileId: commitmentRow.source_profile_id,
  });

  await client.query(
    `UPDATE commitment_occurrences
        SET task_id = $3,
            status = 'dispatched',
            consent_grant_id = $4,
            consent_version = $5,
            updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [located.tenant_id, occurrenceId, taskId, fence.grantId, fence.version],
  );

  return { kind: 'dispatched' };
}

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
  private readonly pool: pg.Pool;
  private readonly consentPublicationGuard: ConsentPublicationGuard;

  constructor(pool: pg.Pool, options: PostgresCommitmentRepositoryOptions = {}) {
    this.pool = pool;
    this.consentPublicationGuard =
      options.consentPublicationGuard ?? MISSING_CONSENT_PUBLICATION_GUARD;
  }

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

      // Cancel every non-terminal occurrence of this commitment: a dispatched occurrence whose
      // Worker is still executing must observe the cancellation (its Outcome publication is
      // rejected inside the publication transaction), and it must not be left `dispatched`
      // forever after the Task/Run terminate.
      await client.query(
        `UPDATE commitment_occurrences
         SET status = 'cancelled', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND commitment_id = $2 AND status IN ('pending', 'dispatched')`,
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
             interval_seconds, next_due_at, version, status
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
        status: string;
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
        status: row.status as CommitmentStatus,
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

  /**
   * Bind the created Task to the reserved Occurrence and advance it to `dispatched`.
   *
   * Idempotent by design: two schedulers may both dispatch the same occurrence after a crash (the
   * Task insert is itself idempotent on `commitment-occ:<occurrenceId>`), so re-binding the *same*
   * Task is a no-op instead of a failure. Binding a *different* Task is rejected, which is what
   * keeps duplicate Task dispatch from ever becoming a second occurrence binding.
   *
   * The consent generation that authorizes the read is resolved and recorded here, in the same
   * transaction that flips the status, so no occurrence can be dispatched without a fence.
   */
  async markDispatched(occurrenceId: Id, taskId: Id): Promise<void> {
    try {
      await withTransaction(this.pool, async (client) => {
        const outcome = await dispatchOccurrence(
          client,
          this.consentPublicationGuard,
          occurrenceId,
          taskId,
        );

        switch (outcome.kind) {
          case 'dispatched':
          case 'already_dispatched':
            return;
          case 'missing':
            throw new DomainError('NOT_FOUND', 'Occurrence does not exist');
          case 'bound_to_other_task':
            throw new DomainError(
              'INVALID_STATE_TRANSITION',
              'Occurrence is already bound to a different Task',
            );
          case 'not_dispatched':
            throw new DomainError(
              'INVALID_STATE_TRANSITION',
              `Occurrence cannot be dispatched from '${outcome.status}' status`,
            );
        }
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  async appendOutcomeIfAbsent(
    grant: WorkerLeaseGrant,
    cmd: AppendOutcomeCommand,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      // Lock order for publication:
      //   commitments -> commitment_occurrences -> tasks -> runs -> consent authority
      //
      // Taking the commitment row lock FIRST serialises publication against `cancel()` and
      // `pause()` (which acquire the same lock), so a cancellation that wins the lock is
      // always observed by the publisher instead of being raced past. Task -> run matches the
      // order used by `ResultCommitter` and `PostgresLeaseQueue`. The consent grant is locked LAST
      // (step 5), by `PostgresConsentPublicationGuard`, on THIS connection and inside THIS
      // transaction, so the consent check is part of the same atomic publication. The default
      // deny-all guard still rejects publication for any deployment that does not configure the
      // durable authority.
      //
      // 1. Lock the commitment and require it to still accept outcomes.
      const commitSql = `
        SELECT status, source_profile_id, schedule_kind
        FROM commitments
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const commitRes = await client.query<{
        status: string;
        source_profile_id: string;
        schedule_kind: string;
      }>(commitSql, [grant.tenantId, cmd.commitmentId]);

      const commitRow = commitRes.rows[0];
      if (commitRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Commitment not found');
      }

      // 2. Lock and verify occurrence
      const occSql = `
        SELECT id, status, task_id, consent_grant_id, consent_version
        FROM commitment_occurrences
        WHERE tenant_id = $1 AND commitment_id = $2 AND id = $3
        FOR UPDATE
      `;
      const occRes = await client.query<{
        id: string;
        status: string;
        task_id: string | null;
        consent_grant_id: string | null;
        consent_version: number | null;
      }>(occSql, [grant.tenantId, cmd.commitmentId, cmd.occurrenceId]);

      const occRow = occRes.rows[0];
      if (occRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Occurrence not found');
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
        SELECT status, cancel_requested_at
        FROM tasks
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
      `;
      const taskRes = await client.query<{
        status: string;
        cancel_requested_at: Date | string | null;
      }>(taskSql, [grant.tenantId, grant.taskId]);

      const taskRow = taskRes.rows[0];
      if (taskRow === undefined) {
        throw new DomainError('NOT_FOUND', 'Task not found in this tenant');
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
          (r.attempt = $6::int) AS is_attempt_match,
          (r.leased_until IS NOT NULL AND r.leased_until > clock_timestamp()) AS is_lease_active
        FROM runs r
        WHERE r.tenant_id = $1 AND r.task_id = $2 AND r.id = $3
        FOR UPDATE
      `;

      const leaseRes = await client.query<{
        run_status: string;
        is_worker_match: boolean;
        is_epoch_match: boolean;
        is_attempt_match: boolean;
        is_lease_active: boolean;
      }>(leaseCheckSql, [
        grant.tenantId,
        grant.taskId,
        grant.runId,
        grant.workerId,
        grant.leaseEpoch,
        grant.attempt,
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

      if (!runRow.is_worker_match || !runRow.is_epoch_match || !runRow.is_attempt_match) {
        throw new DomainError(
          'STALE_LEASE',
          'Worker, lease epoch or run attempt does not match current run owner',
        );
      }

      if (!runRow.is_lease_active) {
        throw new DomainError(
          'STALE_LEASE',
          'Worker lease is expired according to PostgreSQL clock_timestamp()',
        );
      }

      if (taskRow.cancel_requested_at !== null) {
        throw new DomainError('CANCELLED', 'Task cancellation was requested before publication');
      }

      // 5. Idempotent replay, decided only after the caller proved it is the current lease owner
      //    of this Task. A stale worker therefore learns nothing and can write nothing. A one-shot
      //    commitment becomes `completed` inside the transaction that published its outcome, so a
      //    replay of that occurrence is still recognized as "already published" rather than as a
      //    publication against a non-active commitment.
      const existingOutcome = await client.query<{ task_id: string }>(
        `
          SELECT task_id
            FROM commitment_outcomes
           WHERE tenant_id = $1 AND occurrence_id = $2
        `,
        [grant.tenantId, cmd.occurrenceId],
      );

      const existingRow = existingOutcome.rows[0];

      if (existingRow !== undefined) {
        if (existingRow.task_id !== cmd.taskId) {
          throw new DomainError(
            'POLICY_DENIED',
            'Outcome of this occurrence belongs to a different Task',
          );
        }

        return false;
      }

      if (occRow.status === 'cancelled') {
        throw new DomainError('POLICY_DENIED', 'Cannot publish outcome for cancelled occurrence');
      }

      if (occRow.status === 'completed') {
        // A previously committed Outcome must never be re-published or duplicated, and a
        // second append for the same occurrence is an idempotent replay.
        return false;
      }

      if (occRow.status === 'failed') {
        // The occurrence already reached a permanent terminal state; a late success may not
        // resurrect it.
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Cannot publish outcome for a failed occurrence',
        );
      }

      if (taskRow.status !== 'running') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `Task is in '${taskRow.status}' status and no longer executing; outcome publication is rejected`,
        );
      }

      if (commitRow.status !== 'active') {
        throw new DomainError(
          'POLICY_DENIED',
          `Cannot publish outcome for commitment in '${commitRow.status}' status`,
        );
      }

      // 5. Consent authorization fence (P0-C3C §5.2 Pre-Publish Check + P0-C3D).
      //
      // The Source Profile comes from the locked commitment row, never from the caller, so a
      // Worker cannot choose which consent record authorizes its own outcome. The fence is the
      // generation recorded at dispatch: it is compared with the current authoritative generation
      // inside this transaction, so a revoke or re-grant that landed after dispatch is observed.
      //
      // An occurrence without a recorded generation is refused. "The grant is active right now"
      // is not a proof that THIS read was authorized by it.
      await this.consentPublicationGuard.assertFenceCurrent(client, {
        tenantId: grant.tenantId,
        sourceProfileId: commitRow.source_profile_id,
        fence: readConsentFence(occRow),
      });

      // 6. Insert outcome
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

      // 7. Update occurrence status and terminalize a one-shot commitment in the *same*
      //    transaction, so a published Outcome can never leave the Occurrence `dispatched` or a
      //    one-shot Commitment `active` with no future execution.
      const terminalOccStatus =
        cmd.resultStatus === 'failed' || cmd.resultStatus === 'denied' ? 'failed' : 'completed';

      await client.query(
        `UPDATE commitment_occurrences
            SET status = $1, updated_at = clock_timestamp()
          WHERE id = $2`,
        [terminalOccStatus, cmd.occurrenceId],
      );

      if (commitRow.schedule_kind === 'once') {
        await client.query(
          `UPDATE commitments
              SET status = 'completed',
                  next_due_at = NULL,
                  version = version + 1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
          [grant.tenantId, cmd.commitmentId],
        );
      }

      return true;
    });
  }

  /**
   * Authoritative replay lookup.
   *
   * Returns the stored summary only after the *current* request has been authenticated against
   * the same state publication requires: tenant, commitment/occurrence/task lineage, live
   * lease fencing and active consent. A stale worker can therefore never read an outcome it
   * would not have been allowed to publish.
   */
  async findAuthoritativeOutcome(
    grant: WorkerLeaseGrant,
    query: AuthoritativeOutcomeQuery,
  ): Promise<AuthoritativeOutcome | null> {
    return withTransaction(this.pool, async (client) => {
      const lookup = await client.query<{
        commitment_status: string;
        source_profile_id: string;
        occurrence_status: string;
        occurrence_task_id: string | null;
        task_status: string | null;
        task_cancel_requested_at: Date | string | null;
        run_status: string | null;
        is_worker_match: boolean | null;
        is_epoch_match: boolean | null;
        is_attempt_match: boolean | null;
        is_lease_active: boolean | null;
        outcome_summary: string | null;
        outcome_result_status: string | null;
        consent_grant_id: string | null;
        consent_version: number | null;
      }>(
        `
          SELECT c.status            AS commitment_status,
                 c.source_profile_id AS source_profile_id,
                 o.status            AS occurrence_status,
                 o.task_id           AS occurrence_task_id,
                 t.status            AS task_status,
                 t.cancel_requested_at AS task_cancel_requested_at,
                 r.status            AS run_status,
                 (r.worker_id = $4)                       AS is_worker_match,
                 (r.lease_epoch = $5::bigint)             AS is_epoch_match,
                 (r.attempt = $6::int)                    AS is_attempt_match,
                 (r.leased_until IS NOT NULL AND r.leased_until > clock_timestamp())
                                                          AS is_lease_active,
                 out.summary         AS outcome_summary,
                 out.result_status   AS outcome_result_status,
                 o.consent_grant_id  AS consent_grant_id,
                 o.consent_version   AS consent_version
            FROM commitments c
            JOIN commitment_occurrences o
              ON o.tenant_id = c.tenant_id AND o.commitment_id = c.id
            LEFT JOIN tasks t
              ON t.tenant_id = c.tenant_id AND t.id = o.task_id
            LEFT JOIN runs r
              ON r.tenant_id = t.tenant_id AND r.task_id = t.id AND r.id = $3
            LEFT JOIN commitment_outcomes out
              ON out.tenant_id = c.tenant_id AND out.occurrence_id = o.id
           WHERE c.tenant_id = $1 AND c.id = $2 AND o.id = $7
        `,
        [
          grant.tenantId,
          query.commitmentId,
          grant.runId,
          grant.workerId,
          grant.leaseEpoch,
          grant.attempt,
          query.occurrenceId,
        ],
      );

      const row = lookup.rows[0];
      if (row === undefined) {
        throw new DomainError('NOT_FOUND', 'Occurrence not found in this tenant');
      }

      if (row.commitment_status !== 'active') {
        throw new DomainError(
          'POLICY_DENIED',
          `Commitment is '${row.commitment_status}' and cannot produce an outcome`,
        );
      }

      if (row.occurrence_task_id !== grant.taskId) {
        throw new DomainError('POLICY_DENIED', 'Occurrence is not bound to this Task');
      }

      if (row.task_status !== 'running' || row.run_status !== 'running') {
        throw new DomainError('STALE_LEASE', 'Task or Run is no longer executing');
      }

      if (
        row.is_worker_match !== true ||
        row.is_epoch_match !== true ||
        row.is_attempt_match !== true ||
        row.is_lease_active !== true
      ) {
        throw new DomainError('STALE_LEASE', 'Worker lease no longer owns this Run');
      }

      if (row.task_cancel_requested_at !== null) {
        throw new DomainError('CANCELLED', 'Task cancellation was requested during execution');
      }

      await this.consentPublicationGuard.assertFenceCurrent(client, {
        tenantId: grant.tenantId,
        sourceProfileId: row.source_profile_id,
        fence: readConsentFence({
          consent_grant_id: row.consent_grant_id,
          consent_version: row.consent_version,
        }),
      });

      if (row.outcome_summary === null || row.outcome_result_status === null) {
        return null;
      }

      return Object.freeze({
        resultStatus: row.outcome_result_status as OutcomeResultStatus,
        summary: row.outcome_summary,
      });
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

  /**
   * Crash-recovery path for a pending occurrence whose Task already exists.
   *
   * It routes through {@link dispatchOccurrence} rather than writing the status itself, so a
   * reconciliation can never create the consent-free `pending -> dispatched` transition that the
   * scheduler gate exists to prevent. It returns `true` only when it actually bound the Task.
   */
  async reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const outcome = await dispatchOccurrence(
          client,
          this.consentPublicationGuard,
          occurrenceId,
          taskId,
        );

        return outcome.kind === 'dispatched';
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Authoritative identity of the Occurrence bound to this Worker's Task.
   *
   * Tenant isolation and Task lineage are enforced in SQL; a Task that is not bound to an
   * Occurrence of the grant's tenant is indistinguishable from a missing one.
   */
  async findOccurrenceExecutionIdentity(
    grant: WorkerLeaseGrant,
    occurrenceId: Id,
  ): Promise<OccurrenceExecutionIdentity | null> {
    const sql = `
      SELECT o.id            AS occurrence_id,
             o.commitment_id,
             o.status        AS occurrence_status,
             o.task_id,
             c.tenant_id,
             c.agent_id,
             c.source_profile_id,
             c.schedule_kind,
             c.status        AS commitment_status,
             dispatched_task.idempotency_key AS task_idempotency_key
        FROM commitment_occurrences o
        JOIN commitments c
          ON c.tenant_id = o.tenant_id AND c.id = o.commitment_id
        LEFT JOIN tasks dispatched_task
          ON dispatched_task.tenant_id = o.tenant_id AND dispatched_task.id = $3
       WHERE o.tenant_id = $1 AND o.id = $2
    `;

    try {
      const result = await this.pool.query<{
        occurrence_id: string;
        commitment_id: string;
        occurrence_status: string;
        task_id: string | null;
        tenant_id: string;
        agent_id: string;
        source_profile_id: string;
        schedule_kind: string;
        commitment_status: string;
        task_idempotency_key: string | null;
      }>(sql, [grant.tenantId, occurrenceId, grant.taskId]);

      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }

      if (row.task_id !== grant.taskId) {
        if (
          row.task_id === null &&
          row.occurrence_status === 'pending' &&
          row.task_idempotency_key === deriveTaskCreationIdempotencyKey(occurrenceId)
        ) {
          // The Task repository committed its idempotent insert, but the Scheduler has not yet
          // bound task_id to the Occurrence. That short window is retryable for this exact
          // deterministic dispatch key; all other mismatches remain a hard denial.
          throw new DomainError(
            'INVALID_STATE_TRANSITION',
            'Occurrence dispatch has not been bound to its Task yet',
          );
        }

        // The Task this Worker holds is not the Task the Occurrence was dispatched to.
        throw new DomainError('POLICY_DENIED', 'Occurrence is not bound to this Task');
      }

      return Object.freeze({
        tenantId: row.tenant_id,
        commitmentId: row.commitment_id,
        occurrenceId: row.occurrence_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        sourceProfileId: row.source_profile_id,
        scheduleKind: row.schedule_kind as ScheduleKind,
        occurrenceStatus: row.occurrence_status as OccurrenceExecutionIdentity['occurrenceStatus'],
        commitmentStatus: row.commitment_status as CommitmentStatus,
      });
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Terminalize an Occurrence whose Task/Run already reached a terminal state.
   *
   * The full grant authenticates the exact Run owner, lease epoch and attempt that finished.
   * The Run must already be terminal (`failed_terminal`/`cancelled`); a retryable Run never
   * qualifies, so an old Worker cannot mark the Occurrence after lease takeover.
   */
  async finalizeOccurrenceFromTask(
    grant: WorkerLeaseGrant,
    cmd: FinalizeOccurrenceCommand,
  ): Promise<boolean> {
    // Every lock is taken by the shared helper in the repository's canonical order
    // (commitments -> occurrences -> tasks -> runs). Taking the Run lock first here would invert
    // that order against `appendOutcomeIfAbsent`/`cancel()` and could deadlock.
    return withTransaction(this.pool, async (client) =>
      this.finalizeOccurrenceLocked(client, {
        tenantId: grant.tenantId,
        commitmentId: cmd.commitmentId,
        occurrenceId: cmd.occurrenceId,
        taskId: grant.taskId,
        desiredStatus: cmd.terminalStatus,
        runFence: {
          runId: grant.runId,
          attempt: grant.attempt,
          leaseEpoch: grant.leaseEpoch,
          workerId: grant.workerId,
        },
      }),
    );
  }

  /**
   * Recovery path for occurrences that cannot prove their authorization (P0-C3D).
   *
   * An occurrence dispatched before the authorization fence existed has no recorded consent
   * generation. It may already have read its source, so it can neither be published (nothing
   * proves which consent authorized the read) nor silently re-dispatched under today's consent
   * (that would launder a read across generations). The only safe move is to terminalize it as
   * `failed`, which the whole system already handles: the commitment's schedule is unaffected, the
   * scheduler does not retry a terminal occurrence, and `reconcileTerminalOccurrences` will not
   * touch it again.
   *
   * Runs the same `commitments -> commitment_occurrences` lock order as every other writer, and
   * re-checks the outcome table under the lock so an occurrence whose Outcome landed concurrently
   * is left alone. The bound Task is not cancelled: it belongs to the execution lane and its own
   * terminal transition remains authoritative.
   */
  async failUnverifiableOccurrences(limit: number): Promise<number> {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const candidates = await this.pool.query<{
      tenant_id: string;
      commitment_id: string;
      occurrence_id: string;
    }>(
      `
        SELECT o.tenant_id, o.commitment_id, o.id AS occurrence_id
          FROM commitment_occurrences o
         WHERE o.status = 'dispatched'
           AND o.consent_grant_id IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM commitment_outcomes out
              WHERE out.tenant_id = o.tenant_id AND out.occurrence_id = o.id
           )
         ORDER BY o.updated_at ASC
         LIMIT $1
      `,
      [cappedLimit],
    );

    let failed = 0;

    for (const candidate of candidates.rows) {
      const changed = await withTransaction(this.pool, async (client) => {
        const commit = await client.query(
          `SELECT status FROM commitments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [candidate.tenant_id, candidate.commitment_id],
        );

        if (commit.rows[0] === undefined) {
          return false;
        }

        const occurrence = await client.query<{ status: string }>(
          `SELECT status
             FROM commitment_occurrences
            WHERE tenant_id = $1 AND commitment_id = $2 AND id = $3
            FOR UPDATE`,
          [candidate.tenant_id, candidate.commitment_id, candidate.occurrence_id],
        );

        const row = occurrence.rows[0];

        if (row === undefined || row.status !== 'dispatched') {
          return false;
        }

        const outcome = await client.query(
          `SELECT 1 FROM commitment_outcomes WHERE tenant_id = $1 AND occurrence_id = $2 LIMIT 1`,
          [candidate.tenant_id, candidate.occurrence_id],
        );

        if ((outcome.rowCount ?? 0) > 0) {
          return false;
        }

        const updated = await client.query(
          `UPDATE commitment_occurrences
              SET status = 'failed', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND status = 'dispatched'`,
          [candidate.tenant_id, candidate.occurrence_id],
        );

        return (updated.rowCount ?? 0) > 0;
      });

      if (changed) {
        failed += 1;
      }
    }

    return failed;
  }

  /**
   * Crash-safe sweep: `dispatched` occurrences whose Task is already `failed`/`cancelled`.
   *
   * It is the safety net for a Worker that died between `finish()` and the Occurrence
   * transition, and it derives everything from persisted Task state, so it can never revive a
   * retry or overwrite a completed occurrence.
   */
  async reconcileTerminalOccurrences(limit: number): Promise<number> {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const candidates = await this.pool.query<{
      tenant_id: string;
      commitment_id: string;
      occurrence_id: string;
      task_id: string;
      task_status: string;
    }>(
      `
        SELECT o.tenant_id, o.commitment_id, o.id AS occurrence_id, o.task_id,
               t.status AS task_status
          FROM commitment_occurrences o
          JOIN tasks t ON t.tenant_id = o.tenant_id AND t.id = o.task_id
         WHERE o.status = 'dispatched'
           AND t.status IN ('failed', 'cancelled')
         ORDER BY o.updated_at ASC
         LIMIT $1
      `,
      [cappedLimit],
    );

    let reconciled = 0;

    for (const candidate of candidates.rows) {
      const changed = await withTransaction(this.pool, async (client) =>
        this.finalizeOccurrenceLocked(client, {
          tenantId: candidate.tenant_id,
          commitmentId: candidate.commitment_id,
          occurrenceId: candidate.occurrence_id,
          taskId: candidate.task_id,
          desiredStatus: candidate.task_status === 'cancelled' ? 'cancelled' : 'failed',
        }),
      );

      if (changed) {
        reconciled += 1;
      }
    }

    return reconciled;
  }
  /**
   * Shared, lock-ordered terminal transition.
   *
   * Lock order: commitments -> commitment_occurrences -> tasks (-> runs, taken by the caller).
   * The desired status is only a hint: the *persisted* Task status decides whether anything may
   * change, and an explicit commitment cancellation always wins over an execution failure.
   */
  private async finalizeOccurrenceLocked(
    client: pg.PoolClient,
    params: {
      readonly tenantId: Id;
      readonly commitmentId: Id;
      readonly occurrenceId: Id;
      readonly taskId: Id;
      readonly desiredStatus: 'failed' | 'cancelled';
      /**
       * Worker-attempt lineage. When present, the Run is locked (after the Task, preserving lock
       * order) and its persisted state decides whether this attempt may terminalize anything.
       */
      readonly runFence?: {
        readonly runId: Id;
        readonly attempt: number;
        readonly leaseEpoch: number;
        readonly workerId: string;
      };
    },
  ): Promise<boolean> {
    const commit = await client.query<{ status: string; schedule_kind: string }>(
      `
        SELECT status, schedule_kind
          FROM commitments
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE
      `,
      [params.tenantId, params.commitmentId],
    );

    const commitRow = commit.rows[0];
    if (commitRow === undefined) {
      throw new DomainError('NOT_FOUND', 'Commitment not found');
    }

    const occurrence = await client.query<{ status: string; task_id: string | null }>(
      `
        SELECT status, task_id
          FROM commitment_occurrences
         WHERE tenant_id = $1 AND commitment_id = $2 AND id = $3
         FOR UPDATE
      `,
      [params.tenantId, params.commitmentId, params.occurrenceId],
    );

    const occurrenceRow = occurrence.rows[0];
    if (occurrenceRow === undefined) {
      throw new DomainError('NOT_FOUND', 'Occurrence not found');
    }

    if (occurrenceRow.task_id !== params.taskId) {
      throw new DomainError('INVALID_ARGUMENT', 'Occurrence is not bound to this Task');
    }

    if (
      occurrenceRow.status === 'completed' ||
      occurrenceRow.status === 'failed' ||
      occurrenceRow.status === 'cancelled'
    ) {
      // Idempotent: a terminal occurrence is never re-terminalized.
      return false;
    }

    const task = await client.query<{ status: string }>(
      `
        SELECT status
          FROM tasks
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE
      `,
      [params.tenantId, params.taskId],
    );

    const taskRow = task.rows[0];
    if (taskRow === undefined) {
      throw new DomainError('NOT_FOUND', 'Task not found in this tenant');
    }

    if (params.runFence !== undefined) {
      // Locked after the Task on purpose: `appendOutcomeIfAbsent` locks tasks -> runs as well,
      // so a terminal transition can never form a wait cycle with a publication.
      const run = await client.query<{
        status: string;
        attempt: number;
        worker_id: string | null;
        lease_epoch: string;
      }>(
        `
          SELECT status, attempt, worker_id, lease_epoch::text AS lease_epoch
            FROM runs
           WHERE tenant_id = $1 AND task_id = $2 AND id = $3
           FOR UPDATE
        `,
        [params.tenantId, params.taskId, params.runFence.runId],
      );

      const runRow = run.rows[0];

      if (
        runRow === undefined ||
        runRow.attempt !== params.runFence.attempt ||
        runRow.worker_id !== params.runFence.workerId ||
        runRow.lease_epoch !== String(params.runFence.leaseEpoch)
      ) {
        // The attempt that produced this command does not own the Run lineage any more.
        throw new DomainError(
          'STALE_LEASE',
          'Run worker, lease epoch or attempt does not belong to this Worker grant',
        );
      }

      if (runRow.status !== 'failed_terminal' && runRow.status !== 'cancelled') {
        // The retry path or the success path owns the Occurrence; nothing may be finalized.
        return false;
      }
    }

    if (taskRow.status !== 'failed' && taskRow.status !== 'cancelled') {
      // Still running, waiting on approval, or scheduled for a retry: the Task owns the
      // Occurrence and no terminal transition is authorized yet.
      return false;
    }

    const targetStatus: 'failed' | 'cancelled' =
      commitRow.status === 'cancelled'
        ? 'cancelled'
        : taskRow.status === 'cancelled'
          ? 'cancelled'
          : 'failed';

    await client.query(
      `
        UPDATE commitment_occurrences
           SET status = $1, updated_at = clock_timestamp()
         WHERE tenant_id = $2 AND commitment_id = $3 AND id = $4
           AND status IN ('pending', 'dispatched')
      `,
      [targetStatus, params.tenantId, params.commitmentId, params.occurrenceId],
    );

    // One-shot promises have no future execution: a permanently failed or cancelled occurrence
    // is their terminal state. Interval commitments stay active for their next slot.
    if (commitRow.status === 'active' && commitRow.schedule_kind === 'once') {
      await client.query(
        `
          UPDATE commitments
             SET status = $1,
                 next_due_at = NULL,
                 version = version + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = $2 AND id = $3 AND status = 'active'
        `,
        [
          targetStatus === 'cancelled' ? 'cancelled' : 'completed',
          params.tenantId,
          params.commitmentId,
        ],
      );
    }

    return true;
  }
}
