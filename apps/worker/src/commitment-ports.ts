import {
  type CommitmentTaskInput,
  type ScheduleKind,
  type StalledPendingOccurrence,
} from '@ember/contracts';
import type { Id } from '@ember/domain';

/**
 * Worker-local additions to the canonical P0-C3 contract.
 *
 * Every business type used by the Scheduler/Handler (`DueCommitment`, `ReservedSlot`,
 * `AppendOutcomeCommand`, `WorkerLeaseGrant`, `StalledPendingOccurrence`,
 * `ExistingTaskDispatcher`, `DispatchTaskCommand`, `DispatchTaskReceipt`, ...) is imported
 * directly from `@ember/contracts`. This module no longer redeclares them, so the Worker port
 * and `PostgresCommitmentRepository` cannot drift apart.
 */
export {
  deriveTaskCreationIdempotencyKey,
  type AppendOutcomeCommand,
  type AuthoritativeOutcome,
  type AuthoritativeOutcomeQuery,
  type CommitmentStatus,
  type CommitmentTaskInput,
  type DispatchTaskCommand,
  type DispatchTaskReceipt,
  type DueCommitment,
  type DueCommitmentStore,
  type ExistingTaskDispatcher,
  type FinalizeOccurrenceCommand,
  type OccurrenceExecutionIdentity,
  type ReservedSlot,
  type StalledPendingOccurrence,
  type WorkerLeaseGrant,
} from '@ember/contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Routing marker carried by a commitment occurrence Task. */
export interface CommitmentTaskMarker {
  readonly commitmentId: Id;
  readonly occurrenceId: Id;
}

/**
 * Builds canonical commitment task input with semantic parity between regular dispatch
 * and crash recovery.
 */
export function buildCommitmentTaskInput(params: {
  readonly commitmentId: Id;
  readonly occurrenceId: Id;
  readonly sourceProfileId: string;
  readonly scheduleKind: ScheduleKind;
}): CommitmentTaskInput {
  return {
    operation: 'sha256',
    text: JSON.stringify({
      commitmentId: params.commitmentId,
      occurrenceId: params.occurrenceId,
      sourceProfileId: params.sourceProfileId,
      scheduleKind: params.scheduleKind,
    }),
  };
}

/**
 * Reads the commitment marker from a persisted Task input.
 *
 * This is a *routing hint only*: it decides which Run handler is invoked. Every business value
 * the execution then uses (tenant, agent, source profile, schedule kind) is re-resolved from
 * the database by `findOccurrenceExecutionIdentity()`, so a forged marker can only produce a
 * fail-closed terminal failure, never a fabricated execution.
 */
export function readCommitmentTaskMarker(input: unknown): CommitmentTaskMarker | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }

  const record = input as { readonly operation?: unknown; readonly text?: unknown };

  if (record.operation !== 'sha256' || typeof record.text !== 'string') {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(record.text);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const marker = parsed as { readonly commitmentId?: unknown; readonly occurrenceId?: unknown };

  if (typeof marker.commitmentId !== 'string' || typeof marker.occurrenceId !== 'string') {
    return null;
  }

  if (!UUID_PATTERN.test(marker.commitmentId) || !UUID_PATTERN.test(marker.occurrenceId)) {
    return null;
  }

  return { commitmentId: marker.commitmentId, occurrenceId: marker.occurrenceId };
}

/**
 * Runtime validation of a recovered occurrence identity.
 *
 * Recovery is only allowed when ALL FOUR business identity fields were actually reconstructed
 * from the trusted persistent layer. Values are validated at runtime (not just by type) so a
 * non-conforming adapter returning `undefined`, blank strings or an unknown `scheduleKind`
 * cannot cause a fabricated dispatch — or a `.trim()` TypeError mid-loop.
 */
export function hasRecoverableOccurrenceIdentity(occurrence: StalledPendingOccurrence): boolean {
  return (
    isNonBlankString(occurrence.tenantId) &&
    isNonBlankString(occurrence.agentId) &&
    isNonBlankString(occurrence.sourceProfileId) &&
    (occurrence.scheduleKind === 'once' || occurrence.scheduleKind === 'interval')
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
