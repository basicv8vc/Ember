import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ConversationTurnInput,
  type ConversationTurnOutput,
  type ModelBudgetCeilings,
  type ModelCallResult,
  type ModelGateway,
  type ModelRateRow,
} from '@ember/model-gateway';
import { B2_ABSOLUTE_DAY_CEILINGS } from '../../packages/postgres/src/repositories/b2-ledger-limits.js';
import { PostgresB1ConversationWriteRepository } from '../../packages/postgres/src/repositories/b1-conversation-write.js';
import { PostgresModelTurnExecutionRepository } from '../../packages/postgres/src/repositories/b2-model-turn-execution-repository.js';
import { createModelTurnResponder } from '../../apps/worker/src/b1/model-turn-responder.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

/**
 * B2 budget safety, as required by the CTO review of PR #124.
 *
 * Three properties are asserted against real PostgreSQL 17, because all three are accounting
 * properties and none of them can be proved by a unit test with an in-memory ledger:
 *
 *   P0-1  a successful call with no reported usage books the full reservation, never zero;
 *   P0-2  a worst case above the per-attempt cap is refused before any attempt row exists;
 *   P0-3  an actual cost above the reservation is preserved in full (consumed + overage), opens a
 *         durable incident, and refuses further paid calls until a human resolves it.
 *
 * No provider credential exists in this file and no request ever leaves the process.
 */

const SOURCE_TEXT = 'how does the daily model budget actually stop spend';
const MODEL_LABEL = 'gpt-test-pinned-2026-11-03';

const RATE: ModelRateRow = {
  providerId: 'openai',
  modelId: MODEL_LABEL,
  inputMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 2_000_000,
  rateVersion: `${MODEL_LABEL}-invoice-2026-11-03`,
  provenance: 'invoice_verified',
  source: 'integration fixture',
};

/** $2/M in, $20/M out: a maximal request costs ~$0.010, twice the $0.005 cap. */
const EXPENSIVE_RATE: ModelRateRow = {
  ...RATE,
  inputMicroUsdPerMillion: 2_000_000,
  outputMicroUsdPerMillion: 20_000_000,
  rateVersion: 'test-expensive-rate',
};

const CEILINGS: ModelBudgetCeilings = {
  perAttemptMicroUsd: 5_000,
  principalDailyMicroUsd: 250_000,
  tenantDailyMicroUsd: 1_000_000,
  globalDailyMicroUsd: 5_000_000,
  principalDailyTurns: 60,
};

const OBSERVED_COST = 130;

interface Fixture {
  readonly tenantId: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly turnId: string;
}

let db: TestDatabase;
let repository: PostgresModelTurnExecutionRepository;
let writer: PostgresB1ConversationWriteRepository;

/** Returns a successful reply with the scripted usage value: `null` models a missing report. */
class UsageGateway implements ModelGateway {
  readonly providerId = 'openai' as const;
  readonly modelLabel = MODEL_LABEL;
  readonly simulated = false;
  readonly operations = ['conversation.turn'] as const;

  calls = 0;

  constructor(private readonly usage: { inputTokens: number; outputTokens: number } | null) {}

  generateConversationTurn(
    _input: ConversationTurnInput,
    _signal: AbortSignal,
  ): Promise<ModelCallResult<ConversationTurnOutput>> {
    this.calls += 1;

    return Promise.resolve({
      output: { text: 'a reply with an uncertain bill', finishReason: 'stop' as const },
      modelLabel: MODEL_LABEL,
      simulated: false as const,
      usage:
        this.usage === null
          ? null
          : {
              inputTokens: this.usage.inputTokens,
              outputTokens: this.usage.outputTokens,
              costMicroUsd: OBSERVED_COST,
              rateVersion: RATE.rateVersion,
            },
    });
  }
}

function makeResponder(
  gateway: ModelGateway,
  options: { readonly rate?: ModelRateRow; readonly workerId?: string } = {},
) {
  return createModelTurnResponder({
    mode: 'real',
    repository,
    gateway,
    workerId: options.workerId ?? 'worker-b2-budget',
    leaseMs: 30_000,
    ceilings: CEILINGS,
    maxAttempts: 2,
    attemptTimeoutMs: 20_000,
    rate: options.rate ?? RATE,
  });
}

/** Tenant and principal only, with no Turn. Handy for ledger-only assertions that must not leave a
 * claimable Turn behind for a later test in this file to pick up. */
async function createTenant(): Promise<{
  readonly tenantId: string;
  readonly principalId: string;
}> {
  const tenantId = randomUUID();
  const principalId = randomUUID();

  await db.pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'b2 budget']);
  await db.pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
    principalId,
    tenantId,
  ]);
  await db.pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
    randomUUID(),
    tenantId,
    principalId,
  ]);

  return { tenantId, principalId };
}

async function createFixture(
  options: { readonly tenantId?: string; readonly principalId?: string } = {},
): Promise<Fixture> {
  let tenantId = options.tenantId;
  let principalId = options.principalId;

  if (tenantId === undefined || principalId === undefined) {
    const created = await createTenant();
    tenantId = created.tenantId;
    principalId = created.principalId;
  }

  const agentId = randomUUID();
  const conversationId = randomUUID();

  await db.pool.query(
    'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
    [agentId, tenantId, 'b2 budget agent'],
  );
  await db.pool.query(
    "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
    [conversationId, tenantId, agentId],
  );

  const submitted = await writer.submitUserMessage({
    tenantId,
    conversationId,
    request: { client_submission_id: randomUUID(), text: SOURCE_TEXT, transcript_epoch: 0 },
  });

  return {
    tenantId,
    principalId,
    conversationId,
    turnId: submitted.receipt.turn.turn_id,
  };
}

function identity(fixture: Fixture) {
  return {
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    turnId: fixture.turnId,
  };
}

async function claim(fixture: Fixture, workerId = 'worker-direct') {
  const claimResult = await repository.claimTurn({
    turn: identity(fixture),
    workerId,
    leaseMs: 30_000,
  });

  if (claimResult.kind !== 'claimed') {
    throw new Error(`expected a claim, received ${claimResult.reason}`);
  }

  return claimResult.lease;
}

async function utcDay(): Promise<string> {
  const result = await db.observerPool.query<{ readonly day: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
  );

  return result.rows[0]!.day;
}

async function seedGlobalConsumed(microUsd: number): Promise<void> {
  await db.pool.query(
    `
INSERT INTO model_global_spend_days (utc_day, reserved_micro_usd, consumed_micro_usd)
VALUES ($1::date, 0, $2)
ON CONFLICT (utc_day) DO UPDATE
   SET reserved_micro_usd = 0, consumed_micro_usd = $2, updated_at = clock_timestamp()`,
    [await utcDay(), microUsd],
  );
}

async function resetGlobalSpend(): Promise<void> {
  await db.pool.query(
    "DELETE FROM model_global_spend_days WHERE utc_day = (clock_timestamp() AT TIME ZONE 'UTC')::date",
  );
  await db.pool.query('DELETE FROM model_budget_incidents');
}

interface Bucket {
  readonly reserved: number;
  readonly consumed: number;
  readonly overage: number;
}

async function readGlobal(): Promise<Bucket | null> {
  const result = await db.observerPool.query<{
    readonly reserved: string;
    readonly consumed: string;
    readonly overage: string;
  }>(
    `SELECT reserved_micro_usd::text AS reserved, consumed_micro_usd::text AS consumed,
            overage_micro_usd::text AS overage
       FROM model_global_spend_days
      WHERE utc_day = $1::date`,
    [await utcDay()],
  );
  const row = result.rows[0];

  return row === undefined
    ? null
    : {
        reserved: Number(row.reserved),
        consumed: Number(row.consumed),
        overage: Number(row.overage),
      };
}

async function readScope(fixture: Fixture, scope: 'tenant' | 'principal'): Promise<Bucket | null> {
  const result = await db.observerPool.query<{
    readonly reserved: string;
    readonly consumed: string;
    readonly overage: string;
  }>(
    `SELECT reserved_micro_usd::text AS reserved, consumed_micro_usd::text AS consumed,
            overage_micro_usd::text AS overage
       FROM model_spend_days
      WHERE tenant_id = $1 AND scope_kind = $2 AND utc_day = $3::date`,
    [fixture.tenantId, scope, await utcDay()],
  );
  const row = result.rows[0];

  return row === undefined
    ? null
    : {
        reserved: Number(row.reserved),
        consumed: Number(row.consumed),
        overage: Number(row.overage),
      };
}

interface AttemptRow {
  readonly attempt_no: number;
  readonly state: string;
  readonly outcome_code: string | null;
  readonly reserved_micro_usd: string;
  readonly applied_cost_micro_usd: string | null;
  readonly observed_cost_micro_usd: string | null;
  readonly billing_basis: string | null;
  readonly overage_micro_usd: string;
}

async function readAttempts(fixture: Fixture): Promise<readonly AttemptRow[]> {
  const result = await db.observerPool.query<AttemptRow>(
    `SELECT attempt_no, state, outcome_code, reserved_micro_usd::text,
            applied_cost_micro_usd::text, observed_cost_micro_usd::text, billing_basis,
            overage_micro_usd::text
       FROM model_turn_attempts
      WHERE tenant_id = $1 AND turn_id = $2
      ORDER BY attempt_no`,
    [fixture.tenantId, fixture.turnId],
  );

  return result.rows;
}

async function readTurnStatus(fixture: Fixture): Promise<string> {
  const result = await db.observerPool.query<{ readonly status: string }>(
    'SELECT status FROM assistant_turns WHERE tenant_id = $1 AND id = $2',
    [fixture.tenantId, fixture.turnId],
  );

  return result.rows[0]!.status;
}

async function readAssistantMessages(fixture: Fixture) {
  const result = await db.observerPool.query<{
    readonly id: string;
    readonly text: string;
    readonly simulated: boolean;
    readonly model_label: string;
  }>(
    `SELECT id, text, simulated, model_label
       FROM conversation_messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'`,
    [fixture.tenantId, fixture.conversationId],
  );

  return result.rows;
}

describe('B2 budget safety on PostgreSQL 17 (CTO review of PR #124)', () => {
  beforeAll(async () => {
    db = await createTestDatabase({ maxConnections: 16 });

    const version = await db.pool.query<{ readonly server_version_num: string }>(
      'SHOW server_version_num',
    );
    const versionNumber = Number(version.rows[0]?.server_version_num ?? 0);

    expect(versionNumber).toBeGreaterThanOrEqual(170000);
    expect(versionNumber).toBeLessThan(180000);

    repository = new PostgresModelTurnExecutionRepository(db.pool);
    writer = new PostgresB1ConversationWriteRepository(db.pool);
  }, 30_000);

  afterAll(async () => {
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // P0-1 — a missing usage report must never be booked as a free call.
  // -------------------------------------------------------------------------
  describe('P0-1 missing provider usage', () => {
    it('books the full reservation and labels the basis, instead of zero', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const gateway = new UsageGateway(null);
      const summary = await makeResponder(gateway).processOnce();

      expect(summary.completed).toBe(1);
      expect(gateway.calls).toBe(1);

      const attempts = await readAttempts(fixture);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        state: 'conservative_billed',
        outcome_code: 'usage_missing',
        billing_basis: 'conservative_reservation',
        // No measurement exists, so no measurement is claimed.
        observed_cost_micro_usd: null,
      });
      // Everything that was held is booked: the charge is unknown, not small.
      expect(attempts[0]!.applied_cost_micro_usd).toBe(attempts[0]!.reserved_micro_usd);

      const reserved = Number(attempts[0]!.reserved_micro_usd);
      expect(reserved).toBeGreaterThan(0);

      expect(await readGlobal()).toMatchObject({ reserved: 0, consumed: reserved, overage: 0 });
      expect(await readScope(fixture, 'tenant')).toMatchObject({ consumed: reserved });
      expect(await readScope(fixture, 'principal')).toMatchObject({ consumed: reserved });

      // The reply is real and paid for, so it is delivered.
      expect(await readTurnStatus(fixture)).toBe('completed');
      const messages = await readAssistantMessages(fixture);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.simulated).toBe(false);
    });

    it('still books the reported cost when usage is present', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      await makeResponder(new UsageGateway({ inputTokens: 40, outputTokens: 20 })).processOnce();

      const attempts = await readAttempts(fixture);
      expect(attempts[0]).toMatchObject({
        state: 'settled',
        outcome_code: 'ok',
        billing_basis: 'provider_usage',
      });
      expect(Number(attempts[0]!.observed_cost_micro_usd)).toBe(OBSERVED_COST);
      expect(await readGlobal()).toMatchObject({ reserved: 0, consumed: OBSERVED_COST });
    });

    it('opens a usage_missing incident and halts the next paid call', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const gateway = new UsageGateway(null);
      await makeResponder(gateway).processOnce();

      // The incident is the safety property: accounting alone is not enough.
      const incidents = await repository.listOpenBudgetIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        scope: 'tenant',
        reason: 'usage_missing',
        overageMicroUsd: 0,
        resolvedAt: null,
      });

      // The next Turn for the same tenant is hard-refused before any provider call.
      const blocked = await createFixture({
        tenantId: fixture.tenantId,
        principalId: fixture.principalId,
      });
      const gateway2 = new UsageGateway({ inputTokens: 40, outputTokens: 20 });
      const halted = await makeResponder(gateway2).processOnce();

      expect(halted.halted).toBe(1);
      expect(halted.completed).toBe(0);
      expect(gateway2.calls).toBe(0);
      expect(await readAttempts(blocked)).toHaveLength(0);

      // Resolution is attributed; spending resumes only after it.
      const resolved = await repository.resolveBudgetIncident({
        id: incidents[0]!.id,
        resolvedBy: 'cto@ember.test',
        note: 'usage_missing reconciled against provider dashboard',
      });
      expect(resolved).toBe(true);

      await createFixture({ tenantId: fixture.tenantId, principalId: fixture.principalId });
      const after = await makeResponder(gateway2).processOnce();
      expect(after.completed).toBe(1);
      expect(gateway2.calls).toBe(1);
    });

    it('refuses a usage_missing incident that does not match its arithmetic shape', async () => {
      await resetGlobalSpend();
      const tenant = await createTenant();
      const day = await utcDay();

      // observed must equal applied must equal reservation for usage_missing.
      await expect(
        db.pool.query(
          `INSERT INTO model_budget_incidents
             (id, tenant_id, scope_kind, scope_id, utc_day, reason,
              observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
           VALUES ($1, $2, 'tenant', $3, $4::date, 'usage_missing', 0, 100, 0, 100)`,
          [randomUUID(), tenant.tenantId, tenant.tenantId, day],
        ),
      ).rejects.toThrow(/check constraint/i);

      // A valid usage_missing incident is accepted.
      await db.pool.query(
        `INSERT INTO model_budget_incidents
           (id, tenant_id, scope_kind, scope_id, utc_day, reason,
            observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
         VALUES ($1, $2, 'tenant', $3, $4::date, 'usage_missing', 100, 100, 0, 100)`,
        [randomUUID(), tenant.tenantId, tenant.tenantId, day],
      );
    });
  });

  // -------------------------------------------------------------------------
  // P0-2 — an unaffordable request is refused, not truncated to the cap.
  // -------------------------------------------------------------------------
  describe('P0-2 reservation ceiling', () => {
    it('refuses before any attempt row, spend bucket or provider call', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const gateway = new UsageGateway({ inputTokens: 40, outputTokens: 20 });

      const summary = await makeResponder(gateway, { rate: EXPENSIVE_RATE }).processOnce();

      expect(summary.failed).toBe(1);
      expect(gateway.calls).toBe(0);
      expect(await readAttempts(fixture)).toHaveLength(0);
      // No reservation was ever written, so the day book is untouched.
      expect(await readGlobal()).toBeNull();
      expect(await readScope(fixture, 'tenant')).toBeNull();
      expect(await readTurnStatus(fixture)).toBe('failed');
    });

    it('reserves the worst-case cost of the pinned rate, not the cap', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      await makeResponder(new UsageGateway({ inputTokens: 40, outputTokens: 20 })).processOnce();

      const attempts = await readAttempts(fixture);
      const reserved = Number(attempts[0]!.reserved_micro_usd);

      // 512 output tokens at $2/M alone is 1 024 micro-USD, plus the input estimate.
      expect(reserved).toBeGreaterThanOrEqual(1_024);
      expect(reserved).toBeLessThanOrEqual(CEILINGS.perAttemptMicroUsd);
    });

    it('agrees with the database about the absolute day ceilings', async () => {
      // Drift guard: the settlement path needs these numbers to split consumed from overage, and the
      // CHECK constraints enforce them. If either side moves, this test fails instead of production.
      expect(B2_ABSOLUTE_DAY_CEILINGS).toStrictEqual({
        globalMicroUsd: 5_000_000,
        tenantMicroUsd: 1_000_000,
        principalMicroUsd: 250_000,
      });

      const tenant = await createTenant();
      const day = await utcDay();

      await expect(
        db.pool.query(
          `INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd)
           VALUES ($1, 'tenant', $1, $2::date, 1000001)`,
          [tenant.tenantId, day],
        ),
      ).rejects.toThrow(/check constraint/i);

      await expect(
        db.pool.query(
          `INSERT INTO model_spend_days (tenant_id, scope_kind, scope_id, utc_day, reserved_micro_usd)
           VALUES ($1, 'principal', $2, $3::date, 250001)`,
          [tenant.tenantId, tenant.principalId, day],
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });

  // -------------------------------------------------------------------------
  // P0-3 — the actual cost is preserved, and it stops further spending.
  // -------------------------------------------------------------------------
  describe('P0-3 observed cost above the reservation', () => {
    it('keeps the whole actual cost: consumed plus overage, never clipped', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      // A small reservation against a day bucket that is already nearly full, so the settlement
      // cannot absorb the charge. 4 998 000 + 2 000 is exactly the 5 000 000 ceiling.
      await seedGlobalConsumed(B2_ABSOLUTE_DAY_CEILINGS.globalMicroUsd - 2_000);

      const reservation = await repository.reserveAttempt({
        lease,
        ceilings: CEILINGS,
        maxAttempts: 2,
        reservedMicroUsd: 2_000,
        rateVersion: RATE.rateVersion,
        providerId: 'openai',
        modelLabel: MODEL_LABEL,
      });
      expect(reservation.kind).toBe('reserved');
      await repository.markAttemptSent({ lease, attemptNo: 1 });

      const settlement = await repository.settleAttempt({
        tenantId: fixture.tenantId,
        turnId: fixture.turnId,
        attemptNo: 1,
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 5_200,
        inputTokens: 400,
        outputTokens: 500,
      });

      expect(settlement).toMatchObject({
        kind: 'applied',
        appliedMicroUsd: 2_000,
        overageMicroUsd: 3_200,
        incidentsOpened: 1,
      });

      const global = await readGlobal();
      // Consumed stopped at the ceiling; the remaining 3 200 is preserved as overage.
      expect(global).toMatchObject({ reserved: 0, consumed: 5_000_000, overage: 3_200 });

      const attempts = await readAttempts(fixture);
      expect(attempts[0]).toMatchObject({ state: 'settled', outcome_code: 'ok' });
      // The raw provider figure stays unclamped, and applied + overage reconstructs it exactly.
      expect(Number(attempts[0]!.observed_cost_micro_usd)).toBe(5_200);
      expect(Number(attempts[0]!.applied_cost_micro_usd)).toBe(2_000);
      expect(Number(attempts[0]!.overage_micro_usd)).toBe(3_200);

      const incidents = await repository.listOpenBudgetIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        scope: 'global',
        scopeId: 'platform',
        reason: 'day_ceiling_exceeded',
        observedMicroUsd: 5_200,
        appliedMicroUsd: 2_000,
        overageMicroUsd: 3_200,
        reservationMicroUsd: 2_000,
        resolvedAt: null,
      });
    });

    it('halts further paid calls until the incident is resolved, then resumes', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      const reservation = await repository.reserveAttempt({
        lease,
        ceilings: CEILINGS,
        maxAttempts: 2,
        reservedMicroUsd: 100,
        rateVersion: RATE.rateVersion,
        providerId: 'openai',
        modelLabel: MODEL_LABEL,
      });
      expect(reservation.kind).toBe('reserved');
      await repository.markAttemptSent({ lease, attemptNo: 1 });

      // 5 200 against a 100 micro-USD reservation: the day bucket has room, the reservation does not.
      await repository.settleAttempt({
        tenantId: fixture.tenantId,
        turnId: fixture.turnId,
        attemptNo: 1,
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 5_200,
      });

      const incidents = await repository.listOpenBudgetIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        scope: 'tenant',
        reason: 'reservation_exceeded',
        overageMicroUsd: 0,
        reservationMicroUsd: 100,
      });

      // The next Turn for this tenant cannot buy anything. The settled Turn above still holds a live
      // lease, so it is not a candidate; only this new Turn is examined.
      const blocked = await createFixture({
        tenantId: fixture.tenantId,
        principalId: fixture.principalId,
      });
      const gateway = new UsageGateway({ inputTokens: 40, outputTokens: 20 });
      const halted = await makeResponder(gateway).processOnce();

      expect(halted.halted).toBe(1);
      expect(halted.completed).toBe(0);
      expect(gateway.calls).toBe(0);
      expect(await readAttempts(blocked)).toHaveLength(0);

      // Resolution is attributed, and only then does spending resume.
      const resolved = await repository.resolveBudgetIncident({
        id: incidents[0]!.id,
        resolvedBy: 'cto@ember.test',
        note: 'reconciled against invoice line 2026-11; rate row to be re-pinned',
      });
      expect(resolved).toBe(true);
      // Resolving twice does not overwrite the original attribution.
      expect(
        await repository.resolveBudgetIncident({
          id: incidents[0]!.id,
          resolvedBy: 'someone-else',
          note: 'second attempt',
        }),
      ).toBe(false);
      expect(await repository.listOpenBudgetIncidents()).toHaveLength(0);

      await createFixture({ tenantId: fixture.tenantId, principalId: fixture.principalId });
      const after = await makeResponder(gateway).processOnce();

      expect(after.completed).toBe(1);
      expect(gateway.calls).toBe(1);
    });

    it('settles exactly once under concurrent settlement of the same attempt', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      await repository.reserveAttempt({
        lease,
        ceilings: CEILINGS,
        maxAttempts: 2,
        reservedMicroUsd: 5_000,
        rateVersion: RATE.rateVersion,
        providerId: 'openai',
        modelLabel: MODEL_LABEL,
      });
      await repository.markAttemptSent({ lease, attemptNo: 1 });

      const charge = {
        tenantId: fixture.tenantId,
        turnId: fixture.turnId,
        attemptNo: 1,
        state: 'settled' as const,
        outcomeCode: 'ok',
        observedCostMicroUsd: OBSERVED_COST,
      };
      const results = await Promise.all([
        repository.settleAttempt(charge),
        repository.settleAttempt(charge),
      ]);

      const kinds = results.map((result) => result.kind).sort();

      expect(kinds).toStrictEqual(['already_settled', 'applied']);
      // The money moved once, not twice.
      expect(await readGlobal()).toMatchObject({
        reserved: 0,
        consumed: OBSERVED_COST,
        overage: 0,
      });
    });

    it('keeps the incident as evidence when the transcript is deleted', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      await repository.reserveAttempt({
        lease,
        ceilings: CEILINGS,
        maxAttempts: 2,
        reservedMicroUsd: 100,
        rateVersion: RATE.rateVersion,
        providerId: 'openai',
        modelLabel: MODEL_LABEL,
      });
      await repository.markAttemptSent({ lease, attemptNo: 1 });
      await repository.settleAttempt({
        tenantId: fixture.tenantId,
        turnId: fixture.turnId,
        attemptNo: 1,
        state: 'settled',
        outcomeCode: 'ok',
        observedCostMicroUsd: 5_200,
      });

      await db.pool.query('DELETE FROM assistant_turns WHERE tenant_id = $1 AND id = $2', [
        fixture.tenantId,
        fixture.turnId,
      ]);

      // The attempt cascades away with its Turn; the money evidence does not.
      expect(await readAttempts(fixture)).toHaveLength(0);
      const incidents = await repository.listOpenBudgetIncidents();

      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.turnId).toBe(fixture.turnId);
    });

    it('refuses an overage that would be stored as overage without a reason', async () => {
      await resetGlobalSpend();
      const tenant = await createTenant();
      const day = await utcDay();

      // The reason is derived from the arithmetic, so an incident that claims a ceiling breach
      // without one cannot be inserted by any caller.
      await expect(
        db.pool.query(
          `INSERT INTO model_budget_incidents
             (id, tenant_id, scope_kind, scope_id, utc_day, reason,
              observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
           VALUES ($1, $2, 'tenant', $3, $4::date, 'day_ceiling_exceeded', 10, 10, 0, 10)`,
          [randomUUID(), tenant.tenantId, tenant.tenantId, day],
        ),
      ).rejects.toThrow(/check constraint/i);

      // An unresolved incident must be attributable, so a half-resolved row is rejected too.
      await expect(
        db.pool.query(
          `INSERT INTO model_budget_incidents
             (id, tenant_id, scope_kind, scope_id, utc_day, reason,
              observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd,
              resolved_at)
           VALUES ($1, $2, 'tenant', $3, $4::date, 'reservation_exceeded', 20, 20, 0, 10,
                   clock_timestamp())`,
          [randomUUID(), tenant.tenantId, tenant.tenantId, day],
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe('per-Turn attempt authorization ceiling', () => {
    it('allows only one concurrent reservation when the trusted runtime grants one attempt', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);
      const request = {
        lease,
        ceilings: CEILINGS,
        maxAttempts: 1,
        reservedMicroUsd: 100,
        rateVersion: RATE.rateVersion,
        providerId: 'openrouter' as const,
        modelLabel: MODEL_LABEL,
      };

      const outcomes = await Promise.all([
        repository.reserveAttempt(request),
        repository.reserveAttempt(request),
      ]);

      expect(outcomes.map((outcome) => outcome.kind).sort()).toStrictEqual([
        'attempts_exhausted',
        'reserved',
      ]);
      expect(await readAttempts(fixture)).toHaveLength(1);
      expect(await readGlobal()).toMatchObject({ reserved: 100, consumed: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // P0-2 (second review) — TOCTOU between findOutstandingHalt and reserveAttempt.
  //
  // Two separate database connections, one holding the budget-halt advisory lock while it
  // inserts an incident. The second connection's reserveAttempt must block on the lock, then
  // observe the incident once the first commits. This proves the check and the insert are
  // serialised at the transaction level, not by timing luck.
  // -------------------------------------------------------------------------
  describe('P0-2 TOCTOU: incident insertion vs concurrent reservation', () => {
    it('serialises incident commit against a concurrent reserveAttempt (deterministic dual-connection)', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      // Connection A holds the budget-halt advisory lock and inserts an incident.
      const connA = await db.pool.connect();

      try {
        await connA.query('BEGIN');
        await connA.query('SELECT pg_advisory_xact_lock(782, 0)');
        await connA.query(
          `INSERT INTO model_budget_incidents
             (id, tenant_id, scope_kind, scope_id, utc_day, reason, turn_id, attempt_no,
              observed_micro_usd, applied_micro_usd, overage_micro_usd, reservation_micro_usd)
           VALUES ($1, $2::uuid, 'tenant', $2::text, $3::date, 'usage_missing', $4, 1, 100, 100, 0, 100)`,
          [randomUUID(), fixture.tenantId, await utcDay(), fixture.turnId],
        );

        // Start a reservation in the repository's own connection. It must block on the advisory
        // lock held by connA. The fence check (readFence) happens AFTER lockBudgetHalt, so the
        // reservation is stuck at the very first step inside its transaction.
        let reserveSettled = false;
        const reservePromise = repository
          .reserveAttempt({
            lease,
            ceilings: CEILINGS,
            maxAttempts: 2,
            reservedMicroUsd: 100,
            rateVersion: RATE.rateVersion,
            providerId: 'openai',
            modelLabel: MODEL_LABEL,
          })
          .then((r) => {
            reserveSettled = true;
            return r;
          });

        // Deterministic proof of blocking: after 300 ms the reservation has not settled.
        await new Promise((r) => setTimeout(r, 300));
        expect(reserveSettled).toBe(false);

        // Commit A: releases the advisory lock and makes the incident visible.
        await connA.query('COMMIT');

        // The reservation now acquires the lock, sees the incident, and refuses.
        const outcome = await reservePromise;
        expect(reserveSettled).toBe(true);
        expect(outcome.kind).toBe('budget_halted');
        if (outcome.kind === 'budget_halted') {
          expect(outcome.scope).toBe('tenant');
          expect(outcome.reason).toBe('usage_missing');
        }

        // No attempt row was written; the reservation was refused before any money moved.
        expect(await readAttempts(fixture)).toHaveLength(0);
      } finally {
        await connA.query('ROLLBACK').catch(() => undefined);
        connA.release();
      }
    });

    it('a reservation that acquires the lock first is not retroactively invalidated', async () => {
      await resetGlobalSpend();
      const fixture = await createFixture();
      const lease = await claim(fixture);

      // Hold the advisory lock in connection A but do NOT insert any incident.
      const connA = await db.pool.connect();

      try {
        await connA.query('BEGIN');
        await connA.query('SELECT pg_advisory_xact_lock(782, 0)');

        let reserveSettled = false;
        const reservePromise = repository
          .reserveAttempt({
            lease,
            ceilings: CEILINGS,
            maxAttempts: 2,
            reservedMicroUsd: 100,
            rateVersion: RATE.rateVersion,
            providerId: 'openai',
            modelLabel: MODEL_LABEL,
          })
          .then((r) => {
            reserveSettled = true;
            return r;
          });

        await new Promise((r) => setTimeout(r, 300));
        expect(reserveSettled).toBe(false);

        // Commit without inserting an incident: the lock is released, no halt exists.
        await connA.query('COMMIT');

        const outcome = await reservePromise;
        expect(reserveSettled).toBe(true);
        // The reservation succeeds because no incident was ever opened.
        expect(outcome.kind).toBe('reserved');
      } finally {
        await connA.query('ROLLBACK').catch(() => undefined);
        connA.release();
      }
    });
  });
});
