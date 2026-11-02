# Ember P0-C3A Implementation Delivery Report

## Commitment Persistence & HTTP API

**Version:** 1.2.0 FROZEN  
**Author:** Ember P0-C3A Coding Agent (Commitment Persistence & HTTP API)  
**Status:** Completed & Verified (CTO review fixes applied: P0-C3A-1 … P0-C3A-4)  
**Branch:** `feature/p0c-3a-commitment-api`  
**Base Commit:** `bbcad275418cd59c29b742cd2cc6e3bd825c6054`  
**Verified Head Commit:** `91e26135e3dffce9f7b51ee03e1cd4976f0a7d3a` — the exact code + contract SHA that every gate below was executed against, and that GitHub CI run [`41379600792`](https://github.com/basicv8vc/Ember/actions/runs/41379600792) passed on (Node 24 + PostgreSQL 17, 3m04s).  
**PR Head SHA:** the head of `feature/p0c-3a-commitment-api` → PR #56. It sits directly on top of `91e2613` (verified above) with commit `5d91b46` (green in run [`41380036598`](https://github.com/basicv8vc/Ember/actions/runs/41380036598)) and this SHA-record commit, both of which change Markdown only and re-run the identical CI job — so the verified SHA above is never invalidated by a documentation edit.  
**Contract Reference:** `docs/P0-C3-0-CONTRACT-FREEZE.md` (v1.2 FROZEN APPROVED)

---

## 1. Architecture & Design Overview

Ember P0-C3A implements the durable persistence, tenant isolation, concurrency fencing, and HTTP API layer for proactive long-term commitments.

### Core Architecture Responsibilities

1. **Authoritative State Persistence:** PostgreSQL 17 serves as the single authority for commitments, occurrences, and outcomes. The database clock (`clock_timestamp()`) is the only authoritative timekeeper: scheduling, lease freshness, version bumps and occurrence timestamps are all produced in SQL, so clock skew between schedulers, workers and the API cannot change a decision.
2. **RESTful HTTP API (`/v1/commitments`):** Fast, bounded endpoints adhering to RFC 7807 problem details, strict input validation, and header-based `Idempotency-Key` replay fencing.
3. **Optimistic Concurrency Control (CAS):** `pause`, `resume` and `cancel` run inside one transaction that takes a row-level lock on the commitment (`SELECT … FOR UPDATE`), compares the caller's `expected_version` against the locked row, validates the state machine and only then mutates. A stale version or an illegal edge raises `INVALID_STATE_TRANSITION` → `409 Conflict` and writes nothing. `completed` and `cancelled` are terminal, repeated `pause`/`resume`/`cancel` on the state they already produced are idempotent no-ops that do not bump `version`, and `completed → cancelled` is **forbidden**.
4. **Authoritative Worker Lease & Execution Verification:** `appendOutcomeIfAbsent` locks, in order, the commitment, the occurrence, the task and the run. The commitment must be `active`, the occurrence must not be cancelled, the task must be `running`, and the run must be `running` with `worker_id` / `lease_epoch` matching the grant and `leased_until > clock_timestamp()`. Worker ownership, epoch and expiry are all compared inside SQL, so the application clock can neither extend nor shorten a lease.
5. **Scheduler Work Discovery & Occurrence Reservation (`DueCommitmentStore`):** Designed for Agent B (Scheduler Runtime) with single-interval schedule compensation (at most one historical interval when overdue, preventing task storms) and transactional concurrency slot reservation (`ON CONFLICT (commitment_id, scheduled_for) DO NOTHING`).
6. **Zero-Trust Tenant Isolation:** Every table features a composite primary/foreign key scoped by `tenant_id`, guaranteeing cross-tenant data leakage is structurally impossible.

---

## 2. Database Schema & Migration (`0008_p0c3_commitments.sql`)

The migration creates three durable tables and associated indexes:

### 2.1 Table Definitions

Every table is keyed by a surrogate `id` and additionally carries `UNIQUE (tenant_id, id)`, which is the target of every child table's composite `(tenant_id, …)` foreign key. That is what makes cross-tenant references structurally impossible while keeping `id` usable as a plain row identifier.

1. **`commitments`**
   - `id UUID PRIMARY KEY`
   - `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT`
   - `agent_id UUID NOT NULL`
   - `title TEXT NOT NULL` with `char_length(title) BETWEEN 1 AND 140`
   - `status TEXT NOT NULL DEFAULT 'active'` with `status IN ('active', 'paused', 'completed', 'cancelled')`
   - `schedule_kind TEXT NOT NULL` with `schedule_kind IN ('once', 'interval')`
   - `interval_seconds INTEGER` — `NULL` for `once`, `BETWEEN 900 AND 2592000` for `interval`
   - `next_due_at TIMESTAMPTZ` — authoritative due instant, always written from `clock_timestamp()`
   - `source_profile_id TEXT NOT NULL` with `source_profile_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'`
   - `version INTEGER NOT NULL DEFAULT 1` with `version >= 1`
   - `idempotency_key TEXT` / `request_fingerprint TEXT` — both `NULL` for non-idempotent internal rows
   - `created_at` / `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
   - `UNIQUE (tenant_id, id)`, `UNIQUE (tenant_id, idempotency_key)`
   - `FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) ON DELETE RESTRICT`

2. **`commitment_occurrences`**
   - `id UUID PRIMARY KEY`
   - `tenant_id UUID NOT NULL`
   - `commitment_id UUID NOT NULL`
   - `scheduled_for TIMESTAMPTZ NOT NULL`
   - `task_id UUID` — `NULL` until `markDispatched` / `reconcilePendingOccurrence` binds the durable Task
   - `status TEXT NOT NULL DEFAULT 'pending'` with `status IN ('pending', 'dispatched', 'completed', 'failed', 'cancelled')`
   - `created_at` / `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
   - `UNIQUE (tenant_id, id)`
   - `FOREIGN KEY (tenant_id, commitment_id) REFERENCES commitments(tenant_id, id) ON DELETE RESTRICT`
   - `FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE RESTRICT`
   - `UNIQUE (commitment_id, scheduled_for)` — the idempotent scheduling slot

3. **`commitment_outcomes`**
   - `id UUID PRIMARY KEY`
   - `tenant_id UUID NOT NULL`
   - `commitment_id UUID NOT NULL`
   - `occurrence_id UUID NOT NULL`
   - `task_id UUID NOT NULL`
   - `summary TEXT NOT NULL` with `char_length(summary) BETWEEN 1 AND 2000`
   - `result_status TEXT NOT NULL` with `result_status IN ('meaningful_change', 'no_change', 'failed', 'denied')`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
   - `UNIQUE (tenant_id, id)`
   - `FOREIGN KEY (tenant_id, commitment_id) REFERENCES commitments(tenant_id, id) ON DELETE RESTRICT`
   - `FOREIGN KEY (tenant_id, occurrence_id) REFERENCES commitment_occurrences(tenant_id, id) ON DELETE RESTRICT`
   - `FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE RESTRICT`
   - `UNIQUE (occurrence_id)` — one outcome per occurrence, enforced by the database, not by the caller

### 2.2 Strategic Indexes

- `commitments_due_scheduling_idx`: `(next_due_at) WHERE status = 'active' AND next_due_at IS NOT NULL` for due work polling.
- `commitments_tenant_listing_idx`: `(tenant_id, created_at DESC, id DESC)` for cursor-based listing.
- `occurrences_commitment_order_idx`: `(commitment_id, scheduled_for DESC)` for the occurrence history of one commitment.
- `occurrences_pending_reap_idx`: `(created_at) WHERE status = 'pending'` for crash-recovery sweeps.
- `outcomes_commitment_order_idx`: `(commitment_id, created_at DESC, id DESC)` for paginated outcome feeds.

---

## 3. HTTP API Endpoints

All endpoints are mounted under `/v1/commitments` and require Bearer token authentication.

| Method | Path                           | Request Body                                   | Response Status            | Description                                                       |
| ------ | ------------------------------ | ---------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `POST` | `/v1/commitments`              | `CreateCommitmentRequest`                      | `201 Created` / `200 OK`   | Create commitment or replay existing via `Idempotency-Key` header |
| `GET`  | `/v1/commitments`              | Query: `limit`, `cursor`, `status`             | `200 OK`                   | Cursor-paginated listing filtered by status                       |
| `GET`  | `/v1/commitments/:id`          | None                                           | `200 OK` / `404 Not Found` | Fetch single commitment                                           |
| `POST` | `/v1/commitments/:id/pause`    | `StateTransitionRequest` (`expected_version?`) | `200 OK` / `409 Conflict`  | Transition `active` -> `paused` with CAS                          |
| `POST` | `/v1/commitments/:id/resume`   | `StateTransitionRequest` (`expected_version?`) | `200 OK` / `409 Conflict`  | Transition `paused` -> `active` with CAS                          |
| `POST` | `/v1/commitments/:id/cancel`   | `StateTransitionRequest` (`expected_version?`) | `200 OK` / `409 Conflict`  | Transition `active`/`paused` -> `cancelled` with CAS              |
| `GET`  | `/v1/commitments/:id/outcomes` | Query: `limit`, `cursor`                       | `200 OK` / `404 Not Found` | Cursor-paginated outcome query for commitment                     |

---

## 4. CAS and Concurrency Invariants

### 4.1 Idempotency & SHA-256 Fingerprinting

- Every `POST /v1/commitments` requires an `Idempotency-Key` header (8–128 characters, visible ASCII token).
- Payload canonical fingerprint is computed via `sha256(canonicalJson(payload))`.
- If the key exists within the tenant with an identical fingerprint, it returns `200 OK` with the existing commitment receipt and `replayed: true`.
- If the key exists with a different fingerprint, it immediately returns `409 Conflict` (`IDEMPOTENCY_CONFLICT`).

### 4.2 State Machine CAS

Every transition is applied in one database transaction, in this order:

1. `SELECT … FROM commitments WHERE tenant_id = $1 AND id = $2 FOR UPDATE` — the row lock serialises all concurrent writers of that commitment.
2. Validate the state machine edge **and** the caller's `expected_version` against the locked row.
3. `UPDATE … SET status = …, version = version + 1, updated_at = clock_timestamp()` for a real transition.

Consequences that the implementation guarantees (and the test suite proves):

- The version comparison is a **compare inside the locked transaction**. It is not a bare `WHERE version = $n` predicate that could silently update zero rows and be mistaken for a missing resource.
- A stale `expected_version` or an illegal edge raises `INVALID_STATE_TRANSITION`, which the HTTP layer maps to `409 Conflict`. There is **no** separate `VERSION_CONFLICT` error code in the HTTP error table (an earlier revision of this document claimed one).
- Transition table:

  | From        | `pause`                    | `resume`                   | `cancel`                   |
  | ----------- | -------------------------- | -------------------------- | -------------------------- |
  | `active`    | → `paused` (v+1)           | no-op `active`             | → `cancelled` (v+1)        |
  | `paused`    | no-op `paused`             | → `active` (v+1)           | → `cancelled` (v+1)        |
  | `completed` | `INVALID_STATE_TRANSITION` | `INVALID_STATE_TRANSITION` | `INVALID_STATE_TRANSITION` |
  | `cancelled` | `INVALID_STATE_TRANSITION` | `INVALID_STATE_TRANSITION` | no-op `cancelled`          |

- `completed` and `cancelled` are terminal. In particular **`completed → cancelled` is forbidden**: a commitment that already produced its final result can never be retroactively cancelled.
- Idempotent no-ops (`pause` on `paused`, `resume` on `active`, `cancel` on `cancelled`) return the current row unchanged and do **not** increment `version`.
- `cancel` additionally marks the commitment's `pending` occurrences as `cancelled` in the same transaction, so a reconciliation sweep cannot revive them.

### 4.3 Single-Interval Schedule Compensation (Anti-Storm)

When an interval commitment becomes severely overdue (e.g., following system downtime or worker restart), `reserveOccurrence` computes:

```sql
next_due_at = GREATEST(
  scheduled_for + (interval_seconds || ' seconds')::INTERVAL,
  clock_timestamp() + (interval_seconds || ' seconds')::INTERVAL
)
```

This guarantees that **at most one** historical execution slot is produced, and the schedule jumps forward without storming the execution queue.

---

## 5. Multi-Tenant Isolation

- All SQL statements contain strict `tenant_id = $1` filters.
- Composite identity `UNIQUE (tenant_id, id)` is the parent key for every composite `(tenant_id, …)` foreign key, so relational integrity is bounded within the tenant.
- Attempting to inspect or mutate another tenant's commitment produces an invariant `404 Not Found` (`NOT_FOUND`), preventing tenant resource enumeration.

---

## 6. Handoff to Agent B (Scheduler Runtime)

Agent B consumes `PostgresCommitmentRepository`, which implements the frozen `DueCommitmentStore`:

```typescript
export interface DueCommitmentStore {
  // 1. Authoritative due-work polling, ordered by next_due_at (PostgreSQL clock).
  findDueCommitments(limit: number, asOfOverride?: Date): Promise<readonly DueCommitment[]>;

  // 2. Transactional single-slot reservation with anti-storm compensation. `expectedVersion`
  //    is the CAS token; `slotTimeOverride` exists only for virtual-clock tests.
  reserveOccurrence(
    commitmentId: Id,
    expectedVersion: number,
    slotTimeOverride?: Date,
  ): Promise<ReservedSlot | null>;

  // 3. Bind the durable Task to the occurrence (throws INVALID_STATE_TRANSITION otherwise).
  markDispatched(occurrenceId: Id, taskId: Id): Promise<void>;

  // 4. Publish an outcome behind authoritative lease fencing.
  appendOutcomeIfAbsent(grant: WorkerLeaseGrant, cmd: AppendOutcomeCommand): Promise<boolean>;

  // 5. Advance a one-shot commitment to `completed` (0 rows if it is no longer active).
  markCommitmentCompleted(commitmentId: Id, expectedVersion?: number): Promise<boolean>;

  // 6. Crash recovery: pending occurrences older than `timeoutSeconds`.
  findStalledPendingOccurrences(
    timeoutSeconds: number,
    limit: number,
  ): Promise<readonly StalledPendingOccurrence[]>;

  // 7. Re-bind a stalled occurrence to the durable Task that already exists.
  reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean>;

  // 8. Fail an occurrence whose dispatch is permanently unrecoverable.
  markOccurrenceFailed(occurrenceId: Id, reasonCode: string): Promise<void>;
}
```

### 6.1 `StalledPendingOccurrence` is database-authoritative

`findStalledPendingOccurrences` joins each stalled `pending` occurrence to its commitment and
returns everything the scheduler runtime needs to rebuild the dispatch context:

```typescript
export interface StalledPendingOccurrence {
  readonly occurrenceId: Id;
  /** From commitment_occurrences.tenant_id — the real owning tenant. */
  readonly tenantId: Id;
  readonly commitmentId: Id;
  /** From commitments.agent_id — the real target agent. */
  readonly agentId: Id;
  /** From commitments.source_profile_id — the consent/profile scope of the run. */
  readonly sourceProfileId: SourceProfileId;
  /** From commitments.schedule_kind / interval_seconds — needed to re-arm the schedule. */
  readonly scheduleKind: ScheduleKind;
  readonly intervalSeconds: number | null;
  readonly scheduledFor: Date;
  readonly createdAt: Date;
  readonly taskCreationIdempotencyKey: string;
}
```

The scheduler **must** use these returned values verbatim. It must not substitute a synthetic or
"system" tenant/agent for a recovered occurrence: doing so would break tenant isolation, attribute
the recovered Task to the wrong agent, and evaluate consent against the wrong source profile. Rows
without a resolvable commitment cannot appear in this list at all, because the query joins
`commitments` on `(tenant_id, commitment_id)`.

### 6.2 Deterministic Task Idempotency Key Formula

When dispatching a task to the Ember task runner, Agent B must derive the idempotency key using the shared helper:

```typescript
import { deriveTaskCreationIdempotencyKey } from '@ember/contracts';

const taskKey = deriveTaskCreationIdempotencyKey(occurrenceId);
// Returns: "commitment-occ:<occurrenceId>"
```

The key depends only on the occurrence, so a crash between reservation and `markDispatched`
can never produce a second Task for the same slot.

---

## 7. Handoff to Agent C (SourceReader & Consent)

Agent C's `FakeSourceReader` and consent evaluation integrate via the frozen contracts:

- `SourceProfileId`: matches `^[a-z0-9][a-z0-9._-]{2,63}$`.
- `SourceSnapshot`: strict Zod schema with `sourceProfileId`, `observedAt`, `digest` (64-char sha256), and `boundedSafeItems` (max 50 items, payload <= 32 KiB).
- `appendOutcomeIfAbsent` verifies, inside one transaction:
  1. The commitment row is still `active` (locked first, so a concurrent `cancel` is either
     observed here or happens after the outcome is committed).
  2. The occurrence exists, is not `cancelled`, and is bound to the granted `taskId`.
  3. The task is still `running` — a cancelled/failed/completed task can never publish.
  4. The run is `running` and the grant owns it: `worker_id` and `lease_epoch` match, and
     `leased_until > clock_timestamp()` (evaluated by PostgreSQL, never by the app clock).
  5. Strict unique occurrence outcome idempotency (`UNIQUE (tenant_id, occurrence_id)`).

---

## 8. Verification & Quality Gates

All checks and tests were re-executed against real PostgreSQL 17 (Homebrew `postgresql@17`, local
`ember_test` database) in this worktree on the `Implementation Head Commit` recorded at the top of
this document, and the same commit is green in GitHub CI. The counts below are the ones observed on
that SHA, not carried over from an earlier revision.

| Gate                                   | Status | Command                                                         | Result                                                          |
| -------------------------------------- | ------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Format**                             | PASS   | `pnpm format:check`                                             | Exit code 0 (All files conform to Prettier)                     |
| **Lint**                               | PASS   | `pnpm lint`                                                     | Exit code 0 (Zero warnings, zero errors)                        |
| **Typecheck**                          | PASS   | `pnpm typecheck`                                                | Exit code 0 (`tsc -p tsconfig.json`)                            |
| **Build**                              | PASS   | `pnpm build`                                                    | Exit code 0 (`tsc -b tsconfig.build.json`)                      |
| **Migrations (first + repeat run)**    | PASS   | `pnpm db:migrate` twice                                         | 8 idempotent migrations, second run applies 0                   |
| **Unit Tests (Contracts)**             | PASS   | `vitest run tests/unit/p0c3-commitment-contracts.test.ts`       | 16/16 passed                                                    |
| **Unit Tests (HTTP API)**              | PASS   | `vitest run tests/unit/p0c3-commitment-api.test.ts`             | 12/12 passed                                                    |
| **Integration Tests (P0-C3A)**         | PASS   | `vitest run tests/integration/p0c3-commitment-postgres.test.ts` | 17/17 passed                                                    |
| **Integration Tests (Migrations)**     | PASS   | `vitest run tests/integration/migrations.test.ts`               | 7/7 passed                                                      |
| **Full Integration Suite**             | PASS   | `pnpm test:integration`                                         | 30 files passed (311/311 tests)                                 |
| **E2E Tests (P0-C3A HTTP + Postgres)** | PASS   | `vitest run tests/e2e/p0c3-commitment-e2e.test.ts`              | 5/5 passed                                                      |
| **Full E2E Suite**                     | PASS   | `pnpm test:e2e`                                                 | 9 files passed (18/18 tests)                                    |
| **Chaos Suite**                        | PASS   | `pnpm test:chaos`                                               | 5 files passed (27/27 tests)                                    |
| **Full Unit Suite**                    | PASS   | `pnpm test:unit`                                                | 55 files passed (962/962 tests)                                 |
| **GitHub CI**                          | PASS   | `.github/workflows/ci.yml` on `91e2613`                         | `Verify (Node 24 LTS + PostgreSQL 17)` green, run `41379600792` |

**Total new P0-C3A tests passed:** 50/50 (16 contracts + 12 API + 17 integration + 5 E2E) +
7/7 migration verification tests.

### 8.1 CTO Review Fixes and the Tests That Prove Them

| Item  | Fix                                                                                                                                                                                | Regression proof                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C3A-1 | Lease validity (worker, epoch, expiry) is decided entirely by SQL; expiry uses `clock_timestamp()`; initial `next_due_at` also comes from the DB clock                             | `determines lease validity entirely via PostgreSQL clock_timestamp() even under extreme application time skew` (DB-valid lease accepted with the app clock at 2036; DB-expired lease rejected with the app clock at 1990)                                                                      |
| C3A-2 | Publish requires `commitments.status = 'active'`, `tasks.status = 'running'`, `runs.status = 'running'` and a valid lease; locks are taken as commitment → occurrence → task → run | `serialises outcome publication behind a concurrent cancellation and never writes after it` (real second session holds the commitment lock, publisher blocks, then fails closed with `POLICY_DENIED` and 0 outcome rows) + `rejects outcome append if Task is cancelled or Run is not running` |
| C3A-3 | `completed → cancelled` is rejected with `INVALID_STATE_TRANSITION`; terminal no-ops never bump `version`                                                                          | `strictly forbids completed -> cancelled transition…`, `enforces the full transition table and idempotent terminal semantics`, API unit test and E2E `409 INVALID_STATE_TRANSITION`                                                                                                            |
| C3A-4 | `StalledPendingOccurrence` returns `tenantId` / `agentId` / `sourceProfileId` / `scheduleKind` / `intervalSeconds` from the DB join; no synthetic tenant                           | `finds stalled occurrences and reconciles task dispatch` asserts every field equals the seeded tenant/agent/profile/schedule values                                                                                                                                                            |

### 8.2 Mutation Check: the Regression Tests Are Load-Bearing

A passing test proves nothing if it would also pass with the fix reverted. Each fix above was
therefore reverted in isolation — with the production file restored afterwards — and the matching
test was re-run against real PostgreSQL 17:

| Reverted behaviour                                                               | Targeted test                                         | Observed result                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `cancel()` accepts `completed` (the `completed` branch removed)                  | `strictly forbids completed -> cancelled transition…` | FAIL — `promise resolved "{ …(12) }" instead of rejecting`      |
| `appendOutcomeIfAbsent` drops the `FOR UPDATE` on the commitment row             | `serialises outcome publication behind a concurrent…` | FAIL — `expected true to be false` (publisher no longer blocks) |
| Lease expiry moved off the DB clock (`clock_timestamp() + interval '100 years'`) | `determines lease validity entirely via PostgreSQL…`  | FAIL — valid lease rejected (`DomainError: Lease is stale…`)    |

Each revert makes exactly the intended test fail and nothing else, so the three P1 guarantees are
pinned by executable evidence rather than by comments.
