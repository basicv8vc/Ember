import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { B1AssistantTurnDto, B1SendMessageReceipt } from '@ember/contracts';
import {
  B1ProcessCluster,
  type B1Identity,
  type B1ProcessOutputSnapshot,
  type B1SendInput,
} from '../support/b1-process-cluster.js';

const CYCLES = [1, 2] as const;
const OBSERVATION_TIMEOUT_MS = 8_000;
const TURN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

interface StoredTurn {
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly response_message_id: string | null;
}

interface Counts {
  readonly user_messages: string;
  readonly assistant_messages: string;
}

let cluster: B1ProcessCluster;

describe('B1 Worker PostgreSQL outage resilience (bounded stress)', () => {
  beforeEach(async () => {
    cluster = await B1ProcessCluster.start();
  }, 60_000);

  afterEach(async () => {
    if (cluster === undefined) return;
    const unexpectedExit = !cluster.workerIsRunning;
    const snapshot = cluster.workerProcessSnapshot;
    let cleanupError: unknown;
    await cluster.close().catch((error: unknown) => {
      cleanupError = error;
    });
    assertNoSensitiveProcessLogs();

    if (unexpectedExit) {
      if (cleanupError !== undefined && !isOnlyWorkerExit(cleanupError)) {
        throw asError(cleanupError);
      }
      throw new Error(`Worker exited before cleanup: ${JSON.stringify(snapshot)}`);
    }
    if (cleanupError !== undefined) throw asError(cleanupError);
  }, 60_000);

  it.each(CYCLES)(
    'survives an idle Worker outage and resumes after recovery (cycle %i)',
    async (cycle) => {
      const identity = await cluster.signIn(`db-stress-idle-${cycle}`);
      const input = messageInput(identity, `idle-${cycle}`);
      const logOffset = cluster.workerLogs.length;
      const failureStartedAt = new Date().toISOString();
      await cluster.blockDatabaseConnections();
      let outageObservedAt: string | null = null;
      try {
        await expectUnavailableApi(identity, input, true);
        outageObservedAt = new Date().toISOString();
        await waitForWorkerDatabaseFailure(logOffset);
        expectWorkerRunning();
      } finally {
        await cluster.allowDatabaseConnections();
      }

      const restoredAt = new Date().toISOString();
      await waitForApiReady();
      expectWorkerRunning();
      expect(await countsFor(identity, input)).toEqual({
        user_messages: '0',
        assistant_messages: '0',
      });

      // The failed POST was not committed. Replay its same submission key once after recovery.
      const receipt = await cluster.sendReceipt(
        identity,
        identity.me.conversation.conversation_id,
        input,
      );
      const completed = await waitForCompletedTurn(identity, receipt);
      const counts = await assertSingleExchange(identity, input, receipt, completed);
      reportCycle({
        phase: 'idle',
        cycle,
        failureStartedAt,
        outageObservedAt,
        restoredAt,
        turnBefore: 'none',
        turnAfterRecovery: 'none',
        turnFinal: completed.status,
        counts,
        worker: requireWorkerSnapshot(),
      });
    },
    60_000,
  );

  it.each(CYCLES)(
    'recovers a durable running Turn after outage (cycle %i)',
    async (cycle) => {
      const identity = await cluster.signIn(`db-stress-running-${cycle}`);
      const conversationId = identity.me.conversation.conversation_id;
      const input = messageInput(identity, `running-${cycle}`);
      cluster.pauseWorker();
      const receipt = await cluster.sendReceipt(identity, conversationId, input);
      expect(await readStoredTurn(identity, receipt.turn.turn_id)).toMatchObject({
        status: 'running',
        response_message_id: null,
      });

      const logOffset = cluster.workerLogs.length;
      const failureStartedAt = new Date().toISOString();
      await cluster.blockDatabaseConnections();
      let outageObservedAt: string | null = null;
      try {
        await expectUnavailableApi(identity, input, false);
        cluster.resumeWorker();
        await waitForWorkerDatabaseFailure(logOffset);
        outageObservedAt = new Date().toISOString();
        expectWorkerRunning();

        // Hold this same process after its failed DB query to inspect the durable state while the
        // DB is restored. This is a signal pause, never an automatic restart or crash mask.
        cluster.pauseWorker();
      } finally {
        cluster.resumeWorker();
        await cluster.allowDatabaseConnections();
      }

      const restoredAt = new Date().toISOString();
      await waitForApiReady();
      expectWorkerRunning();
      const pending = await readStoredTurn(identity, receipt.turn.turn_id);
      expect(pending).toMatchObject({ status: 'running', response_message_id: null });
      const completed = await waitForCompletedTurn(identity, receipt);
      const counts = await assertSingleExchange(identity, input, receipt, completed);
      reportCycle({
        phase: 'running-turn',
        cycle,
        failureStartedAt,
        outageObservedAt,
        restoredAt,
        turnBefore: 'running',
        turnAfterRecovery: pending?.status,
        turnFinal: completed.status,
        counts,
        worker: requireWorkerSnapshot(),
      });
    },
    60_000,
  );

  it.each(CYCLES)(
    'survives failed initial connection establishment and claims the pending Turn (cycle %i)',
    async (cycle) => {
      const identity = await cluster.signIn(`db-stress-connect-${cycle}`);
      const conversationId = identity.me.conversation.conversation_id;
      const input = messageInput(identity, `connect-${cycle}`);
      const previousWorker = await cluster.stopWorker();
      expect(previousWorker?.exitCode).toBe(0);
      expect(previousWorker?.exitSignal).toBeNull();

      const receipt = await cluster.sendReceipt(identity, conversationId, input);
      expect(await readStoredTurn(identity, receipt.turn.turn_id)).toMatchObject({
        status: 'running',
        response_message_id: null,
      });

      const failureStartedAt = new Date().toISOString();
      await cluster.blockDatabaseConnections();
      let outageObservedAt: string | null = null;
      try {
        const logOffset = cluster.workerLogs.length;
        await cluster.startWorker();
        await expectUnavailableApi(identity, input, false);
        await waitForWorkerDatabaseFailure(logOffset);
        outageObservedAt = new Date().toISOString();
        expectWorkerRunning();
      } finally {
        await cluster.allowDatabaseConnections();
      }

      const restoredAt = new Date().toISOString();
      await waitForApiReady();
      expectWorkerRunning();
      const pending = await readStoredTurn(identity, receipt.turn.turn_id);
      expect(pending).toMatchObject({ status: 'running', response_message_id: null });
      const completed = await waitForCompletedTurn(identity, receipt);
      const counts = await assertSingleExchange(identity, input, receipt, completed);
      reportCycle({
        phase: 'connection-establishment',
        cycle,
        failureStartedAt,
        outageObservedAt,
        restoredAt,
        turnBefore: 'running',
        turnAfterRecovery: pending?.status,
        turnFinal: completed.status,
        counts,
        worker: requireWorkerSnapshot(),
        previousWorker,
      });
    },
  );
});

async function expectUnavailableApi(
  identity: B1Identity,
  input: B1SendInput,
  postMessage: boolean,
): Promise<void> {
  const readiness = await cluster.get('/readyz');
  expect(readiness.status).toBe(503);
  assertSafeUnavailableBody(await readiness.text());
  if (!postMessage) return;

  const response = await cluster.send(identity, identity.me.conversation.conversation_id, input);
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error?: { code?: string; message?: string } };
  expect(body.error?.code).toBe('DB_UNAVAILABLE');
  assertSafeUnavailableBody(JSON.stringify(body));
}

async function waitForWorkerDatabaseFailure(logOffset: number): Promise<void> {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!cluster.workerIsRunning) {
      throw new Error(`Worker exited during injected DB outage: ${cluster.workerExitDiagnostics}`);
    }
    const recent = cluster.workerLogs.slice(logOffset);
    if (
      recent.includes('fake assistant turn iteration failed') ||
      recent.includes('database idle connection error') ||
      recent.includes('reaper tick failed')
    ) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Worker did not observe the injected DB outage: ${cluster.workerExitDiagnostics}`,
  );
}

async function waitForApiReady(): Promise<void> {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await cluster.get('/readyz');
    if (response.status === 200) return;
    expect(response.status).toBe(503);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('API did not recover its database connection within the bounded window');
}

async function readStoredTurn(
  identity: B1Identity,
  turnId: string,
): Promise<StoredTurn | undefined> {
  const result = await cluster.observerPool.query<StoredTurn>(
    `SELECT status, response_message_id
       FROM assistant_turns
      WHERE tenant_id = (SELECT tenant_id FROM consumers WHERE id = $1)
        AND id = $2`,
    [identity.session.consumer_id, turnId],
  );
  return result.rows[0];
}

async function waitForCompletedTurn(
  identity: B1Identity,
  receipt: B1SendMessageReceipt,
): Promise<B1AssistantTurnDto> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await cluster.readTurn(
      identity,
      identity.me.conversation.conversation_id,
      receipt.turn.turn_id,
    );
    if (result.response.status === 503) {
      await delay(POLL_INTERVAL_MS);
      continue;
    }
    expect(result.response.status).toBe(200);
    const turn = result.turn;
    expect(turn).toBeDefined();
    if (turn === undefined) throw new Error('successful Turn poll omitted its parsed response');
    if (turn.status === 'completed') return turn;
    expect(turn.status).toBe('running');
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error('Assistant Turn did not complete within the bounded recovery window');
}

async function assertSingleExchange(
  identity: B1Identity,
  input: B1SendInput,
  receipt: B1SendMessageReceipt,
  turn: B1AssistantTurnDto,
): Promise<Counts> {
  expect(turn.status).toBe('completed');
  expect(turn.response_message_id).not.toBeNull();

  const page = await cluster.readPage(identity, identity.me.conversation.conversation_id);
  const users = page.messages.filter(
    (message) =>
      message.kind === 'user' && message.client_submission_id === input.client_submission_id,
  );
  const replies = page.messages.filter((message) => message.kind === 'ember');
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ message_id: receipt.message.message_id, text: input.text });
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ simulated: true, message_id: turn.response_message_id });
  if (replies[0]?.kind !== 'ember') throw new Error('simulated assistant reply is missing');
  expect(replies[0].text).toMatch(/^\[Simulated reply/i);

  const result = await cluster.observerPool.query<Counts>(
    `SELECT
       (SELECT count(*)::text FROM conversation_messages
         WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'user'
           AND client_submission_id = $3) AS user_messages,
       (SELECT count(*)::text FROM conversation_messages
         WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'
       ) AS assistant_messages`,
    [
      await cluster.tenantIdFor(identity),
      identity.me.conversation.conversation_id,
      input.client_submission_id,
    ],
  );
  expect(result.rows[0]).toEqual({ user_messages: '1', assistant_messages: '1' });
  return result.rows[0]!;
}

async function countsFor(identity: B1Identity, input: B1SendInput): Promise<Counts> {
  const result = await cluster.observerPool.query<Counts>(
    `SELECT
       (SELECT count(*)::text FROM conversation_messages
         WHERE tenant_id = $1 AND kind = 'user' AND client_submission_id = $2) AS user_messages,
       (SELECT count(*)::text FROM conversation_messages
         WHERE tenant_id = $1 AND conversation_id = $3 AND kind = 'ember') AS assistant_messages`,
    [
      await cluster.tenantIdFor(identity),
      input.client_submission_id,
      identity.me.conversation.conversation_id,
    ],
  );
  return result.rows[0]!;
}

function messageInput(identity: B1Identity, label: string): B1SendInput {
  return {
    client_submission_id: randomUUID(),
    text: `private database resilience ${label} ${randomUUID()}`,
    transcript_epoch: identity.me.conversation.transcript_epoch,
  };
}

function expectWorkerRunning(): void {
  expect(cluster.workerIsRunning, cluster.workerExitDiagnostics).toBe(true);
}

function assertSafeUnavailableBody(body: string): void {
  if (body.includes(cluster.databaseName) || /ECONN|postgres:\/\//i.test(body)) {
    throw new Error('the database failure response exposed connection diagnostics');
  }
  const password = decodeURIComponent(new URL(cluster.databaseUrl).password);
  if (password.length > 0 && body.includes(password)) {
    throw new Error('the database failure response exposed the database password');
  }
  if ([...cluster.sensitiveValues].some((value) => value.length > 0 && body.includes(value))) {
    throw new Error('the database failure response exposed a session token or private message');
  }
}

function assertNoSensitiveProcessLogs(): void {
  const logs = cluster.logs();
  const databaseUrl = new URL(cluster.databaseUrl);
  const sensitiveValues = [
    ...cluster.sensitiveValues,
    cluster.databaseName,
    cluster.databaseUrl,
    databaseUrl.username,
    databaseUrl.password,
    decodeURIComponent(databaseUrl.username),
    decodeURIComponent(databaseUrl.password),
  ];
  if (sensitiveValues.some((value) => value.length > 0 && logs.includes(value))) {
    throw new Error(
      'a database credential, provider assertion, session token, or private message appeared in process logs',
    );
  }
}

function requireWorkerSnapshot(): B1ProcessOutputSnapshot {
  const snapshot = cluster.workerProcessSnapshot;
  if (snapshot === undefined) throw new Error('Worker process snapshot is unavailable');
  expect(snapshot.exitCode).toBeNull();
  expect(snapshot.exitSignal).toBeNull();
  return snapshot;
}

function reportCycle(input: {
  readonly phase: string;
  readonly cycle: number;
  readonly failureStartedAt: string;
  readonly outageObservedAt: string | null;
  readonly restoredAt: string;
  readonly turnBefore: string;
  readonly turnAfterRecovery: string | undefined;
  readonly turnFinal: string;
  readonly counts: Counts;
  readonly worker: B1ProcessOutputSnapshot;
  readonly previousWorker?: B1ProcessOutputSnapshot;
}): void {
  process.stdout.write(
    `[b1-db-stress] ${JSON.stringify({
      ...input,
      duplicateAssistantMessages: Math.max(0, Number(input.counts.assistant_messages) - 1),
      worker: snapshotForReport(input.worker),
      previousWorker:
        input.previousWorker === undefined ? undefined : snapshotForReport(input.previousWorker),
    })}\n`,
  );
}

function snapshotForReport(snapshot: B1ProcessOutputSnapshot): B1ProcessOutputSnapshot {
  return {
    pid: snapshot.pid,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
  };
}

function isOnlyWorkerExit(error: unknown): boolean {
  if (!(error instanceof AggregateError)) return false;
  const errors = error.errors;
  return (
    errors.length === 1 &&
    errors[0] instanceof Error &&
    /^apps\/worker\/src\/index\.ts process exited unexpectedly \(/.test(errors[0].message)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
