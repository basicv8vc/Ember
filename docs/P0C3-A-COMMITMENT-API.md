# Ember P0-C3A Implementation Delivery Report

## Commitment Persistence & HTTP API

**Version:** 1.0.0 FROZEN  
**Author:** Ember P0-C3A Coding Agent (Commitment Persistence & HTTP API)  
**Status:** Completed & Verified  
**Branch:** `feature/p0c-3a-commitment-api`  
**Base Commit:** `bbcad275418cd59c29b742cd2cc6e3bd825c6054`  
**Contract Reference:** `docs/P0-C3-0-CONTRACT-FREEZE.md` (v1.2 FROZEN APPROVED)

---

## 1. Architecture & Design Overview

Ember P0-C3A implements the durable persistence, tenant isolation, concurrency fencing, and HTTP API layer for proactive long-term commitments.

### Core Architecture Responsibilities

1. **Authoritative State Persistence:** PostgreSQL 17 serves as the single authority for commitments, occurrences, and outcomes. The database clock (`clock_timestamp()` / `CURRENT_TIMESTAMP`) acts as the single authoritative timekeeper to eliminate clock skew between distributed schedulers and workers.
2. **RESTful HTTP API (`/v1/commitments`):** Fast, bounded endpoints adhering to RFC 7807 problem details, strict input validation, and header-based `Idempotency-Key` replay fencing.
3. **Optimistic Concurrency Control (CAS):** State transitions (`pause`, `resume`, `cancel`) use monotonic integer version counters to reject stale or conflicting updates with `409 Conflict`.
4. **Authoritative Worker Lease Verification:** `appendOutcomeIfAbsent` enforces that only the worker holding a valid, unexpired lease on the associated task and run (`runs.leased_until > clock_timestamp()`) can append an outcome. Furthermore, the commitment must be in `active` state at publish time.
5. **Scheduler Work Discovery & Occurrence Reservation (`DueCommitmentStore`):** Designed for Agent B (Scheduler Runtime) with single-interval schedule compensation (at most one historical interval when overdue to prevent task storms) and transactional concurrency slot reservation (`SKIP LOCKED`).
6. **Zero-Trust Tenant Isolation:** Every table features a composite primary/foreign key scoped by `tenant_id`, guaranteeing cross-tenant data leakage is structurally impossible.

---

## 2. Database Schema & Migration (`0008_p0c3_commitments.sql`)

The migration creates three durable tables and associated indexes:

### 2.1 Table Definitions

1. **`commitments`**
   - `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
   - `id UUID NOT NULL`
   - `agent_id UUID NOT NULL`
   - `title VARCHAR(140) NOT NULL`
   - `status VARCHAR(32) NOT NULL CHECK (status IN ('active', 'paused', 'cancelled', 'completed'))`
   - `schedule_kind VARCHAR(32) NOT NULL CHECK (schedule_kind IN ('once', 'interval'))`
   - `interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds BETWEEN 900 AND 2592000)`
   - `next_due_at TIMESTAMPTZ`
   - `source_profile_id VARCHAR(64) NOT NULL`
   - `version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)`
   - `idempotency_key VARCHAR(128) NOT NULL`
   - `fingerprint CHAR(64) NOT NULL`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `PRIMARY KEY (tenant_id, id)`
   - `UNIQUE (tenant_id, idempotency_key)`

2. **`commitment_occurrences`**
   - `tenant_id UUID NOT NULL`
   - `id UUID NOT NULL`
   - `commitment_id UUID NOT NULL`
   - `scheduled_for TIMESTAMPTZ NOT NULL`
   - `task_id UUID`
   - `status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed', 'failed', 'cancelled'))`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `PRIMARY KEY (tenant_id, id)`
   - `FOREIGN KEY (tenant_id, commitment_id) REFERENCES commitments(tenant_id, id) ON DELETE CASCADE`
   - `FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE SET NULL`
   - `UNIQUE (tenant_id, commitment_id, scheduled_for)`

3. **`commitment_outcomes`**
   - `tenant_id UUID NOT NULL`
   - `id UUID NOT NULL`
   - `commitment_id UUID NOT NULL`
   - `occurrence_id UUID NOT NULL`
   - `task_id UUID NOT NULL`
   - `summary VARCHAR(2000) NOT NULL`
   - `result_status VARCHAR(32) NOT NULL CHECK (result_status IN ('meaningful_change', 'no_change', 'failed', 'denied'))`
   - `snapshot JSONB`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `PRIMARY KEY (tenant_id, id)`
   - `FOREIGN KEY (tenant_id, commitment_id) REFERENCES commitments(tenant_id, id) ON DELETE CASCADE`
   - `FOREIGN KEY (tenant_id, occurrence_id) REFERENCES commitment_occurrences(tenant_id, id) ON DELETE CASCADE`
   - `FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id) ON DELETE CASCADE`
   - `UNIQUE (tenant_id, occurrence_id)`

### 2.2 Strategic Indexes

- `idx_commitments_scheduler_due`: `(status, next_due_at) WHERE status = 'active'` for zero-allocation due work polling.
- `idx_commitments_tenant_status_created`: `(tenant_id, status, created_at DESC)` for cursor-based listing.
- `idx_occurrences_stalled_recovery`: `(status, created_at) WHERE status = 'pending'` for crash reconciliation.
- `idx_outcomes_commitment_created`: `(tenant_id, commitment_id, created_at DESC)` for paginated outcome feeds.

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

- State transitions require `expected_version` for optimistic locking.
- Transition SQL enforces `WHERE tenant_id = $1 AND id = $2 AND status = $3 AND version = $4`.
- If another process updated the record concurrently, zero rows are modified, resulting in `409 Conflict` (`VERSION_CONFLICT`).
- Once in `cancelled` state, all subsequent transition attempts fail with `409 Conflict` (`INVALID_STATE_TRANSITION`).

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
- Composite primary keys `(tenant_id, id)` and composite foreign keys ensure relational integrity is bounded within the tenant.
- Attempting to inspect or mutate another tenant's commitment produces an invariant `404 Not Found` (`NOT_FOUND`), preventing tenant resource enumeration.

---

## 6. Handoff to Agent B (Scheduler Runtime)

Agent B should consume `PostgresCommitmentRepository` implementing `DueCommitmentStore`:

```typescript
export interface DueCommitmentStore {
  // 1. Authoritative due work polling using PostgreSQL clock
  findDueCommitments(limit: number): Promise<readonly DueCommitment[]>;

  // 2. Transactional single-slot reservation with anti-storm compensation
  reserveOccurrence(commitmentId: Id, scheduledFor: Date): Promise<OccurrenceSlot | null>;

  // 3. Mark occurrence dispatched once durable task is created
  markDispatched(occurrenceId: Id, taskId: Id): Promise<boolean>;

  // 4. Crash recovery: find occurrences stalled in 'pending' status
  findStalledPendingOccurrences(
    olderThanSeconds: number,
    limit: number,
  ): Promise<readonly StalledOccurrence[]>;

  // 5. Reconcile stalled occurrence with real Task ID
  reconcilePendingOccurrence(occurrenceId: Id, taskId: Id): Promise<boolean>;

  // 6. Mark occurrence failed on unrecoverable dispatch error
  markOccurrenceFailed(occurrenceId: Id, reason: string): Promise<boolean>;
}
```

### Deterministic Task Idempotency Key Formula

When dispatching a task to the Ember task runner, Agent B must derive the idempotency key using the shared helper:

```typescript
import { deriveTaskCreationIdempotencyKey } from '@ember/contracts';

const taskKey = deriveTaskCreationIdempotencyKey(commitmentId, occurrenceId);
// Returns: "task-comm-<commitmentId>-<occurrenceId>"
```

---

## 7. Handoff to Agent C (SourceReader & Consent)

Agent C's `FakeSourceReader` and consent evaluation integrate via the frozen contracts:

- `SourceProfileId`: matches `^[a-z0-9][a-z0-9._-]{2,63}$`.
- `SourceSnapshot`: strict Zod schema with `sourceProfileId`, `observedAt`, `digest` (64-char sha256), and `boundedSafeItems` (max 50 items, payload <= 32 KiB).
- `appendOutcomeIfAbsent` verifies:
  1. Worker lease grant matches an active task run where `leased_until > clock_timestamp()`.
  2. The parent commitment remains `active` (not paused or cancelled before publication).
  3. Strict unique occurrence outcome idempotency.

---

## 8. Verification & Quality Gates

All checks and tests were executed against real PostgreSQL 17 in the isolated worktree:

| Gate                               | Status | Command                                                         | Result                                      |
| ---------------------------------- | ------ | --------------------------------------------------------------- | ------------------------------------------- |
| **Format**                         | PASS   | `pnpm format:check`                                             | Exit code 0 (All files conform to Prettier) |
| **Lint**                           | PASS   | `pnpm lint`                                                     | Exit code 0 (Zero warnings, zero errors)    |
| **Typecheck**                      | PASS   | `pnpm typecheck`                                                | Exit code 0 (`tsc -p tsconfig.json`)        |
| **Build**                          | PASS   | `pnpm build`                                                    | Exit code 0 (`tsc -b tsconfig.build.json`)  |
| **Unit Tests (Contracts)**         | PASS   | `vitest run tests/unit/p0c3-commitment-contracts.test.ts`       | 16/16 passed                                |
| **Unit Tests (HTTP API)**          | PASS   | `vitest run tests/unit/p0c3-commitment-api.test.ts`             | 11/11 passed                                |
| **Integration Tests (Postgres)**   | PASS   | `vitest run tests/integration/p0c3-commitment-postgres.test.ts` | 12/12 passed                                |
| **Integration Tests (Migrations)** | PASS   | `vitest run tests/integration/migrations.test.ts`               | 7/7 passed                                  |
| **E2E Tests (HTTP + Postgres)**    | PASS   | `vitest run tests/e2e/p0c3-commitment-e2e.test.ts`              | 5/5 passed                                  |
| **Full Unit Suite**                | PASS   | `pnpm test:unit`                                                | 55/55 files passed (961/961 tests)          |

**Total new P0-C3A tests passed:** 44/44 tests + 7/7 migration verification tests.
