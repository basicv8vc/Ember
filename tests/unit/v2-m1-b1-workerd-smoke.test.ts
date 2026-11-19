import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface MiniflareInstance {
  dispatchFetch(input: string): Promise<Response>;
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
  const cloudRuntimeReq = createRequire(
    resolve(REPO_ROOT, 'apps/cloud-async-runtime/package.json'),
  );
  const wranglerPkgPath = cloudRuntimeReq.resolve('wrangler/package.json');
  const mfReq = createRequire(wranglerPkgPath);
  const mfMod = (await import(pathToFileURL(mfReq.resolve('miniflare')).href)) as {
    Miniflare: MiniflareConstructor;
  };
  return mfMod.Miniflare;
}

describe('V2-M1-B1 real local workerd DO SQLite & D1 smoke', () => {
  it('runs shared AgentHeadDO and D1 migrations and enforces SQLite/envelope constraints in workerd', async () => {
    const Miniflare = await loadMiniflareConstructor();
    const workerSrc = `
import { DurableObject } from 'cloudflare:workers';
import {
  applyAgentHeadMigrations,
  applyD1RecoveryMigrations,
  assertValidDispatchEnvelope,
  EVENT_RECOVERY_DO_MIGRATION,
  validateOutboxEnqueueCommand,
} from './runtime-v2/index.js';

export class TestAgentHeadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const aMigration = {
        version: 1,
        name: 'agent_a_business_core',
        statements: [
          'CREATE TABLE IF NOT EXISTS agent_head_meta (id INTEGER PRIMARY KEY CHECK (id = 1), tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL);',
        ],
      };
      applyAgentHeadMigrations(ctx.storage, [aMigration, EVENT_RECOVERY_DO_MIGRATION], 1700000000000);
      // Verify idempotency inside workerd DO startup
      applyAgentHeadMigrations(ctx.storage, [aMigration, EVENT_RECOVERY_DO_MIGRATION], 1700000001000);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/do-check') {
      const migrations = this.ctx.storage.sql
        .exec('SELECT version FROM schema_migrations ORDER BY version ASC')
        .toArray();

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          \`INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_json, state,
            next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
          'out-1',
          'turn',
          'turn-1',
          'durable_turn',
          '{}',
          'pending',
          1000,
          2,
          1000,
          1000,
        );
      });

      const outboxRow = this.ctx.storage.sql
        .exec('SELECT revision FROM v2_dispatch_outbox WHERE outbox_id = ?', 'out-1')
        .one();

      let rejectedNullOrdinaryQueue = false;
      try {
        this.ctx.storage.sql.exec(
          \`INSERT INTO v2_dispatch_outbox (
            outbox_id, entity_kind, entity_id, queue_name, payload_json, state,
            next_attempt_at_ms, fence_epoch, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
          'out-bad-null-queue',
          'turn',
          'turn-2',
          null,
          '{}',
          'pending',
          1000,
          2,
          1000,
          1000,
        );
      } catch {
        rejectedNullOrdinaryQueue = true;
      }

      let rejectedBudgetOnQueue = false;
      try {
        validateOutboxEnqueueCommand({
          outboxId: 'out-bad-budget',
          entityKind: 'budget_sync',
          entityId: 'op-1',
          queueName: 'durable_turn',
          payloadJson: '{}',
          operationId: 'op-1',
          fenceEpoch: 0,
          nextAttemptAtMs: 1000,
        });
      } catch {
        rejectedBudgetOnQueue = true;
      }

      const envelope = assertValidDispatchEnvelope({
        schemaVersion: 2,
        eventId: 'out-1',
        tenantId: 't1',
        agentId: 'a1',
        entityKind: 'turn',
        entityId: 'turn-1',
        queueName: 'durable_turn',
        fenceEpoch: 2,
      });

      return Response.json({
        versions: migrations.map((row) => row.version),
        defaultRevision: outboxRow.revision,
        rejectedNullOrdinaryQueue,
        rejectedBudgetOnQueue,
        envelope,
      });
    }
    return new Response('not-found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/d1-check') {
      const first = await applyD1RecoveryMigrations(env.RECOVERY_DB, 1700000000000);
      const second = await applyD1RecoveryMigrations(env.RECOVERY_DB, 1700000005000);
      await env.RECOVERY_DB
        .prepare(
          \`INSERT INTO v2_recovery_registry (
            agent_key, tenant_id, agent_id, generation, next_recovery_at_ms,
            retry_not_before_ms, status, recovery_attempts, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
        )
        .bind('t1:a1', 't1', 'a1', 1, 5000, null, 'armed', 0, 1000)
        .run();
      const row = await env.RECOVERY_DB
        .prepare('SELECT agent_key, generation, status FROM v2_recovery_registry WHERE agent_key = ?')
        .bind('t1:a1')
        .first();
      return Response.json({ first, second, row });
    }
    const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName('t1:a1'));
    return stub.fetch(request);
  },
};
`;

    const mf = new Miniflare({
      logRequests: false,
      workers: [
        {
          config: {
            name: 'm1-b1-smoke',
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
              RECOVERY_DB: { type: 'd1', id: 'recovery-db-smoke' },
              AGENT_HEAD: {
                type: 'durable-object',
                worker: 'm1-b1-smoke',
                exportName: 'TestAgentHeadDO',
              },
            },
            exports: {
              TestAgentHeadDO: { type: 'durable-object', storage: 'sqlite' },
            },
          },
          dev: { rootPath: REPO_ROOT, unsafeRegisterWorker: true },
        },
      ],
    });

    try {
      const doRes = (await (await mf.dispatchFetch('http://localhost/do-check')).json()) as {
        versions: number[];
        defaultRevision: number;
        rejectedNullOrdinaryQueue: boolean;
        rejectedBudgetOnQueue: boolean;
        envelope: { schemaVersion: number; queueName: string; eventId: string };
      };
      expect(doRes.versions).toEqual([1, 2]);
      expect(doRes.defaultRevision).toBe(0);
      expect(doRes.rejectedNullOrdinaryQueue).toBe(true);
      expect(doRes.rejectedBudgetOnQueue).toBe(true);
      expect(doRes.envelope).toMatchObject({
        schemaVersion: 2,
        eventId: 'out-1',
        queueName: 'durable_turn',
      });

      const d1Res = (await (await mf.dispatchFetch('http://localhost/d1-check')).json()) as {
        first: { appliedVersions: number[]; alreadyAppliedVersions: number[] };
        second: { appliedVersions: number[]; alreadyAppliedVersions: number[] };
        row: { agent_key: string; generation: number; status: string };
      };
      expect(d1Res.first.appliedVersions).toEqual([1]);
      expect(d1Res.second.alreadyAppliedVersions).toEqual([1]);
      expect(d1Res.row).toEqual({ agent_key: 't1:a1', generation: 1, status: 'armed' });
    } finally {
      await mf.dispose();
    }
  });
});
