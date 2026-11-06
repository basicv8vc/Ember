import { randomUUID } from 'node:crypto';
import { IdSchema, toInvalidArgumentError, type B1AssistantTurnDto } from '@ember/contracts';
import { DomainError, type Id } from '@ember/domain';
import type pg from 'pg';
import { z } from 'zod';
import {
  B1_ASSISTANT_TURN_FAILURE_MESSAGE,
  SIMULATED_MODEL_IDENTITY,
  insertTurnResponse,
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
  B2ClaimOutcome,
  B2PublicationResult,
  B2PublishCommand,
  B2ReserveAttemptCommand,
  B2ReserveOutcome,
  B2SettlementOutcome,
  B2TurnContextRow,
  B2TurnLease,
} from './b2-interfaces.js';
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
  async listRunningTurns(limit = B2_TURN_CANDIDATE_LIMIT): Promise<PendingAssistantTurn[]> {
    const parsed = listSchema.safeParse({ limit });

    if (!parsed.success) {
      throw toInvalidArgumentError(parsed.error);
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
 ORDER BY deadline_at ASC, created_at ASC, id ASC
 LIMIT $1::int`,
        [parsed.data.limit],
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

    const { lease, ceilings, reservedMicroUsd, rateVersion, providerId, modelLabel } = parsed.data;

    try {
      return await transaction(this.pool, async (client) => {
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

        if (attemptNo > 2) {
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
      let releaseMicroUsd = 0;

      if (input.state === 'settled') {
        // `applied` is bounded by the reservation; the observed value is stored unclamped so an
        // overage stays visible instead of being silently absorbed. The whole hold ends here:
        // `applied` becomes consumed money and the remainder is returned.
        applied = Math.min(observed ?? 0, reserved);
        releaseMicroUsd = reserved;
      } else if (input.state === 'released') {
        applied = 0;
        releaseMicroUsd = reserved;
      }
      // `unknown_billed` releases nothing: the request may already be on an invoice.

      await applyCharge(
        client,
        row.utc_day,
        input.tenantId,
        row.principal_id,
        releaseMicroUsd,
        applied ?? 0,
      );

      await client.query(
        `
UPDATE model_turn_attempts
   SET state = $4,
       outcome_code = $5,
       applied_cost_micro_usd = $6,
       observed_cost_micro_usd = $7,
       input_tokens = $8,
       output_tokens = $9,
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
        ],
      );

      return { kind: 'applied' as const, state: input.state, appliedMicroUsd: applied };
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
      const messageId = await insertTurnResponse(client, identity, result.text, model);
      const completed = await markTurnCompleted(client, identity, messageId);

      return completed === null
        ? { outcome: 'fenced' as const, turn: null }
        : { outcome: 'published' as const, turn: toTurnDto(completed) };
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

/** Return unused money and book the recognized cost, in the same lock order as a reservation. */
async function applyCharge(
  client: pg.PoolClient,
  utcDay: string,
  tenantId: string,
  principalId: string,
  releaseMicroUsd: number,
  consumedMicroUsd: number,
): Promise<void> {
  await client.query(
    `
UPDATE model_global_spend_days
   SET reserved_micro_usd = reserved_micro_usd - $2,
       consumed_micro_usd = consumed_micro_usd + $3,
       updated_at = clock_timestamp()
 WHERE utc_day = $1::date`,
    [utcDay, releaseMicroUsd, consumedMicroUsd],
  );

  for (const [scopeKind, scopeId] of [
    ['tenant', tenantId],
    ['principal', principalId],
  ] as const) {
    await client.query(
      `
UPDATE model_spend_days
   SET reserved_micro_usd = reserved_micro_usd - $4,
       consumed_micro_usd = consumed_micro_usd + $5,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND utc_day = $6::date`,
      [tenantId, scopeKind, scopeId, releaseMicroUsd, consumedMicroUsd, utcDay],
    );
  }
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
  ceilings: z.strictObject({
    perAttemptMicroUsd: z.number().int().min(1).max(5_000),
    principalDailyMicroUsd: z.number().int().min(0).max(250_000),
    tenantDailyMicroUsd: z.number().int().min(0).max(1_000_000),
    globalDailyMicroUsd: z.number().int().min(0).max(5_000_000),
    principalDailyTurns: z.number().int().min(0).max(60),
  }),
  reservedMicroUsd: z.number().int().min(1).max(5_000),
  rateVersion: z.string().min(1).max(128),
  providerId: z.literal('openai'),
  modelLabel: z.string().min(1).max(120),
});

const markSentSchema = z.strictObject({
  lease: leaseSchema,
  attemptNo: z.number().int().min(1).max(2),
});

const settleSchema = z.strictObject({
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
  ]),
  state: z.enum(['settled', 'unknown_billed', 'released']),
  observedCostMicroUsd: z.number().int().min(0).nullable().optional(),
  inputTokens: z.number().int().min(0).nullable().optional(),
  outputTokens: z.number().int().min(0).nullable().optional(),
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
