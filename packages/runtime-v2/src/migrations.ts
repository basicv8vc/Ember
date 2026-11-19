import type { D1DatabaseLike, DurableObjectStorageLike } from './storage.js';
import {
  DEFAULT_AGENT_HEAD_BUSINESS_DO_MIGRATION_VERSION,
  V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS,
} from './agent-head/schema.js';
import {
  V2_EVENT_RECOVERY_DO_STATEMENTS,
  V2_RECOVERY_REGISTRY_D1_STATEMENTS,
} from './recovery/schema.js';

/**
 * Shared AgentHeadDO schema version ledger per V2-M0-A §4.1 and J1.
 * Both Agent A business migrations (v1) and Agent B event/recovery migrations (v2) execute
 * through the single `applyAgentHeadMigrations` entrypoint inside `blockConcurrencyWhile`.
 */
export const SCHEMA_MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL,
  checksum      TEXT    NOT NULL
);`;

export const DEFAULT_EVENT_RECOVERY_DO_MIGRATION_VERSION = 2;

export interface AgentHeadMigrationStep {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  readonly checksum?: string;
}

export interface AgentHeadMigrationResult {
  readonly appliedVersions: readonly number[];
  readonly alreadyAppliedVersions: readonly number[];
  readonly totalSteps: number;
}

export class MigrationChecksumMismatchError extends Error {
  readonly version: number;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(version: number, expectedChecksum: string, actualChecksum: string) {
    super(
      `schema_migrations checksum mismatch at version ${version}: expected ${expectedChecksum}, got ${actualChecksum}`,
    );
    this.name = 'MigrationChecksumMismatchError';
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export class MigrationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationDefinitionError';
  }
}

/**
 * Synchronous deterministic 64-bit FNV-1a checksum usable inside DO `transactionSync()`.
 */
export function computeMigrationChecksumSync(statements: readonly string[]): string {
  const input = statements.map((statement) => statement.trim()).join('\n;\n');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code + i) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `fnv1a64:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function validateAndSortMigrations(
  steps: readonly AgentHeadMigrationStep[],
): readonly (AgentHeadMigrationStep & { readonly resolvedChecksum: string })[] {
  if (steps.length === 0) {
    throw new MigrationDefinitionError('At least one AgentHeadDO migration step is required');
  }
  const seenVersions = new Set<number>();
  const normalized = steps.map((step) => {
    if (!Number.isSafeInteger(step.version) || step.version < 1) {
      throw new MigrationDefinitionError(`Invalid migration version: ${String(step.version)}`);
    }
    if (seenVersions.has(step.version)) {
      throw new MigrationDefinitionError(`Duplicate migration version: ${step.version}`);
    }
    seenVersions.add(step.version);
    if (step.name.trim().length === 0) {
      throw new MigrationDefinitionError(
        `Migration version ${step.version} must have a non-empty name`,
      );
    }
    if (step.statements.length === 0) {
      throw new MigrationDefinitionError(`Migration version ${step.version} has no statements`);
    }
    const resolvedChecksum = step.checksum ?? computeMigrationChecksumSync(step.statements);
    return {
      ...step,
      resolvedChecksum,
    };
  });

  normalized.sort((a, b) => a.version - b.version);
  return normalized;
}

/**
 * Create the A-owned AgentHeadDO business schema migration step (v1).
 */
export function createAgentHeadBusinessDoMigration(
  version = DEFAULT_AGENT_HEAD_BUSINESS_DO_MIGRATION_VERSION,
): AgentHeadMigrationStep {
  return {
    version,
    name: 'v2_agent_head_business_core',
    statements: V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS,
    checksum: computeMigrationChecksumSync(V2_AGENT_HEAD_BUSINESS_DO_STATEMENTS),
  };
}

/**
 * Create the B-owned AgentHeadDO schema migration step containing
 * `v2_schedules`, `v2_dispatch_outbox`, and `v2_recovery_coverage` (v2).
 */
export function createEventRecoveryDoMigration(
  version = DEFAULT_EVENT_RECOVERY_DO_MIGRATION_VERSION,
): AgentHeadMigrationStep {
  return {
    version,
    name: 'v2_event_recovery_core',
    statements: V2_EVENT_RECOVERY_DO_STATEMENTS,
    checksum: computeMigrationChecksumSync(V2_EVENT_RECOVERY_DO_STATEMENTS),
  };
}

/** Canonical ordered AgentHeadDO migrations (A v1 business tables + B v2 event/recovery tables). */
export function createDefaultAgentHeadMigrations(): readonly AgentHeadMigrationStep[] {
  return [createAgentHeadBusinessDoMigration(), createEventRecoveryDoMigration()];
}

/**
 * Idempotent synchronous DO SQLite migration runner per V2-M0-A §4.1.
 */
export function applyAgentHeadMigrations(
  storage: Pick<DurableObjectStorageLike, 'sql' | 'transactionSync'>,
  steps: readonly AgentHeadMigrationStep[],
  nowMs: number,
): AgentHeadMigrationResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new MigrationDefinitionError(`Invalid migration timestamp nowMs: ${String(nowMs)}`);
  }
  const orderedSteps = validateAndSortMigrations(steps);

  return storage.transactionSync(() => {
    storage.sql.exec(SCHEMA_MIGRATIONS_TABLE_DDL);
    const existingRows = storage.sql
      .exec<{ version: number; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version ASC',
      )
      .toArray();

    const appliedMap = new Map<number, string>();
    for (const row of existingRows) {
      appliedMap.set(row.version, row.checksum);
    }

    const appliedVersions: number[] = [];
    const alreadyAppliedVersions: number[] = [];

    for (const step of orderedSteps) {
      const existingChecksum = appliedMap.get(step.version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== step.resolvedChecksum) {
          throw new MigrationChecksumMismatchError(
            step.version,
            existingChecksum,
            step.resolvedChecksum,
          );
        }
        alreadyAppliedVersions.push(step.version);
        continue;
      }

      for (const statement of step.statements) {
        storage.sql.exec(statement);
      }

      storage.sql.exec(
        'INSERT INTO schema_migrations (version, applied_at_ms, checksum) VALUES (?, ?, ?)',
        step.version,
        nowMs,
        step.resolvedChecksum,
      );
      appliedVersions.push(step.version);
    }

    return {
      appliedVersions,
      alreadyAppliedVersions,
      totalSteps: orderedSteps.length,
    };
  });
}

export const V2_RECOVERY_D1_MIGRATION: AgentHeadMigrationStep = {
  version: 1,
  name: 'v2_recovery_registry',
  statements: V2_RECOVERY_REGISTRY_D1_STATEMENTS,
  checksum: computeMigrationChecksumSync(V2_RECOVERY_REGISTRY_D1_STATEMENTS),
};

export const V2_RECOVERY_D1_MIGRATIONS: readonly AgentHeadMigrationStep[] = [
  V2_RECOVERY_D1_MIGRATION,
];

/**
 * Idempotent D1 schema initializer for local/workerd harnesses & sweeper bootstrap.
 */
export async function applyD1RecoveryMigrations(
  db: D1DatabaseLike,
  nowMs: number,
  steps: readonly AgentHeadMigrationStep[] = V2_RECOVERY_D1_MIGRATIONS,
): Promise<AgentHeadMigrationResult> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new MigrationDefinitionError(`Invalid migration timestamp nowMs: ${String(nowMs)}`);
  }
  const orderedSteps = validateAndSortMigrations(steps);

  await db.prepare(SCHEMA_MIGRATIONS_TABLE_DDL).run();

  const existing = await db
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version ASC')
    .all<{ version: number; checksum: string }>();

  const appliedMap = new Map<number, string>();
  for (const row of existing.results) {
    appliedMap.set(row.version, row.checksum);
  }

  const appliedVersions: number[] = [];
  const alreadyAppliedVersions: number[] = [];

  for (const step of orderedSteps) {
    const existingChecksum = appliedMap.get(step.version);
    if (existingChecksum !== undefined) {
      if (existingChecksum !== step.resolvedChecksum) {
        throw new MigrationChecksumMismatchError(
          step.version,
          existingChecksum,
          step.resolvedChecksum,
        );
      }
      alreadyAppliedVersions.push(step.version);
      continue;
    }

    for (const statement of step.statements) {
      await db.prepare(statement).run();
    }

    await db
      .prepare(
        'INSERT INTO schema_migrations (version, applied_at_ms, checksum) VALUES (?, ?, ?) ON CONFLICT (version) DO NOTHING',
      )
      .bind(step.version, nowMs, step.resolvedChecksum)
      .run();
    appliedVersions.push(step.version);
  }

  return {
    appliedVersions,
    alreadyAppliedVersions,
    totalSteps: orderedSteps.length,
  };
}
