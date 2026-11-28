import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface MiniflareInstance {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}

type MiniflareConstructor = new (options: Record<string, unknown>) => MiniflareInstance;

function isRecoverySurfaceFile(relPath: string): boolean {
  if (relPath.endsWith('.test.ts')) {
    return false;
  }
  return (
    relPath === 'index.ts' ||
    relPath === 'storage.ts' ||
    relPath === 'migrations.ts' ||
    relPath.startsWith('recovery/')
  );
}

function transpileRuntimeV2Modules(): Record<string, { type: 'esm'; contents: string }> {
  const srcRoot = resolve(REPO_ROOT, 'packages/runtime-v2/src');
  const entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true });
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const fullPath = resolve(entry.parentPath, entry.name);
    const relPath = fullPath.slice(srcRoot.length + 1).replace(/\\/g, '/');
    if (!isRecoverySurfaceFile(relPath)) {
      continue;
    }
    let source = readFileSync(fullPath, 'utf8');
    if (relPath === 'index.ts') {
      // Keep only recovery/storage/migration exports so merged A+B+E index entries don't pull unbundled workspace packages into Miniflare.
      source = source
        .split('\n')
        .filter((line) => /from\s+['"]\.\/(?:storage|migrations|recovery\/)/.test(line))
        .join('\n');
    }
    const transpiled = ts.transpileModule(source, {
      fileName: relPath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
    });
    const jsPath = `runtime-v2/${relPath.replace(/\.ts$/, '.js')}`;
    modules[jsPath] = { type: 'esm', contents: transpiled.outputText };
  }
  return modules;
}

async function loadMiniflareConstructor(): Promise<MiniflareConstructor> {
  const apiReq = createRequire(resolve(REPO_ROOT, 'apps/api/package.json'));
  const wranglerPkgPath = apiReq.resolve('wrangler/package.json');
  const mfReq = createRequire(wranglerPkgPath);
  const mfMod = (await import(pathToFileURL(mfReq.resolve('miniflare')).href)) as {
    Miniflare: MiniflareConstructor;
  };
  return mfMod.Miniflare;
}

describe('V2-M1-B2 real local workerd Outbox + Queue + DLQ end-to-end', () => {
  it('delivers durable work through real workerd Cloudflare Queue, enforces fencing, and routes exhausted retries to DLQ', async () => {
    const Miniflare = await loadMiniflareConstructor();
    const workerSrc = `
import { DurableObject } from 'cloudflare:workers';
import {
  applyAgentHeadMigrations,
  computePreDeadlineRetryAtMs,
  EVENT_RECOVERY_DO_MIGRATION,
  handleDurableDeadLetterBatch,
  handleDurableQueueBatch,
  OutboxCoordinator,
  resolveDeadLetterRetrySchedule,
  verifyAndClaimDispatchEnvelope,
} from './runtime-v2/index.js';

export class TestAgentHeadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      applyAgentHeadMigrations(
        ctx.storage,
        [
          {
            version: 1,
            name: 'test_turns',
            statements: [
              \`CREATE TABLE IF NOT EXISTS test_turns (
                turn_id TEXT PRIMARY KEY,
                lease_epoch INTEGER NOT NULL,
                deadline_at_ms INTEGER NOT NULL,
                status TEXT NOT NULL,
                commit_count INTEGER NOT NULL DEFAULT 0
              );\`,
              \`CREATE TABLE IF NOT EXISTS test_worker_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL
              );\`,
            ],
          },
          EVENT_RECOVERY_DO_MIGRATION,
        ],
        1_000,
      );
    });
  }

  #businessPort() {
    const sql = this.ctx.storage.sql;
    return {
      earliestRequiredDiscoveryAtMsSync: () => null,
      listDueBusinessActionsSync: () => [],
      convergeDueBusinessItemSync: () => {},
      inspectOutboxTargetSync: (entityKind, entityId) => {
        const rows = sql
          .exec('SELECT turn_id, lease_epoch, deadline_at_ms, status FROM test_turns WHERE turn_id = ?', entityId)
          .toArray();
        const row = rows[0];
        if (!row) {
          return {
            exists: false,
            targetKind: null,
            targetId: null,
            currentLeaseEpoch: 0,
            deadlineAtMs: 0,
            isTerminal: true,
            cancelRequested: false,
          };
        }
        return {
          exists: true,
          targetKind: entityKind === 'turn' ? 'turn' : 'task',
          targetId: row.turn_id,
          currentLeaseEpoch: row.lease_epoch,
          deadlineAtMs: row.deadline_at_ms,
          isTerminal: row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled',
          cancelRequested: row.status === 'cancelled',
        };
      },
      materializeScheduleOccurrenceSync: () => {},
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const business = this.#businessPort();
    const coordinator = new OutboxCoordinator(this.ctx.storage.sql, {
      storage: this.ctx.storage,
      business,
    });

    if (url.pathname === '/enqueue') {
      const { turnId, outboxId, failMode, deadlineAtMs } = await request.json();
      const nowMs = 10_000;
      const envelope = {
        schemaVersion: 2,
        eventId: outboxId,
        tenantId: 'ten-1',
        agentId: 'ag-1',
        entityKind: 'turn',
        entityId: turnId,
        queueName: 'durable_turn',
        fenceEpoch: 1,
      };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'INSERT INTO test_turns (turn_id, lease_epoch, deadline_at_ms, status) VALUES (?, 1, ?, ?)',
          turnId,
          deadlineAtMs,
          failMode ? 'fail_exec' : 'queued',
        );
        coordinator.enqueueDurableOutboxSync({
          outboxId,
          entityKind: 'turn',
          entityId: turnId,
          queueName: 'durable_turn',
          payloadJson: JSON.stringify(envelope),
          fenceEpoch: 1,
          nextAttemptAtMs: nowMs,
          nowMs,
        });
      });

      const dispatch = await coordinator.dispatchDueOrdinaryOutbox({
        nowMs,
        queues: {
          durable_turn: this.env.DURABLE_TURN_Q,
          agent_task: this.env.AGENT_TASK_Q,
        },
      });
      return Response.json(dispatch);
    }

    if (url.pathname === '/claim') {
      const { envelope, workerId, leaseMs } = await request.json();
      const preCheck = this.ctx.storage.sql
        .exec('SELECT status FROM test_turns WHERE turn_id = ?', envelope.entityId)
        .toArray()[0];
      if (preCheck?.status === 'fail_exec') {
        throw new Error('simulated transient claim unavailability before claim ACK');
      }
      const recoveryPort = {
        claimDurableWork: async (cmd) => {
          return this.ctx.storage.transactionSync(() => {
            const row = this.ctx.storage.sql
              .exec('SELECT status FROM test_turns WHERE turn_id = ?', cmd.envelope.entityId)
              .toArray()[0];
            if (!row) {
              return { kind: 'not_claimed', reason: 'not_found' };
            }
            if (row.status === 'succeeded') {
              return { kind: 'not_claimed', reason: 'terminal' };
            }
            return {
              kind: 'claimed',
              targetKind: 'turn',
              targetId: cmd.envelope.entityId,
              leaseEpoch: cmd.envelope.fenceEpoch,
              leaseExpiresAtMs: 50_000,
              contextJson: JSON.stringify({ failMode: row.status === 'fail_exec' }),
            };
          });
        },
      };

      const res = await verifyAndClaimDispatchEnvelope({
        rawEnvelope: envelope,
        expectedQueueName: 'durable_turn',
        identity: { tenantId: 'ten-1', agentId: 'ag-1' },
        storage: this.ctx.storage,
        coordinator,
        business,
        recoveryPort,
        workerId,
        leaseMs,
        nowMs: 11_000,
      });

      if (res.kind === 'claimed') {
        return Response.json(res.claim);
      }
      if (res.kind === 'already_handled') {
        return Response.json({ kind: 'not_claimed', reason: 'terminal' });
      }
      if (res.kind === 'rejected') {
        return Response.json({ kind: 'not_claimed', reason: 'stale_or_invalid_envelope' });
      }
      return Response.json({ kind: 'not_claimed', reason: res.reason });
    }

    if (url.pathname === '/commit') {
      const { entityId, leaseEpoch } = await request.json();
      const accepted = this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql
          .exec('SELECT lease_epoch, status FROM test_turns WHERE turn_id = ?', entityId)
          .toArray()[0];
        if (!row || row.lease_epoch !== leaseEpoch || row.status === 'succeeded') {
          return false;
        }
        this.ctx.storage.sql.exec(
          "UPDATE test_turns SET status = 'succeeded', commit_count = commit_count + 1 WHERE turn_id = ?",
          entityId,
        );
        return true;
      });
      return Response.json({ accepted });
    }

    if (url.pathname === '/dlq') {
      const { envelope, errorCode, nowMs } = await request.json();
      const decision = this.ctx.storage.transactionSync(() => {
        const target = business.inspectOutboxTargetSync(envelope.entityKind, envelope.entityId);
        const schedule = resolveDeadLetterRetrySchedule({
          nowMs,
          deadlineAtMs: target.deadlineAtMs,
          isTerminalOrCancelled: target.isTerminal || target.cancelRequested,
        });
        if (schedule.action === 'ignored_stale_or_terminal') {
          return schedule;
        }
        coordinator.applyOutboxDeadLetterSync({
          outboxId: envelope.eventId,
          fenceEpoch: envelope.fenceEpoch,
          errorCode,
          nextAttemptAtMs: schedule.alarmAtMs,
          nowMs,
        });
        return schedule;
      });
      return Response.json(decision);
    }

    if (url.pathname === '/inspect') {
      const turns = this.ctx.storage.sql.exec('SELECT * FROM test_turns ORDER BY turn_id ASC').toArray();
      const outbox = this.ctx.storage.sql.exec('SELECT * FROM v2_dispatch_outbox ORDER BY outbox_id ASC').toArray();
      return Response.json({ turns, outbox });
    }

    return new Response('not-found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('ten-1:ag-1'));
    return stub.fetch(request);
  },

  async queue(batch, env) {
    const router = {
      getAgentHeadRecoveryPort: () => {
        const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('ten-1:ag-1'));
        return {
          reconcileFromRegistry: async () => ({ action: 'keep_armed', currentGeneration: 1 }),
          confirmRegistryPlan: async () => ({ confirmed: true }),
          claimDurableWork: async (cmd) => {
            const res = await stub.fetch('http://do/claim', {
              method: 'POST',
              body: JSON.stringify(cmd),
            });
            return res.json();
          },
          commitDurableResult: async (cmd) => {
            const res = await stub.fetch('http://do/commit', {
              method: 'POST',
              body: JSON.stringify(cmd),
            });
            return res.json();
          },
        };
      },
      getDeadLetterPort: () => {
        const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('ten-1:ag-1'));
        return {
          onDispatchDeadLetter: async (cmd) => {
            const res = await stub.fetch('http://do/dlq', {
              method: 'POST',
              body: JSON.stringify(cmd),
            });
            return res.json();
          },
        };
      },
    };

    if (batch.queue === 'durable-turn-dlq') {
      await handleDurableDeadLetterBatch({
        expectedQueueName: 'durable_turn',
        messages: batch.messages,
        router,
        nowMs: () => 50_000,
      });
      return;
    }

    await handleDurableQueueBatch({
      queueName: 'durable_turn',
      messages: batch.messages,
      router,
      retryDelaySeconds: 0,
      executor: {
        executeDurableWork: async (cmd) => {
          const ctx = JSON.parse(cmd.contextJson);
          if (ctx.failMode) {
            throw new Error('simulated worker crash triggers queue retry -> DLQ');
          }
          return { completed: true };
        },
      },
      workerId: 'workerd-queue-consumer',
    });
  },
};
`;

    const mf = new Miniflare({
      logRequests: false,
      workers: [
        {
          config: {
            name: 'm1-b2-queue-test',
            compatibilityDate: '2026-11-10',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'worker.js',
              modulesRoot: '/app',
              modules: {
                'worker.js': { type: 'esm', contents: workerSrc },
                ...transpileRuntimeV2Modules(),
              },
            },
            env: {
              AGENT_HEAD: {
                type: 'durable-object',
                worker: 'm1-b2-queue-test',
                exportName: 'TestAgentHeadDO',
              },
              DURABLE_TURN_Q: {
                type: 'queue',
                name: 'durable-turn',
                dev: { remote: false },
              },
              AGENT_TASK_Q: {
                type: 'queue',
                name: 'agent-task',
                dev: { remote: false },
              },
            },
            exports: {
              TestAgentHeadDO: { type: 'durable-object', storage: 'sqlite' },
            },
            triggers: [
              {
                type: 'queue',
                name: 'durable-turn',
                deadLetterQueue: 'durable-turn-dlq',
                maxBatchSize: 1,
                maxRetries: 1,
              },
              {
                type: 'queue',
                name: 'durable-turn-dlq',
                maxBatchSize: 1,
                maxRetries: 0,
              },
            ],
          },
          dev: { rootPath: REPO_ROOT, unsafeRegisterWorker: true },
        },
      ],
    });

    try {
      // 1. Happy path: Outbox -> real Queue -> DO claim + ack -> worker exec -> single commit
      const enqOk = await (
        await mf.dispatchFetch('http://localhost/enqueue', {
          method: 'POST',
          body: JSON.stringify({
            turnId: 'turn-ok',
            outboxId: 'out-ok',
            failMode: false,
            deadlineAtMs: 120_000,
          }),
        })
      ).json();
      expect(enqOk).toMatchObject({ sentCount: 1 });

      // 2. Failing path (remaining = 1_000ms at DLQ time 50_000ms): Outbox -> Queue -> retries exhausted -> real DLQ -> B1 pre-deadline convergence at 51_000ms
      const enqFail = await (
        await mf.dispatchFetch('http://localhost/enqueue', {
          method: 'POST',
          body: JSON.stringify({
            turnId: 'turn-dlq',
            outboxId: 'out-dlq',
            failMode: true,
            deadlineAtMs: 51_000,
          }),
        })
      ).json();
      expect(enqFail).toMatchObject({ sentCount: 1 });

      // Poll DO inspect briefly until local workerd queue + DLQ consumers settle
      let state: {
        turns: Array<{ turn_id: string; status: string; commit_count: number }>;
        outbox: Array<{
          outbox_id: string;
          state: string;
          dlq_count: number;
          next_attempt_at_ms: number;
          last_error_code: string | null;
        }>;
      } = { turns: [], outbox: [] };

      for (let i = 0; i < 40; i += 1) {
        state = (await (await mf.dispatchFetch('http://localhost/inspect')).json()) as typeof state;
        const okOut = state.outbox.find((o) => o.outbox_id === 'out-ok');
        const dlqOut = state.outbox.find((o) => o.outbox_id === 'out-dlq');
        if (okOut?.state === 'acked' && dlqOut?.state === 'dead_lettered') {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const okTurn = state.turns.find((t) => t.turn_id === 'turn-ok');
      const okOut = state.outbox.find((o) => o.outbox_id === 'out-ok');
      const dlqOut = state.outbox.find((o) => o.outbox_id === 'out-dlq');

      expect(okTurn).toMatchObject({ status: 'succeeded', commit_count: 1 });
      expect(okOut).toMatchObject({ state: 'acked', dlq_count: 0 });
      expect(dlqOut).toMatchObject({
        state: 'dead_lettered',
        dlq_count: 1,
        next_attempt_at_ms: 51_000,
        last_error_code: 'QUEUE_MAX_RETRIES_EXHAUSTED',
      });
    } finally {
      await mf.dispose();
    }
  }, 15_000);
});
