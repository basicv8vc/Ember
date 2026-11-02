import { createHash, randomUUID } from 'node:crypto';
import type {
  CommitmentDto,
  CommitmentOutcomeDto,
  CommitmentReceiptDto,
  CommitmentRepository,
  CreateCommitmentCommand,
  ListCommitmentsOptions,
  ListOutcomesOptions,
  StateTransitionOptions,
} from '@ember/contracts';
import { DomainError, type AuthContext, type Id } from '@ember/domain';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { createDevTokenAuthenticator } from '../../apps/api/src/auth/bearer-authenticator.js';
import {
  COMMITMENTS_PATH,
  IDEMPOTENCY_KEY_HEADER,
} from '../../apps/api/src/commitments/constants.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_A = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_B = '44444444-4444-4444-8444-444444444444';
const AGENT_A = '55555555-5555-4555-8555-555555555555';

const TOKEN_A = 'test-token-tenant-a-auth-secret';
const TOKEN_B = 'test-token-tenant-b-auth-secret';

class FakeCommitmentStore implements CommitmentRepository {
  readonly commitments = new Map<string, CommitmentDto>();
  readonly fingerprints = new Map<string, string>(); // `${tenantId}:${idempotencyKey}` -> fingerprint
  readonly idempotencyIds = new Map<string, string>(); // `${tenantId}:${idempotencyKey}` -> commitmentId
  readonly outcomes = new Map<string, CommitmentOutcomeDto[]>(); // commitmentId -> outcomes

  private computeFingerprint(cmd: CreateCommitmentCommand): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          agentId: cmd.agentId,
          title: cmd.title,
          scheduleKind: cmd.scheduleKind,
          intervalSeconds: cmd.intervalSeconds ?? null,
          dueAt: cmd.dueAt ? cmd.dueAt.toISOString() : null,
          sourceProfileId: cmd.sourceProfileId,
        }),
      )
      .digest('hex');
  }

  async create(
    ctx: AuthContext,
    cmd: CreateCommitmentCommand,
  ): Promise<{ readonly commitment: CommitmentDto; readonly replayed: boolean }> {
    await Promise.resolve();
    const key = `${ctx.tenantId}:${cmd.idempotencyKey}`;
    const fingerprint = this.computeFingerprint(cmd);

    const existingId = this.idempotencyIds.get(key);
    if (existingId !== undefined) {
      const existingFingerprint = this.fingerprints.get(key);
      if (existingFingerprint === fingerprint) {
        const existing = this.commitments.get(existingId)!;
        return { commitment: existing, replayed: true };
      }
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key conflicts with an existing commitment',
      );
    }

    const commitmentId = randomUUID();
    const nowIso = new Date().toISOString();
    const commitment: CommitmentDto = {
      commitment_id: commitmentId,
      tenant_id: ctx.tenantId,
      agent_id: cmd.agentId,
      title: cmd.title,
      status: 'active',
      schedule_kind: cmd.scheduleKind,
      interval_seconds: cmd.intervalSeconds ?? null,
      next_due_at: cmd.dueAt ? cmd.dueAt.toISOString() : nowIso,
      source_profile_id: cmd.sourceProfileId,
      version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    };

    this.commitments.set(commitmentId, commitment);
    this.fingerprints.set(key, fingerprint);
    this.idempotencyIds.set(key, commitmentId);

    return { commitment, replayed: false };
  }

  async get(ctx: AuthContext, commitmentId: Id): Promise<CommitmentDto | null> {
    await Promise.resolve();
    const commitment = this.commitments.get(commitmentId);
    if (!commitment || commitment.tenant_id !== ctx.tenantId) {
      return null;
    }
    return commitment;
  }

  async list(
    ctx: AuthContext,
    options?: ListCommitmentsOptions,
  ): Promise<{ readonly commitments: readonly CommitmentDto[]; readonly nextCursor?: string }> {
    await Promise.resolve();
    const list = Array.from(this.commitments.values()).filter(
      (c) =>
        c.tenant_id === ctx.tenantId &&
        (options?.status === undefined || c.status === options.status),
    );
    return { commitments: list };
  }

  async pause(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    const commitment = await this.get(ctx, commitmentId);
    if (!commitment) {
      throw new DomainError('NOT_FOUND', 'Commitment not found');
    }
    if (options?.expectedVersion !== undefined && commitment.version !== options.expectedVersion) {
      throw new DomainError('INVALID_STATE_TRANSITION', 'Version conflict');
    }
    if (commitment.status === 'paused') {
      return commitment;
    }
    if (commitment.status === 'completed' || commitment.status === 'cancelled') {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Cannot pause commitment in ${commitment.status}`,
      );
    }

    const updated: CommitmentDto = {
      ...commitment,
      status: 'paused',
      version: commitment.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.commitments.set(commitmentId, updated);
    return updated;
  }

  async resume(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    const commitment = await this.get(ctx, commitmentId);
    if (!commitment) {
      throw new DomainError('NOT_FOUND', 'Commitment not found');
    }
    if (options?.expectedVersion !== undefined && commitment.version !== options.expectedVersion) {
      throw new DomainError('INVALID_STATE_TRANSITION', 'Version conflict');
    }
    if (commitment.status === 'active') {
      return commitment;
    }
    if (commitment.status === 'completed' || commitment.status === 'cancelled') {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Cannot resume commitment in ${commitment.status}`,
      );
    }

    const updated: CommitmentDto = {
      ...commitment,
      status: 'active',
      version: commitment.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.commitments.set(commitmentId, updated);
    return updated;
  }

  async cancel(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto> {
    const commitment = await this.get(ctx, commitmentId);
    if (!commitment) {
      throw new DomainError('NOT_FOUND', 'Commitment not found');
    }
    if (options?.expectedVersion !== undefined && commitment.version !== options.expectedVersion) {
      throw new DomainError('INVALID_STATE_TRANSITION', 'Version conflict');
    }
    if (commitment.status === 'cancelled') {
      return commitment;
    }
    if (commitment.status === 'completed') {
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'Cannot cancel a commitment in completed status',
      );
    }

    const updated: CommitmentDto = {
      ...commitment,
      status: 'cancelled',
      next_due_at: null,
      version: commitment.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.commitments.set(commitmentId, updated);
    return updated;
  }

  async listOutcomes(
    ctx: AuthContext,
    commitmentId: Id,
    _options?: ListOutcomesOptions,
  ): Promise<{
    readonly outcomes: readonly CommitmentOutcomeDto[];
    readonly nextCursor?: string;
  } | null> {
    const commitment = await this.get(ctx, commitmentId);
    if (!commitment) {
      return null;
    }
    return { outcomes: this.outcomes.get(commitmentId) ?? [] };
  }

  markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean> {
    const commitment = this.commitments.get(commitmentId);
    if (!commitment || commitment.status !== 'active') {
      return Promise.resolve(false);
    }
    if (expectedVersion !== undefined && commitment.version !== expectedVersion) {
      return Promise.resolve(false);
    }
    this.commitments.set(commitmentId, {
      ...commitment,
      status: 'completed',
      next_due_at: null,
      version: commitment.version + 1,
      updated_at: new Date().toISOString(),
    });
    return Promise.resolve(true);
  }
}

describe('P0-C3A Commitment HTTP API', () => {
  function setupTestApp() {
    const store = new FakeCommitmentStore();
    const authenticator = createDevTokenAuthenticator([
      {
        token: TOKEN_A,
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        policyVersion: 1,
      },
      {
        token: TOKEN_B,
        tenantId: TENANT_B,
        principalId: PRINCIPAL_B,
        policyVersion: 1,
      },
    ]);

    const app = createApp({
      authenticator,
      commitmentStore: store,
    });

    return { app, store };
  }

  describe('Authentication & Headers', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { app } = setupTestApp();
      const res = await app.request(COMMITMENTS_PATH, {
        method: 'GET',
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Bearer token is invalid or unknown', async () => {
      const { app } = setupTestApp();
      const res = await app.request(COMMITMENTS_PATH, {
        method: 'GET',
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when POST /v1/commitments is missing Idempotency-Key header', async () => {
      const { app } = setupTestApp();
      const res = await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: AGENT_A,
          title: 'Missing key test',
          schedule_kind: 'interval',
          interval_seconds: 900,
          source_profile_id: 'fixture.github-release',
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('INVALID_ARGUMENT');
      expect(json.error.message).toBe('Invalid request input');
    });
  });

  describe('POST /v1/commitments (Creation & Idempotency)', () => {
    it('creates a commitment with 201 Created and Location header', async () => {
      const { app } = setupTestApp();
      const idempotencyKey = 'key-test-create-01';

      const res = await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify({
          agent_id: AGENT_A,
          title: 'Durable watch task',
          schedule_kind: 'interval',
          interval_seconds: 900,
          source_profile_id: 'fixture.github-release',
        }),
      });

      expect(res.status).toBe(201);
      const location = res.headers.get('Location');
      expect(location).toMatch(new RegExp(`^${COMMITMENTS_PATH}/[0-9a-f-]+$`));

      const json = (await res.json()) as CommitmentReceiptDto;
      expect(json.status).toBe('active');
      expect(json.replayed).toBe(false);
      expect(json.commitment_id).toBeDefined();
    });

    it('replays with 200 OK and replayed: true for identical request and key', async () => {
      const { app } = setupTestApp();
      const idempotencyKey = 'key-test-replay-01';
      const body = JSON.stringify({
        agent_id: AGENT_A,
        title: 'Replay test',
        schedule_kind: 'interval',
        interval_seconds: 900,
        source_profile_id: 'fixture.github-release',
      });

      const firstRes = await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body,
      });
      expect(firstRes.status).toBe(201);
      const firstJson = (await firstRes.json()) as CommitmentReceiptDto;

      const secondRes = await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body,
      });
      expect(secondRes.status).toBe(200);
      const secondJson = (await secondRes.json()) as CommitmentReceiptDto;
      expect(secondJson.commitment_id).toBe(firstJson.commitment_id);
      expect(secondJson.replayed).toBe(true);
    });

    it('fails with 409 IDEMPOTENCY_CONFLICT when key matches but payload differs', async () => {
      const { app } = setupTestApp();
      const idempotencyKey = 'key-test-conflict-01';

      await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify({
          agent_id: AGENT_A,
          title: 'Original Title',
          schedule_kind: 'interval',
          interval_seconds: 900,
          source_profile_id: 'fixture.github-release',
        }),
      });

      const conflictRes = await app.request(COMMITMENTS_PATH, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_A}`,
          'Content-Type': 'application/json',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify({
          agent_id: AGENT_A,
          title: 'Different Title',
          schedule_kind: 'interval',
          interval_seconds: 900,
          source_profile_id: 'fixture.github-release',
        }),
      });

      expect(conflictRes.status).toBe(409);
      const json = (await conflictRes.json()) as { error: { code: string } };
      expect(json.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('GET /v1/commitments and /:id', () => {
    it('lists commitments scoped to authenticated tenant only', async () => {
      const { app, store } = setupTestApp();
      const ctxA: AuthContext = { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 };
      const ctxB: AuthContext = { tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 };

      await store.create(ctxA, {
        idempotencyKey: 't-a-1',
        agentId: AGENT_A,
        title: 'Tenant A Commitment',
        scheduleKind: 'once',
        sourceProfileId: 'fixture.github-release',
      });

      await store.create(ctxB, {
        idempotencyKey: 't-b-1',
        agentId: AGENT_A,
        title: 'Tenant B Commitment',
        scheduleKind: 'once',
        sourceProfileId: 'fixture.github-release',
      });

      const resA = await app.request(COMMITMENTS_PATH, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      expect(resA.status).toBe(200);
      const jsonA = (await resA.json()) as { commitments: Array<{ title: string }> };
      expect(jsonA.commitments).toHaveLength(1);
      expect(jsonA.commitments[0]?.title).toBe('Tenant A Commitment');
    });

    it('returns uniform 404 for missing or foreign tenant commitment', async () => {
      const { app, store } = setupTestApp();
      const ctxB: AuthContext = { tenantId: TENANT_B, principalId: PRINCIPAL_B, policyVersion: 1 };

      const { commitment } = await store.create(ctxB, {
        idempotencyKey: 't-b-2',
        agentId: AGENT_A,
        title: 'Tenant B Only',
        scheduleKind: 'once',
        sourceProfileId: 'fixture.github-release',
      });

      // Tenant A tries to read Tenant B's commitment
      const res = await app.request(`${COMMITMENTS_PATH}/${commitment.commitment_id}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  describe('State Transitions (pause / resume / cancel)', () => {
    it('pauses and resumes commitment with 200 OK and version increments', async () => {
      const { app, store } = setupTestApp();
      const ctxA: AuthContext = { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 };
      const { commitment } = await store.create(ctxA, {
        idempotencyKey: 'trans-01',
        agentId: AGENT_A,
        title: 'Transition Test',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      // Pause
      const pauseRes = await app.request(`${COMMITMENTS_PATH}/${commitment.commitment_id}/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      expect(pauseRes.status).toBe(200);
      const paused = (await pauseRes.json()) as { status: string; version: number };
      expect(paused.status).toBe('paused');
      expect(paused.version).toBe(2);

      // Resume
      const resumeRes = await app.request(
        `${COMMITMENTS_PATH}/${commitment.commitment_id}/resume`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN_A}` },
        },
      );
      expect(resumeRes.status).toBe(200);
      const resumed = (await resumeRes.json()) as { status: string; version: number };
      expect(resumed.status).toBe('active');
      expect(resumed.version).toBe(3);
    });

    it('cancels commitment and rejects subsequent pause attempts with 409', async () => {
      const { app, store } = setupTestApp();
      const ctxA: AuthContext = { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 };
      const { commitment } = await store.create(ctxA, {
        idempotencyKey: 'cancel-01',
        agentId: AGENT_A,
        title: 'Cancel Test',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      // Cancel
      const cancelRes = await app.request(
        `${COMMITMENTS_PATH}/${commitment.commitment_id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN_A}` },
        },
      );
      expect(cancelRes.status).toBe(200);
      const cancelled = (await cancelRes.json()) as { status: string; next_due_at: unknown };
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.next_due_at).toBeNull();

      // Subsequent pause must be rejected
      const pauseRes = await app.request(`${COMMITMENTS_PATH}/${commitment.commitment_id}/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      expect(pauseRes.status).toBe(409);
      const json = (await pauseRes.json()) as { error: { code: string } };
      expect(json.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('rejects cancellation of a completed commitment with 409 INVALID_STATE_TRANSITION', async () => {
      const { app, store } = setupTestApp();
      const ctxA: AuthContext = { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 };
      const { commitment } = await store.create(ctxA, {
        idempotencyKey: 'completed-cancel-01',
        agentId: AGENT_A,
        title: 'Completed Commitment Test',
        scheduleKind: 'once',
        sourceProfileId: 'fixture.github-release',
      });

      // Mark commitment completed
      await store.markCommitmentCompleted(commitment.commitment_id);

      // Attempting to cancel a completed commitment must fail with 409
      const cancelRes = await app.request(
        `${COMMITMENTS_PATH}/${commitment.commitment_id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN_A}` },
        },
      );
      expect(cancelRes.status).toBe(409);
      const json = (await cancelRes.json()) as { error: { code: string } };
      expect(json.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('GET /v1/commitments/:id/outcomes', () => {
    it('returns paginated outcomes for a tenant-owned commitment', async () => {
      const { app, store } = setupTestApp();
      const ctxA: AuthContext = { tenantId: TENANT_A, principalId: PRINCIPAL_A, policyVersion: 1 };
      const { commitment } = await store.create(ctxA, {
        idempotencyKey: 'outcomes-01',
        agentId: AGENT_A,
        title: 'Outcomes Test',
        scheduleKind: 'interval',
        intervalSeconds: 900,
        sourceProfileId: 'fixture.github-release',
      });

      const outcome: CommitmentOutcomeDto = {
        outcome_id: randomUUID(),
        commitment_id: commitment.commitment_id,
        occurrence_id: randomUUID(),
        task_id: randomUUID(),
        summary: 'Detected new v1.2 release notes without sensitive data.',
        result_status: 'meaningful_change',
        created_at: new Date().toISOString(),
      };
      store.outcomes.set(commitment.commitment_id, [outcome]);

      const res = await app.request(`${COMMITMENTS_PATH}/${commitment.commitment_id}/outcomes`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        commitment_id: string;
        outcomes: Array<{ result_status: string }>;
      };
      expect(json.commitment_id).toBe(commitment.commitment_id);
      expect(json.outcomes).toHaveLength(1);
      expect(json.outcomes[0]?.result_status).toBe('meaningful_change');
    });
  });
});
