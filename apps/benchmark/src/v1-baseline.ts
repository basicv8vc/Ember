import { randomBytes, randomUUID } from 'node:crypto';
import type { Id } from '@ember/domain';
import { resolveBenchmarkGitSha } from './evidence.js';
import { createBenchmarkHarness, type BenchmarkHarness } from './harness.js';
import {
  assertPositiveSafeInt,
  assertValidConcurrencyLevels,
  resolveSafeLocalDatabaseUrl,
} from './local-guard.js';
import { calculateDistribution } from './metrics.js';
import { collectMachineSpecs, TelemetryCollector } from './telemetry.js';
import type {
  EndpointLatencySummary,
  PostgresTableStatDelta,
  V1BaselineReport,
  V1BaselineWorkloadStats,
} from './v2-types.js';

export interface V1BaselineOptions {
  readonly databaseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly concurrencyLevels?: readonly number[];
  readonly requestsPerLevel?: number;
  readonly workerConcurrency?: number;
  readonly enableLocalLoad?: boolean;
  readonly fakeTurnPollIntervalMs?: number;
  readonly log?: (message: string) => void;
}

interface ConsumerSessionContext {
  readonly accessToken: string;
  readonly conversationId: Id;
  readonly transcriptEpoch: number;
}

interface PgStatRow {
  readonly relname: string;
  readonly n_tup_ins: string;
  readonly n_tup_upd: string;
  readonly n_tup_del: string;
  readonly n_live_tup: string;
  readonly total_bytes: string;
}

const TRACKED_BUSINESS_TABLES = [
  'conversation_messages',
  'assistant_turns',
  'conversations',
  'tasks',
  'runs',
  'task_events',
  'budget_operations',
  'staged_blobs',
  'artifacts',
  'blobs',
  'step_checkpoints',
  'workspace_versions',
  'task_results',
  'operation_receipts',
] as const;

async function readExactTableRowCounts(
  harness: BenchmarkHarness,
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of TRACKED_BUSINESS_TABLES) {
    const res = await harness.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${table}"`,
    );
    counts[table] = parseInt(res.rows[0]?.count ?? '0', 10) || 0;
  }
  return counts;
}

function diffExactTableRowCounts(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): { readonly deltas: Readonly<Record<string, number>>; readonly totalInserted: number } {
  const deltas: Record<string, number> = {};
  let totalInserted = 0;
  for (const table of TRACKED_BUSINESS_TABLES) {
    const delta = (after[table] ?? 0) - (before[table] ?? 0);
    if (delta !== 0) {
      deltas[table] = delta;
      if (delta > 0) totalInserted += delta;
    }
  }
  return { deltas, totalInserted };
}

async function readPgSchemaStats(
  harness: BenchmarkHarness,
): Promise<ReadonlyMap<string, PostgresTableStatDelta>> {
  // Force stats flush visibility on the querying session; note that pooled idle connections
  // in PG17 may still retain buffered deltas until their backend cycles or stats interval fires.
  await new Promise((resolve) => setTimeout(resolve, 650));
  await harness.pool.query('SELECT pg_stat_clear_snapshot()').catch(() => undefined);

  const res = await harness.pool.query<PgStatRow>(
    `SELECT relname,
            n_tup_ins::text AS n_tup_ins,
            n_tup_upd::text AS n_tup_upd,
            n_tup_del::text AS n_tup_del,
            n_live_tup::text AS n_live_tup,
            pg_total_relation_size(relid)::text AS total_bytes
       FROM pg_stat_user_tables
      WHERE schemaname = $1
      ORDER BY relname ASC`,
    [harness.schema],
  );

  const map = new Map<string, PostgresTableStatDelta>();
  for (const row of res.rows) {
    const inserts = parseInt(row.n_tup_ins, 10) || 0;
    const updates = parseInt(row.n_tup_upd, 10) || 0;
    const deletes = parseInt(row.n_tup_del, 10) || 0;
    map.set(row.relname, {
      tableName: row.relname,
      inserts,
      updates,
      deletes,
      totalMutations: inserts + updates + deletes,
      liveRowsAfter: parseInt(row.n_live_tup, 10) || 0,
      totalBytesAfter: parseInt(row.total_bytes, 10) || 0,
    });
  }
  return map;
}

function diffPgSchemaStats(
  before: ReadonlyMap<string, PostgresTableStatDelta>,
  after: ReadonlyMap<string, PostgresTableStatDelta>,
): {
  readonly tables: readonly PostgresTableStatDelta[];
  readonly totalLogicalMutations: number;
  readonly totalSchemaBytesAfter: number;
} {
  const tables: PostgresTableStatDelta[] = [];
  let totalLogicalMutations = 0;
  let totalSchemaBytesAfter = 0;

  for (const [name, curr] of after.entries()) {
    const prev = before.get(name);
    const inserts = Math.max(0, curr.inserts - (prev?.inserts ?? 0));
    const updates = Math.max(0, curr.updates - (prev?.updates ?? 0));
    const deletes = Math.max(0, curr.deletes - (prev?.deletes ?? 0));
    const totalMutations = inserts + updates + deletes;
    totalLogicalMutations += totalMutations;
    totalSchemaBytesAfter += curr.totalBytesAfter;

    if (totalMutations > 0 || curr.liveRowsAfter > 0) {
      tables.push({
        tableName: name,
        inserts,
        updates,
        deletes,
        totalMutations,
        liveRowsAfter: curr.liveRowsAfter,
        totalBytesAfter: curr.totalBytesAfter,
      });
    }
  }

  tables.sort((a, b) => b.totalMutations - a.totalMutations);
  return { tables, totalLogicalMutations, totalSchemaBytesAfter };
}

async function runConcurrentOperations(
  concurrency: number,
  totalOps: number,
  fn: (index: number) => Promise<boolean>,
): Promise<{
  readonly latenciesMs: readonly number[];
  readonly successCount: number;
  readonly errorCount: number;
  readonly totalWallMs: number;
}> {
  const latenciesMs: number[] = [];
  let successCount = 0;
  let errorCount = 0;
  let cursor = 0;
  const wallStart = performance.now();

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= totalOps) break;
      const t0 = performance.now();
      const ok = await fn(idx);
      latenciesMs.push(performance.now() - t0);
      if (ok) {
        successCount++;
      } else {
        errorCount++;
      }
    }
  });

  await Promise.all(workers);
  return {
    latenciesMs,
    successCount,
    errorCount,
    totalWallMs: performance.now() - wallStart,
  };
}

function toEndpointSummary(params: {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly concurrency: number;
  readonly run: Awaited<ReturnType<typeof runConcurrentOperations>>;
}): EndpointLatencySummary {
  const { latenciesMs, successCount, errorCount, totalWallMs } = params.run;
  const sampleCount = latenciesMs.length;
  return {
    operation: params.operation,
    method: params.method,
    path: params.path,
    concurrency: params.concurrency,
    sampleCount,
    successCount,
    errorCount,
    throughputReqPerSec:
      totalWallMs > 0 ? Number(((sampleCount / totalWallMs) * 1000).toFixed(2)) : 0,
    latency: calculateDistribution(latenciesMs),
  };
}

/**
 * Measure local V1 runtime baseline across B1 conversation turns, task submission,
 * status reads, concurrency scaling, and PostgreSQL logical DB mutations / storage bytes.
 */
export async function runV1BaselineBenchmark(
  options: V1BaselineOptions = {},
): Promise<V1BaselineReport> {
  const env = options.env ?? process.env;
  const concurrencyLevels = options.concurrencyLevels ?? [1, 10, 25, 50];
  assertValidConcurrencyLevels(concurrencyLevels, 100);

  const requestsPerLevel = options.requestsPerLevel ?? 40;
  assertPositiveSafeInt('requestsPerLevel', requestsPerLevel, 10_000);

  const maxConcurrency = Math.max(...concurrencyLevels);
  const workerConcurrency = options.workerConcurrency ?? Math.max(25, maxConcurrency);
  assertPositiveSafeInt('workerConcurrency', workerConcurrency, 200);

  const enableLocalLoad =
    options.enableLocalLoad === true || env.EMBER_BENCH_ENABLE_LOCAL_LOAD === 'true';
  if (maxConcurrency > 20 && !enableLocalLoad) {
    throw new Error(
      `Safety guard: V1 baseline concurrency=${maxConcurrency} requires enableLocalLoad=true (or --enable-local-load).`,
    );
  }

  // Strictly validate local loopback test database URL BEFORE opening any pool.
  const databaseUrl = resolveSafeLocalDatabaseUrl(options.databaseUrl, env);
  const log = options.log ?? ((msg: string) => console.log(msg));

  const telemetry = new TelemetryCollector({
    targetWorkerConcurrency: workerConcurrency,
    disablePostgresSampling: false,
  });

  log(`[V1 Baseline] Booting isolated V1 API + Worker + FakeTurnResponder...`);
  const harness = await createBenchmarkHarness({
    databaseUrl,
    workerConcurrency,
    isolatedSchema: true,
    keepDb: false,
    telemetry,
    enableB1Chat: true,
    fakeTurnPollIntervalMs: options.fakeTurnPollIntervalMs ?? 25,
  });

  telemetry.attachPool(harness.adminPool);
  telemetry.start();

  try {
    const machine = await collectMachineSpecs(harness.adminPool);

    const userCount = Math.max(10, maxConcurrency);
    log(
      `[V1 Baseline] Provisioning ${userCount} V1 agents and ${userCount} B1 consumer conversations...`,
    );

    const agentIds: Id[] = [];
    for (let i = 0; i < userCount; i++) {
      const resp = await fetch(`${harness.apiUrl}/v1/agents`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${harness.token}`,
        },
        body: JSON.stringify({ name: `v1-baseline-agent-${i}` }),
      });
      if (resp.status !== 201) {
        throw new Error(`Failed to create agent ${i}: HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { agent_id: Id };
      agentIds.push(data.agent_id);
    }

    const sessions: ConsumerSessionContext[] = [];
    for (let i = 0; i < userCount; i++) {
      const sessionResp = await fetch(`${harness.apiUrl}/v1/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'dev',
          identity_token: `bench-dev-user-${i}-${randomBytes(4).toString('hex')}`,
          nonce: randomUUID(),
        }),
      });
      if (sessionResp.status !== 201) {
        const text = await sessionResp.text().catch(() => '');
        throw new Error(`Failed to create B1 dev session ${i}: HTTP ${sessionResp.status} ${text}`);
      }
      const sessionData = (await sessionResp.json()) as { access_token: string };
      const meResp = await fetch(`${harness.apiUrl}/v1/me`, {
        headers: { authorization: `Bearer ${sessionData.access_token}` },
      });
      if (meResp.status !== 200) {
        throw new Error(`Failed to fetch /v1/me for user ${i}: HTTP ${meResp.status}`);
      }
      const me = (await meResp.json()) as {
        conversation: { conversation_id: Id; transcript_epoch: number };
      };
      sessions.push({
        accessToken: sessionData.access_token,
        conversationId: me.conversation.conversation_id,
        transcriptEpoch: me.conversation.transcript_epoch,
      });
    }

    // Warmup 5 requests on chat & tasks, then drain before measurement
    for (let i = 0; i < 5; i++) {
      const s = sessions[i % sessions.length]!;
      await fetch(`${harness.apiUrl}/v1/conversations/${s.conversationId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.accessToken}`,
        },
        body: JSON.stringify({
          client_submission_id: randomUUID(),
          text: `Warmup message ${i}`,
          transcript_epoch: s.transcriptEpoch,
        }),
      });
      await fetch(`${harness.apiUrl}/v1/tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `warmup-${i}-${randomUUID()}`,
          authorization: `Bearer ${harness.token}`,
        },
        body: JSON.stringify({
          agent_id: agentIds[i % agentIds.length],
          kind: 'mock.chat',
          input: { prompt: `Warmup ${i}`, maxOutputTokens: 32 },
        }),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const conversationBenchmarks: EndpointLatencySummary[] = [];
    const taskBenchmarks: EndpointLatencySummary[] = [];
    const statusReadBenchmarks: EndpointLatencySummary[] = [];
    const concurrencySweep: V1BaselineReport['concurrencySweep'][number][] = [];
    const dbMutationStats: V1BaselineWorkloadStats[] = [];

    for (const concurrency of concurrencyLevels) {
      const totalOps = Math.max(concurrency, requestsPerLevel);
      log(`[V1 Baseline] Running concurrency=${concurrency} (${totalOps} ops/workload)...`);

      // 1) Normal Conversation: POST message (ACK) + wait for FakeTurnResponder completion
      const chatAckLatencies: number[] = [];
      const chatCompletionLatencies: number[] = [];
      const createdTurnRefs: { session: ConsumerSessionContext; turnId: string }[] = [];
      const sessionLocks = sessions.map(() => Promise.resolve());

      const chatExactBefore = await readExactTableRowCounts(harness);
      const chatStatsBefore = await readPgSchemaStats(harness);

      const chatRun = await runConcurrentOperations(concurrency, totalOps, async (idx) => {
        const slot = idx % sessions.length;
        const session = sessions[slot]!;

        let release!: () => void;
        const prev = sessionLocks[slot]!;
        sessionLocks[slot] = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prev;

        try {
          const t0 = performance.now();
          const postResp = await fetch(
            `${harness.apiUrl}/v1/conversations/${session.conversationId}/messages`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${session.accessToken}`,
              },
              body: JSON.stringify({
                client_submission_id: randomUUID(),
                text: `V1 baseline conversation turn #${idx} at c=${concurrency}`,
                transcript_epoch: session.transcriptEpoch,
              }),
            },
          );
          const ackMs = performance.now() - t0;
          if (postResp.status !== 201 && postResp.status !== 200) {
            return false;
          }
          chatAckLatencies.push(ackMs);
          const receipt = (await postResp.json()) as { turn: { turn_id: string } };
          createdTurnRefs.push({ session, turnId: receipt.turn.turn_id });

          const deadline = performance.now() + 15_000;
          while (performance.now() < deadline) {
            const turnResp = await fetch(
              `${harness.apiUrl}/v1/conversations/${session.conversationId}/turns/${receipt.turn.turn_id}`,
              { headers: { authorization: `Bearer ${session.accessToken}` } },
            );
            if (turnResp.status === 200) {
              const turn = (await turnResp.json()) as { status: string };
              if (turn.status === 'completed') {
                chatCompletionLatencies.push(performance.now() - t0);
                return true;
              }
              if (turn.status === 'failed' || turn.status === 'cancelled') {
                return false;
              }
            }
            await new Promise((r) => setTimeout(r, 15));
          }
          return false;
        } finally {
          release();
        }
      });

      const chatExactAfter = await readExactTableRowCounts(harness);
      const chatExactDiff = diffExactTableRowCounts(chatExactBefore, chatExactAfter);
      const chatStatsAfter = await readPgSchemaStats(harness);
      const chatDiff = diffPgSchemaStats(chatStatsBefore, chatStatsAfter);
      const chatTelemetry = telemetry.getSummary();

      const minExpectedMessages = chatRun.successCount * 2;
      const observedExactMsgs = chatExactDiff.deltas.conversation_messages ?? 0;
      if (observedExactMsgs < minExpectedMessages) {
        throw new Error(
          `Sanity check failed at c=${concurrency}: expected >= ${minExpectedMessages} conversation_messages inserts, got ${observedExactMsgs}`,
        );
      }

      const pgChatMsgInserts =
        chatDiff.tables.find((t) => t.tableName === 'conversation_messages')?.inserts ?? 0;
      const chatPgStatComplete = pgChatMsgInserts >= minExpectedMessages;

      dbMutationStats.push({
        workloadName: 'v1_b1_conversation_turn',
        concurrency,
        sampleCount: totalOps,
        successCount: chatRun.successCount,
        errorCount: chatRun.errorCount,
        exactTableRowDeltas: chatExactDiff.deltas,
        exactNetRowsInserted: chatExactDiff.totalInserted,
        exactNetRowsPerOperation:
          chatRun.successCount > 0
            ? Number((chatExactDiff.totalInserted / chatRun.successCount).toFixed(2))
            : 0,
        pgStatTupleMutations: chatDiff.totalLogicalMutations,
        pgStatMutationsPerOperation:
          chatRun.successCount > 0
            ? Number((chatDiff.totalLogicalMutations / chatRun.successCount).toFixed(2))
            : 0,
        pgStatAttributionComplete: chatPgStatComplete,
        pgStatAttributionNote: chatPgStatComplete
          ? 'pg_stat_user_tables captured >= expected minimum message inserts.'
          : `INCOMPLETE_POOL_STATS_LAG: pg_stat_user_tables recorded only ${pgChatMsgInserts} conversation_messages inserts vs ${minExpectedMessages} verified via COUNT(*). Use exactTableRowDeltas for row growth and c=1 isolated sample for tuple UPDATEs.`,
        totalSchemaBytesAfter: chatDiff.totalSchemaBytesAfter,
        peakActiveConnections: chatTelemetry.peakPostgresActiveConnections,
        peakTotalConnections: chatTelemetry.peakPostgresTotalConnections,
        peakRssMb: chatTelemetry.peakRssMb,
        tables: chatDiff.tables,
      });

      const chatAckDist = calculateDistribution(chatAckLatencies);
      const chatCompDist = calculateDistribution(chatCompletionLatencies);
      const chatThroughput =
        chatRun.totalWallMs > 0
          ? Number(((chatRun.successCount / chatRun.totalWallMs) * 1000).toFixed(2))
          : 0;

      conversationBenchmarks.push({
        operation: 'b1_send_message_ack',
        method: 'POST',
        path: '/v1/conversations/:id/messages',
        concurrency,
        sampleCount: totalOps,
        successCount: chatAckLatencies.length,
        errorCount: totalOps - chatAckLatencies.length,
        throughputReqPerSec: chatThroughput,
        latency: chatAckDist,
      });
      conversationBenchmarks.push({
        operation: 'b1_turn_end_to_end',
        method: 'POST+POLL',
        path: '/v1/conversations/:id/turns/:turn_id',
        concurrency,
        sampleCount: totalOps,
        successCount: chatRun.successCount,
        errorCount: chatRun.errorCount,
        throughputReqPerSec: chatThroughput,
        latency: chatCompDist,
      });

      // 2) Task Submission & Execution: POST /v1/tasks + poll GET /v1/tasks/:id
      const taskAckLatencies: number[] = [];
      const taskCompletionLatencies: number[] = [];
      const createdTaskIds: Id[] = [];

      const taskExactBefore = await readExactTableRowCounts(harness);
      const taskStatsBefore = await readPgSchemaStats(harness);

      const taskRun = await runConcurrentOperations(concurrency, totalOps, async (idx) => {
        const agentId = agentIds[idx % agentIds.length]!;
        const isFast = idx % 10 < 7;
        const kind = isFast ? 'mock.chat' : 'mock.compute';
        const input = isFast
          ? { prompt: `V1 baseline fast task #${idx}`, maxOutputTokens: 64 }
          : { operation: 'sha256', text: `V1 baseline compute #${idx} `.repeat(40) };

        const t0 = performance.now();
        const postResp = await fetch(`${harness.apiUrl}/v1/tasks`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `v1-base-${concurrency}-${idx}-${randomUUID()}`,
            authorization: `Bearer ${harness.token}`,
          },
          body: JSON.stringify({ agent_id: agentId, kind, input }),
        });
        const ackMs = performance.now() - t0;
        if (postResp.status !== 202 && postResp.status !== 200) {
          return false;
        }
        taskAckLatencies.push(ackMs);
        const receipt = (await postResp.json()) as { task_id: Id };
        createdTaskIds.push(receipt.task_id);

        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline) {
          const getResp = await fetch(`${harness.apiUrl}/v1/tasks/${receipt.task_id}`, {
            headers: { authorization: `Bearer ${harness.token}` },
          });
          if (getResp.status === 200) {
            const detail = (await getResp.json()) as { status: string };
            if (detail.status === 'completed') {
              taskCompletionLatencies.push(performance.now() - t0);
              return true;
            }
            if (detail.status === 'failed' || detail.status === 'cancelled') {
              return false;
            }
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        return false;
      });

      const taskExactAfter = await readExactTableRowCounts(harness);
      const taskExactDiff = diffExactTableRowCounts(taskExactBefore, taskExactAfter);
      const taskStatsAfter = await readPgSchemaStats(harness);
      const taskDiff = diffPgSchemaStats(taskStatsBefore, taskStatsAfter);
      const taskTelemetry = telemetry.getSummary();

      const observedExactTasks = taskExactDiff.deltas.tasks ?? 0;
      if (observedExactTasks < taskRun.successCount) {
        throw new Error(
          `Sanity check failed at c=${concurrency}: expected >= ${taskRun.successCount} tasks inserts, got ${observedExactTasks}`,
        );
      }

      const pgTaskInserts = taskDiff.tables.find((t) => t.tableName === 'tasks')?.inserts ?? 0;
      const taskPgStatComplete = pgTaskInserts >= taskRun.successCount;

      dbMutationStats.push({
        workloadName: 'v1_durable_task_lifecycle',
        concurrency,
        sampleCount: totalOps,
        successCount: taskRun.successCount,
        errorCount: taskRun.errorCount,
        exactTableRowDeltas: taskExactDiff.deltas,
        exactNetRowsInserted: taskExactDiff.totalInserted,
        exactNetRowsPerOperation:
          taskRun.successCount > 0
            ? Number((taskExactDiff.totalInserted / taskRun.successCount).toFixed(2))
            : 0,
        pgStatTupleMutations: taskDiff.totalLogicalMutations,
        pgStatMutationsPerOperation:
          taskRun.successCount > 0
            ? Number((taskDiff.totalLogicalMutations / taskRun.successCount).toFixed(2))
            : 0,
        pgStatAttributionComplete: taskPgStatComplete,
        pgStatAttributionNote: taskPgStatComplete
          ? 'pg_stat_user_tables captured >= expected minimum task inserts.'
          : `INCOMPLETE_POOL_STATS_LAG: pg_stat_user_tables recorded only ${pgTaskInserts} task inserts vs ${taskRun.successCount} verified via COUNT(*). Use exactTableRowDeltas for row growth and c=1 isolated sample for tuple UPDATEs.`,
        totalSchemaBytesAfter: taskDiff.totalSchemaBytesAfter,
        peakActiveConnections: taskTelemetry.peakPostgresActiveConnections,
        peakTotalConnections: taskTelemetry.peakPostgresTotalConnections,
        peakRssMb: taskTelemetry.peakRssMb,
        tables: taskDiff.tables,
      });

      const taskAckDist = calculateDistribution(taskAckLatencies);
      const taskCompDist = calculateDistribution(taskCompletionLatencies);
      const taskThroughput =
        taskRun.totalWallMs > 0
          ? Number(((taskRun.successCount / taskRun.totalWallMs) * 1000).toFixed(2))
          : 0;

      taskBenchmarks.push({
        operation: 'task_submit_ack',
        method: 'POST',
        path: '/v1/tasks',
        concurrency,
        sampleCount: totalOps,
        successCount: taskAckLatencies.length,
        errorCount: totalOps - taskAckLatencies.length,
        throughputReqPerSec: taskThroughput,
        latency: taskAckDist,
      });
      taskBenchmarks.push({
        operation: 'task_end_to_end',
        method: 'POST+POLL',
        path: '/v1/tasks/:id',
        concurrency,
        sampleCount: totalOps,
        successCount: taskRun.successCount,
        errorCount: taskRun.errorCount,
        throughputReqPerSec: taskThroughput,
        latency: taskCompDist,
      });

      // 3) Dedicated Status & History Read Benchmarks at the same concurrency
      const taskStatusReadRun = await runConcurrentOperations(
        concurrency,
        totalOps,
        async (idx) => {
          const taskId = createdTaskIds[idx % createdTaskIds.length]!;
          const resp = await fetch(`${harness.apiUrl}/v1/tasks/${taskId}`, {
            headers: { authorization: `Bearer ${harness.token}` },
          });
          await resp.arrayBuffer();
          return resp.status === 200;
        },
      );
      const taskStatusSummary = toEndpointSummary({
        operation: 'task_status_read',
        method: 'GET',
        path: '/v1/tasks/:id',
        concurrency,
        run: taskStatusReadRun,
      });
      statusReadBenchmarks.push(taskStatusSummary);

      const convHistoryReadRun = await runConcurrentOperations(
        concurrency,
        totalOps,
        async (idx) => {
          const session = sessions[idx % sessions.length]!;
          const resp = await fetch(
            `${harness.apiUrl}/v1/conversations/${session.conversationId}/messages?after=0&limit=50`,
            { headers: { authorization: `Bearer ${session.accessToken}` } },
          );
          await resp.arrayBuffer();
          return resp.status === 200;
        },
      );
      statusReadBenchmarks.push(
        toEndpointSummary({
          operation: 'b1_conversation_history_read',
          method: 'GET',
          path: '/v1/conversations/:id/messages',
          concurrency,
          run: convHistoryReadRun,
        }),
      );

      if (createdTurnRefs.length > 0) {
        const turnStatusReadRun = await runConcurrentOperations(
          concurrency,
          totalOps,
          async (idx) => {
            const ref = createdTurnRefs[idx % createdTurnRefs.length]!;
            const resp = await fetch(
              `${harness.apiUrl}/v1/conversations/${ref.session.conversationId}/turns/${ref.turnId}`,
              { headers: { authorization: `Bearer ${ref.session.accessToken}` } },
            );
            await resp.arrayBuffer();
            return resp.status === 200;
          },
        );
        statusReadBenchmarks.push(
          toEndpointSummary({
            operation: 'b1_turn_status_read',
            method: 'GET',
            path: '/v1/conversations/:id/turns/:turn_id',
            concurrency,
            run: turnStatusReadRun,
          }),
        );
      }

      concurrencySweep.push({
        concurrency,
        chatSampleCount: totalOps,
        chatSuccessCount: chatRun.successCount,
        chatAckP50Ms: chatAckDist.p50Ms,
        chatAckP95Ms: chatAckDist.p95Ms,
        chatCompletionP50Ms: chatCompDist.p50Ms,
        chatCompletionP95Ms: chatCompDist.p95Ms,
        taskSampleCount: totalOps,
        taskSuccessCount: taskRun.successCount,
        taskAckP50Ms: taskAckDist.p50Ms,
        taskAckP95Ms: taskAckDist.p95Ms,
        taskCompletionP50Ms: taskCompDist.p50Ms,
        taskCompletionP95Ms: taskCompDist.p95Ms,
        statusReadP95Ms: taskStatusSummary.latency.p95Ms,
        chatThroughputPerSec: chatThroughput,
        taskThroughputPerSec: taskThroughput,
      });
    }

    return {
      scenarioId: 'ember-v2-m0-v1-baseline',
      evidenceKind: 'measured_local_pg',
      gitSha: resolveBenchmarkGitSha(),
      timestamp: new Date().toISOString(),
      machine,
      conversationBenchmarks,
      taskBenchmarks,
      statusReadBenchmarks,
      concurrencySweep,
      dbMutationStats,
      notes: [
        'All measurements collected locally against isolated loopback PostgreSQL 17 schemas only; remote/production URLs and general DATABASE_URL fallback are blocked.',
        'B1 conversation turns use FakeTurnResponder (FakeLlm, zero external LLM calls) with 25ms poll interval.',
        'Task submissions use DeterministicExecutor (mock.chat / mock.compute) with 25ms poll loop.',
        'exactTableRowDeltas uses deterministic SELECT COUNT(*) deltas before/after each workload; pg_stat_user_tables can lag across pooled idle backends and is explicitly flagged pgStatAttributionComplete=false whenever inserts fall below sanity thresholds.',
      ],
    };
  } finally {
    telemetry.stop();
    await harness.stop();
  }
}
