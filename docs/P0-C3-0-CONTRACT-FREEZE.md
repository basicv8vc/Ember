# Ember P0-C3-0 — Shared Contract Freeze (v1.0)

> **Status:** PROPOSED — Submitted by Lane A for CTO Review & Freeze Confirmation.  
> **Milestone:** P0-C3 (Persistent Promise Loop).  
> **Lane A (Commitment Persistence & HTTP API):** Owner of shared contracts, PostgreSQL schemas, and API facade.  
> **Lane B (Scheduler & Outcome Runtime):** Consumer of `DueCommitmentStore`, occurrence reservation, and outcome persistence.  
> **Lane C (Read-Only Source & Consent Boundary):** Provider of `source_profile_id` validation and `SourceSnapshot` shape.  
> **Baseline Commit:** `bbcad275418cd59c29b742cd2cc6e3bd825c6054` (post-PR #43, post-PR #51, post-PR #52 `origin/main`).  
> **Rule:** No lane may begin production implementation until the CTO signs off on this frozen specification.

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
| Lane A: Commitment Persistence & HTTP API                                          |
|   - Durable PostgreSQL storage: commitments, occurrences, outcomes                |
|   - Strict CAS optimistic locking on version                                      |
|   - Idempotency-Key deduplication (SHA-256 fingerprint)                           |
+-----------------------------------------------------------------------------------+
                  |                                     ^
(DueCommitmentStore)                                    | (appendOutcomeIfAbsent)
                  v                                     |
+-----------------------------------------------------------------------------------+
| Lane B: Durable Cloud Scheduler & Guarded Worker Runtime                          |
|   - findDueCommitments(now, limit)                                                |
|   - reserveOccurrence(commitmentId, scheduledFor, expectedVersion)                |
|   - markDispatched(occurrenceId, taskId) -> dispatches durable Task               |
|   - Guarded execution: Sentinel deny = 0 budget, 0 source callback               |
+-----------------------------------------------------------------------------------+
                  |
                  v (readSnapshot)
+-----------------------------------------------------------------------------------+
| Lane C: Read-Only Source Port & Consent Boundary                                  |
|   - source_profile_id validation & FakeSourceReader fixtures                      |
|   - Zero-network default, zero credentials, untrusted data only                    |
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

export const OUTCOME_RESULT_STATUSES = ['succeeded', 'failed', 'denied', 'no_change'] as const;
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
  readonly source_profile_id: string; // Regex matching ^[a-z0-9][a-z0-9._-]{2,63}$
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
  readonly result_status: OutcomeResultStatus; // succeeded | failed | denied | no_change
  readonly created_at: string; // RFC 3339
}
```

#### Paginated Outcome Page Wire DTO (`CommitmentOutcomePageDto`)

```typescript
export interface CommitmentOutcomePageDto {
  readonly commitment_id: string;
  readonly outcomes: readonly CommitmentOutcomeDto[];
  readonly next_cursor?: string; // Opaque base64 cursor or ISO timestamp cursor
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
   * Recalculates next_due_at if it is in the past.
   * Rejects terminal states with INVALID_STATE_TRANSITION.
   */
  resume(
    ctx: AuthContext,
    commitmentId: Id,
    options?: StateTransitionOptions,
  ): Promise<CommitmentDto>;

  /**
   * Transition active|paused -> cancelled.
   * Irreversible. Immediately clears next_due_at to prevent future scheduling.
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

Lane B's scheduler does not use `AuthContext` (it operates cloud-side on trusted persisted data). It consumes the narrow `DueCommitmentStore` port implemented by Lane A:

```typescript
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
  readonly scheduledFor: Date;
  readonly commitmentVersion: number;
}

export interface NewOutcomeRecord {
  readonly occurrenceId: Id;
  readonly commitmentId: Id;
  readonly taskId: Id;
  readonly summary: string;
  readonly resultStatus: OutcomeResultStatus;
}

export interface DueCommitmentStore {
  /**
   * Query up to `limit` active commitments where next_due_at <= now.
   * Read-only sweep with skip-locked or bounded row selection.
   */
  findDueCommitments(now: Date, limit: number): Promise<readonly DueCommitment[]>;

  /**
   * Transactional atomic reservation of one occurrence slot:
   * 1. SELECT commitment FOR UPDATE. Verifies status == 'active' and version == expectedVersion.
   * 2. Checks if occurrence (commitment_id, scheduled_for) already exists.
   * 3. Inserts pending occurrence with generated occurrence_id.
   * 4. Updates commitment next_due_at and increments version.
   * Returns null if commitment was modified, paused, cancelled, or slot already reserved.
   */
  reserveOccurrence(
    commitmentId: Id,
    scheduledFor: Date,
    expectedVersion: number,
  ): Promise<ReservedSlot | null>;

  /**
   * Binds the dispatched Task ID to the occurrence and advances status to 'dispatched'.
   */
  markDispatched(occurrenceId: Id, taskId: Id): Promise<void>;

  /**
   * Records occurrence failure if Task creation or dispatch failed before running.
   */
  markOccurrenceFailed(occurrenceId: Id, reasonCode: string): Promise<void>;

  /**
   * Durably append an outcome for an occurrence.
   * Idempotent: (occurrence_id) has a unique constraint. If already committed, returns false.
   */
  appendOutcomeIfAbsent(outcome: NewOutcomeRecord): Promise<boolean>;

  /**
   * Advance one-shot commitment to 'completed' once outcome is stored.
   */
  markCommitmentCompleted(commitmentId: Id): Promise<void>;
}
```

### Scheduling Invariants

1. **Single Occurrence Identity:** The composite key `(commitment_id, scheduled_for)` is unique. Two concurrent scheduler ticks or processes racing on the same due slot will result in exactly one inserted occurrence row; the second will safely receive `null` and do nothing.
2. **At-Least-Once Execution vs Single Dispatch Record:** The scheduler guarantees a single dispatch record per slot. External side effects are never claimed as exactly-once.
3. **No Resurrecting Cancelled Work:** `reserveOccurrence` checks status under row lock. If cancelled concurrently, reservation fails closed.

---

## 5. SourceProfile ID & SourceSnapshot Minimal Contract (Lane C Boundary)

Lane C provides read-only source fixtures and policy checks. Lane A persists `source_profile_id` and Lane B passes `SourceSnapshot` to the summary engine.

```typescript
/**
 * Opaque server-owned profile identifier.
 * NEVER a caller-provided raw URL, file path, or secret token.
 * Examples: 'fixture.github-release', 'fixture.weather-report'
 */
export type SourceProfileId = string;

export interface SourceSnapshotItem {
  readonly id: string; // Bounded <= 128 chars
  readonly title: string; // Bounded <= 256 chars
  readonly contentSnippet: string; // Bounded <= 1,000 chars, untrusted text
  readonly observedAt: string; // RFC 3339
}

export interface SourceSnapshot {
  readonly sourceProfileId: SourceProfileId;
  readonly observedAt: string; // RFC 3339
  readonly digest: string; // SHA-256 hex string (64 characters)
  readonly safeItems: readonly SourceSnapshotItem[]; // Maximum 50 items
}
```

### Safety Rules:

- **Untrusted Data Only:** Snapshot items are data to compare or summarize, **never instructions** to override Sentinel, change execution routes, or request credentials.
- **Redaction Invariant:** Neither `source_profile_id` nor `SourceSnapshot` may contain bearer tokens, private keys, passwords, or query strings with secrets.
- **Zero-Network Default:** In P0-C3, only deterministic fixtures are permitted. Live network egress is disabled.

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

-- Index for due work discovery by scheduler
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
  CONSTRAINT outcomes_result_status_check CHECK (result_status IN ('succeeded', 'failed', 'denied', 'no_change'))
);

CREATE INDEX IF NOT EXISTS outcomes_commitment_order_idx
  ON commitment_outcomes (commitment_id, created_at DESC, id DESC);
```

---

## 9. Cross-Lane Interface Handoff Table

| Provider   | Consumer      | Frozen Interface / Artifact | Description                                                                          |
| :--------- | :------------ | :-------------------------- | :----------------------------------------------------------------------------------- |
| **Lane A** | **Lane B**    | `DueCommitmentStore` port   | `findDueCommitments`, `reserveOccurrence`, `markDispatched`, `appendOutcomeIfAbsent` |
| **Lane A** | **Lane B, C** | `@ember/contracts` DTOs     | `CommitmentDto`, `CommitmentOccurrenceDto`, `CommitmentOutcomeDto`, `SourceSnapshot` |
| **Lane A** | **iOS Inbox** | REST Endpoints              | `GET /v1/commitments`, `GET /v1/commitments/:id/outcomes`                            |
| **Lane C** | **Lane A**    | `SOURCE_PROFILE_ID_REGEX`   | Format validation for accepted source profiles                                       |
| **Lane C** | **Lane B**    | `FakeSourceReader`          | Returns `SourceSnapshot` for deterministic test evaluation                           |

---

## 10. Boundary & Negative Invariants

1. **Zero Outbound Sockets:** Neither Lane A, B, nor C initiates real external network calls.
2. **Zero Credential Execution:** No OAuth secrets, bearer tokens, or private keys are accepted, stored, or executed.
3. **No iOS Code Changes:** iOS M2 remains mock-first and owned by iOS Lead. No Swift files are modified in backend lanes.
4. **No Cross-Lane Edits:** Lane A owns `packages/contracts`, `packages/postgres`, `apps/api/src/commitments`. It does NOT touch `packages/execution` or `apps/worker`.

---

## 11. CTO Freeze Confirmation Request

Lane A requests CTO review on this specification. Once confirmed as **C3-0 FROZEN**, Lane A, Lane B, and Lane C may begin parallel implementation on their dedicated branches.
