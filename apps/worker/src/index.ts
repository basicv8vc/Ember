import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunExecutionContext, SourceProfileId } from '@ember/contracts';
import {
  LocalBlobStore,
  PostgresApprovalRepository,
  PostgresB1AssistantTurnRepository,
  PostgresBlobStore,
  PostgresBudgetLedger,
  PostgresCheckpointStore,
  PostgresCommitmentRepository,
  PostgresConsentPublicationGuard,
  PostgresConsentRepository,
  PostgresLeaseQueue,
  PostgresModelTurnExecutionRepository,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresWorkspaceStore,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
  systemClock,
} from '@ember/postgres';
import { createModelGateway } from '@ember/model-gateway';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  DeterministicExecutionRouter,
  DeterministicExecutor,
  EXECUTABLE_TASK_KINDS,
  fromResolvedGenerationConsent,
  type SentinelPolicy,
} from '@ember/execution';
import {
  CredentialBroker,
  InMemoryCredentialRegistry,
  SYNTHETIC_EGRESS_POLICY,
} from '@ember/credentials';
import { loadWorkerConfig } from './config.js';
import { evaluateSchedulerConsentGate } from './commitment-consent.js';
import { createCommitmentRunHandler } from './commitment-handler.js';
import { createCommitmentRouteAwareRunHandler } from './commitment-run-router.js';
import { startCommitmentScheduler } from './commitment-scheduler-runtime.js';
import { CommitmentSourceReader } from './commitment-source-reader.js';
import { createDurableRunHandler, DURABLE_TASK_KINDS } from './durable-run-handler.js';
import { createWorkerLogger, safeWorkerErrorCategory, type WorkerLogger } from './logger.js';
import { createFakeTurnResponder, type FakeTurnResponderRunner } from './b1/fake-turn-responder.js';
import {
  createModelTurnResponder,
  type ModelTurnResponderRunner,
} from './b1/model-turn-responder.js';
import { runPollLoop } from './poll-loop.js';
import { runReaperLoop } from './reaper-loop.js';
import { createRunHandler } from './run-handler.js';

function registerShutdown(controller: AbortController, logger: WorkerLogger): void {
  let stopping = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('worker stopping', { signal });
    controller.abort();
  };

  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const databaseConfig = loadDatabaseConfig();
  const logger = createWorkerLogger({ level: config.logLevel });
  const pool = createPool(
    { ...databaseConfig, applicationName: 'ember-worker' },
    {
      onClientError: (error) => {
        logger.warn('database client connection error', {
          category: safeWorkerErrorCategory(error),
        });
      },
    },
  );

  // Claim eligibility is derived from the handler's own capability list, so the worker can
  // never claim a Task kind it has no deterministic branch for.
  const claimableKinds =
    config.mode === 'poll' && config.blobRoot !== null ? DURABLE_TASK_KINDS : EXECUTABLE_TASK_KINDS;
  const queue = new PostgresLeaseQueue(pool, {
    ...config.lease,
    clock: systemClock,
    ...(config.mode === 'poll' ? { claimableKinds } : {}),
  });
  const controller = new AbortController();

  // P0-C3D Consent integration (single durable authority, four gates).
  //
  // `PostgresConsentRepository` is the authoritative store: it implements the frozen P0-C3C
  // `ConsentAuthority.resolveGeneration` and returns the effective (`active` | `revoked` |
  // `expired`) status of the current generation, derived from `expires_at` against the database
  // clock. `fromResolvedGenerationConsent` adapts it to the Worker's fence gates, so one binding
  // simultaneously arms:
  //
  //   1. the orchestrator's versioned pre-read fence,
  //   2. the reader's pre- and post-read fence re-verification,
  //   3. the scheduler startup gate,
  //   4. and, in the PostgreSQL repository, the transaction-scoped dispatch + publication guard
  //      (`PostgresConsentPublicationGuard`), which locks the consent row on the publishing
  //      transaction's own connection.
  //
  // There is no deny-all placeholder and no active-only fallback: an outcome whose occurrence
  // records no generation is refused.
  const consentStore = new PostgresConsentRepository(pool);
  // `grants` is the SAME persistence the generations are resolved from, so the connector boundary
  // evaluates `allowedOperations`/`scopes` against the durable record. A Worker-side copy of those
  // terms would be exactly the scope laundering P0-C3B removed: the boundary could then authorize a
  // read from terms no grant ever approved.
  const consentGrants = {
    get: (tenantId: string, sourceProfileId: SourceProfileId, now?: Date) =>
      consentStore.getForTenant(tenantId, sourceProfileId, now),
  };
  const consentAuthority = fromResolvedGenerationConsent(consentStore, { grants: consentGrants });
  const consentPublicationGuard = new PostgresConsentPublicationGuard();
  const consentGate = evaluateSchedulerConsentGate(consentAuthority);

  registerShutdown(controller, logger);

  logger.info('worker starting', {
    mode: config.mode,
    env: config.env,
    simulatedExecution: config.simulatedExecution,
    b1FakeResponderEnabled: config.b1FakeResponderEnabled,
    modelExecution: config.model.ok ? config.model.mode : 'refused',
    durableExecution: config.blobRoot !== null,
    workerId: config.workerId,
    database: describeDatabaseTarget(databaseConfig.connectionString),
    leaseDurationMs: config.lease.leaseDurationMs,
    heartbeatIntervalMs: config.lease.heartbeatIntervalMs,
    reaperIntervalMs: config.intervalMs,
    concurrency: config.concurrency,
    budgetPolicyId: config.budget.policyId,
    budgetPolicyVersion: config.budget.policyVersion,
    sentinelPolicyId: config.sentinel.policyId,
    sentinelPolicyVersion: config.sentinel.policyVersion,
    credentialBrokerBound: true,
    schedulerEnabled: config.scheduler.enabled,
    consentReady: consentGate.ready,
    consentReadiness: consentGate.reason,
    ...(config.mode === 'poll' ? { claimableKinds } : {}),
  });

  let schedulerLoop: Promise<void> = Promise.resolve();
  let reaperLoop: Promise<void> | undefined;
  let fakeTurnRunner: FakeTurnResponderRunner | undefined;
  let modelTurnRunner: ModelTurnResponderRunner | undefined;
  try {
    if (config.b1FakeResponderEnabled) {
      fakeTurnRunner = createFakeTurnResponder({
        repository: new PostgresB1AssistantTurnRepository(pool),
        logger,
      }).start(controller.signal);
      logger.info('fake B1 assistant turn responder enabled');
    }

    // B2: the only place a real model reply can be produced. `disabled` starts nothing at all;
    // `fake` runs the same claim/fence chain with labelled, zero-cost output; `real` reaches the
    // pinned adapter, which itself refuses to be constructed without an approved model and rate.
    if (config.model.ok && config.model.mode !== 'disabled') {
      const mode = config.model.mode;
      const gateway = createModelGateway(config.model);

      modelTurnRunner = createModelTurnResponder({
        mode,
        repository: new PostgresModelTurnExecutionRepository(pool),
        gateway,
        workerId: config.workerId,
        leaseMs: config.model.settings.leaseMs,
        ceilings: config.model.settings.ceilings,
        maxAttempts: config.model.settings.maxAttempts,
        attemptTimeoutMs: config.model.settings.attemptTimeoutMs,
        rate: mode === 'real' ? config.model.rate : null,
        logger,
      }).start(controller.signal);

      logger.info('model assistant turn responder enabled', {
        mode,
        providerId: config.model.settings.providerId,
        modelId: config.model.settings.modelId,
        // Which reviewed decision this process is spending under, and when it lapses. Both are
        // policy, not secrets: an operator reading a log should be able to answer "who allowed
        // this, until when" without opening the repository.
        ...(config.model.mode === 'real'
          ? {
              approvalId: config.model.approval.approvalId,
              approvalExpiresAt: config.model.approval.expiresAt,
              rateVersion: config.model.rate.rateVersion,
            }
          : {}),
        // Ceilings are policy, not secrets: logging them makes a misconfiguration visible.
        principalDailyMicroUsd: config.model.settings.ceilings.principalDailyMicroUsd,
        tenantDailyMicroUsd: config.model.settings.ceilings.tenantDailyMicroUsd,
        globalDailyMicroUsd: config.model.settings.ceilings.globalDailyMicroUsd,
        maxAttempts: config.model.settings.maxAttempts,
      });
    }

    // P0-C3B: shares `controller.signal`, so SIGINT/SIGTERM drains it with every other loop.
    schedulerLoop = startCommitmentScheduler({
      config,
      pool,
      logger,
      signal: controller.signal,
      consent: consentAuthority,
    });

    const reaper = runReaperLoop({
      queue,
      clock: systemClock,
      intervalMs: config.intervalMs,
      errorBackoffMs: config.errorBackoffMs,
      logger,
      signal: controller.signal,
    });
    reaperLoop = reaper;

    if (config.mode === 'reaper-only') {
      // Task reaping, the scheduler and B1 turns share one lifecycle and drain together.
      await Promise.all([
        reaper,
        schedulerLoop,
        ...(fakeTurnRunner === undefined ? [] : [fakeTurnRunner.done]),
        ...(modelTurnRunner === undefined ? [] : [modelTurnRunner.done]),
      ]);
      return;
    }

    const contextReader = new PostgresRunExecutionContextReader(pool, systemClock);
    const router = new DeterministicExecutionRouter();
    const executor = new DeterministicExecutor();

    // Wire Lane C's simulated Credential Broker in trusted composition root (P0-C2C / P0-C2B)
    const credentialRegistry = new InMemoryCredentialRegistry();
    const credentialBroker = new CredentialBroker({
      registry: credentialRegistry,
      policy: SYNTHETIC_EGRESS_POLICY,
      trustedWorkerId: config.workerId,
    });

    // With a controlled blob root the worker runs the P0B-06 durable path: artifacts,
    // checkpoints and the terminal Run state are committed by one fenced transaction.
    // Without it, only the in-memory P0B-05 simulation is available.
    const blobs =
      config.blobRoot === null
        ? null
        : new PostgresBlobStore(pool, new LocalBlobStore({ rootDir: config.blobRoot }));

    const sentinelPolicy = (context: RunExecutionContext): SentinelPolicy =>
      createDefaultSentinelPolicy({
        policyId: config.sentinel.policyId,
        policyVersion: config.sentinel.policyVersion,
        tenantId: context.tenantId,
        allowedActions: config.sentinel.allowedActions,
      });

    // The commitment orchestrator resolves its policy from the occurrence context, which carries
    // the same trusted tenant but not the Run-only fields.
    const commitmentSentinelPolicy = (context: { readonly tenantId: string }): SentinelPolicy =>
      createDefaultSentinelPolicy({
        policyId: config.sentinel.policyId,
        policyVersion: config.sentinel.policyVersion,
        tenantId: context.tenantId,
        allowedActions: config.sentinel.allowedActions,
      });

    // One durable budget ledger backs both execution paths, so the commitment loop cannot
    // silently exceed a limit the standard path enforces.
    const budgetLedger = new PostgresBudgetLedger(pool, { policy: config.budget });

    const defaultHandler =
      blobs === null
        ? createRunHandler({
            contextReader,
            router,
            executor,
            clock: systemClock,
            logger,
            sentinelPolicy,
            credentialBroker,
          })
        : createDurableRunHandler({
            contextReader,
            router,
            executor,
            blobs,
            checkpoints: new PostgresCheckpointStore(pool),
            committer: new PostgresRunResultCommitter(pool, {
              policy: config.lease,
              blobs,
            }),
            workspaces: new PostgresWorkspaceStore(pool),
            approvals: new PostgresApprovalRepository(pool, { clock: systemClock }),
            budget: budgetLedger,
            clock: systemClock,
            logger,
            sentinelPolicy,
            credentialBroker,
          });

    // P0-C3B execution runtime: authoritative PostgreSQL commitment store, consent-gated source
    // reader, guarded orchestrator and the occurrence-aware run handler. The store carries the
    // transaction-scoped Consent publication guard, so an Outcome can only be appended while the
    // same authority reports active Consent.
    const commitmentStore = new PostgresCommitmentRepository(pool, {
      consentPublicationGuard,
    });

    const commitmentHandler = createCommitmentRunHandler({
      contextReader,
      store: commitmentStore,
      orchestrator: new CommitmentOrchestrator({
        store: {
          findAuthoritativeOutcome: (grant, query) =>
            commitmentStore.findAuthoritativeOutcome(grant, query),
          appendOutcomeIfAbsent: (grant, cmd) => commitmentStore.appendOutcomeIfAbsent(grant, cmd),
        },
        // Consumed exactly like Lane C's durable authority will be: the orchestrator captures a
        // versioned fence before the read and re-verifies it immediately before publication. The
        // placeholder rejects both calls, so nothing is read and nothing is published.
        consent: consentAuthority,
        sourceReader: new CommitmentSourceReader({
          consent: consentAuthority,
          grants: consentGrants,
          logger,
        }),
        budget: budgetLedger,
        sentinelPolicy: commitmentSentinelPolicy,
        clock: systemClock,
        logger,
      }),
      clock: systemClock,
      workerId: config.workerId,
      logger,
    });

    const handler = createCommitmentRouteAwareRunHandler({
      contextReader,
      clock: systemClock,
      commitmentHandler,
      defaultHandler,
      logger,
    });

    // Every loop shares one stop signal: shutdown drains Task polling/reaping, the scheduler and
    // B1 turns before the PostgreSQL pool can close.
    try {
      const pollSummary = runPollLoop({
        queue,
        handler,
        clock: systemClock,
        workerId: config.workerId,
        concurrency: config.concurrency,
        heartbeatIntervalMs: config.lease.heartbeatIntervalMs,
        idleIntervalMs: config.intervalMs,
        errorBackoffMs: config.errorBackoffMs,
        logger,
        signal: controller.signal,
      });
      await Promise.all([
        reaper,
        schedulerLoop,
        pollSummary,
        ...(fakeTurnRunner === undefined ? [] : [fakeTurnRunner.done]),
        ...(modelTurnRunner === undefined ? [] : [modelTurnRunner.done]),
      ]);
      const summary = await pollSummary;

      logger.info('poll loop stopped', { ...summary, workerId: config.workerId });
    } catch (error) {
      // A failing poll loop must never leave the reaper or scheduler running: abort first, then
      // drain them, so the pool can be closed exactly once below.
      controller.abort();
      fakeTurnRunner?.stop();
      modelTurnRunner?.stop();
      await Promise.allSettled([
        reaper,
        schedulerLoop,
        ...(fakeTurnRunner === undefined ? [] : [fakeTurnRunner.done]),
        ...(modelTurnRunner === undefined ? [] : [modelTurnRunner.done]),
      ]);
      throw error;
    }
  } finally {
    // Also drain loops if initialization failed before reaching the main Promise.all. Otherwise
    // the scheduler or B1 responder could keep using a pool that is already closing.
    controller.abort();
    fakeTurnRunner?.stop();
    modelTurnRunner?.stop();
    await Promise.allSettled([
      schedulerLoop,
      ...(reaperLoop === undefined ? [] : [reaperLoop]),
      ...(fakeTurnRunner === undefined ? [] : [fakeTurnRunner.done]),
      ...(modelTurnRunner === undefined ? [] : [modelTurnRunner.done]),
    ]);
    await pool.end();
    logger.info('worker stopped', { workerId: config.workerId });
  }
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    // Keep fatal programming errors fatal, but never print driver messages that may include
    // connection details, SQL, parameters or source text.
    process.stderr.write(`worker failed: ${safeWorkerErrorCategory(error)}\n`);
    process.exitCode = 1;
  });
}
