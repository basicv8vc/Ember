import type { RunExecutionContext } from '@ember/contracts';
import {
  LocalBlobStore,
  PostgresApprovalRepository,
  PostgresBlobStore,
  PostgresBudgetLedger,
  PostgresCheckpointStore,
  PostgresCommitmentRepository,
  PostgresLeaseQueue,
  PostgresRunExecutionContextReader,
  PostgresRunResultCommitter,
  PostgresWorkspaceStore,
  createPool,
  describeDatabaseTarget,
  loadDatabaseConfig,
  systemClock,
} from '@ember/postgres';
import {
  CommitmentOrchestrator,
  createDefaultSentinelPolicy,
  DeterministicExecutionRouter,
  DeterministicExecutor,
  EXECUTABLE_TASK_KINDS,
  type SentinelPolicy,
} from '@ember/execution';
import {
  CredentialBroker,
  InMemoryCredentialRegistry,
  SYNTHETIC_EGRESS_POLICY,
} from '@ember/credentials';
import { loadWorkerConfig } from './config.js';
import {
  createCommitmentConsentPublicationGuard,
  evaluateSchedulerConsentGate,
} from './commitment-consent.js';
import { createCommitmentRunHandler } from './commitment-handler.js';
import { createCommitmentRouteAwareRunHandler } from './commitment-run-router.js';
import { startCommitmentScheduler } from './commitment-scheduler-runtime.js';
import {
  CommitmentSourceReader,
  createUnavailableConsentAuthority,
} from './commitment-source-reader.js';
import { createDurableRunHandler, DURABLE_TASK_KINDS } from './durable-run-handler.js';
import { createWorkerLogger, type WorkerLogger } from './logger.js';
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
  const pool = createPool(databaseConfig, {
    onIdleError: () => {
      logger.warn('database idle connection error');
    },
  });

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

  // P0-C3B Consent integration seam (single object, four gates).
  //
  // The authority wired here simultaneously arms: the orchestrator's versioned pre-read fence,
  // the reader's pre- and post-read fence re-verification, the transaction-scoped publication
  // guard inside `PostgresCommitmentRepository`, and the scheduler startup gate. Lane C has not
  // landed durable Consent persistence yet, so this is the deny-all placeholder and every one of
  // those gates fails closed.
  //
  // The whole integration is replacing this one binding with a P0-C3C `resolveGeneration`
  // authority wrapped in `fromResolvedGenerationConsent(...)`; no gate changes when it lands.
  const consentAuthority = createUnavailableConsentAuthority();
  const consentGate = evaluateSchedulerConsentGate(consentAuthority);

  registerShutdown(controller, logger);

  logger.info('worker starting', {
    mode: config.mode,
    env: config.env,
    simulatedExecution: config.simulatedExecution,
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
  try {
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
      // The scheduler still shares this lifecycle: shutdown drains both loops together.
      await Promise.all([reaper, schedulerLoop]);
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
      consentPublicationGuard: createCommitmentConsentPublicationGuard(consentAuthority),
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

    // Every loop shares one stop signal: shutdown drains the reaper and scheduler while the poll
    // loop stops claiming new Runs, and in-flight executions observe the abort.
    try {
      const summary = await Promise.all([
        reaper,
        schedulerLoop,
        runPollLoop({
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
        }),
      ]).then(([, , pollSummary]) => pollSummary);

      logger.info('poll loop stopped', { ...summary, workerId: config.workerId });
    } catch (error) {
      // A failing poll loop must never leave the reaper or scheduler running: abort first, then
      // drain them, so the pool can be closed exactly once below.
      controller.abort();
      await Promise.allSettled([reaper, schedulerLoop]);
      throw error;
    }
  } finally {
    // Also drain loops if initialization failed before reaching the main Promise.all. Otherwise
    // the scheduler could keep using a pool that is already closing.
    controller.abort();
    await Promise.allSettled([schedulerLoop, ...(reaperLoop === undefined ? [] : [reaperLoop])]);
    await pool.end();
    logger.info('worker stopped', { workerId: config.workerId });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`worker failed: ${message}\n`);
  process.exitCode = 1;
});
