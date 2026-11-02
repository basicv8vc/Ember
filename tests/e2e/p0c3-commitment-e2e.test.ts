import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommitmentDto, CommitmentReceiptDto } from '@ember/contracts';
import { E2eCluster } from './support/e2e-cluster.js';

describe('P0-C3A E2E Commitment HTTP API & Real PostgreSQL', () => {
  let cluster: E2eCluster;
  let agentId: string;

  beforeAll(async () => {
    cluster = await E2eCluster.start({ startWorker: false });

    // Provision an agent via HTTP POST /v1/agents for tenantA
    const res = await cluster.fetch('/v1/agents', {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { name: 'Commitment-E2E-Agent' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent_id: string };
    agentId = body.agent_id;
  });

  afterAll(async () => {
    await cluster?.stop();
  });

  it('creates a commitment via POST /v1/commitments with Idempotency-Key and replays safely', async () => {
    const idempotencyKey = `e2e-idem-${randomUUID()}`;
    const payload = {
      agent_id: agentId,
      title: 'Check for high priority support tickets',
      schedule_kind: 'interval',
      interval_seconds: 900,
      source_profile_id: 'acc-work-gmail',
    };

    // First request: 201 Created
    const res1 = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: payload,
    });
    expect(res1.status).toBe(201);

    const receipt1 = (await res1.json()) as CommitmentReceiptDto;
    expect(receipt1.commitment_id).toBeDefined();
    expect(receipt1.status).toBe('active');
    expect(receipt1.replayed).toBe(false);
    expect(res1.headers.get('location')).toBe(`/v1/commitments/${receipt1.commitment_id}`);

    // Exact replay with same Idempotency-Key: 200 OK
    const res2 = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: payload,
    });
    expect(res2.status).toBe(200);
    const receipt2 = (await res2.json()) as CommitmentReceiptDto;
    expect(receipt2.commitment_id).toBe(receipt1.commitment_id);
    expect(receipt2.replayed).toBe(true);

    // Conflict with different payload under same Idempotency-Key: 409 Conflict
    const res3 = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        ...payload,
        title: 'Different title that triggers fingerprint conflict',
      },
    });
    expect(res3.status).toBe(409);
    const errBody = (await res3.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('supports retrieval and list filtering via GET /v1/commitments', async () => {
    const idempotencyKey = `e2e-list-${randomUUID()}`;
    const payload = {
      agent_id: agentId,
      title: 'List retrieval test',
      schedule_kind: 'interval',
      interval_seconds: 1800,
      source_profile_id: 'acc-listing-test',
    };

    const createRes = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: payload,
    });
    expect(createRes.status).toBe(201);
    const receipt = (await createRes.json()) as CommitmentReceiptDto;

    // Single item GET /v1/commitments/:id
    const getRes = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}`, {
      method: 'GET',
      token: cluster.tenantA.token,
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as CommitmentDto;
    expect(fetched.commitment_id).toBe(receipt.commitment_id);
    expect(fetched.title).toBe('List retrieval test');
    expect(fetched.schedule_kind).toBe('interval');
    expect(fetched.interval_seconds).toBe(1800);
    expect(fetched.source_profile_id).toBe('acc-listing-test');

    // List GET /v1/commitments
    const listRes = await cluster.fetch('/v1/commitments?status=active', {
      method: 'GET',
      token: cluster.tenantA.token,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      commitments: CommitmentDto[];
      next_cursor?: string;
    };
    expect(Array.isArray(listBody.commitments)).toBe(true);
    expect(listBody.commitments.some((c) => c.commitment_id === receipt.commitment_id)).toBe(true);
  });

  it('enforces CAS optimistic concurrency and state transitions: pause -> resume -> cancel', async () => {
    const idempotencyKey = `e2e-cas-${randomUUID()}`;
    const createRes = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        agent_id: agentId,
        title: 'CAS lifecycle test',
        schedule_kind: 'interval',
        interval_seconds: 900,
        source_profile_id: 'acc-cas-test',
      },
    });
    expect(createRes.status).toBe(201);
    const receipt = (await createRes.json()) as CommitmentReceiptDto;
    expect(receipt.status).toBe('active');

    // Stale pause (wrong expected_version)
    const stalePause = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/pause`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { expected_version: 999 },
    });
    expect(stalePause.status).toBe(409);
    const staleErr = (await stalePause.json()) as { error: { code: string } };
    expect(staleErr.error.code).toBe('INVALID_STATE_TRANSITION');

    // Valid pause (expected_version: 1)
    const pauseRes = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/pause`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { expected_version: 1 },
    });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as CommitmentDto;
    expect(paused.status).toBe('paused');
    expect(paused.version).toBe(2);

    // Valid resume (expected_version: 2)
    const resumeRes = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/resume`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { expected_version: 2 },
    });
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as CommitmentDto;
    expect(resumed.status).toBe('active');
    expect(resumed.version).toBe(3);

    // Valid cancel (expected_version: 3)
    const cancelRes = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/cancel`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { expected_version: 3 },
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as CommitmentDto;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.version).toBe(4);

    // Illegal state transition on cancelled commitment
    const illegalPause = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/pause`, {
      method: 'POST',
      token: cluster.tenantA.token,
      body: { expected_version: 4 },
    });
    expect(illegalPause.status).toBe(409);
    const illegalErr = (await illegalPause.json()) as { error: { code: string } };
    expect(illegalErr.error.code).toBe('INVALID_STATE_TRANSITION');

    // Verify completed -> cancelled is strictly rejected with 409 INVALID_STATE_TRANSITION
    const compKey = `e2e-comp-${randomUUID()}`;
    const compCreateRes = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': compKey },
      body: {
        agent_id: agentId,
        title: 'Completed transition test',
        schedule_kind: 'interval',
        interval_seconds: 900,
        source_profile_id: 'acc-cas-test',
      },
    });
    expect(compCreateRes.status).toBe(201);
    const compReceipt = (await compCreateRes.json()) as CommitmentReceiptDto;

    // Mark completed via repository
    await cluster.commitments.markCommitmentCompleted(compReceipt.commitment_id);

    // Cancel on completed commitment must fail with 409 INVALID_STATE_TRANSITION
    const compCancelRes = await cluster.fetch(
      `/v1/commitments/${compReceipt.commitment_id}/cancel`,
      {
        method: 'POST',
        token: cluster.tenantA.token,
      },
    );
    expect(compCancelRes.status).toBe(409);
    const compCancelErr = (await compCancelRes.json()) as { error: { code: string } };
    expect(compCancelErr.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('guarantees tenant isolation: Tenant B cannot access or mutate Tenant A commitments', async () => {
    const idempotencyKey = `e2e-tenant-${randomUUID()}`;
    const createRes = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        agent_id: agentId,
        title: 'Tenant isolation test',
        schedule_kind: 'interval',
        interval_seconds: 900,
        source_profile_id: 'acc-tenant-test',
      },
    });
    expect(createRes.status).toBe(201);
    const tenantAReceipt = (await createRes.json()) as CommitmentReceiptDto;

    // Tenant B attempts to read Tenant A's commitment -> 404
    const getRes = await cluster.fetch(`/v1/commitments/${tenantAReceipt.commitment_id}`, {
      method: 'GET',
      token: cluster.tenantB.token,
    });
    expect(getRes.status).toBe(404);
    const getErr = (await getRes.json()) as { error: { code: string } };
    expect(getErr.error.code).toBe('NOT_FOUND');

    // Tenant B attempts to pause Tenant A's commitment -> 404
    const pauseRes = await cluster.fetch(`/v1/commitments/${tenantAReceipt.commitment_id}/pause`, {
      method: 'POST',
      token: cluster.tenantB.token,
      body: { expected_version: 1 },
    });
    expect(pauseRes.status).toBe(404);
    const pauseErr = (await pauseRes.json()) as { error: { code: string } };
    expect(pauseErr.error.code).toBe('NOT_FOUND');

    // Tenant B lists commitments -> Tenant A's commitment is not present
    const listRes = await cluster.fetch('/v1/commitments', {
      method: 'GET',
      token: cluster.tenantB.token,
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { commitments: CommitmentDto[] };
    expect(listBody.commitments.some((c) => c.commitment_id === tenantAReceipt.commitment_id)).toBe(
      false,
    );
  });

  it('queries outcomes via GET /v1/commitments/:id/outcomes', async () => {
    const idempotencyKey = `e2e-outcomes-${randomUUID()}`;
    const createRes = await cluster.fetch('/v1/commitments', {
      method: 'POST',
      token: cluster.tenantA.token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        agent_id: agentId,
        title: 'Outcome endpoint query test',
        schedule_kind: 'interval',
        interval_seconds: 900,
        source_profile_id: 'acc-outcomes-test',
      },
    });
    expect(createRes.status).toBe(201);
    const receipt = (await createRes.json()) as CommitmentReceiptDto;

    const res = await cluster.fetch(`/v1/commitments/${receipt.commitment_id}/outcomes`, {
      method: 'GET',
      token: cluster.tenantA.token,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commitment_id: string;
      outcomes: unknown[];
      next_cursor?: string;
    };
    expect(body.commitment_id).toBe(receipt.commitment_id);
    expect(Array.isArray(body.outcomes)).toBe(true);
    expect(body.outcomes).toHaveLength(0);
  });
});
