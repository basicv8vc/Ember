# Ember Cloud Staging — Verification Evidence

What was actually executed for this PR, on 2026-11-06, and what it proves. Anything not
verified here is called out as such instead of being implied.

Environment: macOS (arm64) host, Docker 29.0.1, PostgreSQL 17.6, Node 24.22.1, pnpm 12.15.0.
No cloud resource was created and no shared database was touched: every database in these
runs was a container created for the run and dropped afterwards.

This revision covers the **B2 Model Execution integration**: the branch rebased onto `main`
(`f423b99`, B2 real assistant turn runtime, #124), images now ship `@ember/model-gateway`,
the schema inventory is 16 migrations (`0001`–`0016`), and a full-lifecycle HTTP E2E runs
the conversation path end to end with B2's deterministic Fake Model.

---

## 1. Images build from the lockfile

```text
$ docker build -f infra/staging/docker/Dockerfile --target api    -t ember-api:local-e2e .
$ docker build -f infra/staging/docker/Dockerfile --target worker -t ember-worker:local-e2e .

ember-api:local-e2e      373MB
ember-worker:local-e2e   372MB
```

The build installs with `pnpm install --frozen-lockfile`, runs `pnpm build`, prunes
development dependencies, and fails if `apps/api/dist/index.js`,
`apps/worker/dist/index.js`, `packages/model-gateway/dist/index.js` or
`packages/postgres/dist/cli/migrate.js` is missing. Both images run as `10001:10001`.
`@ember/model-gateway` is a workspace package resolved from its own manifest in the frozen
install; verified inside the Worker image:

```text
/app/packages/model-gateway/dist/index.js
/app/packages/model-gateway/node_modules/zod
```

## 2. The stack starts and reports healthy

The staging profile (`NODE_ENV=staging`, `EMBER_MODEL_EXECUTION=disabled`) — all four
containers:

```text
NAME                        SERVICE    STATUS                   PORTS
ember-staging-api-1         api        Up (healthy)             127.0.0.1:18787->8787/tcp
ember-staging-edge-1        edge       Up                       127.0.0.1:18080->80/tcp, 127.0.0.1:18443->443/tcp
ember-staging-postgres-1    postgres   Up (healthy)             5432/tcp
ember-staging-worker-1      worker     Up (healthy)
```

PostgreSQL publishes nothing at all; the API is reachable only on host loopback; the edge is
the single public surface. The Worker starts with `modelExecution: "disabled"` — no model
turn responder, a submitted Turn stays durably pending, which is the staging contract
until a reviewed real-model configuration exists.

The acceptance profile (`NODE_ENV=test`, `EMBER_MODEL_EXECUTION=fake`, a per-run unique
`ember-e2e-*` volume namespace and loopback-only ports) additionally proves the same
images boot with the B2 responder (`model assistant turn responder enabled`, mode `fake`)
— see §6. Every E2E run generates its own compose project name and volume prefix and
force-injects them, so a run can never address (or tear down) volumes owned by staging or
production; teardown removes only the resources that run created.

## 3. Migrations apply and are idempotent (acceptance 3)

```text
run 1:  migrations complete: 16 applied, 0 already applied
run 2:  migrations complete: 0 applied, 16 already applied
```

Both runs are the containerised migrator (`node packages/postgres/dist/cli/migrate.js`)
against PostgreSQL 17.6, with checksum verification and the advisory lock active. The
inventory is the current one: 16 files, `0001`–`0016`, including the three B2 migrations
(`0014_model_execution`, `0015_model_budget_safety`,
`0016_model_budget_incident_usage_missing`).

## 4. Smoke suite through real TLS (acceptance 4)

`smoke.sh` against `https://localhost:18443` (Caddy, internal CA), verifying the chain
rather than skipping it:

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

## 5. Worker health (a process with no socket)

Host-level report on the staging profile:

```text
worker_health=healthy
  stalled_tasks   = 0   (due > 300s, unleased)
  expired_leases  = 0
  overdue_turns   = 0
  pending_turns   = 0
  messages        = 0
  oldest_due_age  = 0s
  migrations      = 16
```

## 6. Full-lifecycle HTTP E2E with the B2 Fake Model (acceptance 1, 2, 5, 6)

`cloud-e2e.sh` drives the **real containers and the TLS edge** — not in-process fakes —
through HTTP only. 22/22 checks passed:

```text
PASS  E-1a PostgreSQL 17 starts healthy
PASS  E-1b migrations apply (16 on disk) — migrations complete: 16 applied, 0 already applied
PASS  E-1c re-run is a no-op (idempotent) — migrations complete: 0 applied, 16 already applied
PASS  E-2a api/worker/edge containers start healthy
PASS  E-2b POST /v1/auth/session issues a session token
PASS  E-3 GET /v1/me authenticates and surfaces the conversation
PASS  E-4 message accepted with a running Turn
PASS  E-5 Worker persists the Assistant reply (Fake Model) — model_label=ember-fake-model-gateway-1
PASS  E-5b Turn reaches completed with a response message — status=completed
PASS  E-6 iOS read path sees the reply over TLS — messages=2
PASS  E-9a no credential is refused (401)
PASS  E-9b forged Apple assertion is rejected — status=401
PASS  E-9c dev sign-in is unavailable on the public listener (404)
PASS  E-9d legacy dev bearer authenticates nothing (401)
PASS  E-7a message accepted while the Worker is stopped
PASS  E-7b the pending Turn stays durable while no Worker runs
PASS  E-7c a fresh Worker completes the pending Turn
PASS  E-8 conversation history readable after an API restart (same token) — messages=4
PASS  E-10a Worker runs the Model Gateway in fake mode only
PASS  E-10b environment carries no provider credential and no real mode — EMBER_MODEL_EXECUTION=fake
PASS  E-10c Worker logs show no provider endpoint
PASS  E-11 no token, message body or database password in process logs

cloud E2E: 22/22 passed
```

Read as the mission mapping:

- **User authentication (restricted, documented).** The session token comes from the real
  `POST /v1/auth/session` route on a one-shot container that binds loopback with the dev
  provider legally enabled (test markers + isolated opt-in). Every subsequent call uses
  that token through the TLS edge, exactly like an iOS session. Two limits are honest:
  an Apple assertion cannot be exchanged offline (its failure path is asserted instead,
  `401` for a forged assertion), and sign-in through the public listener is impossible by
  design (R-9: the dev provider requires a loopback listener; `404` is asserted).
- **Conversation / message / turn / reply / iOS read.** `GET /v1/me` surfaces the
  auto-provisioned conversation; `POST .../messages` returns 201 with a `running` Turn;
  the Worker claims it through the B2 model-turn chain, and the published reply arrives
  as `kind: "ember"`, `simulated: true`, `model_label: ember-fake-model-gateway-1` —
  visible through the same `GET .../messages` endpoint the iOS client reads.
- **Worker restart recovery.** A Turn submitted while the Worker container is stopped
  stays `running` and is completed by the fresh Worker process — the task is durable, not
  in-memory.
- **Real model mode off.** The Worker log reports the responder in `fake` mode only, the
  environment carries no provider credential, and no provider endpoint appears in logs.

Reproduce:

```sh
infra/staging/scripts/cloud-e2e.sh
```

Complementary durability evidence from the previous revision (`verify-durability.mjs`, 9/9
against the compiled artifacts) is unchanged and still holds.

## 7. Production-startup blockers and the dev bearer boundary (acceptance 5)

Runtime probes against the exact code in the images:

```text
REFUSED staging + fake model                 → EMBER_MODEL_EXECUTION=fake is refused in
                                              production or staging: simulated replies must
                                              never be served by a process that claims to
                                              run a live model
REFUSED staging + real model (no credential) → EMBER_MODEL_EXECUTION=real refused:
                                              model_not_approved
BOOT    staging + disabled                   → model.mode = disabled

REFUSED NODE_ENV=production (no dev tokens)  → Dev tenant bearer tokens are local-development
                                              only; refusing to load them with
                                              NODE_ENV=production
BOOT    NODE_ENV=staging + dev tokens set    → tenants: 1
BOOT    NODE_ENV=test + dev tokens (dev)     → tenants: 1
```

Reported, not fixed here (any fix touches authentication semantics and goes in a separate
PR — see `fix/runtime-production-env`, #126):

- **R-1 — API cannot boot with `NODE_ENV=production` at all.** `loadDevAuthConfig()`
  throws unconditionally on that marker, even with no dev credential configured. Staging
  runs `NODE_ENV=staging` + `EMBER_ENV=ci` as a workaround because the API `EMBER_ENV`
  enum still only accepts `local|test|ci`.
- **R-2 — legacy dev bearer tokens are refused at runtime only under
  `NODE_ENV=production`.** On `NODE_ENV=staging` the loader accepts them (probe above:
  `tenants: 1`). The deployment layer closes this: `preflight` refuses the entire
  `EMBER_DEV_AUTH_TENANT_*` set in every mode, and the smoke suite asserts `401` on the
  legacy routes. The runtime should also fail closed on every shared marker.
- **R-3 — `EMBER_MODEL_EXECUTION=fake` is refused under staging/production markers** (B2
  boundary, by design: a live-marked deployment must never serve simulated replies). This
  is why the full-lifecycle E2E runs the documented `e2e` acceptance profile
  (`NODE_ENV=test`), never the staging profile. On staging, `disabled` is the contract and
  `real` cannot boot without a reviewed approval, an invoice-verified rate and a
  credential.

## 8. Configuration guard

`preflight` refuses the shipped templates until placeholders are replaced, and evaluates
three modes: `staging`, `local` (hostname relaxation only) and `e2e` (acceptance: test
markers + Fake Model, every authentication rule unchanged). New refusals proven:

```text
E_MODEL_REAL       EMBER_MODEL_EXECUTION=real       — refused in every mode
E_MODEL_EXECUTION  EMBER_MODEL_EXECUTION=fake       — refused outside e2e mode
E_PROVIDER_SECRET  EMBER_MODEL_API_KEY              — refused in every mode
E_NODE_ENV         e2e mode + NODE_ENV=staging      — refused
```

Covered by 58 unit tests (`tests/unit/deploy`):

```text
$ pnpm exec vitest run --config vitest.unit.config.ts tests/unit/deploy
✓ tests/unit/deploy/staging-deployment-config.test.ts (58 tests)
```

## 9. Repository gates

| Gate                                                          | Result                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                              | clean                                                                                                                      |
| `pnpm format:check`                                           | clean                                                                                                                      |
| `eslint` on changed paths                                     | clean                                                                                                                      |
| `pnpm exec vitest … tests/unit/deploy`                        | 58/58                                                                                                                      |
| full unit suite                                               | 1383/1384 — the one failure is the pre-existing `local-blob-store` sandbox fs-shim issue (reproduces on unmodified `main`) |
| CI `staging-images.yml` (images + durability + lifecycle-e2e) | proven on the PR                                                                                                           |

## 10. Acceptance status

| #   | Mission item                                         | Status   | Evidence                                 |
| --- | ---------------------------------------------------- | -------- | ---------------------------------------- |
| 1   | PR #123 rebased onto latest `main`                   | **pass** | branch tip on `f423b99`, clean rebase    |
| 2   | Docker build includes `@ember/model-gateway`         | **pass** | §1 (manifest + dist + zod in image)      |
| 3   | 16 migrations incl. `0014`–`0016` apply idempotently | **pass** | §3, §6 (E-1b/E-1c)                       |
| 4   | API/Worker/PostgreSQL/Caddy start                    | **pass** | §2, §4, §6 (E-2a)                        |
| 5   | Production blockers + dev bearer boundary reported   | **pass** | §7 (R-1/R-2/R-3), fixes in a separate PR |
| 6   | Full HTTP E2E with Fake Model (auth→reply→iOS read)  | **pass** | §6 (22/22)                               |
| 7   | Worker restart recovers pending tasks                | **pass** | §6 (E-7a/b/c)                            |
| 8   | Real model mode stays off                            | **pass** | §6 (E-10a/b/c), §7 R-3 probe             |

## 11. Not verified, and why

- **ACME certificate issuance** — requires a public DNS name (not authorised).
- **A real Apple identity token exchange** — requires a device sign-in against the real
  Apple bundle id. The forged-assertion rejection and the session machinery are proven;
  the success path is the first device test once the host exists.
- **The success path of sign-in through the public listener** — impossible by design (R-9)
  until the host exists with a real Apple verifier; the E2E sign-in uses the loopback
  one-shot described in §6.
- **Behaviour under production traffic** — no load test was run; staging is a correctness
  environment first.
- **AWS-side controls** (security group, instance profile, SSM reachability) — nothing was
  created, so nothing could be tested. They are specified, not proven.
