# Ember Cloud Staging — Verification Evidence

What was actually executed for this PR, on 2026-11-06, and what it proves. Anything not
verified here is called out as such instead of being implied.

Environment: macOS (arm64) host, Docker 29.0.1, PostgreSQL 17.6, Node 24.22.1, pnpm 12.15.0.
No cloud resource was created and no shared database was touched: every database in these
runs was a container created for the run and dropped afterwards.

---

## 1. Images build from the lockfile

```text
$ docker build -f infra/staging/docker/Dockerfile --target api    -t ember-api:local-verify    .
$ docker build -f infra/staging/docker/Dockerfile --target worker -t ember-worker:local-verify .

ember-api:local-verify      372MB
ember-worker:local-verify   371MB
```

The build installs with `pnpm install --frozen-lockfile`, runs `pnpm build`, prunes
development dependencies, and fails if `apps/api/dist/index.js`,
`apps/worker/dist/index.js` or `packages/postgres/dist/cli/migrate.js` is missing. Both
images run as `10001:10001`.

## 2. The stack starts and reports healthy

```text
$ docker compose --env-file /tmp/ember-staging-verify.env -f infra/staging/compose.yaml up -d --wait

NAME                        SERVICE    STATUS                   PORTS
ember-staging-api-1         api        Up (healthy)             127.0.0.1:18787->8787/tcp
ember-staging-edge-1        edge       Up                       127.0.0.1:18080->80/tcp, 127.0.0.1:18443->443/tcp
ember-staging-postgres-1    postgres   Up (healthy)             5432/tcp
ember-staging-worker-1      worker     Up (healthy)
```

Note the `PORTS` column: PostgreSQL publishes nothing at all, and the API is reachable only on
host loopback. The edge is the single public surface.

Startup logs (abridged, verbatim):

```json
{"level":"info","message":"api listening","service":"ember-api","env":"ci","host":"0.0.0.0","port":8787,
 "database":{"host":"postgres","port":5432,"database":"ember"}}
{"level":"warn","message":"no dev tenant credentials configured; every /v1 request will be rejected"}
{"level":"info","service":"ember-worker","message":"worker starting","mode":"poll","env":"ci",
 "simulatedExecution":"local-only","b1FakeResponderEnabled":false,"durableExecution":true,
 "schedulerEnabled":false,"consentReady":true,"claimableTasks":["mock.chat","mock.compute","mock.file","mock.approval"]}
```

`no dev tenant credentials configured` is the desired line: no legacy bearer token can
authenticate anything.

## 3. Migrations apply and are idempotent (acceptance 4)

```text
run 1:  migrations complete: 13 applied, 0 already applied
run 2:  migrations complete: 0 applied, 13 already applied
```

Both runs are the containerised migrator (`node packages/postgres/dist/cli/migrate.js`) against
PostgreSQL 17.6, with checksum verification and the advisory lock active. The inventory is the
current one (13 files, `0001`–`0013`).

## 4. Smoke suite through real TLS (acceptance 1, 2, 3, 7, 8, 10)

`smoke.sh` against `https://localhost:18443` (Caddy, internal CA), verifying the chain rather
than skipping it:

```text
PASS  liveness /healthz                              HTTP 200
PASS  liveness reports ok                            contains "status":"ok"
PASS  readiness /readyz (PostgreSQL 17)              HTTP 200
PASS  readiness reports ready                        contains "status":"ready"
PASS  dev sign-in refused                            HTTP 404
PASS  forged Apple assertion refused                 HTTP 401
PASS  /v1/me without credentials                     HTTP 401
PASS  /v1/me with forged session token               HTTP 401
PASS  legacy dev bearer refused (/v1/agents)         HTTP 401
PASS  legacy dev bearer refused (/v1/tasks)          HTTP 401
PASS  unknown route                                  HTTP 404
PASS  unknown route uses ErrorResponse               contains "error"
PASS  edge hides server identity                     no Server header
PASS  edge sends HSTS                                HSTS present

smoke: 14 passed, 0 failed
```

The two negative authentication results are the important ones: the development sign-in route
does not exist on this deployment, and a forged Apple assertion is refused rather than failing
open.

## 5. Worker health (a process with no socket)

Container healthcheck, executed inside the image:

```json
{ "status": "healthy", "stalled_tasks": 0, "expired_leases": 0, "migrations": 13 }
```

Host-level report:

```text
worker_health=healthy
  stalled_tasks   = 0   (due > 300s, unleased)
  expired_leases  = 0
  overdue_turns   = 0
  pending_turns   = 0
  messages        = 0
  oldest_due_age  = 0s
  migrations      = 13
```

## 6. Restart behaviour (acceptance 5, 6, 9)

Restarting both application containers left every durable table untouched:

```text
BEFORE: 13|0|0|0|0|0      (schema_migrations|tenants|conversations|messages|turns|sessions)
AFTER : 13|0|0|0|0|0
api     Up 29 seconds (healthy)
worker  Up 29 seconds (healthy)
```

Row counts on an empty database are weak evidence, so the real check drives traffic.
`verify-durability.mjs` runs the **compiled artifacts the images run** (`apps/api/dist`,
`apps/worker/dist`) as real processes against a real PostgreSQL 17 database, and asserts:

```text
PASS  migrations apply to a fresh database — ember_staging_durability
PASS  message accepted with no Worker running — turn cde6f224-7d4a-4c9a-9f2d-9f2a639f7c20
PASS  API restarted — SIGTERM then fresh process
PASS  A-6 conversation history readable after API restart
PASS  A-5 pending Turn persisted across the restart — status=running
PASS  A-5 fresh Worker recovered and completed the pending Turn — status=completed
PASS  A-5 Worker restarted cleanly and stayed healthy
PASS  A-6 assistant reply persisted in the transcript
PASS  A-9 no credential or private body in process logs — 28 log lines scanned

9/9 checks passed
```

Read as the acceptance mapping:

- **5.** A Turn submitted with no Worker running is durably stored, still `running` after an
  API restart, and completed by a Worker that starts afterwards. A Worker restart mid-life is
  clean.
- **6.** The transcript is read with a session token minted _before_ the restart, proving both
  the history and the token survive.
- **9.** The log scan looks for the session token, the provider assertion, the nonce, the
  message body and the database password across every process lifetime. None appeared.

Reproduce:

```sh
node infra/staging/scripts/verify-durability.mjs \
  --admin-database-url postgres://ember:<password>@127.0.0.1:55433/ember_staging_verify
```

## 7. Configuration guard

`preflight` refuses the shipped template, which is the intended behaviour:

```text
[violation] E_PLACEHOLDER_VALUE DATABASE_URL: still contains a template placeholder
[violation] E_EDGE_HOSTNAME EMBER_STAGING_HOSTNAME: must be the real public DNS name
```

and accepts the resolved environment and the local verification profile:

```text
preflight guard v1 (local) — /tmp/ember-staging-verify.env
[ok] 0 warning(s), no violations
preflight passed
```

The guard is covered by 47 unit tests that assert each refusal (dev provider, dev tenant
tokens, fake responder, `NODE_ENV=production`, debug logging, public database host, `shua`
reference, provider credentials, TLS bypass, placeholder values) **and** that `--mode=local`
relaxes hostnames only.

```text
$ pnpm exec vitest run --config vitest.unit.config.ts tests/unit/deploy
✓ tests/unit/deploy/staging-deployment-config.test.ts (47 tests)
```

## 8. Repository gates

| Gate                          | Result                                                 |
| ----------------------------- | ------------------------------------------------------ |
| `pnpm typecheck`              | clean                                                  |
| `pnpm format:check`           | clean                                                  |
| `eslint` on changed paths     | clean                                                  |
| `pnpm test:unit` (full suite) | 1300 passed, 2 failed — both environmental (see below) |

The two failures are unrelated to this PR and reproduce the local sandbox's file-system shim:
`tests/unit/local-blob-store.test.ts` cannot call `link()` ("Brokered link refused"), and
`tests/unit/test-registration-guard.test.ts` times out at 5 s while walking the repository.
Neither file is touched by this PR.

`pnpm test:e2e` (the B1 process suite) could not be executed in this sandbox: it spawns the API
through `tsx`, whose cold start here is 7–18 s, exceeding the suite's own 15 s API-start
budget. That is why §6 uses `verify-durability.mjs` against the compiled artifacts instead —
the same code path the images execute, without a TypeScript loader.

## 9. Acceptance status

| #   | Criterion                                       | Status      | Evidence                                                                                                                                                                                                    |
| --- | ----------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API container starts                            | **pass**    | §2, healthcheck `healthy`                                                                                                                                                                                   |
| 2   | Worker container starts                         | **pass**    | §2, §5                                                                                                                                                                                                      |
| 3   | PostgreSQL 17 connects                          | **pass**    | §2 `/readyz` ready, §3 migrations                                                                                                                                                                           |
| 4   | 13 migrations apply and re-run idempotently     | **pass**    | §3                                                                                                                                                                                                          |
| 5   | Worker restart loses no pending Turn            | **pass**    | §6 (A-5)                                                                                                                                                                                                    |
| 6   | Conversation history readable after API restart | **pass**    | §6 (A-6)                                                                                                                                                                                                    |
| 7   | Real authentication path available              | **partial** | Apple verification is mounted and rejects a forged assertion with 401 (§4). Proving the _success_ path needs a real Apple identity token from a device; that is the first device test once the host exists. |
| 8   | No development identity bypass                  | **pass**    | §4 (`404` for `provider:"dev"`, `401` for legacy bearer), §7                                                                                                                                                |
| 9   | Configuration and log redaction                 | **pass**    | §6 (A-9), §7                                                                                                                                                                                                |
| 10  | Ready for public HTTPS integration              | **partial** | TLS termination, HSTS, header hiding and proxying verified with a private CA (§4). ACME issuance needs a real hostname and DNS record, which this task does not authorise.                                  |

## 10. Not verified, and why

- **ACME certificate issuance** — requires a public DNS name (not authorised).
- **A real Apple identity token exchange** — requires a device sign-in against the real Apple
  bundle id.
- **Behaviour under production traffic** — no load test was run; staging is a correctness
  environment first.
- **AWS-side controls** (security group, instance profile, SSM reachability) — nothing was
  created, so nothing could be tested. They are specified, not proven.
