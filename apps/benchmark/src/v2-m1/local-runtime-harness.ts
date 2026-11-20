import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FakeModelGatewayServer } from './fake-model-gateway-server.js';
import { V2FaultInjector } from './fault-injector.js';
import {
  assertIsolatedWranglerConfig,
  assertNoAccidentalEnvFiles,
  assertSafeLocalV2RuntimeEnv,
  buildSanitizedLocalWorkerVars,
  parseStrictJsonc,
  validateWorkerVarOverrides,
} from './local-v2-guard.js';

/**
 * Smoke-only D1 fixture schema used exclusively by `target.kind === 'harness_smoke'`.
 * Never applied to `ab_runtime`: Agent B owns real D1 migrations and schema verification.
 */
export const HARNESS_SMOKE_D1_RECOVERY_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS v2_recovery_registry (
  agent_key                 TEXT    PRIMARY KEY,
  tenant_id                 TEXT    NOT NULL,
  agent_id                  TEXT    NOT NULL,
  generation                INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  next_recovery_at_ms       INTEGER NOT NULL,
  retry_not_before_ms       INTEGER,
  status                    TEXT    NOT NULL CHECK (status IN ('armed', 'backoff', 'quarantined')),
  sweep_lease_owner         TEXT,
  sweep_lease_expires_at_ms INTEGER,
  recovery_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  last_error_code           TEXT,
  updated_at_ms             INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_v2_recovery_due
  ON v2_recovery_registry (next_recovery_at_ms, agent_key)
  WHERE status IN ('armed', 'backoff', 'quarantined')`,
]);

export type V2HarnessTarget =
  | {
      readonly kind: 'ab_runtime';
      readonly configPath: string;
      readonly env?: string;
      readonly prebuiltWorkerDir?: string;
      readonly d1BindingName?: string;
    }
  | {
      readonly kind: 'harness_smoke';
    };

export interface V2LocalRuntimeHarnessOptions {
  readonly target: V2HarnessTarget;
  readonly vars?: Record<string, string>;
}

interface WranglerWorkerHandle {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  scheduled(options: { scheduledTime: Date; cron: string }): Promise<{
    readonly outcome: string;
    readonly noRetry: boolean;
  }>;
  getEnv(): Promise<Record<string, unknown>>;
  listDurableObjectIds(classNameOrBindingName: string): Promise<string[]>;
  evictDurableObject(
    classNameOrBindingName: string,
    options: { readonly name?: string; readonly id?: string },
  ): Promise<void>;
  getDurableObjectStorage(
    classNameOrBindingName: string,
    options: { readonly name?: string; readonly id?: string },
  ): Promise<{
    exec<T = Record<string, unknown>>(
      sql: string,
      ...bindings: (string | number | null)[]
    ): Promise<T[]>;
  }>;
  applyD1Migrations?(bindingName: string): Promise<void>;
}

interface WranglerTestHarness {
  listen(): Promise<void>;
  close(): Promise<void>;
  getWorker(): Promise<WranglerWorkerHandle>;
}

interface WranglerModule {
  createTestHarness(options: {
    readonly root?: string;
    readonly workers: ReadonlyArray<{
      readonly configPath: string;
      readonly env?: string;
      readonly prebuiltWorkerDir?: string;
      readonly vars?: Record<string, string>;
    }>;
  }): WranglerTestHarness;
}

export interface D1DatabaseBindingLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{
        readonly results?: T[];
        readonly meta?: Record<string, unknown>;
      }>;
      run(): Promise<{ readonly meta?: Record<string, unknown> }>;
    };
    all<T = Record<string, unknown>>(): Promise<{
      readonly results?: T[];
      readonly meta?: Record<string, unknown>;
    }>;
    run(): Promise<{ readonly meta?: Record<string, unknown> }>;
  };
  exec(sql: string): Promise<unknown>;
}

export interface QueueProducerBindingLike {
  send(message: unknown, options?: { readonly delaySeconds?: number }): Promise<void>;
}

/**
 * Explicitly non-authoritative infrastructure smoke worker ONLY for testing that the local
 * Wrangler/Miniflare/workerd harness wires AgentHeadDO (SQLite + Alarm), GlobalBudgetDO (SQLite),
 * D1, Queues + DLQ, R2, Scheduled Cron, FaultInjector, and FakeModelGateway.
 * Never claims to validate A/B business invariants.
 */
const HARNESS_SMOKE_WORKER_SOURCE = `
import { DurableObject } from 'cloudflare:workers';

export class AgentHeadDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(\`
      CREATE TABLE IF NOT EXISTS harness_smoke_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        alarm_fires INTEGER NOT NULL DEFAULT 0,
        last_alarm_ms INTEGER,
        boot_counter INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO harness_smoke_state (id, alarm_fires, boot_counter) VALUES (1, 0, 0);
    \`);
    this.ctx.storage.sql.exec('UPDATE harness_smoke_state SET boot_counter = boot_counter + 1 WHERE id = 1');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ping') {
      const cursor = this.ctx.storage.sql.exec(
        'SELECT alarm_fires, last_alarm_ms, boot_counter FROM harness_smoke_state WHERE id = 1',
      );
      const row = [...cursor][0];
      return Response.json({
        ok: true,
        rowsRead: cursor.rowsRead,
        rowsWritten: cursor.rowsWritten,
        state: row,
      });
    }
    if (url.pathname === '/arm-alarm') {
      const body = await request.json();
      const delayMs = Math.max(10, Number(body.delayMs ?? 30));
      const targetAt = Date.now() + delayMs;
      await this.ctx.storage.setAlarm(targetAt);
      return Response.json({ armedAtMs: targetAt });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    this.ctx.storage.sql.exec(
      'UPDATE harness_smoke_state SET alarm_fires = alarm_fires + 1, last_alarm_ms = ? WHERE id = 1',
      Date.now(),
    );
  }
}

export class GlobalBudgetDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(\`
      CREATE TABLE IF NOT EXISTS harness_smoke_budget (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checks INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO harness_smoke_budget (id, checks) VALUES (1, 0);
    \`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check') {
      const cursor = this.ctx.storage.sql.exec(
        'UPDATE harness_smoke_budget SET checks = checks + 1 WHERE id = 1 RETURNING checks',
      );
      const row = [...cursor][0];
      return Response.json({
        ok: true,
        checks: row.checks,
        rowsRead: cursor.rowsRead,
        rowsWritten: cursor.rowsWritten,
      });
    }
    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/harness-smoke/health') {
      return Response.json({
        ok: true,
        evidenceKind: 'harness_infra_smoke_only',
        emberEnv: env.EMBER_ENV,
        modelMode: env.EMBER_MODEL_MODE,
        isolated: env.EMBER_V2_ISOLATED_HARNESS === 'true',
      });
    }
    if (url.pathname === '/harness-smoke/do') {
      const name = url.searchParams.get('agent') ?? 'smoke-agent-1';
      const stub = env.AGENT_HEAD.get(env.AGENT_HEAD.idFromName(name));
      const action = url.searchParams.get('action') ?? 'ping';
      if (action === 'arm') {
        const res = await stub.fetch('http://do/arm-alarm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.method === 'POST' ? await request.text() : '{}',
        });
        return new Response(res.body, { status: res.status, headers: res.headers });
      }
      const res = await stub.fetch('http://do/ping');
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    if (url.pathname === '/harness-smoke/budget') {
      const stub = env.GLOBAL_BUDGET.get(env.GLOBAL_BUDGET.idFromName('global'));
      const res = await stub.fetch('http://gb/check');
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    if (url.pathname === '/harness-smoke/d1') {
      const res = await env.D1_RECOVERY.prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = 'v2_recovery_registry'",
      ).all();
      return Response.json({ ok: true, results: res.results, meta: res.meta });
    }
    if (url.pathname === '/harness-smoke/queue' && request.method === 'POST') {
      const body = await request.json();
      const targetQueue = body.queue === 'agent_task' ? env.AGENT_TASK_QUEUE : env.DURABLE_TURN_QUEUE;
      await targetQueue.send(body.payload ?? { kind: 'smoke' });
      return Response.json({ enqueued: true, queue: body.queue ?? 'durable_turn' });
    }
    if (url.pathname === '/harness-smoke/events') {
      const list = await env.R2_BLOBS.list({ prefix: 'smoke-events/' });
      const items = [];
      for (const obj of list.objects) {
        const val = await env.R2_BLOBS.get(obj.key);
        if (val) items.push(await val.json());
      }
      return Response.json({ items });
    }
    if (url.pathname === '/harness-smoke/fake-model' && request.method === 'POST') {
      const payload = await request.text();
      const res = await fetch(env.FAKE_MODEL_GATEWAY_URL + '/v2/fake-model/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    }
    return new Response('not found', { status: 404 });
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const body = msg.body ?? {};
      if (batch.queue === 'durable_turn_dlq' || batch.queue === 'agent_task_dlq') {
        await env.R2_BLOBS.put(
          'smoke-events/dlq-' + msg.id + '.json',
          JSON.stringify({ queue: batch.queue, id: msg.id, body, attempts: msg.attempts }),
        );
        msg.ack();
        continue;
      }
      if (body.forceFail === true) {
        msg.retry();
        continue;
      }
      await env.R2_BLOBS.put(
        'smoke-events/ack-' + msg.id + '.json',
        JSON.stringify({ queue: batch.queue, id: msg.id, body, attempts: msg.attempts }),
      );
      msg.ack();
    }
  },

  async scheduled(controller, env) {
    await env.R2_BLOBS.put(
      'smoke-events/cron-' + Date.now() + '.json',
      JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
    );
  },
};
`;

function hasMigrationsDirForBinding(
  effectiveConfig: Record<string, unknown>,
  bindingName: string,
): boolean {
  const dbs = effectiveConfig.d1_databases;
  if (!Array.isArray(dbs)) return false;
  for (const entry of dbs) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).binding === bindingName
    ) {
      const migrationsDir = (entry as Record<string, unknown>).migrations_dir;
      return typeof migrationsDir === 'string' && migrationsDir.trim().length > 0;
    }
  }
  return false;
}

/**
 * Reproducible local Cloudflare `workerd` integration harness for V2 M1.
 * Strictly isolated from V1 production/staging configs and external cloud/LLM egress.
 */
export class V2LocalRuntimeHarness {
  readonly targetKind: V2HarnessTarget['kind'];
  readonly fakeGateway: FakeModelGatewayServer;
  readonly faultInjector: V2FaultInjector;
  readonly wranglerVersion: string;

  #tempDir: string | null = null;
  #wranglerHarness: WranglerTestHarness | null = null;
  #worker: WranglerWorkerHandle | null = null;
  #d1BindingName = 'D1_RECOVERY';

  private constructor(
    targetKind: V2HarnessTarget['kind'],
    wranglerVersion: string,
    fakeGateway: FakeModelGatewayServer,
    faultInjector: V2FaultInjector,
  ) {
    this.targetKind = targetKind;
    this.wranglerVersion = wranglerVersion;
    this.fakeGateway = fakeGateway;
    this.faultInjector = faultInjector;
  }

  static async start(options: V2LocalRuntimeHarnessOptions): Promise<V2LocalRuntimeHarness> {
    // Fail-closed preflight BEFORE starting FakeModelGatewayServer, FaultInjector, or workerd.
    assertSafeLocalV2RuntimeEnv(process.env);
    validateWorkerVarOverrides(options.vars);

    let abConfigPath: string | undefined;
    let abRoot: string | undefined;
    let abEnvName: string | undefined;
    let abPrebuiltWorkerDir: string | undefined;
    let abEffectiveConfig: Record<string, unknown> | undefined;
    let d1BindingName = 'D1_RECOVERY';

    if (options.target.kind === 'ab_runtime') {
      abConfigPath = path.resolve(options.target.configPath);
      const ext = path.extname(abConfigPath).toLowerCase();
      if (ext !== '.json' && ext !== '.jsonc') {
        throw new Error(
          `Unsupported Wrangler config format "${ext || 'none'}" at "${abConfigPath}": local V2 harness only accepts strict JSON/JSONC configs.`,
        );
      }

      abRoot = path.dirname(abConfigPath);
      abEnvName = options.target.env;
      abPrebuiltWorkerDir = options.target.prebuiltWorkerDir;
      if (options.target.d1BindingName !== undefined) {
        d1BindingName = options.target.d1BindingName;
      }

      const rawText = readFileSync(abConfigPath, 'utf8');
      const parsed = parseStrictJsonc(rawText, abConfigPath);
      abEffectiveConfig = assertIsolatedWranglerConfig(parsed, abEnvName);
      assertNoAccidentalEnvFiles(abRoot, abEnvName);
    }

    const apiPkgUrl = new URL('../../../api/package.json', import.meta.url);
    const req = createRequire(apiPkgUrl);
    const wranglerEntry = req.resolve('wrangler');
    const wranglerPkgPath = path.resolve(path.dirname(wranglerEntry), '../package.json');
    let wranglerVersion = 'unknown';
    try {
      const pkg = JSON.parse(readFileSync(wranglerPkgPath, 'utf8')) as { version?: string };
      wranglerVersion = pkg.version ?? 'unknown';
    } catch {
      // ignore
    }

    const wranglerMod = (await import(wranglerEntry)) as WranglerModule;
    const fakeGateway = new FakeModelGatewayServer();
    const faultInjector = new V2FaultInjector();
    const harness = new V2LocalRuntimeHarness(
      options.target.kind,
      wranglerVersion,
      fakeGateway,
      faultInjector,
    );
    harness.#d1BindingName = d1BindingName;

    try {
      const fakeGatewayUrl = await fakeGateway.start();
      const faultControlUrl = await faultInjector.startControlServer();
      assertSafeLocalV2RuntimeEnv(process.env, { fakeGatewayUrl, faultControlUrl });

      const vars = buildSanitizedLocalWorkerVars({ fakeGatewayUrl, faultControlUrl }, options.vars);

      let root: string;
      let configPath: string;
      let envName: string | undefined;
      let prebuiltWorkerDir: string | undefined;

      if (options.target.kind === 'harness_smoke') {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ember-v2-m1-harness-'));
        harness.#tempDir = tempDir;
        writeFileSync(path.join(tempDir, 'smoke-worker.mjs'), HARNESS_SMOKE_WORKER_SOURCE, 'utf8');
        configPath = path.join(tempDir, 'wrangler.jsonc');
        root = tempDir;
        const smokeConfig = {
          name: 'ember-v2-m1-harness-smoke',
          main: 'smoke-worker.mjs',
          compatibility_date: '2026-11-01',
          compatibility_flags: ['nodejs_compat'],
          durable_objects: {
            bindings: [
              { name: 'AGENT_HEAD', class_name: 'AgentHeadDO' },
              { name: 'GLOBAL_BUDGET', class_name: 'GlobalBudgetDO' },
            ],
          },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['AgentHeadDO', 'GlobalBudgetDO'] }],
          d1_databases: [
            {
              binding: 'D1_RECOVERY',
              database_name: 'ember-v2-m1-local-d1',
              database_id: '00000000-0000-0000-0000-000000000010',
            },
          ],
          r2_buckets: [{ binding: 'R2_BLOBS', bucket_name: 'ember-v2-m1-local-blobs' }],
          queues: {
            producers: [
              { binding: 'DURABLE_TURN_QUEUE', queue: 'durable_turn' },
              { binding: 'AGENT_TASK_QUEUE', queue: 'agent_task' },
            ],
            consumers: [
              {
                queue: 'durable_turn',
                max_batch_size: 5,
                max_batch_timeout: 0,
                max_retries: 5,
                retry_delay: 0,
                dead_letter_queue: 'durable_turn_dlq',
              },
              {
                queue: 'agent_task',
                max_batch_size: 5,
                max_batch_timeout: 0,
                max_retries: 5,
                retry_delay: 0,
                dead_letter_queue: 'agent_task_dlq',
              },
              {
                queue: 'durable_turn_dlq',
                max_batch_size: 5,
                max_batch_timeout: 0,
                max_retries: 0,
              },
              { queue: 'agent_task_dlq', max_batch_size: 5, max_batch_timeout: 0, max_retries: 0 },
            ],
          },
          triggers: { crons: ['* * * * *'] },
        };
        assertIsolatedWranglerConfig(smokeConfig);
        writeFileSync(configPath, JSON.stringify(smokeConfig, null, 2), 'utf8');
      } else {
        configPath = abConfigPath!;
        root = abRoot!;
        envName = abEnvName;
        prebuiltWorkerDir = abPrebuiltWorkerDir;
      }

      const wranglerHarness = wranglerMod.createTestHarness({
        root,
        workers: [
          {
            configPath,
            ...(envName !== undefined ? { env: envName } : {}),
            ...(prebuiltWorkerDir !== undefined ? { prebuiltWorkerDir } : {}),
            vars,
          },
        ],
      });

      // Set #wranglerHarness BEFORE listen() so startup failures always clean up via dispose().
      harness.#wranglerHarness = wranglerHarness;
      await wranglerHarness.listen();
      const worker = await wranglerHarness.getWorker();
      harness.#worker = worker;

      const d1 = await harness.getD1Database();
      if (d1 === null) {
        throw new Error(
          `Required D1 binding "${d1BindingName}" is missing from Worker environment.`,
        );
      }

      if (options.target.kind === 'harness_smoke') {
        for (const stmt of HARNESS_SMOKE_D1_RECOVERY_STATEMENTS) {
          await d1.prepare(stmt).run();
        }
      } else {
        // Real ab_runtime path: apply Agent B's actual Wrangler D1 migrations (if declared),
        // never D's smoke fixture DDL, and fail closed if v2_recovery_registry is absent.
        if (
          abEffectiveConfig !== undefined &&
          hasMigrationsDirForBinding(abEffectiveConfig, d1BindingName)
        ) {
          if (typeof worker.applyD1Migrations !== 'function') {
            throw new Error(
              `Wrangler worker handle missing applyD1Migrations() for "${d1BindingName}".`,
            );
          }
          await worker.applyD1Migrations(d1BindingName);
        }

        const check = await d1
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_recovery_registry'",
          )
          .all<{ name: string }>();
        if ((check.results?.length ?? 0) === 0) {
          throw new Error(
            `Required D1 table "v2_recovery_registry" is missing on binding "${d1BindingName}". Agent B must provide real D1 migrations; the acceptance harness does not pre-create or mask missing migrations.`,
          );
        }
      }

      return harness;
    } catch (err) {
      await harness.dispose().catch(() => undefined);
      throw err;
    }
  }

  #requireWorker(): WranglerWorkerHandle {
    if (this.#worker === null) {
      throw new Error('V2LocalRuntimeHarness is not running or already disposed');
    }
    return this.#worker;
  }

  async fetch(pathname: string, init?: RequestInit): Promise<Response> {
    return this.#requireWorker().fetch(pathname, init);
  }

  async fetchJson<T = unknown>(
    pathname: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ readonly status: number; readonly data: T }> {
    const res = await this.#requireWorker().fetch(pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  async triggerScheduled(
    scheduledTimeMs = Date.now(),
    cron = '* * * * *',
  ): Promise<{
    readonly outcome: string;
    readonly noRetry: boolean;
  }> {
    return this.#requireWorker().scheduled({ scheduledTime: new Date(scheduledTimeMs), cron });
  }

  async getEnv(): Promise<Record<string, unknown>> {
    return this.#requireWorker().getEnv();
  }

  async getD1Database(): Promise<D1DatabaseBindingLike | null> {
    const env = await this.getEnv();
    const binding = env[this.#d1BindingName];
    if (binding !== null && typeof binding === 'object') {
      return binding as D1DatabaseBindingLike;
    }
    return null;
  }

  async getQueueProducer(bindingName: string): Promise<QueueProducerBindingLike | null> {
    const env = await this.getEnv();
    const binding = env[bindingName];
    if (binding !== null && typeof binding === 'object') {
      return binding as QueueProducerBindingLike;
    }
    return null;
  }

  async listDurableObjectIds(classNameOrBindingName: string): Promise<readonly string[]> {
    return this.#requireWorker().listDurableObjectIds(classNameOrBindingName);
  }

  async evictDurableObject(
    classNameOrBindingName: string,
    identifier: { readonly name?: string; readonly id?: string },
  ): Promise<void> {
    await this.#requireWorker().evictDurableObject(classNameOrBindingName, identifier);
  }

  async readDurableObjectRows<T = Record<string, unknown>>(
    classNameOrBindingName: string,
    identifier: { readonly name?: string; readonly id?: string },
    query: `SELECT ${string}`,
    ...bindings: (string | number | null)[]
  ): Promise<T[]> {
    const sql = await this.#requireWorker().getDurableObjectStorage(
      classNameOrBindingName,
      identifier,
    );
    return sql.exec<T>(query, ...bindings);
  }

  async dispose(): Promise<void> {
    this.#worker = null;
    if (this.#wranglerHarness !== null) {
      await this.#wranglerHarness.close().catch(() => undefined);
      this.#wranglerHarness = null;
    }
    await this.faultInjector.stopControlServer().catch(() => undefined);
    await this.fakeGateway.stop().catch(() => undefined);
    if (this.#tempDir !== null) {
      rmSync(this.#tempDir, { recursive: true, force: true });
      this.#tempDir = null;
    }
  }
}
