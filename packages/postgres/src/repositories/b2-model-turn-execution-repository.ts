import { randomUUID } from 'node:crypto';
import {
  DelegationToolNameSchema,
  IdSchema,
  NotesActionItemsInputSchema,
  TaskEventSchema,
  TaskTitleSchema,
  toInvalidArgumentError,
  type B1AssistantTurnDto,
} from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import { prepareTaskCommand } from '../task-digest.js';
import {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  SIMULATED_MODEL_IDENTITY,
  allocateSequence,
  insertTurnResponse,
  isExpired,
  lockTurn,
  markTurnCompleted,
  markTurnFailed,
  toTurnDto,
  type AssistantModelIdentity,
  type PendingAssistantTurn,
  type TurnRow,
} from './b1-turn-publication.js';
import type {
  B2AttemptCharge,
  B2BudgetIncident,
  B2ClaimOutcome,
  B2PublicationResult,
  B2PublishCommand,
  B2ReserveAttemptCommand,
  B2ReserveOutcome,
  B2SettlementOutcome,
  B2TurnContextRow,
  B2TurnLease,
} from './b2-interfaces.js';
import { B2_ABSOLUTE_DAY_CEILINGS } from './b2-ledger-limits.js';
import { asDomainError } from './support.js';

export const B2_TURN_CANDIDATE_LIMIT = 50;

/** Labels that may only ever belong to simulated text. Mirrors the Alpha anti-misrepresentation rule. */
const SIMULATED_LABEL_PATTERN = /-(fake|echo)-/;

/**
 * Internal control-flow signal for a refusal that must roll the whole reservation back.
 * It never escapes this module: `withTransaction`-style error mapping would turn it into
 * `DB_UNAVAILABLE`, so this file carries its own transaction helper.
 */
class Refusal extends Error {
  override readonly name = 'Refusal';
  readonly outcome: B2ReserveOutcome;

  constructor(outcome: B2ReserveOutcome) {
    super('b2 reservation refused');
    this.outcome = outcome;
  }
}

async function transaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;

  try {
    client = await pool.connect();
  } catch (error) {
    throw asDomainError(error);
  }

  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error instanceof Refusal ? error : asDomainError(error);
  } finally {
    client.release();
  }
}

interface FenceRow {
  readonly status: TurnRow['status'];
  readonly lease_epoch: string | number;
  readonly lease_owner: string | null;
  readonly within_deadline: boolean;
  readonly lease_live: boolean;
}

interface ClaimRow extends FenceRow {
  readonly deadline_at: Date | string;
  readonly lease_expires_at: Date | string;
}

interface IncidentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope_kind: 'global' | 'tenant' | 'principal';
  readonly scope_id: string;
  readonly utc_day: string;
  readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  readonly turn_id: string | null;
  readonly attempt_no: number | null;
  readonly observed_micro_usd: string | number;
  readonly applied_micro_usd: string | number;
  readonly overage_micro_usd: string | number;
  readonly reservation_micro_usd: string | number;
  readonly detected_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly resolved_by: string | null;
  readonly resolution_note: string | null;
}

function toIncident(row: IncidentRow): B2BudgetIncident {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope_kind,
    scopeId: row.scope_id,
    utcDay: row.utc_day,
    reason: row.reason,
    turnId: row.turn_id,
    attemptNo: row.attempt_no,
    observedMicroUsd: Number(row.observed_micro_usd),
    appliedMicroUsd: Number(row.applied_micro_usd),
    overageMicroUsd: Number(row.overage_micro_usd),
    reservationMicroUsd: Number(row.reservation_micro_usd),
    detectedAt: toIso(row.detected_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
  };
}

/**
 * B2 durable Turn execution: claim, fence, attempt accounting and money reservation.
 *
 * Invariants this class exists to provide, in the order a reviewer should check them:
 * 1. **No transaction spans provider I/O.** Every method commits before returning, and the
 *    responder calls the provider between two calls to this class.
 * 2. **One outbound start per attempt.** `markAttemptSent` is a compare-and-set on
 *    `send_started_at IS NULL` that also re-checks the lease, so a worker that lost its lease
 *    cannot start a second billed request for the same attempt number.
 * 3. **Cancellation and timeout win.** Every terminal transition requires `status = 'running'`
 *    *and* the expected `lease_epoch`/`lease_owner`, so a late reply and a swept turn cannot
 *    publish anything.
 * 4. **Reservation is pessimistic.** Only a provably unsent request releases money; an abort or a
 *    crash keeps the reservation as `unknown_billed` until it is reconciled with the invoice.
 */
export class PostgresModelTurnExecutionRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Candidate scan: running, not currently leased, not past its deadline. */
  async listRunningTurns(
    limit = B2_TURN_CANDIDATE_LIMIT,
    onlyTurn?: {
      readonly tenantId: string;
      readonly conversationId: string;
      readonly turnId: string;
    },
  ): Promise<PendingAssistantTurn[]> {
    const parsed = listSchema.safeParse({ limit });
    const parsedTurn = onlyTurn === undefined ? null : identitySchema.safeParse(onlyTurn);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    if (parsedTurn !== null && !parsedTurn.success) {
      throw toInvalidArgumentError(parsedTurn.error);
    }

    try {
      const result = await this.pool.query<{
        readonly tenant_id: string;
        readonly conversation_id: string;
        readonly turn_id: string;
      }>(
        `
SELECT tenant_id, conversation_id, id AS turn_id
  FROM assistant_turns
 WHERE status = 'running'
   AND deadline_at > clock_timestamp()
   AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
   AND (
     $2::uuid IS NULL
     OR (tenant_id = $2::uuid AND conversation_id = $3::uuid AND id = $4::uuid)
   )
 ORDER BY deadline_at ASC, created_at ASC, id ASC
 LIMIT $1::int`,
        [
          parsed.data.limit,
          parsedTurn?.data.tenantId ?? null,
          parsedTurn?.data.conversationId ?? null,
          parsedTurn?.data.turnId ?? null,
        ],
      );

      return result.rows.map((row) => ({
        tenantId: row.tenant_id,
        conversationId: row.conversation_id,
        turnId: row.turn_id,
      }));
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Atomically take the lease.
   *
   * Two workers racing on the same row serialize on the row lock: the loser re-evaluates the
   * `WHERE` clause against the committed lease and updates zero rows. Zero rows means zero
   * provider calls — the caller never learns a partially granted claim.
   */
  async claimTurn(command: {
    readonly turn: PendingAssistantTurn;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<B2ClaimOutcome> {
    const parsed = claimSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { turn, workerId, leaseMs } = parsed.data;

    try {
      const updated = await this.pool.query<ClaimRow>(
        `
UPDATE assistant_turns t
   SET lease_epoch = t.lease_epoch + 1,
       lease_owner = $4,
       lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
       claim_count = t.claim_count + 1,
       updated_at = clock_timestamp()
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
   AND t.status = 'running'
   AND t.deadline_at > clock_timestamp()
   AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= clock_timestamp())
RETURNING t.status, t.lease_epoch, t.lease_owner, t.deadline_at, t.lease_expires_at,
          t.deadline_at > clock_timestamp() AS within_deadline,
          (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > clock_timestamp()) AS lease_live`,
        [turn.tenantId, turn.conversationId, turn.turnId, workerId, leaseMs],
      );
      const row = updated.rows[0];

      if (row !== undefined) {
        return {
          kind: 'claimed',
          lease: {
            ...turn,
            leaseEpoch: Number(row.lease_epoch),
            leaseOwner: workerId,
            deadlineAt: toIso(row.deadline_at),
            leaseExpiresAt: toIso(row.lease_expires_at),
          },
        };
      }

      return { kind: 'not_claimed', reason: await this.classifyMiss(turn) };
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Last messages of this conversation up to the message being answered.
   *
   * Only `user` and `ember` rows: task references, task results, artifacts and other tenants'
   * conversations are never candidates for egress. The bound is applied here so the context builder
   * receives at most `maxMessages` rows.
   */
  async loadTurnContext(command: {
    readonly turn: PendingAssistantTurn;
    readonly maxMessages: number;
  }): Promise<readonly B2TurnContextRow[]> {
    const parsed = contextSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { turn } = parsed.data;

    try {
      const result = await this.pool.query<{
        readonly sequence: string | number;
        readonly kind: 'user' | 'ember';
        readonly text: string;
      }>(
        `
SELECT m.sequence, m.kind, m.text
  FROM conversation_messages m
 WHERE m.tenant_id = $1
   AND m.conversation_id = $2
   AND m.kind IN ('user', 'ember')
   AND m.sequence <= (
     SELECT s.sequence
       FROM conversation_messages s
       JOIN assistant_turns t
         ON t.tenant_id = s.tenant_id
        AND t.conversation_id = s.conversation_id
        AND t.source_message_id = s.id
      WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3
   )
 ORDER BY m.sequence DESC
 LIMIT $4::int`,
        [turn.tenantId, turn.conversationId, turn.turnId, parsed.data.maxMessages],
      );

      return result.rows
        .map((row) => ({
          sequence: Number(row.sequence),
          kind: row.kind,
          text: row.text,
        }))
        .reverse();
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Reserve money and open one attempt in a single transaction.
   *
   * Lock order is global day → tenant day → principal day → attempt, and it is the same order the
   * settlement uses, so two workers cannot deadlock on the shared counters. Any bucket refusing its
   * ceiling rolls the whole transaction back: there is no state in which money is reserved without
   * an attempt, or an attempt exists without its reservation.
   */
  async reserveAttempt(command: B2ReserveAttemptCommand): Promise<B2ReserveOutcome> {
    const parsed = reserveSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { lease, ceilings, maxAttempts, reservedMicroUsd, rateVersion, providerId, modelLabel } =
      parsed.data;

    try {
      return await transaction(this.pool, async (client) => {
        // Serialize against concurrent incident creation (settleAttempt / resolveBudgetIncident)
        // so the halt check below cannot race with an in-flight incident insert.
        await lockBudgetHalt(client);

        const fence = await readFence(client, lease);

        if (!isFenceValid(fence, lease)) {
          throw new Refusal({ kind: 'lease_lost' });
        }

        const principal = await client.query<{ readonly principal_id: string }>(
          'SELECT principal_id FROM consumers WHERE tenant_id = $1',
          [lease.tenantId],
        );
        const principalId = principal.rows[0]?.principal_id;

        // Fail closed: a paid call without a server-derived principal could not be metered per user.
        if (principalId === undefined) {
          throw new Refusal({ kind: 'principal_unavailable' });
        }

        // An unresolved incident means the ledger has already spent money it did not predict, or has
        // crossed a hard ceiling. Either way no further paid call may start until a human has looked
        // at it: this is the "stop spending" half of the overage path.
        const halted = await findOutstandingHalt(client, lease.tenantId, principalId);

        if (halted !== null) {
          throw new Refusal({
            kind: 'budget_halted',
            scope: halted.scope,
            reason: halted.reason,
          });
        }

        const day = await client.query<{ readonly utc_day: string }>(
          "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS utc_day",
        );
        const utcDay = day.rows[0]?.utc_day;

        if (utcDay === undefined) {
          throw new DomainError('DB_UNAVAILABLE', 'could not sample the database UTC day');
        }

        const existing = await client.query<{ readonly current: number }>(
          `SELECT coalesce(max(attempt_no), 0)::int AS current
             FROM model_turn_attempts
            WHERE tenant_id = $1 AND turn_id = $2`,
          [lease.tenantId, lease.turnId],
        );
        const attemptNo = (existing.rows[0]?.current ?? 0) + 1;

        if (attemptNo > maxAttempts) {
          throw new Refusal({ kind: 'attempts_exhausted' });
        }

        await reserveGlobal(client, utcDay, reservedMicroUsd, ceilings.globalDailyMicroUsd);
        await reserveScope(
          client,
          lease.tenantId,
          'tenant',
          lease.tenantId,
          utcDay,
          reservedMicroUsd,
          ceilings.tenantDailyMicroUsd,
          0,
          ceilings.principalDailyTurns,
        );
        await reserveScope(
          client,
          lease.tenantId,
          'principal',
          principalId,
          utcDay,
          reservedMicroUsd,
          ceilings.principalDailyMicroUsd,
          attemptNo === 1 ? 1 : 0,
          ceilings.principalDailyTurns,
        );

        const operationId = randomUUID();

        await client.query(
          `
INSERT INTO model_turn_attempts
       (tenant_id, turn_id, attempt_no, operation_id, principal_id, utc_day,
        provider_id, model_label, rate_version, state, reserved_micro_usd)
VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 'reserved', $10)`,
          [
            lease.tenantId,
            lease.turnId,
            attemptNo,
            operationId,
            principalId,
            utcDay,
            providerId,
            modelLabel,
            rateVersion,
            reservedMicroUsd,
          ],
        );

        return {
          kind: 'reserved' as const,
          attempt: {
            attemptNo,
            operationId,
            utcDay,
            reservedMicroUsd,
          },
        };
      });
    } catch (error) {
      if (error instanceof Refusal) {
        return error.outcome;
      }

      throw error;
    }
  }

  /**
   * The one-send compare-and-set.
   *
   * `send_started_at` moves from NULL exactly once per attempt, and only while the caller still
   * holds the live lease on a running, unexpired Turn. Missing this CAS costs a conservative
   * attempt instead of risking an undetectable extra paid call.
   */
  async markAttemptSent(command: {
    readonly lease: B2TurnLease;
    readonly attemptNo: number;
  }): Promise<boolean> {
    const parsed = markSentSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { lease, attemptNo } = parsed.data;

    try {
      const result = await this.pool.query(
        `
UPDATE model_turn_attempts a
   SET send_started_at = clock_timestamp()
  FROM assistant_turns t
 WHERE a.tenant_id = $1 AND a.turn_id = $2 AND a.attempt_no = $3
   AND a.state = 'reserved' AND a.send_started_at IS NULL
   AND t.tenant_id = a.tenant_id AND t.id = a.turn_id
   AND t.status = 'running'
   AND t.lease_epoch = $4 AND t.lease_owner = $5
   AND t.deadline_at > clock_timestamp()
   AND t.lease_expires_at > clock_timestamp()`,
        [lease.tenantId, lease.turnId, attemptNo, lease.leaseEpoch, lease.leaseOwner],
      );

      return (result.rowCount ?? 0) === 1;
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Close the financial side of one attempt.
   *
   * `settled` books the observed cost and releases the unused part of the reservation;
   * `unknown_billed` keeps the full reservation because the request may already be on an invoice;
   * `released` returns it, and is only legal when provably no request left the process.
   */
  async settleAttempt(charge: B2AttemptCharge): Promise<B2SettlementOutcome> {
    const parsed = settleSchema.safeParse(charge);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const input = parsed.data;

    return transaction(this.pool, async (client) => {
      // Serialize against concurrent reservation checks (reserveAttempt) so any incident this
      // settlement opens is visible to the next reservation that acquires the lock.
      await lockBudgetHalt(client);

      const attempt = await client.query<{
        readonly state: string;
        readonly reserved_micro_usd: string | number;
        readonly utc_day: string;
        readonly principal_id: string;
      }>(
        `
SELECT state, reserved_micro_usd, utc_day::text AS utc_day, principal_id
  FROM model_turn_attempts
 WHERE tenant_id = $1 AND turn_id = $2 AND attempt_no = $3
 FOR UPDATE`,
        [input.tenantId, input.turnId, input.attemptNo],
      );
      const row = attempt.rows[0];

      if (row === undefined) {
        return { kind: 'not_found' as const };
      }

      if (row.state !== 'reserved') {
        return { kind: 'already_settled' as const, state: row.state };
      }

      const reserved = Number(row.reserved_micro_usd);
      const observed = input.observedCostMicroUsd ?? null;

      let applied: number | null = null;
      let chargeMicroUsd = 0;
      let releaseMicroUsd = 0;
      let billingBasis: string | null = null;

      if (input.state === 'settled') {
        // The reservation is released in full and the *actual* cost is recognized. `applied` is what
        // the reservation covered; anything above it is overage, recorded rather than clipped.
        // The whole hold ends here, so `applied` becomes consumed money and the hold is returned.
        applied = Math.min(observed ?? 0, reserved);
        chargeMicroUsd = observed ?? 0;
        releaseMicroUsd = reserved;
        billingBasis = 'provider_usage';
      } else if (input.state === 'conservative_billed') {
        // The provider answered but did not report usage. The charge is unknown, so the full
        // reservation is booked: never zero, and never less than what was held.
        applied = reserved;
        chargeMicroUsd = reserved;
        releaseMicroUsd = reserved;
        billingBasis = 'conservative_reservation';
      } else if (input.state === 'released') {
        applied = 0;
        billingBasis = 'not_billed';
        releaseMicroUsd = reserved;
      }
      // `unknown_billed` releases nothing and recognizes nothing: the request may already be on an
      // invoice, and the hold is the only record of it.

      const charged =
        releaseMicroUsd === 0 && chargeMicroUsd === 0
          ? []
          : await applyCharge(client, {
              utcDay: row.utc_day,
              tenantId: input.tenantId,
              principalId: row.principal_id,
              releaseMicroUsd,
              chargeMicroUsd,
            });

      // A bucket that could not absorb the charge has breached its hard ceiling: preserve the
      // excess and open the incident that stops further paid calls.
      let incidentsOpened = 0;

      for (const bucket of charged) {
        if (bucket.overageMicroUsd > 0) {
          await insertIncident(client, {
            tenantId: input.tenantId,
            scope: bucket.scope,
            scopeId: bucket.scopeId,
            utcDay: row.utc_day,
            reason: 'day_ceiling_exceeded',
            turnId: input.turnId,
            attemptNo: input.attemptNo,
            observedMicroUsd: chargeMicroUsd,
            appliedMicroUsd: bucket.appliedMicroUsd,
            overageMicroUsd: bucket.overageMicroUsd,
            reservationMicroUsd: reserved,
          });
          incidentsOpened += 1;
        }
      }

      // The day allowance absorbed the cost, but the actual charge still beat this attempt's
      // reservation. That is a pricing defect, not a budget breach, and it must also halt spend:
      // the next reservation would be just as wrong.
      if (incidentsOpened === 0 && observed !== null && observed > reserved) {
        await insertIncident(client, {
          tenantId: input.tenantId,
          scope: 'tenant',
          scopeId: input.tenantId,
          utcDay: row.utc_day,
          reason: 'reservation_exceeded',
          turnId: input.turnId,
          attemptNo: input.attemptNo,
          observedMicroUsd: observed,
          appliedMicroUsd: observed,
          overageMicroUsd: 0,
          reservationMicroUsd: reserved,
        });
        incidentsOpened = 1;
      }

      // P0-1: a missing-usage reply is conservatively billed at the full reservation, but the
      // *true* charge is unknown. That uncertainty is itself a budget incident: the ledger has
      // spent money it cannot verify, so every subsequent paid call must halt until a human
      // reconciles. Accounting alone is not enough — the halt is the safety property.
      if (input.state === 'conservative_billed') {
        await insertIncident(client, {
          tenantId: input.tenantId,
          scope: 'tenant',
          scopeId: input.tenantId,
          utcDay: row.utc_day,
          reason: 'usage_missing',
          turnId: input.turnId,
          attemptNo: input.attemptNo,
          observedMicroUsd: reserved,
          appliedMicroUsd: reserved,
          overageMicroUsd: 0,
          reservationMicroUsd: reserved,
        });
        incidentsOpened += 1;
      }

      const attemptOverage = applied === null ? 0 : Math.max(0, (observed ?? 0) - applied);
      const overageMicroUsd = charged.reduce((total, item) => total + item.overageMicroUsd, 0);

      await client.query(
        `
UPDATE model_turn_attempts
   SET state = $4,
       outcome_code = $5,
       applied_cost_micro_usd = $6,
       observed_cost_micro_usd = $7,
       input_tokens = $8,
       output_tokens = $9,
       billing_basis = $10,
       overage_micro_usd = $11,
       settled_at = clock_timestamp()
 WHERE tenant_id = $1 AND turn_id = $2 AND attempt_no = $3 AND state = 'reserved'`,
        [
          input.tenantId,
          input.turnId,
          input.attemptNo,
          input.state,
          input.outcomeCode,
          applied,
          observed,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          billingBasis,
          attemptOverage,
        ],
      );

      return {
        kind: 'applied' as const,
        state: input.state,
        appliedMicroUsd: applied,
        overageMicroUsd,
        incidentsOpened,
      };
    });
  }

  /**
   * Publish the reply, or refuse to.
   *
   * This is the only method that can write `simulated: false`. It requires the exact lease epoch and
   * owner the caller claimed, a still-running Turn, an unexpired deadline and a live lease — all
   * evaluated with the database clock while the conversation and turn rows are locked.
   *
   * A refusal is a normal outcome, not an error: cancellation, a sweeper and a lease takeover all
   * land here, and the correct behaviour in each case is to discard the text.
   */
  async publishCompletion(command: B2PublishCommand): Promise<B2PublicationResult> {
    const parsed = publishSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const { lease, result } = parsed.data;
    const identity: PendingAssistantTurn = {
      tenantId: lease.tenantId,
      conversationId: lease.conversationId,
      turnId: lease.turnId,
    };

    return transaction(this.pool, async (client) => {
      const locked = await lockTurn(client, identity);

      if (locked === null) {
        return { outcome: 'fenced' as const, turn: null };
      }

      const fence = await readFence(client, lease);

      if (!isFenceValid(fence, lease)) {
        return { outcome: 'fenced' as const, turn: toTurnDto(locked) };
      }

      if (result.status === 'failed') {
        const messageId = await insertTurnResponse(
          client,
          identity,
          B1_ASSISTANT_TURN_FAILURE_MESSAGE,
          SIMULATED_MODEL_IDENTITY,
        );
        const failed = await markTurnFailed(client, identity, messageId, result.failureReason);

        return failed === null
          ? { outcome: 'fenced' as const, turn: null }
          : { outcome: 'published' as const, turn: toTurnDto(failed) };
      }

      const model: AssistantModelIdentity = {
        label: result.modelLabel,
        simulated: result.simulated,
      };

      if (result.delegation === undefined) {
        const messageId = await insertTurnResponse(client, identity, result.text, model);
        const completed = await markTurnCompleted(client, identity, messageId);

        return completed === null
          ? { outcome: 'fenced' as const, turn: null }
          : { outcome: 'published' as const, turn: toTurnDto(completed), delegatedTaskId: null };
      }

      // Expired turns never create Tasks or task_reference rows.
      if (await isExpired(client, locked)) {
        const timeoutMessageId = await insertTurnResponse(
          client,
          identity,
          B1_ASSISTANT_TURN_FAILURE_MESSAGE,
          SIMULATED_MODEL_IDENTITY,
        );
        const timedOut = await markTurnFailed(client, identity, timeoutMessageId, 'timeout');

        return timedOut === null
          ? { outcome: 'fenced' as const, turn: null }
          : { outcome: 'published' as const, turn: toTurnDto(timedOut), delegatedTaskId: null };
      }

      // Guard against the sub-millisecond edge where `deadline_at` crosses right as
      // `markTurnCompleted` runs: rolling back the savepoint discards Task + task_reference cleanly.
      await client.query('SAVEPOINT b3_delegation_attempt');
      const taskId = await createOrReuseTurnDelegatedTask(client, identity, result.delegation);
      const messageId = await insertTurnResponse(client, identity, result.text, model);
      await ensureTurnTaskReference(client, identity, taskId);
      const completed = await markTurnCompleted(client, identity, messageId);

      if (completed === null) {
        await client.query('ROLLBACK TO SAVEPOINT b3_delegation_attempt');
        await client.query('RELEASE SAVEPOINT b3_delegation_attempt');
        return { outcome: 'fenced' as const, turn: null };
      }

      if (completed.status === 'failed' && completed.failure_reason === 'timeout') {
        await client.query('ROLLBACK TO SAVEPOINT b3_delegation_attempt');
        await client.query('RELEASE SAVEPOINT b3_delegation_attempt');
        const timeoutMessageId = await insertTurnResponse(
          client,
          identity,
          B1_ASSISTANT_TURN_FAILURE_MESSAGE,
          SIMULATED_MODEL_IDENTITY,
        );
        const timedOut = await markTurnFailed(client, identity, timeoutMessageId, 'timeout');

        return timedOut === null
          ? { outcome: 'fenced' as const, turn: null }
          : { outcome: 'published' as const, turn: toTurnDto(timedOut), delegatedTaskId: null };
      }

      await client.query('RELEASE SAVEPOINT b3_delegation_attempt');
      return {
        outcome: 'published' as const,
        turn: toTurnDto(completed),
        delegatedTaskId: taskId,
      };
    });
  }

  /**
   * Deadline sweeper. Independent of any lease: B1 T-1 makes the 60 s budget authoritative, so a
   * turn whose deadline has passed must fail even while a worker still believes it owns the lease.
   * That worker's later publication is then rejected by the fence, which is the point.
   */
  async expireTurnIfDue(command: PendingAssistantTurn): Promise<B1AssistantTurnDto | null> {
    const parsed = identitySchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    const identity = parsed.data;

    return transaction(this.pool, async (client) => {
      const locked = await lockTurn(client, identity);

      if (locked === null) {
        return null;
      }

      if (locked.status !== 'running') {
        return toTurnDto(locked);
      }

      const due = await client.query<{ readonly due: boolean }>(
        'SELECT $1::timestamptz <= clock_timestamp() AS due',
        [locked.deadline_at],
      );

      if (due.rows[0]?.due !== true) {
        return null;
      }

      const messageId = await insertTurnResponse(
        client,
        identity,
        B1_ASSISTANT_TURN_FAILURE_MESSAGE,
        SIMULATED_MODEL_IDENTITY,
      );
      const failed = await markTurnFailed(client, identity, messageId, 'timeout');

      return failed === null ? null : toTurnDto(failed);
    });
  }

  /**
   * Open budget incidents, newest first.
   *
   * This is the operator half of the halt: a paid call is refused while any of these applies, and the
   * row is the evidence needed to reconcile `observed_micro_usd` against an invoice line.
   */
  async listOpenBudgetIncidents(limit = 50): Promise<readonly B2BudgetIncident[]> {
    const parsed = incidentListSchema.safeParse({ limit });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      const result = await this.pool.query<IncidentRow>(
        `
SELECT id, tenant_id, scope_kind, scope_id, utc_day::text AS utc_day, reason, turn_id,
       attempt_no, observed_micro_usd, applied_micro_usd, overage_micro_usd,
       reservation_micro_usd, detected_at, resolved_at, resolved_by, resolution_note
  FROM model_budget_incidents
 WHERE resolved_at IS NULL
 ORDER BY detected_at DESC, id ASC
 LIMIT $1::int`,
        [parsed.data.limit],
      );

      return result.rows.map(toIncident);
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /**
   * Resolve one incident, which re-enables paid calls for every scope it was blocking.
   *
   * Resolution is attributed and idempotent-by-refusal: an already-resolved incident updates zero
   * rows rather than overwriting the original attribution.
   */
  async resolveBudgetIncident(command: {
    readonly id: string;
    readonly resolvedBy: string;
    readonly note: string;
  }): Promise<boolean> {
    const parsed = resolveIncidentSchema.safeParse(command);

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
    }

    try {
      return await transaction(this.pool, async (client) => {
        // Serialize against reserveAttempt / settleAttempt so a resolution cannot interleave
        // with a halt check or incident insert.
        await lockBudgetHalt(client);

        const result = await client.query(
          `
UPDATE model_budget_incidents
   SET resolved_at = clock_timestamp(),
       resolved_by = $2,
       resolution_note = $3
 WHERE id = $1 AND resolved_at IS NULL`,
          [parsed.data.id, parsed.data.resolvedBy, parsed.data.note],
        );

        return (result.rowCount ?? 0) === 1;
      });
    } catch (error) {
      throw error instanceof Refusal ? error : asDomainError(error);
    }
  }

  private async classifyMiss(
    turn: PendingAssistantTurn,
  ): Promise<'not_found' | 'not_running' | 'deadline_expired' | 'lease_active'> {
    const result = await this.pool.query<{
      readonly status: string;
      readonly expired: boolean;
    }>(
      `
SELECT status,
       deadline_at <= clock_timestamp() AS expired
  FROM assistant_turns
 WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
      [turn.tenantId, turn.conversationId, turn.turnId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return 'not_found';
    }

    if (row.status !== 'running') {
      return 'not_running';
    }

    return row.expired ? 'deadline_expired' : 'lease_active';
  }
}

async function readFence(
  client: pg.PoolClient,
  lease: { readonly tenantId: Id; readonly conversationId: Id; readonly turnId: Id },
): Promise<FenceRow | null> {
  const result = await client.query<FenceRow>(
    `
SELECT t.status,
       t.lease_epoch,
       t.lease_owner,
       t.deadline_at > clock_timestamp() AS within_deadline,
       (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > clock_timestamp()) AS lease_live
  FROM assistant_turns t
 WHERE t.tenant_id = $1 AND t.conversation_id = $2 AND t.id = $3`,
    [lease.tenantId, lease.conversationId, lease.turnId],
  );

  return result.rows[0] ?? null;
}

function isFenceValid(row: FenceRow | null, lease: B2TurnLease): boolean {
  if (row === null) {
    return false;
  }

  if (row.status !== 'running' || !row.within_deadline || !row.lease_live) {
    return false;
  }

  return Number(row.lease_epoch) === lease.leaseEpoch && row.lease_owner === lease.leaseOwner;
}

/**
 * Reserve against the shared global bucket.
 *
 * The ceiling is applied to `reserved + consumed` and is enforced on **both** paths: the `SELECT`
 * form gates the first insert of the day, and the `ON CONFLICT ... WHERE` gates every later one.
 * Writing the cap only in the conflict branch would let the very first reservation of a day — the
 * one case where the row does not exist yet — bypass its own limit.
 */
async function reserveGlobal(
  client: pg.PoolClient,
  utcDay: string,
  amount: number,
  ceiling: number,
): Promise<void> {
  const result = await client.query(
    `
INSERT INTO model_global_spend_days (utc_day, reserved_micro_usd)
SELECT $1::date, $2::bigint
 WHERE $2::bigint <= $3::bigint
ON CONFLICT (utc_day) DO UPDATE
   SET reserved_micro_usd = model_global_spend_days.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
       updated_at = clock_timestamp()
 WHERE model_global_spend_days.reserved_micro_usd
     + model_global_spend_days.consumed_micro_usd
     + EXCLUDED.reserved_micro_usd <= $3`,
    [utcDay, amount, ceiling],
  );

  if ((result.rowCount ?? 0) !== 1) {
    throw new Refusal({ kind: 'budget_exceeded', scope: 'global' });
  }
}

async function reserveScope(
  client: pg.PoolClient,
  tenantId: string,
  scopeKind: 'tenant' | 'principal',
  scopeId: string,
  utcDay: string,
  amount: number,
  ceiling: number,
  turnsStartedDelta: number,
  turnCap: number,
): Promise<void> {
  const result = await client.query(
    `
INSERT INTO model_spend_days
       (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd, turns_started)
SELECT $1, $2, $3, $4::date, $5::bigint, $6::int
 WHERE $5::bigint <= $7::bigint AND $6::int <= $8::int
ON CONFLICT (tenant_id, scope_kind, scope_id, utc_day) DO UPDATE
   SET reserved_micro_usd = model_spend_days.reserved_micro_usd + EXCLUDED.reserved_micro_usd,
       turns_started = model_spend_days.turns_started + EXCLUDED.turns_started,
       updated_at = clock_timestamp()
 WHERE model_spend_days.reserved_micro_usd
     + model_spend_days.consumed_micro_usd
     + EXCLUDED.reserved_micro_usd <= $7
   AND model_spend_days.turns_started + EXCLUDED.turns_started <= $8`,
    [tenantId, scopeKind, scopeId, utcDay, amount, turnsStartedDelta, ceiling, turnCap],
  );

  if ((result.rowCount ?? 0) !== 1) {
    throw new Refusal({ kind: 'budget_exceeded', scope: scopeKind });
  }
}

/** One bucket's share of a settlement: how much it could absorb, and what it could not. */
interface BucketChargeResult {
  readonly scope: 'global' | 'tenant' | 'principal';
  readonly scopeId: string;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
}

/**
 * How much of `charge` fits inside the day ceiling.
 *
 * `release` is money already held for this attempt; releasing it first is what makes room for the
 * charge. The remainder is **overage and is returned, never discarded**: the caller records it in the
 * bucket and opens an incident. Clipping it to the ceiling is the defect this function replaces.
 */
function splitCharge(
  reserved: number,
  consumed: number,
  release: number,
  charge: number,
  ceiling: number,
): {
  readonly remainingReserved: number;
  readonly appliedMicroUsd: number;
  readonly overageMicroUsd: number;
} {
  const remainingReserved = reserved - release;
  const room = Math.max(0, ceiling - (remainingReserved + consumed));
  const appliedMicroUsd = Math.min(charge, room);

  return { remainingReserved, appliedMicroUsd, overageMicroUsd: charge - appliedMicroUsd };
}

async function chargeGlobal(
  client: pg.PoolClient,
  utcDay: string,
  releaseMicroUsd: number,
  chargeMicroUsd: number,
): Promise<BucketChargeResult> {
  // Ensures the row exists so the next statement can actually lock it; a reservation would normally
  // have created it, but settlement must not depend on that.
  await client.query(
    `INSERT INTO model_global_spend_days (utc_day) VALUES ($1::date)
     ON CONFLICT (utc_day) DO NOTHING`,
    [utcDay],
  );

  const locked = await client.query<{
    readonly reserved_micro_usd: string | number;
    readonly consumed_micro_usd: string | number;
  }>(
    `SELECT reserved_micro_usd, consumed_micro_usd
       FROM model_global_spend_days
      WHERE utc_day = $1::date
      FOR UPDATE`,
    [utcDay],
  );
  const reserved = Number(locked.rows[0]!.reserved_micro_usd);
  const consumed = Number(locked.rows[0]!.consumed_micro_usd);
  const split = splitCharge(
    reserved,
    consumed,
    releaseMicroUsd,
    chargeMicroUsd,
    B2_ABSOLUTE_DAY_CEILINGS.globalMicroUsd,
  );

  await client.query(
    `
UPDATE model_global_spend_days
   SET reserved_micro_usd = $2,
       consumed_micro_usd = $3,
       overage_micro_usd = overage_micro_usd + $4,
       updated_at = clock_timestamp()
 WHERE utc_day = $1::date`,
    [utcDay, split.remainingReserved, consumed + split.appliedMicroUsd, split.overageMicroUsd],
  );

  return {
    scope: 'global',
    scopeId: 'platform',
    appliedMicroUsd: split.appliedMicroUsd,
    overageMicroUsd: split.overageMicroUsd,
  };
}

async function chargeScope(
  client: pg.PoolClient,
  tenantId: string,
  scopeKind: 'tenant' | 'principal',
  scopeId: string,
  utcDay: string,
  releaseMicroUsd: number,
  chargeMicroUsd: number,
): Promise<BucketChargeResult> {
  await client.query(
    `INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day)
     VALUES ($1, $2, $3, $4::date)
     ON CONFLICT (tenant_id, scope_kind, scope_id, utc_day) DO NOTHING`,
    [tenantId, scopeKind, scopeId, utcDay],
  );

  const locked = await client.query<{
    readonly reserved_micro_usd: string | number;
    readonly consumed_micro_usd: string | number;
  }>(
    `SELECT reserved_micro_usd, consumed_micro_usd
       FROM model_spend_days
      WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND utc_day = $4::date
      FOR UPDATE`,
    [tenantId, scopeKind, scopeId, utcDay],
  );
  const reserved = Number(locked.rows[0]!.reserved_micro_usd);
  const consumed = Number(locked.rows[0]!.consumed_micro_usd);
  const ceiling =
    scopeKind === 'tenant'
      ? B2_ABSOLUTE_DAY_CEILINGS.tenantMicroUsd
      : B2_ABSOLUTE_DAY_CEILINGS.principalMicroUsd;
  const split = splitCharge(reserved, consumed, releaseMicroUsd, chargeMicroUsd, ceiling);

  await client.query(
    `
UPDATE model_spend_days
   SET reserved_micro_usd = $5,
       consumed_micro_usd = $6,
       overage_micro_usd = overage_micro_usd + $7,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND utc_day = $4::date`,
    [
      tenantId,
      scopeKind,
      scopeId,
      utcDay,
      split.remainingReserved,
      consumed + split.appliedMicroUsd,
      split.overageMicroUsd,
    ],
  );

  return {
    scope: scopeKind,
    scopeId,
    appliedMicroUsd: split.appliedMicroUsd,
    overageMicroUsd: split.overageMicroUsd,
  };
}

/**
 * Return unused money and book the recognized cost, in the same lock order as a reservation:
 * global day → tenant day → principal day.
 */
async function applyCharge(
  client: pg.PoolClient,
  input: {
    readonly utcDay: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly releaseMicroUsd: number;
    readonly chargeMicroUsd: number;
  },
): Promise<readonly BucketChargeResult[]> {
  return [
    await chargeGlobal(client, input.utcDay, input.releaseMicroUsd, input.chargeMicroUsd),
    await chargeScope(
      client,
      input.tenantId,
      'tenant',
      input.tenantId,
      input.utcDay,
      input.releaseMicroUsd,
      input.chargeMicroUsd,
    ),
    await chargeScope(
      client,
      input.tenantId,
      'principal',
      input.principalId,
      input.utcDay,
      input.releaseMicroUsd,
      input.chargeMicroUsd,
    ),
  ];
}

/**
 * Serialize budget halt checks against incident creation and resolution.
 *
 * `findOutstandingHalt` is a plain SELECT, so without this lock a settlement could commit an
 * incident between the check and the reservation — a classic TOCTOU that would let a paid call
 * proceed despite the halt. The advisory lock is taken first in every transaction that touches
 * the incident table (`reserveAttempt`, `settleAttempt`, `resolveBudgetIncident`), which
 * serializes the check with the insert at the database level. The lock is held only for the
 * duration of a short, I/O-free transaction.
 */
const BUDGET_HALT_LOCK_CLASS = 782;
const BUDGET_HALT_LOCK_ID = 0;

async function lockBudgetHalt(client: pg.PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
    BUDGET_HALT_LOCK_CLASS,
    BUDGET_HALT_LOCK_ID,
  ]);
}

async function insertIncident(
  client: pg.PoolClient,
  input: {
    readonly tenantId: string;
    readonly scope: 'global' | 'tenant' | 'principal';
    readonly scopeId: string;
    readonly utcDay: string;
    readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
    readonly turnId: string;
    readonly attemptNo: number;
    readonly observedMicroUsd: number;
    readonly appliedMicroUsd: number;
    readonly overageMicroUsd: number;
    readonly reservationMicroUsd: number;
  },
): Promise<void> {
  await client.query(
    `
INSERT INTO model_budget_incidents
       (id, tenant_id, scope_kind, scope_id, utc_day, reason, turn_id, attempt_no,
        observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12)`,
    [
      randomUUID(),
      input.tenantId,
      input.scope,
      input.scopeId,
      input.utcDay,
      input.reason,
      input.turnId,
      input.attemptNo,
      input.observedMicroUsd,
      input.appliedMicroUsd,
      input.overageMicroUsd,
      input.reservationMicroUsd,
    ],
  );
}

/**
 * The stop switch: any unresolved incident that applies to this call.
 *
 * Checked before a reservation is written and before any request is built, so a halted tenant makes
 * zero provider calls rather than "fewer" ones. Global incidents block everyone, which is correct:
 * the shared daily bucket is the thing that ran out.
 */
async function findOutstandingHalt(
  client: pg.PoolClient,
  tenantId: string,
  principalId: string,
): Promise<{
  readonly scope: 'global' | 'tenant' | 'principal';
  readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
} | null> {
  const result = await client.query<{
    readonly scope_kind: 'global' | 'tenant' | 'principal';
    readonly reason: 'day_ceiling_exceeded' | 'reservation_exceeded' | 'usage_missing';
  }>(
    `
SELECT scope_kind, reason
  FROM model_budget_incidents
 WHERE resolved_at IS NULL
   AND (
     scope_kind = 'global'
     OR (tenant_id = $1 AND scope_kind = 'tenant')
     OR (tenant_id = $1 AND scope_kind = 'principal' AND scope_id = $2)
   )
 ORDER BY CASE scope_kind WHEN 'global' THEN 0 WHEN 'tenant' THEN 1 ELSE 2 END
 LIMIT 1`,
    [tenantId, principalId],
  );
  const row = result.rows[0];

  return row === undefined ? null : { scope: row.scope_kind, reason: row.reason };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const identitySchema = z.strictObject({
  tenantId: IdSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
});

const leaseSchema = z.strictObject({
  tenantId: IdSchema,
  conversationId: IdSchema,
  turnId: IdSchema,
  leaseEpoch: z.number().int().nonnegative(),
  leaseOwner: z.string().min(1).max(128),
  deadlineAt: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
});

const claimSchema = z.strictObject({
  turn: identitySchema,
  workerId: z.string().min(1).max(128),
  leaseMs: z.number().int().min(1).max(60_000),
});

const listSchema = z.strictObject({
  limit: z.number().int().min(1).max(200),
});

const contextSchema = z.strictObject({
  turn: identitySchema,
  maxMessages: z.number().int().min(1).max(50),
});

const reserveSchema = z.strictObject({
  lease: leaseSchema,
  maxAttempts: z.number().int().min(1).max(2),
  ceilings: z.strictObject({
    perAttemptMicroUsd: z.number().int().min(1).max(5_000),
    principalDailyMicroUsd: z.number().int().min(0).max(250_000),
    tenantDailyMicroUsd: z.number().int().min(0).max(1_000_000),
    globalDailyMicroUsd: z.number().int().min(0).max(5_000_000),
    principalDailyTurns: z.number().int().min(0).max(60),
  }),
  reservedMicroUsd: z.number().int().min(1).max(5_000),
  rateVersion: z.string().min(1).max(128),
  providerId: z.enum(['openai', 'openrouter']),
  modelLabel: z.string().min(1).max(120),
});

const markSentSchema = z.strictObject({
  lease: leaseSchema,
  attemptNo: z.number().int().min(1).max(2),
});

const settleSchema = z
  .strictObject({
    tenantId: IdSchema,
    turnId: IdSchema,
    attemptNo: z.number().int().min(1).max(2),
    outcomeCode: z.enum([
      'ok',
      'model_timeout',
      'model_unavailable',
      'model_rate_limited',
      'model_auth_failed',
      'model_invalid_output',
      'client_cancelled',
      'not_sent',
      'usage_missing',
    ]),
    state: z.enum(['settled', 'unknown_billed', 'released', 'conservative_billed']),
    observedCostMicroUsd: z.number().int().min(0).nullable().optional(),
    inputTokens: z.number().int().min(0).nullable().optional(),
    outputTokens: z.number().int().min(0).nullable().optional(),
  })
  // `settled` claims to know the cost, so it must carry one. `conservative_billed` claims the
  // opposite, so inventing a number there would misrepresent an estimate as a measurement.
  .refine(
    (value) =>
      value.state !== 'settled' ||
      (value.observedCostMicroUsd !== null && value.observedCostMicroUsd !== undefined),
    { message: 'settled requires an observed cost', path: ['observedCostMicroUsd'] },
  )
  .refine(
    (value) =>
      value.state !== 'conservative_billed' ||
      value.observedCostMicroUsd === null ||
      value.observedCostMicroUsd === undefined,
    { message: 'conservative billing must not carry an observed cost', path: ['state'] },
  );

const incidentListSchema = z.strictObject({
  limit: z.number().int().min(1).max(500),
});

const resolveIncidentSchema = z.strictObject({
  id: IdSchema,
  resolvedBy: z.string().min(1).max(128),
  note: z.string().min(1).max(1_000),
});

const delegationSchema = z.strictObject({
  toolName: DelegationToolNameSchema,
  title: TaskTitleSchema.optional(),
  input: NotesActionItemsInputSchema,
});

const publishSchema = z.strictObject({
  lease: leaseSchema,
  result: z.discriminatedUnion('status', [
    z
      .strictObject({
        status: z.literal('completed'),
        text: z.string().min(1).max(8192),
        modelLabel: z.string().min(1).max(120),
        simulated: z.boolean(),
        delegation: delegationSchema.optional(),
      })
      // Anti-misrepresentation rule at the persistence boundary: a real label can never carry
      // `simulated: true`, and a `-fake-`/`-echo-` label can never claim to be real.
      .refine((value) => value.simulated === SIMULATED_LABEL_PATTERN.test(value.modelLabel), {
        message: 'simulated must match the model label',
        path: ['simulated'],
      }),
    z.strictObject({
      status: z.literal('failed'),
      failureReason: z.enum(['timeout', 'internal_error']),
    }),
  ]),
});

async function createOrReuseTurnDelegatedTask(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  delegation: z.infer<typeof delegationSchema>,
): Promise<Id> {
  const agentLookup = await client.query<{
    readonly agent_id: string;
    readonly policy_version: number;
  }>(
    `SELECT c.agent_id, a.policy_version
       FROM conversations c
       JOIN agents a
         ON a.tenant_id = c.tenant_id AND a.id = c.agent_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [identity.tenantId, identity.conversationId],
  );
  const meta = agentLookup.rows[0];

  if (meta === undefined) {
    throw new DomainError('NOT_FOUND', 'conversation agent is not visible in this tenant');
  }

  const prepared = prepareTaskCommand({
    agentId: meta.agent_id,
    idempotencyKey: `turn:${identity.turnId}`,
    kind: 'notes.action_items',
    ...(delegation.title === undefined ? {} : { title: delegation.title }),
    input: delegation.input,
  });

  const inserted = await client.query<{
    readonly id: string;
    readonly accepted_at: Date | string;
  }>(
    `INSERT INTO tasks (
       id, tenant_id, agent_id, kind, title, input, digest, idempotency_key, deadline_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id, accepted_at`,
    [
      randomUUID(),
      identity.tenantId,
      prepared.command.agentId,
      prepared.command.kind,
      prepared.command.title ?? null,
      JSON.stringify(prepared.command.input),
      prepared.digest,
      prepared.command.idempotencyKey,
      prepared.deadlineAt,
    ],
  );
  const insertedRow = inserted.rows[0];

  if (insertedRow !== undefined) {
    const parsedEvent = TaskEventSchema.safeParse({
      taskId: insertedRow.id,
      sequence: 1,
      phase: 'accepted',
      occurredAt: toIso(insertedRow.accepted_at),
      traceId: randomUUID(),
      payload: {
        taskKind: prepared.command.kind,
        policyVersion: meta.policy_version,
        replayed: false,
      },
    });

    if (!parsedEvent.success) {
      throw new DomainError('INVALID_ARGUMENT', 'accepted event failed its redaction contract');
    }

    await client.query(
      `INSERT INTO task_events (id, tenant_id, task_id, sequence, phase, payload, trace_id, occurred_at)
       VALUES ($1, $2, $3, 1, 'accepted', $4::jsonb, $5, $6)`,
      [
        randomUUID(),
        identity.tenantId,
        parsedEvent.data.taskId,
        JSON.stringify(parsedEvent.data.payload),
        parsedEvent.data.traceId,
        insertedRow.accepted_at,
      ],
    );

    return insertedRow.id;
  }

  const existing = await client.query<{ readonly id: string; readonly digest: string }>(
    `SELECT id, digest
       FROM tasks
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [identity.tenantId, prepared.command.idempotencyKey],
  );
  const existingRow = existing.rows[0];

  if (existingRow === undefined) {
    throw new DomainError('DB_UNAVAILABLE', 'delegated task idempotency lookup did not resolve');
  }

  if (existingRow.digest !== prepared.digest) {
    throw new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'idempotency key already belongs to a different canonical command',
    );
  }

  return existingRow.id;
}

async function ensureTurnTaskReference(
  client: pg.PoolClient,
  identity: PendingAssistantTurn,
  taskId: Id,
): Promise<void> {
  const existing = await client.query(
    `SELECT 1
       FROM conversation_messages
      WHERE tenant_id = $1 AND task_id = $2 AND kind = 'task_reference'
      LIMIT 1`,
    [identity.tenantId, taskId],
  );

  if ((existing.rowCount ?? 0) > 0) {
    return;
  }

  const sequence = await allocateSequence(client, identity);
  await client.query(
    `INSERT INTO conversation_messages
       (id, tenant_id, conversation_id, sequence, kind, task_id)
     VALUES ($1, $2, $3, $4::bigint, 'task_reference', $5)
     ON CONFLICT (tenant_id, task_id) WHERE task_id IS NOT NULL DO NOTHING`,
    [randomUUID(), identity.tenantId, identity.conversationId, sequence, taskId],
  );
}
