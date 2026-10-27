# Ember

1000 Agents. 1000 Embers. Only active agents need a flame.

Ember is a Personal Agent Platform built as a cloud control plane plus a local device agent.
A user owns one logically long-lived personal agent; expensive execution capacity is created
on demand for active work instead of renting one full VM per user. The long-term question is
whether 1,000 logical agents can be served with good responsiveness, safe isolation, and sane
cost while only active tasks consume expensive runtime.

> **Scope of this repository right now:** P0B-01 (repository foundation) only.
> Nothing here proves sandbox isolation, real LLM behaviour, or 1,000-agent production
> performance. See [P0-B status](#p0-b-status) below.

## P0-B status

| Work package | Scope                                                                                                                | Status                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **P0B-01**   | Repository foundation: Node/TypeScript/pnpm workspace, Hono API, local PostgreSQL, migration runner, tests, CI, docs | **Implemented in this PR** |
| P0B-02       | Domain types, task state machine, Zod schemas                                                                        | Not started                |
| P0B-03       | Task/Run/Event/Artifact schema, repositories, idempotent task creation                                               | Not started                |
| P0B-04       | Worker claim/lease/fencing/retry                                                                                     | Not started                |
| P0B-05       | Execution router, deterministic mock LLM, fake sandbox                                                               | Not started                |
| P0B-06       | Artifact store, workspace CAS, checkpoints                                                                           | Not started                |
| P0B-07       | Task HTTP API, tenant authZ, event log, SSE                                                                          | Not started                |
| P0B-08       | Cancellation, mock approval, budget guard                                                                            | Not started                |
| P0B-09       | Telemetry, chaos and local load tests                                                                                | Not started                |
| P0B-10       | Demo commands, results report, final review                                                                          | Not started                |

There is intentionally **no task API, no worker, no sandbox, and no business schema** yet.
`GET /healthz` returning 200 is not evidence that P0-B works end to end.

## Repository layout

```text
Ember/
  apps/
    api/                  # Hono HTTP service (app factory + Node listener)
  packages/
    postgres/             # DB config, pool factory, migration runner + CLI
  infra/
    local/
      compose.yaml        # local PostgreSQL only (loopback-bound)
      initdb/             # creates the integration-test database on first start
  migrations/             # ordered SQL migrations (infrastructure metadata only)
  tests/
    unit/                 # no database, no fixed ports
    integration/          # real PostgreSQL, unique throwaway schema per run
  docs/
    P0B-IMPLEMENTATION.md # architecture decisions and deferred boundaries
    P0B-ACCEPTANCE.md     # acceptance checklist with real command results
  .github/workflows/ci.yml
  .env.example
  package.json
  pnpm-workspace.yaml
  tsconfig*.json
```

`packages/domain` and `packages/contracts` are deliberately **not** created yet: they would
only contain empty placeholders. They arrive together with P0B-02 domain code. The rationale
is recorded in [docs/P0B-IMPLEMENTATION.md](docs/P0B-IMPLEMENTATION.md).

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
| `pnpm build`                        | `tsc -b` project-reference build (Node ESM output)           |
| `pnpm typecheck`                    | `tsc --noEmit` over apps, packages, and tests (strict)       |
| `pnpm lint`                         | ESLint flat config with type-aware TypeScript rules          |
| `pnpm format:check` / `pnpm format` | Prettier check / write                                       |
| `pnpm test:unit`                    | Unit + in-process HTTP tests, no database needed             |
| `pnpm test:integration`             | Real PostgreSQL migration tests (`TEST_DATABASE_URL`)        |
| `pnpm dev:db` / `pnpm dev:db:down`  | Start / stop the local PostgreSQL container                  |
| `pnpm db:migrate`                   | Apply pending migrations (safe to re-run)                    |

`pnpm dev` starts the API only. There is no worker process yet — the worker is P0B-04.

## Environment variables

All variables are validated with Zod at startup. Invalid values stop the process with a
message that names the variable but never echoes credentials.

| Variable                        | Default              | Purpose                                                                         |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `EMBER_ENV`                     | `local`              | `local` \| `test` \| `ci`                                                       |
| `EMBER_HOST`                    | `127.0.0.1`          | Listener address. A non-loopback host is refused unless the opt-in below is set |
| `EMBER_PORT`                    | `8787`               | Listener port (1–65535)                                                         |
| `EMBER_LOG_LEVEL`               | `info`               | `debug` \| `info` \| `warn` \| `error`                                          |
| `EMBER_ALLOW_NON_LOOPBACK_BIND` | `false`              | Must be `true` to bind anything other than loopback                             |
| `DATABASE_URL`                  | — (required)         | Application database, `postgres://…`                                            |
| `TEST_DATABASE_URL`             | — (integration only) | Database used by `pnpm test:integration`                                        |
| `EMBER_DB_POOL_MAX`             | `10`                 | Pool size (1–50)                                                                |
| `EMBER_DB_CONNECT_TIMEOUT_MS`   | `5000`               | Connection timeout                                                              |
| `EMBER_DB_IDLE_TIMEOUT_MS`      | `30000`              | Idle connection timeout                                                         |
| `EMBER_DB_STATEMENT_TIMEOUT_MS` | `10000`              | Server-side statement timeout                                                   |
| `EMBER_MIGRATIONS_DIR`          | `./migrations`       | Optional override used by the migration CLI                                     |

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
  - applied checksums are verified, so editing history fails loudly;
  - re-running is a no-op. There are no down migrations in P0.
- Only `0001_platform_metadata.sql` exists: it creates infrastructure metadata, **not** the
  P0B-03 task/run/event/artifact schema.

Integration tests create a schema named `ember_it_<random hex>`, run migrations inside it, and
drop only that schema afterwards. They never truncate or delete `public` or other schemas.

## Testing

```bash
pnpm test:unit        # 3 files, 23 tests (no database)
pnpm test:integration # 5 tests against real PostgreSQL
```

- Unit tests cover env validation (including the loopback guard), log redaction, migration
  file parsing, `/healthz` and `/readyz` over `app.request` **and** over a real loopback socket
  bound to port `0`.
- Integration tests require `TEST_DATABASE_URL`; if it is missing the suite fails instead of
  silently passing. They verify connection, first migration, repeat migration, the recorded
  version, readiness, and checksum tamper detection.

Exact results for this PR, including CI, are recorded in
[docs/P0B-ACCEPTANCE.md](docs/P0B-ACCEPTANCE.md).

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` (and manual dispatch) with:

`pnpm install --frozen-lockfile` → `lint` → `format:check` → `typecheck` → `test:unit` →
`build` → `db:migrate` (twice) → `test:integration`

It uses a temporary PostgreSQL 17 service container, `permissions: contents: read`, no
secrets, no cloud account, no deployments, and no automatic merge.

## Security and cost boundaries

- Listener defaults to loopback; public binding requires an explicit opt-in variable.
- No real LLM, sandbox provider, cloud deployment, OAuth, payments, or user data.
- Database credentials come from local env files; logs redact the password.
- No arbitrary code execution or host shell exists in this phase.
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

- [docs/P0B-IMPLEMENTATION.md](docs/P0B-IMPLEMENTATION.md) — architecture decisions, module
  boundaries, deferred work.
- [docs/P0B-ACCEPTANCE.md](docs/P0B-ACCEPTANCE.md) — P0B-01 acceptance checklist with real
  command output and status.
