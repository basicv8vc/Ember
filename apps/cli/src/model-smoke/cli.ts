import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelGateway } from '@ember/model-gateway';
import {
  createPool,
  describeDatabaseTarget,
  formatDatabaseTarget,
  loadDatabaseConfig,
  PostgresB1ConversationWriteRepository,
  PostgresModelTurnExecutionRepository,
} from '@ember/postgres';
import { createModelTurnResponder } from '../../../worker/src/b1/model-turn-responder.js';
import { loadWorkerConfig } from '../../../worker/src/config.js';

/**
 * L4-B paid Smoke Test — the only command in this repository that may incur a real provider charge.
 *
 * It is a separate executable on purpose. Nothing in CI, in `pnpm test`, or in the worker imports it,
 * so a green pipeline can never spend money; and it refuses to run unless every condition below is
 * already satisfied in the environment it is given:
 *
 *   1. `EMBER_MODEL_EXECUTION=real` resolves — which by itself requires the code-owned allowlist
 *      entry, an **unexpired dated approval record**, an explicitly reviewed official-price or
 *      invoice rate row and a usable credential (see `resolveModelExecution`);
 *   2. `EMBER_MODEL_SMOKE_APPROVAL` names that same approval id — an operator must restate the
 *      decision, because "the config was real" is not the same as "I was asked to spend now";
 *   3. `--max-turns` is exactly 1 — this command creates exactly one requested Turn;
 *   4. the responder is scoped to that exact Turn id, so concurrent or historical Turns cannot be
 *      picked up and billed by this run;
 *   5. `--confirm` is passed. Without it the command prints the plan and exits.
 *
 * `EMBER_MODEL_SMOKE_DATABASE_URL` is mandatory and must target a dedicated database distinct from
 * `DATABASE_URL`. The smoke refuses any existing assistant Turns or resident Worker connection.
 */

export const MAX_SMOKE_TURNS = 1;

export interface SmokePlan {
  readonly approvalId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly rateVersion: string;
  readonly maxTurns: number;
  readonly database: string;
}

export type SmokeRefusal =
  | 'approval_not_real'
  | 'approval_missing'
  | 'approval_mismatch'
  | 'max_turns_invalid'
  | 'not_confirmed';

export interface SmokePreconditions {
  readonly modelMode: string;
  readonly modelId: string | null;
  readonly providerId: string;
  readonly rateVersion: string | null;
  readonly approvalIdFromConfig: string | null;
  readonly approvalIdFromEnv: string | undefined;
  readonly maxTurns: number;
  readonly confirmed: boolean;
}

/** Require separate host/port/database identity; credentials are intentionally ignored. */
export function hasIsolatedSmokeDatabase(
  smokeDatabaseUrl: string,
  runtimeDatabaseUrl: string,
): boolean {
  const smoke = describeDatabaseTarget(smokeDatabaseUrl);
  const runtime = describeDatabaseTarget(runtimeDatabaseUrl);

  if (
    smoke.host === null ||
    smoke.database === null ||
    runtime.host === null ||
    runtime.database === null
  ) {
    return false;
  }

  // Database names must differ even when the URLs use aliases for the same PostgreSQL host.
  if (smoke.database === runtime.database) {
    return false;
  }

  const smokeKey = `${smoke.host.toLowerCase()}:${smoke.port ?? 5432}/${smoke.database}`;
  const runtimeKey = `${runtime.host.toLowerCase()}:${runtime.port ?? 5432}/${runtime.database}`;
  return smokeKey !== runtimeKey;
}

/**
 * Pure gate, so the refusal matrix is testable without a database, a credential or a network.
 *
 * The order matters: "the deployment is not even configured for real inference" is a different
 * message from "you did not confirm this run", and an operator needs to know which one stopped them.
 */
export function evaluateSmokePreconditions(
  input: SmokePreconditions,
):
  | { readonly ok: true; readonly approvalId: string }
  | { readonly ok: false; readonly refusal: SmokeRefusal } {
  if (input.modelMode !== 'real') {
    return { ok: false, refusal: 'approval_not_real' };
  }

  const declared = input.approvalIdFromEnv?.trim() ?? '';

  if (declared.length === 0) {
    return { ok: false, refusal: 'approval_missing' };
  }

  if (input.approvalIdFromConfig === null || declared !== input.approvalIdFromConfig) {
    return { ok: false, refusal: 'approval_mismatch' };
  }

  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > MAX_SMOKE_TURNS) {
    return { ok: false, refusal: 'max_turns_invalid' };
  }

  if (!input.confirmed) {
    return { ok: false, refusal: 'not_confirmed' };
  }

  return { ok: true, approvalId: declared };
}

const REFUSAL_TEXT: Readonly<Record<SmokeRefusal, string>> = Object.freeze({
  approval_not_real:
    'EMBER_MODEL_EXECUTION is not a resolved "real" mode. There is nothing to smoke-test, and a ' +
    'fake provider is never a substitute: fix the model configuration first (see ' +
    'docs/product/L4B-FIRST-REAL-LLM-RESPONSE.md §7).',
  approval_missing:
    'EMBER_MODEL_SMOKE_APPROVAL is unset. A paid run must restate the approval id it is relying on.',
  approval_mismatch:
    'EMBER_MODEL_SMOKE_APPROVAL does not match the approval recorded for the configured model. ' +
    'Refusing: the id in the environment and the id in code must be the same decision.',
  max_turns_invalid: '--max-turns must be exactly 1 for a paid smoke run.',
  not_confirmed: 'Refusing to spend without --confirm. The plan above is what would have run.',
});

export interface SmokeDeps {
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly writeEvidence: (path: string, text: string) => void;
}

export interface ParsedSmokeArgs {
  readonly confirm: boolean;
  readonly maxTurns: number;
  readonly text: string;
  readonly evidencePath: string | null;
}

export const DEFAULT_SMOKE_PROMPT =
  'Reply with one short sentence confirming that this is a live model response.';

export function parseSmokeArgs(argv: readonly string[]): ParsedSmokeArgs {
  let confirm = false;
  let maxTurns = 1;
  let text = DEFAULT_SMOKE_PROMPT;
  let evidencePath: string | null = null;

  for (const argument of argv) {
    if (argument === '--confirm') {
      confirm = true;
    } else if (argument.startsWith('--max-turns=')) {
      maxTurns = Number(argument.slice('--max-turns='.length));
    } else if (argument.startsWith('--text=')) {
      text = argument.slice('--text='.length);
    } else if (argument.startsWith('--evidence=')) {
      evidencePath = argument.slice('--evidence='.length);
    }
  }

  return { confirm, maxTurns, text, evidencePath };
}

/**
 * The evidence document.
 *
 * Content-free by construction: it carries ids, timings, the pinned model identity and the booked
 * cost, and it never carries the prompt text, the reply text or the credential. A reviewer needs to
 * verify *that* a turn happened and what it cost, not what was said.
 */
export interface SmokeEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'l4b-paid-smoke';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly approvalId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly rateVersion: string;
  readonly database: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly summary: Readonly<Record<string, number | boolean>>;
  readonly attemptCount: number;
  readonly turn: {
    readonly status: string;
    readonly failureReason: string | null;
    readonly responseMessageId: string | null;
  };
  readonly reply: {
    readonly messageId: string;
    readonly modelLabel: string;
    readonly simulated: boolean;
    readonly characters: number;
  } | null;
  readonly attempt: {
    readonly attemptNo: number;
    readonly state: string;
    readonly outcomeCode: string | null;
    readonly reservedMicroUsd: string;
    readonly appliedCostMicroUsd: string | null;
    readonly observedCostMicroUsd: string | null;
    readonly inputTokens: string | null;
    readonly outputTokens: string | null;
  } | null;
  readonly verdict: 'pass' | 'fail';
  readonly reasons: readonly string[];
}

export function buildEvidence(input: {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly plan: SmokePlan;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly summary: Readonly<Record<string, number | boolean>>;
  readonly attemptCount: number;
  readonly turn: SmokeEvidence['turn'];
  readonly reply: SmokeEvidence['reply'];
  readonly attempt: SmokeEvidence['attempt'];
}): SmokeEvidence {
  const reasons: string[] = [];

  if (input.summary['completed'] !== 1) {
    reasons.push('the responder did not report exactly one completed Turn');
  }
  if (input.summary['examined'] !== 1) {
    reasons.push('the responder did not examine exactly the one scoped smoke Turn');
  }
  if (input.turn.status !== 'completed') {
    reasons.push(`the persisted Turn status is ${input.turn.status}`);
  }
  if (input.reply === null) {
    reasons.push('no Ember reply row was persisted');
  } else {
    if (input.reply.simulated) {
      reasons.push('the persisted reply is marked simulated');
    }
    if (input.reply.modelLabel !== input.plan.modelId) {
      reasons.push('the persisted reply does not carry the pinned model id');
    }
    if (input.reply.characters === 0) {
      reasons.push('the persisted reply is empty');
    }
  }
  if (input.attemptCount !== 1) {
    reasons.push(`the smoke wrote ${input.attemptCount} provider attempts instead of exactly one`);
  }
  if (input.attempt === null) {
    reasons.push('no attempt row was written');
  } else {
    if (input.attempt.attemptNo !== 1) {
      reasons.push(`the smoke attempt number is ${input.attempt.attemptNo} instead of 1`);
    }
    if (input.attempt.state !== 'settled') {
      reasons.push(`the attempt settled as ${input.attempt.state}`);
    }
  }

  return {
    schemaVersion: 1,
    kind: 'l4b-paid-smoke',
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    approvalId: input.plan.approvalId,
    providerId: input.plan.providerId,
    modelId: input.plan.modelId,
    rateVersion: input.plan.rateVersion,
    database: input.plan.database,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    summary: input.summary,
    attemptCount: input.attemptCount,
    turn: input.turn,
    reply: input.reply,
    attempt: input.attempt,
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* The executable part. Nothing above touches the network or a database.                            */
/* ------------------------------------------------------------------------------------------------ */

interface Row {
  readonly [key: string]: unknown;
}

/**
 * Reads a column as text.
 *
 * `Row` holds `unknown` by design, because `pg` decides a JavaScript type per column; formatting one
 * with `String()` would silently print `[object Object]` for anything unexpected. Only a scalar that
 * has an unambiguous textual form is rendered, and anything else is a programming error rather than
 * something to paste into an evidence file.
 */
function columnText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

function columnTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : columnText(value);
}

function columnNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return Number(value);
  }
  return Number.NaN;
}

/**
 * Runs one Turn through the production responder against the configured database.
 */
export async function runPaidSmoke(
  args: ParsedSmokeArgs,
  deps: SmokeDeps = {
    now: () => new Date(),
    log: (line) => process.stdout.write(`${line}\n`),
    writeEvidence: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  },
): Promise<number> {
  const env = process.env;
  const model = loadWorkerConfig(env).model;

  if (!model.ok) {
    deps.log(`refused: model execution resolution failed (${model.reason})`);
    return 2;
  }

  const gate = evaluateSmokePreconditions({
    modelMode: model.mode,
    modelId: model.mode === 'real' ? model.settings.modelId : null,
    providerId: model.settings.providerId,
    rateVersion: model.mode === 'real' ? model.rate.rateVersion : null,
    approvalIdFromConfig: model.mode === 'real' ? model.approval.approvalId : null,
    approvalIdFromEnv: env['EMBER_MODEL_SMOKE_APPROVAL'],
    maxTurns: args.maxTurns,
    confirmed: args.confirm,
  });

  if (!gate.ok) {
    deps.log(`refused: ${REFUSAL_TEXT[gate.refusal]}`);
    return 2;
  }

  if (model.mode !== 'real') {
    // Unreachable after the gate, but the narrowing has to be explicit for the type checker.
    deps.log('refused: model execution is not real');
    return 2;
  }

  const smokeDatabaseUrl = env['EMBER_MODEL_SMOKE_DATABASE_URL']?.trim() ?? '';
  const runtimeDatabaseUrl = env['DATABASE_URL']?.trim() ?? '';

  if (
    smokeDatabaseUrl.length === 0 ||
    runtimeDatabaseUrl.length === 0 ||
    !hasIsolatedSmokeDatabase(smokeDatabaseUrl, runtimeDatabaseUrl)
  ) {
    deps.log(
      'refused: EMBER_MODEL_SMOKE_DATABASE_URL must point to a separate dedicated database from DATABASE_URL.',
    );
    return 3;
  }

  const databaseConfig = loadDatabaseConfig({ DATABASE_URL: smokeDatabaseUrl });
  // Host/port/database only: `formatDatabaseTarget` never prints the credential.
  const database = formatDatabaseTarget(describeDatabaseTarget(databaseConfig.connectionString));

  const plan: SmokePlan = {
    approvalId: gate.approvalId,
    providerId: model.settings.providerId,
    modelId: model.settings.modelId ?? '',
    rateVersion: model.rate.rateVersion,
    maxTurns: args.maxTurns,
    database,
  };

  deps.log('paid smoke plan');
  deps.log(`  approval        ${plan.approvalId}`);
  deps.log(`  provider/model  ${plan.providerId} / ${plan.modelId}`);
  deps.log(`  rate            ${plan.rateVersion}`);
  deps.log(`  database        ${plan.database}`);
  deps.log(`  max turns       ${plan.maxTurns}`);
  deps.log(`  per-attempt ceiling ${model.settings.ceilings.perAttemptMicroUsd / 1_000_000} USD`);

  const pool = createPool(databaseConfig);
  const startedAt = deps.now();

  try {
    const residentWorkers = await pool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name IN ('ember', 'ember-worker')
          AND pid <> pg_backend_pid()`,
    );

    if (Number(residentWorkers.rows[0]?.count ?? '0') > 0) {
      deps.log(
        'refused: an Ember Worker is connected to the smoke database. Stop it or select a dedicated database.',
      );
      return 3;
    }

    const existingTurns = await pool.query<{ readonly count: string }>(
      'SELECT count(*)::text AS count FROM assistant_turns',
    );

    if (Number(existingTurns.rows[0]?.count ?? '0') > 0) {
      deps.log(
        'refused: the dedicated smoke database already contains assistant Turns. Use an empty isolated database.',
      );
      return 3;
    }

    const tenantId = randomUUID();
    const principalId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
      tenantId,
      `l4b smoke ${startedAt.toISOString()}`,
    ]);
    await pool.query("INSERT INTO principals (id, tenant_id, role) VALUES ($1, $2, 'owner')", [
      principalId,
      tenantId,
    ]);
    await pool.query('INSERT INTO consumers (id, tenant_id, principal_id) VALUES ($1, $2, $3)', [
      randomUUID(),
      tenantId,
      principalId,
    ]);
    await pool.query(
      'INSERT INTO agents (id, tenant_id, name, policy_version) VALUES ($1, $2, $3, 1)',
      [agentId, tenantId, 'l4b smoke agent'],
    );
    await pool.query(
      "INSERT INTO conversations (id, tenant_id, agent_id, kind) VALUES ($1, $2, $3, 'main')",
      [conversationId, tenantId, agentId],
    );

    const writer = new PostgresB1ConversationWriteRepository(pool);
    const submitted = await writer.submitUserMessage({
      tenantId,
      conversationId,
      request: { client_submission_id: randomUUID(), text: args.text, transcript_epoch: 0 },
    });

    const gateway = createModelGateway(model);
    const responder = createModelTurnResponder({
      mode: 'real',
      repository: new PostgresModelTurnExecutionRepository(pool),
      gateway,
      workerId: 'l4b-paid-smoke',
      leaseMs: model.settings.leaseMs,
      ceilings: model.settings.ceilings,
      // The first paid smoke has one provider attempt. A failed call is reconciled before any
      // human decides whether to run another smoke; the normal worker keeps its two-attempt bound.
      maxAttempts: 1,
      attemptTimeoutMs: model.settings.attemptTimeoutMs,
      rate: model.rate,
      onlyTurn: {
        tenantId,
        conversationId,
        turnId: submitted.receipt.turn.turn_id,
      },
      batchSize: 1,
      intervalMs: 1_000,
    });

    // One pass, one Turn. `maxTurns` is a hard stop on the loop, not a retry budget: an attempt
    // retry inside a Turn is already bounded by `maxAttempts` and is part of one paid Turn.
    const summaries: Array<Readonly<Record<string, number | boolean>>> = [];

    for (let index = 0; index < plan.maxTurns; index += 1) {
      const summary = await responder.processOnce();
      summaries.push(summary as unknown as Readonly<Record<string, number | boolean>>);

      if (summary.examined === 0) {
        break;
      }
    }

    const finishedAt = deps.now();

    const turn = await pool.query<Row>(
      `SELECT status, failure_reason, response_message_id
         FROM assistant_turns WHERE tenant_id = $1 AND id = $2`,
      [tenantId, submitted.receipt.turn.turn_id],
    );

    const reply = await pool.query<Row>(
      `SELECT id, model_label, simulated, length(text)::text AS chars
         FROM conversation_messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'ember'
        ORDER BY sequence DESC LIMIT 1`,
      [tenantId, conversationId],
    );

    const attempts = await pool.query<Row>(
      `SELECT attempt_no, state, outcome_code, reserved_micro_usd::text, 
              applied_cost_micro_usd::text, observed_cost_micro_usd::text,
              input_tokens::text, output_tokens::text
         FROM model_turn_attempts
        WHERE tenant_id = $1 AND turn_id = $2
        ORDER BY attempt_no`,
      [tenantId, submitted.receipt.turn.turn_id],
    );

    const turnRow = turn.rows[0];
    const replyRow = reply.rows[0];
    const attemptRow = attempts.rows[0];

    const evidence = buildEvidence({
      startedAt,
      finishedAt,
      plan,
      tenantId,
      conversationId,
      turnId: submitted.receipt.turn.turn_id,
      summary: summaries[0] ?? {},
      attemptCount: attempts.rows.length,
      turn: {
        status: columnText(turnRow?.['status'] ?? 'missing'),
        failureReason: columnTextOrNull(turnRow?.['failure_reason']),
        responseMessageId: columnTextOrNull(turnRow?.['response_message_id']),
      },
      reply:
        replyRow === undefined
          ? null
          : {
              messageId: columnText(replyRow['id']),
              modelLabel: columnText(replyRow['model_label']),
              simulated: replyRow['simulated'] === true,
              characters: columnNumber(replyRow['chars']),
            },
      attempt:
        attemptRow === undefined
          ? null
          : {
              attemptNo: columnNumber(attemptRow['attempt_no']),
              state: columnText(attemptRow['state']),
              outcomeCode: columnTextOrNull(attemptRow['outcome_code']),
              reservedMicroUsd: columnText(attemptRow['reserved_micro_usd']),
              appliedCostMicroUsd: columnTextOrNull(attemptRow['applied_cost_micro_usd']),
              observedCostMicroUsd: columnTextOrNull(attemptRow['observed_cost_micro_usd']),
              inputTokens: columnTextOrNull(attemptRow['input_tokens']),
              outputTokens: columnTextOrNull(attemptRow['output_tokens']),
            },
    });

    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;

    if (args.evidencePath !== null) {
      deps.writeEvidence(args.evidencePath, serialized);
      deps.log(`evidence written to ${args.evidencePath}`);
    } else {
      process.stdout.write(serialized);
    }

    deps.log(
      `verdict ${evidence.verdict}` +
        (evidence.reasons.length === 0 ? '' : `: ${evidence.reasons.join('; ')}`),
    );

    return evidence.verdict === 'pass' ? 0 : 1;
  } finally {
    await pool.end();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return runPaidSmoke(parseSmokeArgs(argv));
}

// Direct CLI execution guard, mirroring `sandbox-smoke`: importing this module from a test must not
// run anything, and running it must never be a side effect of another command.
const currentFilePath = fileURLToPath(import.meta.url);
const entryArg = process.argv[1];

if (
  entryArg &&
  (resolve(entryArg) === currentFilePath || entryArg.endsWith('model-smoke/cli.ts'))
) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      // Never print a driver message: it can carry connection details or SQL parameters.
      process.stderr.write(`[FATAL]: ${error instanceof Error ? error.name : 'unknown error'}\n`);
      process.exit(1);
    });
}
