# Ember P0-C3-0 — Shared Contract Freeze (v1.2 — FROZEN)

> **Status:** FROZEN — Approved by CTO for Parallel Implementation (Stage 2 Kickoff).  
> **Milestone:** P0-C3 (Persistent Promise Loop).  
> **Lane A (Commitment Persistence & HTTP API):** Owner of shared contracts, PostgreSQL schemas, and API facade.  
> **Lane B (Scheduler & Outcome Runtime):** Consumer of `DueCommitmentStore`, occurrence reservation, and lease-checked outcome persistence.  
> **Lane C (Read-Only Source & Consent Boundary):** Provider of `SourceReader`, consent checking, and frozen `SourceSnapshot` specification.  
> **Baseline Commit:** `bbcad275418cd59c29b742cd2cc6e3bd825c6054` (post-PR #43, post-PR #51, post-PR #52 `origin/main`).  
> **Rule:** Parallel implementation across lanes is authorized. All three lanes follow the frozen interfaces herein.

---

## 1. Architectural Role and Trust Boundaries

A **Commitment** represents durable user intent over time ("keep an eye on this topic and report meaningful changes").  
A **Task** remains an existing, single-attempt execution unit with its own lifecycle, leasing epoch, budget, and Sentinel gate.  
A **CommitmentOccurrence** is a scheduled time slot linking a commitment to at most one durable task dispatch record.  
A **CommitmentOutcome** is an append-only, non-sensitive summary produced by an occurrence run, visible in the iOS Inbox.

```
+-----------------------------------------------------------------------------------+
| User / iOS App                                                                    |
|   POST /v1/commitments (Idempotency-Key)                                          |
|   GET  /v1/commitments/:id/outcomes (Paginated read)                              |
+-----------------------------------------------------------------------------------+
                                   | (AuthContext: tenantId, principalId)
                                   v
+-----------------------------------------------------------------------------------+
| Lane A: Commitment Persistence & HTTP API                                         |
|   - PostgreSQL authoritative clock & storage: commitments, occurrences, outcomes   |
|   - Row-level lock & CAS optimistic locking on version                            |
|   - Idempotency-Key deduplication (SHA-256 fingerprint)                           |
+-----------------------------------------------------------------------------------+
                  |                                     ^
(DueCommitmentStore)                                    | (appendOutcomeIfAbsent with
                  |                                     |  WorkerLeaseGrant check)
                  v                                     |
+-----------------------------------------------------------------------------------+
| Lane B: Durable Cloud Scheduler & Guarded Worker Runtime                          |
|   - findDueCommitments(limit) [PostgreSQL clock authoritative]                    |
|   - reserveOccurrence(commitmentId, expectedVersion) [Slot locked in DB]          |
|   - deriveTaskCreationIdempotencyKey(occurrenceId) [Crash-safe Task dispatch]     |
|   - markDispatched(occurrenceId, taskId)                                          |
|   - Guarded execution: Sentinel deny = 0 budget, 0 source callback                |
+-----------------------------------------------------------------------------------+
                  |
                  v (readSnapshot(profileId, trustedContext, signal))
+-----------------------------------------------------------------------------------+
| Lane C: Read-Only Source Port & Consent Boundary                                  |
|   - source_profile_id validation & FakeSourceReader fixtures                      |
|   - Pre-read Consent check; in-flight AbortSignal on revocation/cancellation      |
|   - Zero-network default, zero credentials, untrusted data only                   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Strict Data Transfer Objects (DTOs)

All external wire representations use **snake_case** JSON and RFC 3339 UTC timestamps (`YYYY-MM-DDTHH:mm:ss.sssZ`).  
Internal TypeScript domain models use **camelCase**.  
All schemas are strictly validated via Zod (`z.strictObject`), rejecting undeclared properties.

### 2.1 Vocabulary and Scalar Types

```typescript
export const COMMITMENT_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const SCHEDULE_KINDS = ['once', 'interval'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const OCCURRENCE_STATUSES = [
  'pending',
  'dispatched',
  'completed',
  'failed',
  'cancelled',
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/**
 * Unified outcome result statuses (P2 reconciled between Lane A and Lane B).
 *
 * - `meaningful_change`: meaningful update detected and summarized for the user
 * - `no_change`: check executed successfully; source had no meaningful delta
 * - `failed`: execution failed due to deterministic or infrastructure fault
 * - `denied`: operation rejected by Sentinel, budget, or consent policy
 */
export const OUTCOME_RESULT_STATUSES = [
  'meaningful_change',
  'no_change',
  'failed',
  'denied',
] as const;
export type OutcomeResultStatus = (typeof OUTCOME_RESULT_STATUSES)[number];

/** Bounded title: 1 to 140 unicode characters, trimmed, no multiline control characters. */
export const COMMITMENT_TITLE_LIMITS = Object.freeze({
  minChars: 1,
  maxChars: 140,
});

/** Bounded interval: minimum 15 minutes (900s), maximum 30 days (2,592,000s). */
export const COMMITMENT_INTERVAL_LIMITS = Object.freeze({
  minSeconds: 900,
  maxSeconds: 2_592_000,
});

/** Source profile ID: 3 to 64 chars, lowercase alphanumeric, dots, dashes, underscores. */
export const SOURCE_PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * Frozen SourceSnapshot item limits (P2 reconciled across Lanes A, B, and C).
 */
export const SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  profileIdMinChars: 3,
  profileIdMaxChars: 64,
  itemIdMaxChars: 128,
  itemTitleMaxChars: 256,
  itemContentSnippetMaxChars: 1_000,
  maxItems: 50,
  maxPayloadBytes: 32_768, // 32 KiB ceiling (CTO Frozen)
});

/** Outcome summary bound: 1 to 2,000 characters. */
export const OUTCOME_SUMMARY_LIMITS = Object.freeze({
  minChars: 1,
  maxChars: 2_000,
});
```

### 2.2 Wire DTOs & Schemas

#### Commitment Detail Wire DTO (`CommitmentDto`)

```typescript
export interface CommitmentDto {
  readonly commitment_id: string; // UUIDv4
  readonly tenant_id: string; // UUIDv4 (read-only output)
  readonly agent_id: string; // UUIDv4
  readonly title: string; // 1..140 characters
  readonly status: CommitmentStatus; // active | paused | completed | cancelled
  readonly schedule_kind: ScheduleKind; // once | interval
  readonly interval_seconds: number | null; // null for once; 900..2592000 for interval
  readonly next_due_at: string | null; // RFC 3339 timestamp or null
  readonly source_profile_id: string; // Matches ^[a-z0-9][a-z0-9._-]{2,63}$
  readonly version: number; // Positive integer (starts at 1, increments on state change)
  readonly created_at: string; // RFC 3339
  readonly updated_at: string; // RFC 3339
}
```

#### Commitment Receipt Wire DTO (`CommitmentReceiptDto`)

```typescript
export interface CommitmentReceiptDto {
  readonly commitment_id: string;
  readonly status: CommitmentStatus;
  readonly created_at: string;
  readonly replayed: boolean; // true if satisfied by idempotent replay
}
```

#### Create Commitment Request Wire DTO (`CreateCommitmentRequest`)

_User input is strictly bounded. Callers cannot supply `tenant_id`, `principal_id`, `version`, `status`, or internal database fields._

```typescript
export interface CreateCommitmentRequest {
  readonly agent_id: string; // UUIDv4
  readonly title: string; // 1..140 characters
  readonly schedule_kind: ScheduleKind; // once | interval
  readonly interval_seconds?: number; // Required if schedule_kind === 'interval'
  readonly due_at?: string; // Optional ISO timestamp for first run; defaults to now()
  readonly source_profile_id: string; // 3..64 characters
}
```

#### Commitment Occurrence Wire DTO (`CommitmentOccurrenceDto`)

```typescript
export interface CommitmentOccurrenceDto {
  readonly occurrence_id: string; // UUIDv4
  readonly commitment_id: string; // UUIDv4
  readonly scheduled_for: string; // RFC 3339
  readonly task_id: string | null; // UUIDv4 of linked Task, or null if pending dispatch
  readonly status: OccurrenceStatus; // pending | dispatched | completed | failed | cancelled
  readonly created_at: string; // RFC 3339
  readonly updated_at: string; // RFC 3339
}
```

#### Commitment Outcome Wire DTO (`CommitmentOutcomeDto`)

```typescript
export interface CommitmentOutcomeDto {
  readonly outcome_id: string; // UUIDv4
  readonly commitment_id: string; // UUIDv4
  readonly occurrence_id: string; // UUIDv4
  readonly task_id: string; // UUIDv4
  readonly summary: string; // 1..2000 characters, non-sensitive
  readonly result_status: OutcomeResultStatus; // meaningful_change | no_change | failed | denied
  readonly created_at: string; // RFC 3339
}
```

#### Paginated Outcome Page Wire DTO (`CommitmentOutcomePageDto`)

```typescript
export interface CommitmentOutcomePageDto {
  readonly commitment_id: string;
  readonly outcomes: readonly CommitmentOutcomeDto[];
  readonly next_cursor?: string; // Opaque cursor for chronological pagination
}
```

---

## 3. Commitment Repository Transactional Interface

The persistence layer (`@ember/postgres`) exposes this transactional repository. Every user-facing method accepts a gateway-verified `AuthContext`, enforcing strict tenant isolation.

```typescript
import type { AuthContext, Id } from '@ember/domain';

export interface CreateCommitmentCommand {
  readonly idempotencyKey: string;
  readonly agentId: Id;
  readonly title: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds?: number;
  readonly dueAt?: Date;
  readonly sourceProfileId: string;
}

export interface StateTransitionOptions {
  readonly expectedVersion?: number; // Optional CAS check
}

export interface ListCommitmentsOptions {
  readonly limit?: number; // Default 50, maximum 100
  readonly cursor?: string;
  readonly status?: CommitmentStatus;
}

export interface ListOutcomesOptions {
  readonly limit?: number; // Default 50, maximum 100
  readonly cursor?: string; // Exclusive cursor
}

export interface CommitmentRepository {
  /**
   * Idempotently create a commitment under AuthContext.tenantId.
   * - Same key + same payload -> returns existing receipt with replayed=true (HTTP 200).
   * - Same key + different payload -> throws IDEMPOTENCY_CONFLICT (HTTP 409).
   */
  create(
    ctx: AuthContext,
    cmd: CreateCommitmentCommand,
  ): Promise<{
    readonly commitment: CommitmentDto;
    readonly replayed: boolean;
  }>;

  /**
   * Fetch a single commitment by ID scoped to ctx.tenantId.
   * Returns null if missing or belonging to another tenant (indistinguishable 404).
   */
  get(ctx: AuthContext, commitmentId: Id): Promise<CommitmentDto | null>;

  /**
   * Paginated list of commitments for ctx.tenantId.
   */
  list(
    ctx: AuthContext,
    options?: ListCommitmentsOptions,
  ): Promise<{
    readonly commitments: readonly CommitmentDto[];
    readonly nextCursor?: string;
  }>;

  /**
   * Transition active -> paused.
   * Idempotent if already paused.
   * Rejects terminal states (completed, cancelled) with INVALID_STATE_TRANSITION.
   */
  pause(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  /**
   * Transition paused -> active.
   * Recalculates next_due_at if it is in the past using DB clock.
   * Rejects terminal states with INVALID_STATE_TRANSITION.
   */
  resume(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  /**
   * Transition active|paused -> cancelled.
   * Irreversible. Immediately clears next_due_at in DB to prevent future scheduling.
   * Idempotent if already cancelled.
   */
  cancel(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  /**
   * List outcomes for a tenant-owned commitment in chronological order.
   * Returns null if commitment not found or foreign tenant.
   */
  listOutcomes(
    ctx: AuthContext,
    commitmentId: Id,
    options?: ListOutcomesOptions,
  ): Promise<{
    readonly outcomes: readonly CommitmentOutcomeDto[];
    readonly nextCursor?: string;
  } | null>;
}
```

---

## 4. DueCommitmentStore Interface (Scheduler Integration Port for Lane B)

### 4.1 P1 Revisions Addressed

1. **PostgreSQL as Authoritative Clock & Schedule Compensation:**
   The caller does **not** supply caller-local `now` or `scheduledFor`. PostgreSQL's `clock_timestamp()` is authoritative.
   `findDueCommitments` queries `WHERE next_due_at <= clock_timestamp()`.
   `reserveOccurrence` locks the commitment row via `SELECT ... FOR UPDATE`, validates `next_due_at <= clock_timestamp()`, and takes the persisted `next_due_at` as the authoritative `scheduled_for` timestamp. (Test time override parameters are strictly for test harnesses and must not be accessible in production invocation paths).
   **Schedule Compensation Invariant:** To prevent task storms when the system recovers after downtime, the scheduler compensates **at most one historical interval** per run. The subsequent `next_due_at` is advanced past any skipped intervals (i.e. `GREATEST(scheduled_for + interval, clock_timestamp() + interval)`).
2. **Authoritative Lease & Execution Verification on Outcome Append:**
   `appendOutcomeIfAbsent` requires a verified `WorkerLeaseGrant`, and verifies inside one transaction that locks the commitment row first (serialising against `pause`/`cancel`), then the occurrence, the task and the run:
   - Valid lease on `runs`: `runs.worker_id = grant.workerId`, `runs.lease_epoch = grant.leaseEpoch`, and `runs.leased_until > clock_timestamp()`. Worker ownership, epoch and expiry are compared **inside PostgreSQL**; the application clock is never consulted.
   - The `runs.status` must be `running`, and the underlying `tasks.status` must also be `running`. A `queued` Task has no executing lease, and a `cancelled` / `failed` / `completed` Task can never publish an outcome.
   - The occurrence's `task_id` matches `grant.taskId` and the occurrence is not `cancelled`.
   - The commitment's status must still be strictly `active`. If paused or cancelled, outcome write is rejected fail-closed.
   - Note on Consent: Before publication, consent is re-evaluated; in-memory `FakeConsentRegistry` does not provide cross-process atomicity guarantees, so persistent database guards serve as the authoritative gate.
   - Old/stale workers cannot bypass checks via idempotent replays.
3. **Atomic State Check on Commitment Completion:**
   `markCommitmentCompleted` validates under row lock that `status = 'active'`. If the commitment was cancelled, it updates 0 rows and returns `false`. Late workers can **never** turn a `cancelled` commitment into `completed`.
4. **Interrupted Dispatch Recovery & Reconciliation:**
   - **Stable Task Idempotency Key:** `deriveTaskCreationIdempotencyKey(occurrenceId)` produces `commitment-occ:${occurrenceId}` so crashing before binding `taskId` never creates duplicate Tasks on retry.
   - **Reconciliation Sweep:** `findStalledPendingOccurrences` identifies orphan pending occurrences that exceeded the dispatch deadline.
   - **Database-Authoritative Recovery Context:** Each `StalledPendingOccurrence` carries `tenantId`, `agentId`, `sourceProfileId`, `scheduleKind`, `intervalSeconds`, `scheduledFor`, `createdAt` and `taskCreationIdempotencyKey`, all read from the occurrence/commitment rows. Lane B must rebuild the dispatch from those values; substituting a synthetic "system" tenant/agent is forbidden.
   - **Re-binding:** `reconcilePendingOccurrence` atomically binds `task_id` and transitions status to `dispatched`.

### 4.2 TypeScript Port Definition

```typescript
export interface WorkerLeaseGrant {
  readonly tenantId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

export interface DueCommitment {
  readonly commitmentId: Id;
  readonly tenantId: Id;
  readonly agentId: Id;
  readonly title: string;
  readonly sourceProfileId: string;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly nextDueAt: Date;
  readonly version: number;
}

export interface ReservedSlot {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly scheduledFor: Date; // Authoritative timestamp locked from commitment.next_due_at
  readonly commitmentVersion: number;
}

export interface AppendOutcomeCommand {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly summary: string;
  readonly resultStatus: OutcomeResultStatus;
}

export interface StalledPendingOccurrence {
  readonly occurrenceId: Id;
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly agentId: Id;
  readonly sourceProfileId: SourceProfileId;
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly scheduledFor: Date;
  readonly createdAt: Date;
  readonly taskCreationIdempotencyKey: string;
}

export interface DueCommitmentStore {
  /**
   * Query up to `limit` active commitments where next_due_at <= clock_timestamp().
   * PostgreSQL clock is authoritative. `asOfOverride` is strictly for virtual-clock tests.
   */
  findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]>;

  /**
   * Transactional atomic reservation of one occurrence slot:
   * 1. SELECT commitment FOR UPDATE. Verifies status == 'active', next_due_at <= now,
   *    and version == expectedVersion.
   * 2. Authoritative scheduledFor is taken directly from commitment.next_due_at.
   * 3. Checks if occurrence (commitment_id, scheduled_for) already exists.
   * 4. Inserts pending occurrence with generated occurrence_id.
   * 5. Advances commitment next_due_at (or null if once) and increments version.
   * Returns null if commitment was modified, paused, cancelled, or slot already reserved.
   */
  reserveOccurrence(
    commitmentId: Id,
    expectedVersion: number,
    slotTimeOverride?: Date, // Optional override strictly for test harnesses
  ): Promise<ReservedSlot | null>;

  /**
   * Binds the dispatched Task ID to the occurrence and advances status to 'dispatched'.
   */
  markDispatched(occurrenceId: Id, taskId: Id): Promise<void>;

  /**
   * Durably append an outcome for an occurrence with authoritative lease verification.
   * In a single transaction that locks commitment -> occurrence -> task -> run:
   * 1. Verifies the commitment is still `active` (a winning cancel is always observed).
   * 2. Verifies the occurrence is not `cancelled` and matches grant.taskId.
   * 3. Verifies tasks.status = 'running'.
   * 4. Verifies runs.status = 'running', runs.worker_id / runs.lease_epoch match the grant,
   *    and runs.leased_until > clock_timestamp() (all compared inside PostgreSQL).
   * 5. Inserts outcome row (unique on occurrence_id).
   * 6. Advances occurrence status to 'completed' (or 'failed' if result_status is failed/denied).
   * Throws STALE_LEASE if the run is not running or the lease expired/is stale.
   * Throws INVALID_STATE_TRANSITION if the task is no longer running.
   * Throws POLICY_DENIED if the commitment or occurrence was cancelled.
   * Returns false if outcome was already committed.
   */
  appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean>;

  /**
   * Advance one-shot commitment to 'completed' once outcome is stored.
   * Atomically verifies status == 'active' [AND version == expectedVersion].
   * If commitment was cancelled in the interim, updates 0 rows and returns false.
   */
  markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean>;

  /**
   * Find occurrences stalled in 'pending' status for longer than timeoutSeconds.
   */
  findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]>;

  /**
   * Crash recovery: bind existing or replayed Task ID to stalled occurrence and mark 'dispatched'.
   */
  reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean>;

  /**
   * Mark pending occurrence failed or cancelled if dispatch failed permanently.
   */
  markOccurrenceFailed(occurrenceId: Id, reasonCode: string): Promise<void>;
}

/**
 * Deterministic derivation of Task creation idempotency key from occurrenceId.
 * Format: `commitment-occ:${occurrenceId}`
 */
export function deriveTaskCreationIdempotencyKey(occurrenceId: Id): string {
  return `commitment-occ:${occurrenceId}`;
}
```

---

## 5. SourceReader Contract & Consent Boundary (Lane B / Lane C Unification)

### 5.1 Unified Source Types & Limits (P1 & P2 Reconciled)

```typescript
export type SourceProfileId = string;

export interface SourceSnapshotItem {
  readonly id: string; // Max 128 chars
  readonly title: string; // Max 256 chars
  readonly contentSnippet: string; // Max 1,000 chars, untrusted text
  readonly observedAt: string; // RFC 3339
}

export interface SourceSnapshot {
  readonly sourceProfileId: SourceProfileId;
  readonly observedAt: string; // RFC 3339
  readonly digest: string; // SHA-256 hex string (64 characters)
  readonly boundedSafeItems: readonly SourceSnapshotItem[]; // Max 50 items (P2 unified)
}

/**
 * Server-derived execution context passed to SourceReader.
 * NEVER accepted from client JSON.
 */
export interface TrustedSourceAccessContext {
  readonly tenantId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly runId: Id;
  readonly leaseEpoch: number;
  readonly authorizedAt: string; // RFC 3339
}

/**
 * Unified SourceReader interface implemented by Lane C and consumed by Lane B.
 */
export interface SourceReader {
  readSnapshot(
    profileId: SourceProfileId,
    trustedContext: TrustedSourceAccessContext,
    signal: AbortSignal,
  ): Promise<SourceSnapshot>;
}
```

### 5.2 Consent Verification & Revocation Rules (P1 Reconciled)

1. **Pre-Read Consent Gate:**  
   Before calling `SourceReader.readSnapshot()`, the runtime verifies that the source profile is active, allowlisted, belongs to `trustedContext.tenantId`, and has not expired or been revoked. If consent check fails, **0 reader invocations and 0 network calls** are made; the occurrence fails with a `POLICY_DENIED` outcome.
2. **In-Flight Cancellation / Revocation:**  
   If a user pauses/cancels the commitment or revokes source consent while a snapshot read is in-flight, the runtime aborts the `AbortSignal`. `FakeSourceReader` / future readers must cease processing immediately.
3. **Publication Boundary on Revoked/Cancelled State:**  
   Even if a snapshot read completes before revocation is observed, `DueCommitmentStore.appendOutcomeIfAbsent` performs an atomic check on the commitment status inside the PostgreSQL transaction. If the commitment status is `cancelled`, the outcome write is **aborted and rejected**. A cancelled commitment can never publish new visible outcomes.
4. **Untrusted Data Invariant:**  
   Content inside `boundedSafeItems` is strictly data. Prompt injection patterns (e.g. `System: ignore previous instructions`) are never interpreted as instructions, tool calls, or policy changes.
5. **Zero-Network Default:**  
   In P0-C3, all source reads are served from deterministic local fixtures. Live network egress remains strictly disabled.

---

## 6. HTTP API Specification

Base path: `/v1/commitments`  
All routes require a valid `Authorization: Bearer <token>` header verified by `authMiddleware`.

### 6.1 Endpoints Table

| Method | Path                           | Request Body                    | Headers                            | Success                           | Error Statuses     | Description                          |
| :----- | :----------------------------- | :------------------------------ | :--------------------------------- | :-------------------------------- | :----------------- | :----------------------------------- |
| `POST` | `/v1/commitments`              | `CreateCommitmentRequest`       | `Idempotency-Key` (required)       | `201 Created` / `200 OK` (replay) | 400, 401, 409      | Create commitment; idempotent on key |
| `GET`  | `/v1/commitments`              | None                            | Query: `limit`, `cursor`, `status` | `200 OK`                          | 400, 401           | List tenant commitments              |
| `GET`  | `/v1/commitments/:id`          | None                            | None                               | `200 OK`                          | 401, 404           | Get commitment detail                |
| `POST` | `/v1/commitments/:id/pause`    | `{ expected_version?: number }` | None                               | `200 OK`                          | 400, 401, 404, 409 | Pause future occurrences             |
| `POST` | `/v1/commitments/:id/resume`   | `{ expected_version?: number }` | None                               | `200 OK`                          | 400, 401, 404, 409 | Resume paused commitment             |
| `POST` | `/v1/commitments/:id/cancel`   | `{ expected_version?: number }` | None                               | `200 OK`                          | 400, 401, 404, 409 | Terminal cancellation                |
| `GET`  | `/v1/commitments/:id/outcomes` | None                            | Query: `limit`, `cursor`           | `200 OK`                          | 400, 401, 404      | Ordered paginated outcomes           |

### 6.2 Error Responses & HTTP Status Mapping

All errors conform to Ember's frozen `ErrorResponseSchema`:

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Invalid request input",
    "request_id": "req_01abc..."
  }
}
```

| Domain Error Code          | HTTP Status | Trigger Condition in Commitment API                                                                |
| :------------------------- | :---------- | :------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`         | 400         | Malformed JSON, title > 140 chars, interval < 900s, malformed UUID, missing Idempotency-Key header |
| `UNAUTHENTICATED`          | 401         | Missing, malformed, or invalid bearer token                                                        |
| `NOT_FOUND`                | 404         | Commitment does not exist OR belongs to another tenant (uniform error, no existence leak)          |
| `IDEMPOTENCY_CONFLICT`     | 409         | Same Idempotency-Key with different payload parameters                                             |
| `INVALID_STATE_TRANSITION` | 409         | Attempting to pause/resume a cancelled or completed commitment; or `expected_version` CAS mismatch |
| `DB_UNAVAILABLE`           | 503         | PostgreSQL pool timeout, disconnection, or serialization failure                                   |

### 6.3 Idempotency Semantics

1. Every `POST /v1/commitments` requires an `Idempotency-Key` header (8..128 chars, regex `/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`).
2. The payload hash is computed via `sha256(canonicalJson(requestBody))`.
3. If `(tenant_id, idempotency_key)` is present:
   - If payload hash matches: return existing commitment with `200 OK`, `replayed: true`, and `Location` header.
   - If payload hash differs: fail immediately with `409 IDEMPOTENCY_CONFLICT`.
4. Idempotency records are committed atomically in the same database transaction as the commitment row.

---

## 7. State Machine and Concurrency (CAS) Semantics

### 7.1 State Diagram

```
                 +-------------+
                 |   active    |<----------+
                 +-------------+           |
                  |     |     |            |
         pause    |     |     | complete   | resume
                  v     |     v            |
            +--------+  |   +-----------+  |
            | paused |--|-->| completed |  |
            +--------+  |   +-----------+  |
                 |      |                  |
                 +------+                  |
                 |      |                  |
          cancel |      +------------------+
                 v
           +-----------+
           | cancelled | (terminal)
           +-----------+
```

### 7.2 Transition Matrix

| From \ To       | `active`                               | `paused`                               | `completed`                                | `cancelled`             |
| :-------------- | :------------------------------------- | :------------------------------------- | :----------------------------------------- | :---------------------- |
| **`active`**    | Idempotent (200 OK, version unchanged) | **Legal** (version + 1)                | **Legal** (on one-shot finish)             | **Legal** (version + 1) |
| **`paused`**    | **Legal** (version + 1)                | Idempotent (200 OK, version unchanged) | **Illegal** (409 INVALID_STATE_TRANSITION) | **Legal** (version + 1) |
| **`completed`** | **Illegal** (409)                      | **Illegal** (409)                      | Idempotent (200 OK)                        | **Illegal** (409)       |
| **`cancelled`** | **Illegal** (409)                      | **Illegal** (409)                      | **Illegal** (409)                          | Idempotent (200 OK)     |

### 7.3 Concurrency & Version Rules

- **Optimistic Concurrency (CAS):** If `expected_version` is provided in the request body, the database update checks `WHERE version = expected_version`. If the row has been modified in the interim, update affects 0 rows and returns `409 INVALID_STATE_TRANSITION`.
- **Cancellation Guarantee:** Once `cancelled` is committed, `next_due_at` is set to `NULL`. The scheduler will never select this commitment. Any in-flight execution checking the commitment status will abort publication.
- **History Preservation:** Cancelling a commitment **never** deletes historical occurrences, completed tasks, or recorded outcomes.

---

## 8. Database Schema Blueprint (`migrations/0008_p0c3_commitments.sql`)

```sql
-- 1. Commitments table
CREATE TABLE IF NOT EXISTS commitments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  schedule_kind text NOT NULL,
  interval_seconds integer,
  next_due_at timestamptz,
  source_profile_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  idempotency_key text,
  request_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commitments_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT commitments_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT commitments_title_length_check CHECK (char_length(title) >= 1 AND char_length(title) <= 140),
  CONSTRAINT commitments_status_check CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  CONSTRAINT commitments_schedule_kind_check CHECK (schedule_kind IN ('once', 'interval')),
  CONSTRAINT commitments_interval_bounds_check CHECK (
    (schedule_kind = 'once' AND interval_seconds IS NULL) OR
    (schedule_kind = 'interval' AND interval_seconds >= 900 AND interval_seconds <= 2592000)
  ),
  CONSTRAINT commitments_source_profile_format_check CHECK (source_profile_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT commitments_version_positive_check CHECK (version >= 1)
);

-- Index for due work discovery by scheduler (using authoritative DB clock)
CREATE INDEX IF NOT EXISTS commitments_due_scheduling_idx
  ON commitments (next_due_at)
  WHERE status = 'active' AND next_due_at IS NOT NULL;

-- Index for tenant listing
CREATE INDEX IF NOT EXISTS commitments_tenant_listing_idx
  ON commitments (tenant_id, created_at DESC, id DESC);

-- 2. Commitment Occurrences table
CREATE TABLE IF NOT EXISTS commitment_occurrences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  task_id uuid,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occurrences_tenant_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT occurrences_unique_slot UNIQUE (commitment_id, scheduled_for),
  CONSTRAINT occurrences_status_check CHECK (status IN ('pending', 'dispatched', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS occurrences_commitment_order_idx
  ON commitment_occurrences (commitment_id, scheduled_for DESC);

-- Index for crash recovery / orphan pending reconciliation
CREATE INDEX IF NOT EXISTS occurrences_pending_reap_idx
  ON commitment_occurrences (created_at)
  WHERE status = 'pending';

-- 3. Commitment Outcomes table
CREATE TABLE IF NOT EXISTS commitment_outcomes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  commitment_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  task_id uuid NOT NULL,
  summary text NOT NULL,
  result_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcomes_tenant_commitment_fk FOREIGN KEY (tenant_id, commitment_id)
    REFERENCES commitments (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT outcomes_occurrence_unique UNIQUE (occurrence_id),
  CONSTRAINT outcomes_summary_length_check CHECK (char_length(summary) >= 1 AND char_length(summary) <= 2000),
  CONSTRAINT outcomes_result_status_check CHECK (result_status IN ('meaningful_change', 'no_change', 'failed', 'denied'))
);

CREATE INDEX IF NOT EXISTS outcomes_commitment_order_idx
  ON commitment_outcomes (commitment_id, created_at DESC, id DESC);
```

---

## 9. Cross-Lane Interface Handoff Table & Sign-Off Checklist

| Provider   | Consumer      | Frozen Interface / Artifact | Description                                                                                                                                                               | Status          |
| :--------- | :------------ | :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------- |
| **Lane A** | **Lane B**    | `DueCommitmentStore` port   | DB-clock authoritative `findDueCommitments`, `reserveOccurrence`, `deriveTaskCreationIdempotencyKey`, `reconcilePendingOccurrence`, lease-checked `appendOutcomeIfAbsent` | **P1 RESOLVED** |
| **Lane A** | **Lane B, C** | `@ember/contracts` DTOs     | `CommitmentDto`, `CommitmentOccurrenceDto`, `CommitmentOutcomeDto`, `SourceSnapshot` (`boundedSafeItems`), `OutcomeResultStatus`                                          | **P2 RESOLVED** |
| **Lane A** | **iOS Inbox** | REST Endpoints              | `GET /v1/commitments`, `GET /v1/commitments/:id/outcomes`                                                                                                                 | **FROZEN**      |
| **Lane C** | **Lane A**    | `SOURCE_PROFILE_ID_REGEX`   | Format validation for accepted source profiles                                                                                                                            | **FROZEN**      |
| **Lane C** | **Lane B**    | `SourceReader`              | `readSnapshot(profileId, trustedContext, signal)` with consent check & in-flight revocation                                                                               | **P1 RESOLVED** |

---

## 10. Boundary & Negative Invariants

1. **Zero Outbound Sockets:** Neither Lane A, B, nor C initiates real external network calls.
2. **Zero Credential Execution:** No OAuth secrets, bearer tokens, or private keys are accepted, stored, or executed.
3. **No iOS Code Changes:** iOS M2 remains mock-first and owned by iOS Lead. No Swift files are modified in backend lanes.
4. **No Cross-Lane Edits:** Lane A owns `packages/contracts`, `packages/postgres`, `apps/api/src/commitments`. It does NOT touch `packages/execution` or `apps/worker`.

---

## 11. Final CTO Freeze Sign-Off Request

All 4 P1 and 2 P2 items requested by CTO have been incorporated into this document. Lane A submits this revision on PR #56 for final **C3-0 FROZEN** confirmation.
