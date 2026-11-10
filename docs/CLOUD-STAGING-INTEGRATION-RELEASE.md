# Ember Cloud Staging — integration and release contract

**Status (2026-11-10): BLOCKED.** CTO authorized starting Cloud Staging with model execution
disabled. No Worker deployment, migration, credential/Secret change, DNS change, or model call
has been performed. Workers Paid was shown active in the Cloudflare dashboard earlier today;
the current Wrangler identity cannot read billing, so the account owner must recheck plan details
before the 30-second runtime is deployed. The legacy Tunnel and its data remain untouched; the
new service uses `workers.dev` and has no Tunnel dependency.

## 1. Architecture and scope

```text
iOS ── HTTPS ──> Cloudflare Worker API ── Hyperdrive ──> Neon PostgreSQL
                         │
                         └── Cloudflare Queue → async runtime (PR #147; Draft, not deployed)
```

The intended Staging path is Cloudflare Workers + Hyperdrive + Neon. No backend process may
run on a developer Mac. The existing single-host Docker/AWS runbooks under
`docs/CLOUD-STAGING-*` and `infra/staging/` are historical alternatives: retain them and their
data, but do not use them as the deployment path for this service. Do not delete, reroute, or
depend on the legacy Tunnel.

Draft PR #146 carries the API adapter from #138 and adds the transactional outbox/Queue producer.
Draft PR #147 adds the Cloudflare Queue consumer and outbox relay. Neither is merged or deployed.
The Node Worker on a Mac is not an acceptable Staging backend.

## 2. Read-only inventory

Collected on 2026-11-10 from PR metadata, package-local Wrangler 4.158.0 read-only queries, and
the Cloudflare dashboard. No remote resource, secret, queue message, migration, or DNS record was
changed by this release review.

| Resource                   | Observed state                                                                                                                                                                                              | Release limitation                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker                     | Existing `ember-cloud-api`; URL `https://ember-cloud-api.10kpaper.workers.dev`; active version `1c39de72-4101-44a9-812c-ffcfce097039` at 100% traffic.                                                      | This is not an accepted Staging URL. Its source SHA is unknown; no custom domain/DNS route is configured.                                                                                                                                                                                                                  |
| Workers plan               | Cloudflare dashboard showed Workers Paid active earlier on 2026-11-10, consistent with Jia's upgrade report.                                                                                                | Wrangler OAuth lacks billing-read scope, so current billing/CPU entitlement could not be refreshed through CLI. Confirm the account's Paid Standard entitlement before deployment; do not add another paid resource.                                                                                                       |
| API config                 | PR #146 HEAD `81599343e853894cb26d35744206a2030aab2889`; audience `com.basicv8vc.ember`; Queue producer `ember-assistant-turns`.                                                                            | Its default config names `ember-cloud-api`, sets `EMBER_ENV=production`, and binds existing Hyperdrive `a331…`. Deploying this file would update the currently active Worker; it is not a Staging config.                                                                                                                  |
| API Hyperdrive             | `a331dbebe08c4f4e9ec7eac2d2baf5a3`; database `ember_test`, role `ember_worker`, TLS `require`, cache disabled, connection limit 5.                                                                          | This is already bound to the active API. Stored password and current role grants were not read; do not reuse it for a separately isolated Staging API without confirming the database boundary.                                                                                                                            |
| Runtime Hyperdrive         | `1af8ca2e11434f6dbaa90f4e1f640aeb` (`ember-cloudflare-free-runtime`); database `ember_test`, role `ember_free_runtime`, cache disabled, limit 20.                                                           | Metadata reports `mtls={}`; actual TLS handshake, stored password, role grants, and data isolation are unverified. The PR #147 config still has a placeholder ID.                                                                                                                                                          |
| Queues                     | `ember-assistant-turns` (`d0447576…`) and `ember-assistant-turns-dlq` (`787ba34d…`) exist. The two `ember-free-runtime-*` queues also exist.                                                                | `ember-assistant-turns` already has one producer and one consumer; its consumer is `ember-cloudflare-free-runtime-experiment`. Cloudflare currently permits one consumer per Queue. Do not attach a second consumer or deploy Fake settings into Staging.                                                                  |
| Experiment Worker          | `ember-cloudflare-free-runtime-experiment`, version `b1b42e27-516d-4341-a65f-8485979483a1` at 100%; vars are `EMBER_ENV=test`, `NODE_ENV=test`, `EMBER_MODEL_EXECUTION=fake`; it consumes both Queue pairs. | This is an existing test experiment, not the reviewed Staging runtime. Its Queue consumers must be explicitly reconciled before using those queues for Staging. No Worker Secret names were listed; Hyperdrive credentials are not exposed by that command.                                                                |
| Neon / migrations          | Both Hyperdrive configs name database `ember_test`; they point at different Neon hosts/roles. Main contains migrations through `0016`; #146 adds `0017` and `0018`; #145 adds `0019`.                       | No direct Neon migration credential/session is available. Current remote migration rows/checksums, password rotation, TLS handshake, grants, backup state, and which Neon branch is isolated for Staging remain unverified. PR #146 reports `0017` present and `0018` unapplied; that is not an independent current query. |
| Cloudflare deploy identity | `wrangler whoami` succeeds; OAuth has broad Workers/scripts/Queues write and other account scopes.                                                                                                          | It is not least privilege and has no billing-read. No `CLOUDFLARE_API_TOKEN` or Neon migration credential is present in the shell. Do not log or transfer credential values.                                                                                                                                               |
| Wrangler version           | Package-local Wrangler `4.158.0` was used for the build dry-runs; global Wrangler is `4.91.0`.                                                                                                              | Use the package-local pinned version for release commands and record it.                                                                                                                                                                                                                                                   |
| Legacy Tunnel              | No Tunnel configuration was needed or changed for the `workers.dev` service.                                                                                                                                | Preserve the existing Tunnel and its data. This release has no route dependency on it.                                                                                                                                                                                                                                     |

### Security and schema evidence

- PR #138's role SQL creates `ember_worker` with no superuser, database/role creation,
  replication, or `BYPASSRLS` privileges, sets 5-second statement/idle-transaction timeouts,
  and grants only the B1 conversation/session/turn/nonce table access. A prior direct-login
  check reported TLS 1.3 and denied schema creation, task, and migration-table access. Those
  checks predate the current release evidence and must be repeated against the exact Neon
  branch/role before Stage 2.
- Merge/deployment migration order is `0017_apple_nonce_replay.sql`, then `0018_b1_turn_dispatch_outbox.sql`.
  Keep one copy of `0018` when #146 and #147 are integrated. `0019_model_openrouter_provider.sql`
  exists only in #145 and is not required for the first disabled deployment; apply it only with
  the OpenRouter integration and separately approved model smoke. PR #135's migration result is
  for a comparison Neon project, not this target.
- Check current migration IDs and checksums through an authorized direct, unpooled migrator
  connection. That credential is not available in this session, so no migration was run.
- Hyperdrive uses transaction pooling. Keep migrations on the direct Neon connection; do not
  route the migration runner through Hyperdrive. Cloudflare documents the transaction-pooling
  constraints [here](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/).
- PR #135 reports Neon Free's limited history/backup posture. Before any real-user data, require
  an approved backup plan and a successful restore drill. No Staging data may be reset or
  deleted as part of smoke testing.
- PR #135 also observed Neon Free compute scale-to-zero; the L4-D run saw cold-connect wakeups
  around 90–100 seconds. This is not an always-warm latency guarantee. If the Staging availability
  target requires warm compute, obtain separate approval for a paid plan before changing it.

## 3. PR and CI review

| PR                                                  | Current source / state                                 | Infrastructure finding                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#135](https://github.com/basicv8vc/Ember/pull/135) | `9ea952f66b6e26d0701f411110b225824c137b33`, OPEN/Draft | Recommends Neon and documents comparative provider checks, migrations, TLS and restore limitations. It does not establish the current deployed DB's schema or credentials.                                                                                                                                                                                         |
| [#138](https://github.com/basicv8vc/Ember/pull/138) | `9927263010ce8a8d078246fa0ad3b6d294f09a9a`, OPEN/Draft | Predecessor API adapter, carried into #146. Do not merge independently with #146 without checking overlap.                                                                                                                                                                                                                                                         |
| [#139](https://github.com/basicv8vc/Ember/pull/139) | `026cd1dc367a914f1225926182cb05ba037f6bea`, OPEN/Draft | The PR body says the hosted diagnostic is not run. A later local run recorded 9 unique leases and 7 pool-acquire timeouts at pool 8/concurrency 16; integrity checks passed, but the matrix and conclusive repeat remain incomplete. The current worktree has uncommitted diagnostic edits. Do not treat this as capacity acceptance or claim 10,000-user support. |
| [#146](https://github.com/basicv8vc/Ember/pull/146) | `81599343e853894cb26d35744206a2030aab2889`, OPEN/Draft | Integrates the API adapter, `0017`, `0018`, and transactional outbox. Merge/review first after replacing its production-named deploy target with an isolated Staging config.                                                                                                                                                                                       |
| [#147](https://github.com/basicv8vc/Ember/pull/147) | `b9383cb326d08ad180017d3566772c62ffa2e25f`, OPEN/Draft | Depends on #146; adds Queue runtime and a second copy of `0018`. Rebase after #146, drop duplicate migration, use Staging marker and a real runtime Hyperdrive ID; its checked-in model mode is `disabled`.                                                                                                                                                        |
| [#145](https://github.com/basicv8vc/Ember/pull/145) | `af889718fb0e65b699ed583633d85ca3cdc67dce`, OPEN/Draft | Adds OpenRouter and migration `0019`. Keep separate from first Staging deployment; no model/provider/budget or paid smoke approval has been given.                                                                                                                                                                                                                 |

GitHub checks for #145–#147 currently fail before any workflow step ran (2–3 seconds, zero steps
in the run records). This is not a CI pass. The local #147 runtime unit suite passed 9/9, its
TypeScript build passed, and both Worker dry-runs bundled, but dry-run does not contact Cloudflare
or Neon. The full Fake Model E2E was not run because Docker is unavailable on this Mac.

## 4. Deployment interface for Agents A/B/C

This is the proposed handoff. Confirm each row against the owning agent's exact HEAD before
deploying; no business code is changed by this infrastructure PR.

| Owner                       | Required handoff                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent A — API (#146)        | Exact API/migration HEAD; keep B1 idempotency, tenant isolation, transcript and Unknown-ACK semantics. Provide a separately named Staging Worker config and the Apple audience `com.basicv8vc.ember`. |
| Agent B — runtime (#147)    | Rebase after #146, retain one `0018`, use a dedicated runtime identity/Hyperdrive, and specify how the existing Queue consumer is safely transferred or isolated. Keep model execution `disabled`.    |
| Agent C — model gate (#145) | Keep the OpenRouter adapter and `0019` separate until model, exact budget and one paid smoke are approved by the CTO. No provider call is authorized now.                                             |
| Agent D — release           | Pin exact clean SHAs, verify direct Neon migrations/roles, deploy only isolated Staging Worker names, run remote acceptance and give the accepted URL/SHA/evidence to the iOS Lead.                   |

The currently deployed API version predates #146 and has no Queue producer/outbox path. The
existing experiment consumer is configured for `test`/`fake`; it is not the reviewed #147
runtime. PR #147's disabled mode ACKs queue delivery but leaves the durable Turn pending; a
pending `running` row is not a completed assistant response. Keep the API identity separate from
the executor identity and verify the executor's required grants before deployment.

The HTTP acceptance contract from the current API is:

| Call                                                                                                     | Expected result                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                                                           | 200 liveness response.                                                                                                           |
| `GET /readyz`                                                                                            | 200 only when the database readiness query succeeds.                                                                             |
| `GET /v1/me` without a session                                                                           | 401.                                                                                                                             |
| `POST /v1/auth/session`                                                                                  | Accept a valid Apple identity token for audience `com.basicv8vc.ember`; reject nonce replay.                                     |
| `POST /v1/conversations/{conversationId}/messages`                                                       | 201 for a new submission; 200 for an identical `client_submission_id` replay. Message and durable Turn are committed atomically. |
| `GET /v1/message-submissions/{clientSubmissionId}` and `GET /v1/conversations/{conversationId}/messages` | Resolve an Unknown ACK and confirm the message is persisted.                                                                     |
| `GET /v1/conversations/{conversation_id}/turns/{turn_id}`                                                | Read the persisted Turn state. A `running` row alone is not proof of async execution.                                            |
| Second tenant reads first tenant's submission/conversation                                               | 404.                                                                                                                             |

The API does not currently promise an assistant completion when model execution is disabled.
Agent A must define the durable disabled-state and executor-trigger behavior before the Turn
acceptance is considered complete.

## 5. Repeatable release procedure

Run this only after the integration inputs above are complete and the required operation has
its separate approval.

1. **Pin the input.** Record the exact clean Git SHAs for API, executor and migrations. Install
   with `pnpm install --frozen-lockfile`; use the API package's pinned Wrangler rather than the
   global binary. Cloudflare recommends a project-local Wrangler so teams use the same version
   ([installation guidance](https://developers.cloudflare.com/workers/wrangler/install-and-update/)).
2. **Preflight config.** Confirm a Staging-only Worker/config, `EMBER_ENV=staging`, Apple
   audience `com.basicv8vc.ember`, no custom DNS route, no provider key, and model execution
   `disabled` for every deployed executor. Confirm plan and resource limits before proceeding.
3. **Resolve the Queue target.** Read the current message/backlog counts and confirm the active
   consumer. The existing primary Queue has one consumer (`ember-cloudflare-free-runtime-experiment`);
   do not configure another consumer. Approve a controlled consumer transfer or choose an isolated
   Staging Queue before deployment; preserve existing messages and DLQ data.
4. **Recheck identities.** Through a direct Neon login, verify the runtime role's non-admin
   attributes, memberships and exact grants; verify TLS and 5-second timeouts. Confirm that the
   Hyperdrive origin password matches the current role without printing it. Keep the direct
   migrator credentials separate from the runtime role.
5. **Migrate only if needed.** Inspect current migration IDs/checksums and backup first. Apply
   `0017` then `0018` over the direct/unpooled Neon connection using the authorized migrator; retain
   one migration record per file and verify checksums afterward. Defer `0019` until the model PR is
   approved. No migration credential is currently available. Never reset or delete Staging data.
6. **Build and deploy.** Use a new Staging API Worker name and `EMBER_ENV=staging`; never run
   #146's default `ember-cloud-api`/`production` config against the current Worker. Use the
   package-local Wrangler dry-run, inspect bindings, then deploy API and runtime only after the
   database and Queue gates pass. Keep `workers.dev`; do not add/change a route or DNS record.
   Record source SHA,
   Wrangler version, deployment ID and Worker version ID. Cloudflare tracks Worker versions and
   deployments separately ([version/deployment model](https://developers.cloudflare.com/workers/versions-and-deployments/)).
7. **Verify health and identity.** Require `GET /healthz` = 200, `GET /readyz` = 200 with a
   database query, and unauthenticated `GET /v1/me` = 401. Verify Apple sessions against the
   exact audience using two disposable Apple test identities; keep tokens/nonces in memory or
   stdin only and do not print them.
8. **Verify B1 persistence and tenant boundaries.** Submit one uniquely identified synthetic
   message; expect 201 for first submission and 200 for identical idempotent replay. Read the
   submission receipt/Unknown-ACK result, transcript and durable Turn; verify a second Apple
   tenant receives 404 for the first tenant's resources. Retain smoke rows; do not delete them.
9. **Verify the cloud runtime.** Confirm the Turn's durable state through the Cloudflare Queue
   and PostgreSQL executor with no Mac process. In this first release execution stays disabled,
   so no assistant reply is expected. Run a Fake Model E2E only in a separate isolated test
   namespace; do not set Fake on Staging. This Mac currently lacks Docker, so that local E2E is
   not verified either.
10. **Capture evidence.** Save timestamp, exact Git SHA(s), Worker deployment/version IDs, the
    HTTPS Base URL, migration head/checksums, and sanitized request/status results. Never include
    connection strings, passwords, Apple tokens/nonces, or provider keys.

### Rollback

Before deployment, record the current active Worker version. If the new version fails health or
smoke checks, the release operator may roll back to that specific version using
`wrangler rollback <version-id>` or the Cloudflare dashboard. Cloudflare's rollback creates a
new deployment of the selected version and does not change Hyperdrive/database resources
([rollback procedure](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)).
Run the health smoke again after rollback. Database schema is forward-only; roll back code only
when that version remains compatible with the current schema. Rollback is a remote deployment
and requires its own authorization.

## 6. Separate approval boundaries

| Operation                                                                                      | Approval needed                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Read-only inventory and local docs                                                             | Completed; no resource changed.                                                                                    |
| Deploy or roll back a Worker version                                                           | Confirm the exact source SHA and target Worker for that deployment.                                                |
| Neon migrations, role/password changes, Hyperdrive credential update, or Worker Secret changes | Confirm each operation and the exact Staging database/Worker independently.                                        |
| New DNS/custom hostname/route                                                                  | Not part of this plan; requires explicit separate approval.                                                        |
| Paid Neon/Workers/Queues/Workflows upgrade or other billable resource                          | Requires explicit approval; do not auto-create. If always-on Neon compute is required, price and approve it first. |
| Enable a model/provider or perform the first real LLM E2E                                      | CTO approval of model, exact published pricing/budget, and one paid smoke, separately from deployment approval.    |

## 7. Readiness decision

**BLOCKED — not `STAGING READY`.** No Staging deployment URL or deployment SHA exists. The
known `https://ember-cloud-api.10kpaper.workers.dev` endpoint belongs to the existing active
Worker and is not approved for iOS Staging traffic. Blockers: (1) #146/#147/#145 remain Draft;
#146's default config would update the current Worker; #147 has a placeholder Hyperdrive ID; (2)
the primary Queue already has the Fake experiment as its single consumer, and backlog/message
state has not been read in this pass; (3) no authorized Neon migrator credential is available to
verify/apply `0017`/`0018`, and `0019` belongs to the not-yet-approved model PR; (4) runtime role
grants, Hyperdrive password and TLS handshake are unverified; (5) GitHub jobs failed before any
workflow step, and the full local Fake E2E cannot run without Docker; (6) no Staging health,
Apple-auth, database, Queue or Turn persistence smoke has been performed. Do not send the
existing URL to the iOS Lead as an accepted Base URL.
