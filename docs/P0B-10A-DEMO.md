# Ember · P0B-10A Local Demo CLI & Real HTTP E2E Closed Loop

## 1. Overview

Ticket **P0B-10A** delivers the developer-facing local demonstration CLI (`pnpm demo`) and the comprehensive HTTP end-to-end test suite (`pnpm test:e2e`) for the Ember Personal Agent Platform (P0-B Minimum Vertical Slice).

This implementation connects all core platform components through real loopback HTTP and real PostgreSQL transactions:

- **Hono HTTP API Gateway**: Token authentication, task creation/inbox, event streams/SSE, approvals, and artifact downloads.
- **Durable Worker Cluster**: PostgreSQL-backed `LeaseQueue` with lease renewal, reaper loop, `DeterministicExecutionRouter`, `DeterministicExecutor`, `PostgresArtifactStore`, `PostgresWorkspaceStore`, `PostgresCheckpointStore`, and `PostgresBudgetLedger`.
- **Zero-Bypass End-to-End Integrity**: Every operation in the demo and E2E tests communicates exclusively through real HTTP endpoints and database transactions. No internal handler bypasses or fake in-memory shortcuts are used.
- **Strict Tenant Isolation & Privacy**: Dual dev tenant configuration (`Tenant Alpha` and `Tenant Beta`), cross-tenant queries return `404 NOT_FOUND` (non-discoverable), and credentials/tokens are never logged.

---

## 2. Quick Start & Execution Guide

### 2.1 Prerequisites & Database Setup

Ember requires Node.js `24.x`, pnpm `12.x`, and a local PostgreSQL instance.

```bash
# 1. Install dependencies (strictly pinned via frozen lockfile)
pnpm install --frozen-lockfile

# 2. Setup local development environment
cp .env.example .env.local

# 3. Ensure local PostgreSQL is running (Compose or local service)
# By default, pointed to 127.0.0.1:5432 or 55432
pnpm dev:db

# 4. Apply platform migrations
pnpm db:migrate
```

### 2.2 Running the Official Local Demo

The interactive demo executes the four official scenarios sequentially, printing real-time step progress, sanitized task/run IDs, and audit summaries:

```bash
# Run all four official scenarios
pnpm demo

# Or run an individual scenario
pnpm demo --scenario fast
pnpm demo --scenario standard
pnpm demo --scenario crash-resume
pnpm demo --scenario tenant-isolation
```

### 2.3 Running the HTTP E2E Test Suite

```bash
pnpm test:e2e
```

### 2.4 Running Full Monorepo Verifications

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:chaos
pnpm test:e2e
```

### 2.5 Dual-Process Local Development (`pnpm dev`)

In P0B-10A, root `package.json` was updated to start both API and Worker concurrently in parallel:

```bash
# Starts both @ember/api and @ember/worker concurrently
pnpm dev

# Or start individually:
pnpm dev:api
pnpm dev:worker
```

_Note_: To enable task polling in local development, configure `EMBER_WORKER_MODE=poll`, `EMBER_WORKER_SIMULATED_EXECUTION=local-only`, and `EMBER_WORKER_BLOB_ROOT=/tmp/ember-blobs` in `.env.local`.

---

## 3. The Four Official Demo Scenarios

### Scenario A — Fast Path (No Sandbox Execution)

- **Goal**: Prove that a lightweight prompt task (`mock.chat`, prompt length ≤ 256) returns a Durable Ack immediately, executes via `DeterministicMockLLM`, streams events, and completes **without** allocating any Fake Sandbox.
- **Execution Flow**:
  1. `POST /v1/agents` provisions Agent A under Tenant A.
  2. `POST /v1/tasks` submits a short `mock.chat` task with `Idempotency-Key`.
  3. API commits the task to PostgreSQL and returns `202 Accepted` (`status: queued`, persisted `task_id`).
  4. Worker claims the run; router selects `fast` (`chat_short_prompt_fast`).
  5. Events emitted: `accepted ➔ leased ➔ started ➔ progress ➔ completed`.
  6. Assertions verify `FakeSandboxProvider.create` was invoked **0 times**.

### Scenario B — Standard Path (Fake Sandbox Lifecycle, CAS & Artifact Store)

- **Goal**: Prove the full lifecycle of a compute task requiring sandbox allocation, step checkpointing, content-addressed artifact persistence, and workspace CAS versioning.
- **Execution Flow**:
  1. `POST /v1/tasks` submits a `mock.compute` task (payload > 512 chars).
  2. Worker claims task; router selects `standard` (`compute_large_input_standard`).
  3. `FakeSandboxProvider.create()` allocates a transient sandbox.
  4. Computation runs inside sandbox; output bytes are staged and committed to blob storage and PostgreSQL.
  5. Checkpoint committed to `step_checkpoints`; Workspace version bumped via CAS (e.g. from 0 to 1).
  6. `FakeSandboxProvider.destroy()` is called in `finally`.
  7. Client downloads artifact raw bytes via HTTP `GET /v1/artifacts/:artifactId` and strictly verifies:
     - Computed text output matches expected SHA-256.
     - Downloaded raw byte length strictly equals artifact metadata `size`.
     - Raw SHA-256 of downloaded bytes strictly matches artifact metadata `sha256`.
  8. Assertions verify active lingering sandboxes count is **0**.

### Scenario C — Simulated Lease Expiration & Checkpoint Resume with Fencing

- **Goal**: Prove that a task can resume from a committed step checkpoint after a worker crash and lease expiration without duplicating work, and that late commits from stale workers are rejected by lease fencing.
- **Execution Flow**:
  1. Background worker loop is paused; `POST /v1/tasks` submits a `mock.compute` task.
  2. Worker 1 (`worker-crash-1`) claims the task and executes the `produce` step, stages the artifact, and commits the step checkpoint with `mode: 'progress'`. Task and Run 1 remain in `running` status.
  3. Controlled crash simulation: rewinds `runs.leased_until` to the past and rewinds `tasks.created_at` / `tasks.lease_expires_at` to satisfy `tasks_check` while making the lease expired.
  4. Background reaper (`queue.reapExpired()`) transitions Run 1 to `lease_expired` and Task to `retryable_failed`.
  5. Fencing assertion: the crashed Worker 1 attempts a late write using its original `RunGrant`; strictly rejected by PostgreSQL with `DomainError('STALE_LEASE')`.
  6. Task retry is scheduled (`next_run_at = now() - 1 second`) and background worker loop is restarted.
  7. Worker 2 claims the task (Run 2 with higher lease epoch), queries checkpoints, detects that `produce` was already committed, **skips produce**, publishes the result, and completes the task.
  8. Strict assertions verify:
     - Run 1 status is `lease_expired`.
     - Run 2 status is `succeeded`.
     - Checkpoint count for `produce` is strictly **1** (zero duplicate executions).
     - Total checkpoint count is strictly **2** (`produce` + `publish`).
     - Task final status is `completed`.

### Scenario D — Tenant Isolation & Non-Discoverable Authorization

- **Goal**: Prove strict multi-tenant authorization boundaries and zero-knowledge non-discoverability.
- **Execution Flow**:
  1. Tenant A provisions Agent A, Task A, and Artifact A.
  2. Tenant B (authenticated with Token B) attempts:
     - `GET /v1/tasks/:taskIdA` ➔ `404 NOT_FOUND` (indistinguishable from missing).
     - `GET /v1/tasks/:taskIdA/events` ➔ `404 NOT_FOUND`.
     - `GET /v1/tasks/:taskIdA/artifacts` ➔ `404 NOT_FOUND`.
     - `POST /v1/tasks/:taskIdA/cancel` ➔ `404 NOT_FOUND`.
  3. Unauthenticated requests (no token) ➔ `401 UNAUTHENTICATED`.
  4. Forged bearer tokens ➔ `401 UNAUTHENTICATED`.
  5. Spoofed tenant headers (passing `X-Tenant-Id: tenant-a` with Token B) ➔ `404 NOT_FOUND` (tenant identity is strictly derived from bearer token configuration, never request headers).

---

## 4. B-T Requirements Traceability Matrix

| Requirement | Category             | Test File                                       | Verified Property                                                                                                                                                                  |  Status  |
| :---------- | :------------------- | :---------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: |
| **B-T05**   | Budget Guard         | `tests/e2e/b-t05-budget-guard.test.ts`          | Exceeding budget limit rejects step reservation; marks run and task `failed` (`BUDGET_EXCEEDED`)                                                                                   | **PASS** |
| **B-T15**   | Fast Path E2E        | `tests/e2e/b-t15-fast-task.test.ts`             | Real HTTP POST agent/task, Durable Ack, SSE event phases, FakeSandbox count = 0                                                                                                    | **PASS** |
| **B-T16**   | Standard Path E2E    | `tests/e2e/b-t16-standard-task.test.ts`         | Real HTTP compute task, FakeSandbox create/destroy, Artifact raw byte length & SHA-256 metadata verification, CAS bump, 0 lingering sandboxes                                      | **PASS** |
| **B-T17**   | Resume & Fencing     | `tests/e2e/b-t17-workspace-resume.test.ts`      | Distinct Sandbox IDs (`sandboxId1 !== sandboxId2`), Workspace CAS version increment, Checkpoint resumption skipping produce, Stale worker fencing (`STALE_LEASE`)                  | **PASS** |
| **B-T18**   | SSE Reconnect        | `tests/e2e/b-t18-sse-reconnect.test.ts`         | SSE client disconnects, reconnects with `Last-Event-ID`, replays missing events monotonically without gaps                                                                         | **PASS** |
| **B-T19**   | Cancellation         | `tests/e2e/b-t19-cancellation.test.ts`          | Queued cancel (`200 OK`, `terminal: true`), Confirmed running state before cancel (`202 Accepted`), cooperative halt to unique `cancelled` state, zero subsequent step checkpoints | **PASS** |
| **B-T20**   | Mock Approval        | `tests/e2e/b-t20-mock-approval.test.ts`         | Parks in `waiting_approval`, approve decision resumes from checkpoint, deny decision fails task                                                                                    | **PASS** |
| **B-T21**   | Security Isolation   | `tests/e2e/b-t21-23-security-isolation.test.ts` | Tenant B querying Tenant A task returns `404 NOT_FOUND` without resource enumeration leak                                                                                          | **PASS** |
| **B-T22**   | Resource Privacy     | `tests/e2e/b-t21-23-security-isolation.test.ts` | Tenant B reading Tenant A artifacts, events, or SSE streams returns `404 NOT_FOUND`                                                                                                | **PASS** |
| **B-T23**   | Authentication Guard | `tests/e2e/b-t21-23-security-isolation.test.ts` | Missing or invalid bearer tokens return `401 UNAUTHENTICATED`                                                                                                                      | **PASS** |

---

## 5. Architectural Boundaries & Isolation Guarantees

1. **No Destructive Operations**:
   - The test harnesses and demo CLI never issue `rm -rf`, `DROP SCHEMA public`, or system-wide `pkill`.
   - Every demo run and E2E test creates an ephemeral schema with a unique cryptographic suffix (`ember_demo_[a-f0-9]{12}` or `ember_e2e_[a-f0-9]{12}`) and drops only that specific schema upon completion.
   - Temporary blob directories use `mkdtempSync` under the OS temporary directory and are removed in `finally`.
2. **Loopback Only**:
   - Servers bind exclusively to `127.0.0.1` on dynamic ports (`port: 0`), preventing network interface exposure.
3. **Log Hygiene & Credential Redaction**:
   - Tokens and secrets are never printed.
   - Task and Run IDs are masked/redacted in demo outputs (`[sanitized 04a0...91e1]`).
