# Ember

1000 Agents. 1000 Embers. Only active agents need a flame.

Ember is a Personal Agent Platform built as a cloud control plane plus a local device agent.
A user owns one logically long-lived personal agent; expensive execution capacity is created
on demand for active work instead of renting one full VM per user. The long-term question is
whether 1,000 logical agents can be served with good responsiveness, safe isolation, and sane
cost while only active tasks consume expensive runtime.

> **Scope of this repository right now:** P0B-01 (repository foundation), P0B-02
> (domain models, state machines and contracts) and P0B-03 (PostgreSQL durable task inbox)
> are merged on `main`. P0B-04 adds durable PostgreSQL lease claiming, heartbeat, reaper,
> fencing and bounded retry in this Draft PR. There is still **no Agent execution**, no
> task HTTP API, no sandbox provider, no real LLM and no complete cancellation API.
> A successful lease claim is not a successful Task execution. Nothing here proves sandbox
> isolation, real LLM behaviour or 1,000-agent production performance. See
> [P0-B status](#p0-b-status) below.

## P0-B status

| Work package | Scope                                                                                                                | Status                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **P0B-01**   | Repository foundation: Node/TypeScript/pnpm workspace, Hono API, local PostgreSQL, migration runner, tests, CI, docs | **Merged on `main`**       |
| **P0B-02**   | Domain models, Task/Run state machines, Zod schemas, contracts, error model                                          | **Merged on `main`**       |
| **P0B-03**   | PostgreSQL business schema, tenant-scoped repositories, canonical digest, atomic/idempotent task creation            | **Merged on `main`**       |
| **P0B-04**   | PostgreSQL durable lease queue, heartbeat, reaper, fencing, bounded retry, ADR-0001 cancellation                     | **Implemented in this PR** |
| P0B-05       | Execution router, deterministic mock LLM, fake sandbox                                                               | Not started                |
| P0B-06       | Artifact store, workspace CAS, checkpoints                                                                           | Not started                |
| P0B-07       | Task HTTP API, tenant authZ, event log, SSE                                                                          | Not started                |
| P0B-08       | Cancellation, mock approval, budget guard                                                                            | Not started                |
| P0B-09       | Telemetry, chaos and local load tests                                                                                | Not started                |
| P0B-10       | Demo commands, results report, final review                                                                          | Not started                |

P0B-04 now provides a durable `PostgresLeaseQueue` and a minimal `reaper-only` worker
process. There is intentionally **no Agent execution, no Execution Router, no sandbox and
no task HTTP API** yet. `claimNext` returning a lease only means a fenced Run was persisted;
it does not mean the Task ran or succeeded. `GET /healthz` returning 200 is not evidence
that P0-B works end to end.

## Repository layout

```text
Ember/
  apps/
    api/                  # Hono HTTP service (app factory + Node listener)
    worker/               # Minimal reaper-only process; no Task execution (P0B-05)
  packages/
    domain/               # pure domain types, Task/Run state machines, errors
    contracts/            # Zod input/output schemas, DTOs, cross-module interfaces
    postgres/             # DB config, pool factory, migration runner, repositories, lease queue
  infra/
    local/
      compose.yaml        # local PostgreSQL only (loopback-bound)
      initdb/             # creates the integration-test database on first start
  migrations/             # ordered SQL migrations (0001 metadata, 0002 business schema,
                          # 0003 FK hardening, 0004 lease/fencing indexes and safety checks)
  tests/
    unit/                 # no database, no fixed ports
    integration/          # real PostgreSQL, unique throwaway schema per run
  docs/
    P0B-IMPLEMENTATION.md      # P0B-01 architecture decisions and deferred boundaries
    P0B-ACCEPTANCE.md          # P0B-01 acceptance checklist with real command results
    P0B-02-IMPLEMENTATION.md   # P0B-02 domain/contracts design and state machines
    P0B-02-ACCEPTANCE.md       # P0B-02 verification evidence and B-T01–B-T04 status
    P0B-03-IMPLEMENTATION.md   # P0B-03 schema, transactions, digest and idempotency design
    P0B-03-ACCEPTANCE.md       # P0B-03 verification evidence and B-T06–B-T08 status
    adr/0001-cancellation-and-retry-coordination.md  # Accepted OQ-1 decision
    P0B-04-IMPLEMENTATION.md   # P0B-04 lease/fencing/retry transactions and ADR-0002
    P0B-04-ACCEPTANCE.md       # P0B-04 command evidence and B-T09–B-T11 status
  .github/workflows/ci.yml
  .env.example
  package.json
  pnpm-workspace.yaml
  tsconfig*.json
```

`packages/domain` and `packages/contracts` are real packages (P0B-02). The domain package has
no runtime dependencies and owns Task/Run state semantics; the contracts package depends on the
domain and Zod. P0B-03 wires them into real PostgreSQL repositories, but **not** into a task
HTTP API: that remains P0B-07.

## Domain and contracts (P0B-02)

- `@ember/domain` is pure TypeScript: no Hono, PostgreSQL, filesystem, network or clock. It
  defines `AuthContext`, `TaskCommand`, `TaskView`, `LeasedRun`, `TaskEvent`, `TaskStatus`,
  `RunStatus`, the Task/Run transition tables, terminal-state rules and stable `DomainError`s.
- `@ember/contracts` validates boundaries with Zod 4: strict per-kind mock inputs, UUIDs,
  bounded deadlines, header-only idempotency keys, receipts/events and their snake_case HTTP
  DTOs, plus provider-neutral `TaskRepository`/`LeaseQueue`/`ArtifactStore`/`SandboxProvider`
  interfaces. No fake implementations exist. Event payloads use a closed safe-metadata
  allowlist (enums, UUIDs, integers, booleans only), and error DTOs expose only a fixed
  public message; internal `diagnostic` text is never serialised.
- **Task** is the user's overall intent, **Run** is one execution attempt, and **Event** is a
  fact that happened. `accepted` is an event, not a `TaskStatus`; `waiting_external` is outside
  P0-B. Terminal Task states (`completed`, `failed`, `cancelled`) have no outgoing edges, and
  same-state assignment is rejected rather than treated as an implicit no-op.

See [docs/P0B-02-IMPLEMENTATION.md](docs/P0B-02-IMPLEMENTATION.md) for the complete transition
tables, input semantics and open design questions.

## Durable task inbox (P0B-03)

- `migrations/0002_durable_task_inbox.sql` adds `tenants`, `principals`, `agents`,
  `workspaces`, `tasks`, `runs` (reserved structure only) and `task_events`.
- `migrations/0003_tasks_current_run_tenant_fk.sql` adds a tenant- and task-safe composite
  foreign key for `tasks.current_run_id`; a run from another tenant or another task is
  rejected by PostgreSQL. No Worker/Lease code writes this pointer yet.
- `PostgresAgentRepository` creates an agent and its single version-0 workspace in one
  transaction. `PostgresTaskRepository.create()` writes a `queued` task and exactly one
  `accepted` event in the same transaction and returns a receipt only **after commit**.
- `UNIQUE (tenant_id, idempotency_key)` is enforced by PostgreSQL. 24 truly concurrent
  identical requests produce one task and one accepted event: one `replayed: false` and 23
  `replayed: true` receipts. Different tenants may reuse the same key; the same key with a
  different canonical command returns `IDEMPOTENCY_CONFLICT`.
- The command digest is a versioned SHA-256 over `agentId`, `kind`, validated `input` and a
  UTC-normalised `deadlineAt`. Object key order does not matter; array order does. The
  idempotency key is not part of the digest, and commands over 64 KiB UTF-8 bytes are
  rejected before persistence.
- Tenant-owned rows use explicit `tenant_id` plus composite foreign keys such as
  `(tenant_id, agent_id)` and `(tenant_id, task_id)`, so direct SQL cannot attach another
  tenant's agent or task. Reads return `null`/`NOT_FOUND` without revealing existence.
- `requestCancel()` follows ADR-0001 from P0B-04: `queued`, `retryable_failed` and
  `waiting_approval` become `cancelled` atomically; `running` records intent until the current
  valid Run or the Reaper converges it. The public cancellation API and cooperative remote
  abort remain P0B-08.

See [docs/P0B-03-IMPLEMENTATION.md](docs/P0B-03-IMPLEMENTATION.md) and
[docs/P0B-03-ACCEPTANCE.md](docs/P0B-03-ACCEPTANCE.md).

## Durable leasing, fencing and retry (P0B-04)

- `migrations/0004_lease_fencing_and_retry.sql` adds safe-`bigint` bounds for
  `lease_epoch`, a partial unique index guaranteeing at most one `created|running` Run per
  Task, and deterministic claim/deadline indexes. `0001`–`0003` remain immutable.
- `PostgresLeaseQueue` implements the existing `LeaseQueue` contract:
  `claimNext`, `heartbeat`, `reapExpired`, `finish`. Claims use a Task row lock plus
  `FOR UPDATE SKIP LOCKED`, re-check every predicate under the lock, create a fresh Run and
  `lease_epoch`, and return only after `COMMIT`.
- Fencing compares Tenant + Task + current Run + `lease_epoch`. A stale Run cannot renew,
  finish, overwrite a newer attempt or emit a second terminal event. `finish(false)` means no
  valid current lease and nothing was written; database errors are fixed `DomainError`s.
- Lease expiry is recovered by the Reaper: old Run becomes `lease_expired`, the Task becomes
  `retryable_failed` (bounded exponential backoff) or `failed` when attempts/deadline are
  exhausted. Retries always create a **new** Run and **new** epoch.
- ADR-0001 cancellation is implemented transactionally. Once cancellation commits, no new
  Run may be created. `retryable_failed → cancelled` is now a legal Task edge.
- **OQ-2 is conditionally accepted in ADR-0002:** `queued → failed` is used only to
  terminalize a Task that is already past its deadline or has exhausted its execution
  budget before any claim. It never fabricates a Run and never overrides ADR-0001
  cancellation priority.
- `apps/worker` is a minimal, stoppable `reaper-only` process. The production entry refuses
  `poll` mode because P0B-05 has no Execution Router/FakeLLM/FakeSandbox. There is **no fake
  success executor**, no Agent business execution and no automatic Resume yet.

See [docs/P0B-04-IMPLEMENTATION.md](docs/P0B-04-IMPLEMENTATION.md),
[docs/P0B-04-ACCEPTANCE.md](docs/P0B-04-ACCEPTANCE.md) and
[docs/adr/0001-cancellation-and-retry-coordination.md](docs/adr/0001-cancellation-and-retry-coordination.md).

## Prerequisites

Verified locally for this PR:

| Tool       | Version                              | Notes                                                                       |
| ---------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Node.js    | **24.22.1 LTS (Krypton)**            | `.nvmrc` pins this; Node 26 is not LTS yet at the time of writing           |
| pnpm       | **12.15.0**                          | declared via `packageManager`; pnpm is the package manager, not the runtime |
| PostgreSQL | **17 (Docker `postgres:17-alpine`)** | local container only; any local PostgreSQL 15+ works too                    |
| Docker     | 29.0.1 + Docker Compose v2           | only for the local database                                                 |
| OS         | macOS (Darwin 25.3.0, arm64)         | CI runs on `ubuntu-latest`                                                  |

Node 24 LTS or newer LTS is required (`engines` enforces `>=24 <25`). pnpm 12+ is required.
No cloud account, paid API, or model key is needed.

## Quick start

```bash
# 1. Install dependencies (reproducible)
pnpm install --frozen-lockfile

# 2. Local environment (gitignored)
cp .env.example .env.local

# 3. Start PostgreSQL (localhost:55432 by default)
pnpm dev:db

# 4. Apply migrations
pnpm db:migrate

# 5. Start the API on http://127.0.0.1:8787
pnpm dev

# 6. Optional: start the reaper-only worker (does NOT execute Tasks)
pnpm dev:worker
```

Then:

```bash
curl -i http://127.0.0.1:8787/healthz   # 200 liveness, independent of the database
curl -i http://127.0.0.1:8787/readyz     # 200 when PostgreSQL is reachable, otherwise 503
```

Running the compiled artifact instead of the watcher:

```bash
pnpm build
pnpm start
```

## Commands

| Command                             | What it does                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`    | Reproducible install from `pnpm-lock.yaml`                   |
| `pnpm dev`                          | API with env-file loading and watch mode on `127.0.0.1:8787` |
| `pnpm start`                        | Run the built API from `apps/api/dist`                       |
| `pnpm dev:worker`                   | Reaper-only worker (no Task execution; P0B-05 will add it)   |
| `pnpm start:worker`                 | Run the built reaper-only worker from `apps/worker/dist`     |
| `pnpm build`                        | `tsc -b` project-reference build (Node ESM output)           |
| `pnpm typecheck`                    | `tsc --noEmit` over apps, packages, and tests (strict)       |
| `pnpm lint`                         | ESLint flat config with type-aware TypeScript rules          |
| `pnpm format:check` / `pnpm format` | Prettier check / write                                       |
| `pnpm test:unit`                    | Unit + in-process HTTP tests, no database needed             |
| `pnpm test:integration`             | Real PostgreSQL migration tests (`TEST_DATABASE_URL`)        |
| `pnpm dev:db` / `pnpm dev:db:down`  | Start / stop the local PostgreSQL container                  |
| `pnpm db:migrate`                   | Apply pending migrations (safe to re-run)                    |

`pnpm dev` starts the API only. `pnpm dev:worker` is a separate process and only runs the
lease Reaper. It **does not claim or execute Tasks**: the production entry refuses
`EMBER_WORKER_MODE=poll` until P0B-05 provides the Execution Router and a real RunHandler.

## Environment variables

All variables are validated with Zod at startup. Invalid values stop the process with a
message that names the variable but never echoes credentials.

| Variable                        | Default              | Purpose                                                                                                                                   |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBER_ENV`                     | `local`              | `local` \| `test` \| `ci`                                                                                                                 |
| `EMBER_HOST`                    | `127.0.0.1`          | Listener address. Bracketed IPv6 literals are normalised (`[::1]` → `::1`). A non-loopback host is refused unless the opt-in below is set |
| `EMBER_PORT`                    | `8787`               | Listener port (1–65535)                                                                                                                   |
| `EMBER_LOG_LEVEL`               | `info`               | `debug` \| `info` \| `warn` \| `error`                                                                                                    |
| `EMBER_ALLOW_NON_LOOPBACK_BIND` | `false`              | Must be `true` to bind anything other than loopback                                                                                       |
| `DATABASE_URL`                  | — (required)         | Application database, `postgres://…`                                                                                                      |
| `TEST_DATABASE_URL`             | — (integration only) | Database used by `pnpm test:integration`                                                                                                  |
| `EMBER_DB_POOL_MAX`             | `10`                 | Pool size (1–50)                                                                                                                          |
| `EMBER_DB_CONNECT_TIMEOUT_MS`   | `5000`               | Connection timeout                                                                                                                        |
| `EMBER_DB_IDLE_TIMEOUT_MS`      | `30000`              | Idle connection timeout                                                                                                                   |
| `EMBER_DB_STATEMENT_TIMEOUT_MS` | `10000`              | Server-side statement timeout                                                                                                             |
| `EMBER_MIGRATIONS_DIR`          | `./migrations`       | Optional override used by the migration CLI                                                                                               |
| `EMBER_WORKER_MODE`             | `reaper-only`        | `reaper-only`; `poll` is refused until P0B-05 has an executor                                                                             |
| `EMBER_WORKER_ID`               | `worker-local`       | Opaque 1–128 char worker label (not an auth credential)                                                                                   |
| `EMBER_WORKER_INTERVAL_MS`      | `2000`               | Reaper poll interval (100–60000)                                                                                                          |
| `EMBER_WORKER_ERROR_BACKOFF_MS` | `1000`               | Bounded failure backoff (100–60000)                                                                                                       |
| `EMBER_WORKER_LEASE_MS`         | `30000`              | Lease duration (1000–300000)                                                                                                              |
| `EMBER_WORKER_HEARTBEAT_MS`     | `10000`              | Heartbeat cadence; must be strictly shorter than the lease                                                                                |
| `EMBER_WORKER_RETRY_BASE_MS`    | `1000`               | First retry delay; doubles up to the cap                                                                                                  |
| `EMBER_WORKER_RETRY_CAP_MS`     | `30000`              | Maximum retry delay                                                                                                                       |
| `EMBER_WORKER_REAPER_BATCH`     | `50`                 | Maximum expired Tasks per reaper transaction                                                                                              |

`.env.local` is loaded by the scripts through Node's `--env-file-if-exists`; it is gitignored.
`.env.example` contains local-only placeholder credentials and no real secrets.

## HTTP endpoints

| Method        | Path       | Status                                                                |
| ------------- | ---------- | --------------------------------------------------------------------- |
| `GET`         | `/healthz` | 200 liveness. **Never** touches PostgreSQL                            |
| `GET`         | `/readyz`  | 200 when `SELECT 1` succeeds, 503 otherwise (readiness, not liveness) |
| anything else | —          | JSON 404; no `/v1/*` endpoints exist yet                              |

The app factory (`apps/api/src/app.ts`) is separate from the listener
(`apps/api/src/index.ts`), so tests exercise HTTP without binding a public port.

## Database and migrations

- `infra/local/compose.yaml` runs PostgreSQL 17 bound to `127.0.0.1:55432` and creates
  `ember` plus `ember_test` (the test database is created by `infra/local/initdb` on first
  volume initialisation).
- Prefer an existing local PostgreSQL? Point `DATABASE_URL`/`TEST_DATABASE_URL` at it and skip
  `pnpm dev:db`; create the two databases yourself.
- `packages/postgres/src/migrator.ts` is a small SQL migration runner:
  - files are `NNNN_lower_snake_case.sql` in `migrations/`, applied in ascending order;
  - one session-level advisory lock serialises concurrent runners;
  - each migration and its `schema_migrations` version row commit in one transaction;
  - applied id, filename, and checksum are verified, so edited or renamed history fails
    loudly;
  - re-running is a no-op. There are no down migrations in P0.
- `0001_platform_metadata.sql` creates infrastructure metadata only.
- `0002_durable_task_inbox.sql` is the P0B-03 business schema. It includes tasks, runs
  (structure only), task events, agents/workspaces and tenants/principals; artifact,
  checkpoint, approval, budget and inbound-event tables remain future work.
- `0003_tasks_current_run_tenant_fk.sql` is a forward hardening migration for PR #3 P1-1:
  `(tenant_id, id, current_run_id) → runs (tenant_id, task_id, id)` plus
  `UNIQUE (tenant_id, task_id, id)` and a referencing index.
- `0004_lease_fencing_and_retry.sql` adds safe-int `lease_epoch` checks, a partial unique
  index for at most one `created|running` Run per Task, and claim/deadline indexes.
- Migrations are never edited after being applied; checksum and filename guards fail loudly.

Integration tests create a schema named `ember_it_<random hex>`, run migrations inside it, and
drop only that schema afterwards. They never truncate or delete `public` or other schemas.

## Testing

```bash
pnpm test:unit        # 11 files, 265 tests (no database)
pnpm test:integration # 72 tests against real PostgreSQL 17
```

- Unit tests cover the P0B-01 infrastructure (env validation, strict loopback guard,
  whitelist-only database log metadata, migration file parsing, `/healthz` and `/readyz`, real
  IPv4/IPv6 loopback sockets) plus P0B-02 domain contracts: the complete Task and Run state
  matrices, terminal-state invariants, stable transition errors, all mock input schemas,
  forged tenant/principal fields, idempotency keys, receipt/event DTOs, public/internal error
  separation and validation-error redaction. P0B-03 adds canonical digest/UTF-8 tests and
  SQL-vocabulary alignment checks. P0B-04 adds retry/clock/epoch/worker-id policy tests,
  the worker's stop-aware loop tests, and the updated full Task matrix for ADR-0001/ADR-0002.
- Integration tests require `TEST_DATABASE_URL`; if it is missing the suite fails instead of
  silently passing. They verify connection, `0001`–`0004`, repeat migration, readiness,
  checksum/rename tamper detection, Durable Ack (including injected event/COMMIT failures),
  24-request concurrent idempotency, conflicts, tenant-safe FKs, `current_run_id`
  positive/negative cases, event ordering and the database payload allowlist. P0B-04 adds
  real PostgreSQL B-T09 (two independent pools and 24 concurrent claims), B-T10 (lease
  expiry, crash/restart, reaper races, bounded retry and deadlines), B-T11 (stale
  epoch/run/tenant fencing and single terminal finish) and OQ-1 cancellation races.

Exact P0B-04 results, including the CI run, are recorded in
[docs/P0B-04-ACCEPTANCE.md](docs/P0B-04-ACCEPTANCE.md). P0B-03 results remain in
[docs/P0B-03-ACCEPTANCE.md](docs/P0B-03-ACCEPTANCE.md); P0B-01/P0B-02 acceptance reports
remain in [docs/P0B-ACCEPTANCE.md](docs/P0B-ACCEPTANCE.md) and
[docs/P0B-02-ACCEPTANCE.md](docs/P0B-02-ACCEPTANCE.md). Historical reports are not rewritten.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` (and manual dispatch) with:

`pnpm install --frozen-lockfile` → `lint` → `format:check` → `typecheck` → `test:unit` →
`build` → `db:migrate` (twice) → `test:integration`

It uses a temporary PostgreSQL 17 service container, `permissions: contents: read`, no
secrets, no cloud account, no deployments, and no automatic merge.

## Security and cost boundaries

- Loopback detection is strict: only `localhost`, syntactically valid `127.0.0.0/8` addresses,
  and `::1` are treated as loopback; malformed addresses such as `127.999.999.999` are not.
- Listener defaults to loopback; public binding requires an explicit opt-in variable.
- No real LLM, sandbox provider, cloud deployment, OAuth, payments, or user data.
- The P0B-04 worker does not claim or execute Tasks; only the Reaper loop runs. There is no
  fake success path and no arbitrary code execution or host shell.
- Database credentials come from local env files. Logs and CLI output only contain whitelisted
  connection metadata (host, port, database) — never userinfo, passwords, or query parameters.
- Worker leases are fenced by Tenant + Task + current Run + epoch. A Worker ID is not an
  authentication credential; external AuthN/AuthZ remains P0B-07.
- Dependencies are open-source npm packages pinned by `pnpm-lock.yaml`; no paid services.

These measures are development hygiene, not a security certification.

## Troubleshooting

| Symptom                                               | Cause / fix                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid database environment: DATABASE_URL …`        | Missing `DATABASE_URL`. Copy `.env.example` to `.env.local` or export the variable                                                                                     |
| `Refusing to bind non-loopback host …`                | `EMBER_HOST` is not loopback. Keep `127.0.0.1`, or set `EMBER_ALLOW_NON_LOOPBACK_BIND=true` deliberately                                                               |
| `Cannot connect to the Docker daemon`                 | Start Docker Desktop, then `pnpm dev:db`                                                                                                                               |
| `port is already allocated`                           | Another service uses 55432. Set `EMBER_DB_HOST_PORT` and update `.env.local`                                                                                           |
| `TEST_DATABASE_URL is required for integration tests` | Start the local DB and create `.env.local`, or export `TEST_DATABASE_URL`                                                                                              |
| `database "ember_test" does not exist`                | Existing Docker volume was created before `initdb` existed: `docker compose -f infra/local/compose.yaml down -v` (deletes only the Ember local volume) and start again |
| `ERR_PNPM_OUTDATED_LOCKFILE`                          | Run `pnpm install` without `--frozen-lockfile`, then commit the updated lockfile                                                                                       |
| Node version error from `engine-strict`               | Switch to Node 24 LTS (`nvm use`)                                                                                                                                      |

## Documentation

- [docs/P0B-IMPLEMENTATION.md](docs/P0B-IMPLEMENTATION.md) — P0B-01 architecture decisions,
  module boundaries, deferred work.
- [docs/P0B-ACCEPTANCE.md](docs/P0B-ACCEPTANCE.md) — P0B-01 acceptance checklist with real
  command output and status (historical, not rewritten).
- [docs/P0B-02-IMPLEMENTATION.md](docs/P0B-02-IMPLEMENTATION.md) — P0B-02 domain model,
  state machines, schemas and error model.
- [docs/P0B-02-ACCEPTANCE.md](docs/P0B-02-ACCEPTANCE.md) — P0B-02 command evidence,
  B-T01–B-T04 status, risks and deferred scope.
- [docs/P0B-03-IMPLEMENTATION.md](docs/P0B-03-IMPLEMENTATION.md) — P0B-03 schema,
  transactions, canonical digest and idempotency strategy.
- [docs/P0B-03-ACCEPTANCE.md](docs/P0B-03-ACCEPTANCE.md) — P0B-03 command evidence,
  B-T06–B-T08 status, concurrency samples and risks.
- [docs/adr/0001-cancellation-and-retry-coordination.md](docs/adr/0001-cancellation-and-retry-coordination.md)
  — accepted OQ-1 cancellation/retry coordination decision.
- [docs/adr/0002-preclaim-deadline-failure.md](docs/adr/0002-preclaim-deadline-failure.md)
  — conditionally accepted OQ-2 pre-claim deadline/budget failure rule.
- [docs/P0B-04-IMPLEMENTATION.md](docs/P0B-04-IMPLEMENTATION.md) — P0B-04 lease queue,
  fencing, transaction ordering, retry policy, ADR-0002 and worker boundaries.
- [docs/P0B-04-ACCEPTANCE.md](docs/P0B-04-ACCEPTANCE.md) — P0B-04 command evidence,
  B-T09–B-T11 concurrency samples, CI and remaining risks.
