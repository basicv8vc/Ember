# Ember Cloud Staging — integration and release contract

**Status (2026-11-10): BLOCKED.** This is the Cloudflare-first release plan and current
resource inventory. It does not authorize a Worker deployment, database migration, credential
or Secret change, DNS change, paid resource, or model call. The legacy Tunnel and its data are
out of scope for changes; the new service uses `workers.dev` and has no Tunnel dependency.

## 1. Architecture and scope

```text
iOS ── HTTPS ──> Cloudflare Worker API ── Hyperdrive ──> Neon PostgreSQL
                         │
                         └── cloud executor (required; not integrated/deployed yet)
```

The intended Staging path is Cloudflare Workers + Hyperdrive + Neon. No backend process may
run on a developer Mac. The existing single-host Docker/AWS runbooks under
`docs/CLOUD-STAGING-*` and `infra/staging/` are historical alternatives: retain them and their
data, but do not use them as the deployment path for this service. Do not delete, reroute, or
depend on the legacy Tunnel.

The API Worker and database configuration are currently supplied by Draft PR #138. The
independent executor must be supplied by the cloud-runtime work (Agent A/B or a separately
reviewed Cloudflare Queues/Workflows integration); the Node Worker on a Mac is not an
acceptable substitute.

## 2. Read-only inventory

Collected on 2026-11-10 from PR metadata, the local PR #138 checkout, and read-only Wrangler
queries. No remote resource or secret was changed.

| Resource | Observed state | Release limitation |
| --- | --- | --- |
| Worker | `ember-cloud-api`; `workers.dev` enabled; HTTPS URL `https://ember-cloud-api.10kpaper.workers.dev`; active version `1c39de72-4101-44a9-812c-ffcfce097039` at 100% traffic (deployment `de8fec42-f9b0-4d1c-bc40-b5975d211b90`, created 2026-11-08). | Wrangler reports a version ID, not a source Git SHA. The live version-to-commit mapping is unverified. No custom domain or DNS route is configured. |
| Plan | PR #138 reports Workers Free and a Free Hyperdrive configuration. | The plan/billing page was not independently verified. Recheck before release; stop before accepting an upgrade or billable add-on. |
| Worker config | PR #138 HEAD `9927263010ce8a8d078246fa0ad3b6d294f09a9a`; audience `com.basicv8vc.ember`; `EMBER_ENV=production`. | Apple audience matches the iOS bundle ID. The `production` marker is fail-closed but is inconsistent with a separately named Staging release; confirm an isolated Staging marker/config before calling this endpoint Staging. |
| Hyperdrive | `a331dbebe08c4f4e9ec7eac2d2baf5a3`; origin is Neon `ember_test` in `ap-southeast-1`, role `ember_worker`; TLS mode `require`; cache disabled; origin connection limit 5. Metadata was created/updated 2026-11-08. | Metadata confirms target and TLS setting only. It cannot prove the stored password works or that the current role has the intended memberships/grants. Revalidate after the role recreation before relying on `/readyz`. |
| Worker Secrets | `wrangler secret list --name ember-cloud-api` returned no names. PR #138 says no application Secret is needed for the API Worker. | The database credential remains inside Hyperdrive; the direct Neon migration credential is separate and must never be bound to the Worker. Secret values were not read. |
| Neon | The Hyperdrive endpoint identifies the current database target as `ember_test`. | No Neon control-plane/CLI session is available here. Current branch, compute state, role memberships, migration version/checksums, backup settings, and the Hyperdrive password cannot be independently inspected from this session. |
| Cloudflare deploy identity | The local Wrangler OAuth identity has broad write scopes, including Workers/scripts, D1, routes/KV, AI, Queues/Pipelines, Secrets Store and other account products. | This is not least privilege. Before routine release use, rotate/replace it with a dedicated account-scoped credential containing only the permissions needed for this Worker and Hyperdrive. Do not paste or log credential values. |
| Wrangler version | The API package pins Wrangler `4.158.0`; the global Homebrew binary resolves to `4.91.0`. | The global binary is stale. Install from the lockfile and use the package-local scripts for build/deploy; record the exact local version used. |
| Legacy Tunnel | No Tunnel configuration was needed or changed for the `workers.dev` service. | Preserve the existing Tunnel and its data. This release has no route dependency on it. |

### Security and schema evidence

- PR #138's role SQL creates `ember_worker` with no superuser, database/role creation,
  replication, or `BYPASSRLS` privileges, sets 5-second statement/idle-transaction timeouts,
  and grants only the B1 conversation/session/turn/nonce table access. A prior direct-login
  check reported TLS 1.3 and denied schema creation, task, and migration-table access. Those
  checks predate the current release evidence and must be repeated against the exact Neon
  branch/role before Stage 2.
- Expected schema head is migration `0017_apple_nonce_replay.sql` (migrations `0001`–`0017`).
  PR #135 reports applying all 17 migrations twice on a comparison Neon project; that does not
  prove the current Hyperdrive database is at `0017`. The runtime role cannot read migration
  records, so verify the exact version/checksums through a separate direct, unpooled migrator
  connection.
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

| PR | Current source / state | Infrastructure finding |
| --- | --- | --- |
| [#135](https://github.com/basicv8vc/Ember/pull/135) | `9ea952f66b6e26d0701f411110b225824c137b33`, OPEN/Draft | Recommends Neon and documents comparative provider checks, migrations, TLS and restore limitations. It does not establish the current deployed DB's schema or credentials. |
| [#138](https://github.com/basicv8vc/Ember/pull/138) | `9927263010ce8a8d078246fa0ad3b6d294f09a9a`, OPEN/Draft | Provides the API Worker, Hyperdrive binding and least-privilege B1 role. Its README is stale: it says the Hyperdrive ID is a placeholder and no cloud resources exist, while the config and live inventory show an active Hyperdrive and Worker. The PR's seven remote checks are limited and do not cover valid Apple sign-in, full B1 writes/ACK, tenant isolation, recovery, or asynchronous Turn completion. |
| [#139](https://github.com/basicv8vc/Ember/pull/139) | `026cd1dc367a914f1225926182cb05ba037f6bea`, OPEN/Draft | The PR body says the hosted diagnostic is not run. A later local run recorded 9 unique leases and 7 pool-acquire timeouts at pool 8/concurrency 16; integrity checks passed, but the matrix and conclusive repeat remain incomplete. The current worktree has uncommitted diagnostic edits. Do not treat this as capacity acceptance or claim 10,000-user support. |

GitHub checks for these PR heads currently fail before any workflow step ran (2–3 seconds,
zero steps in the run records). This is not a CI pass, and the legacy Docker/EC2 checks on #135
do not validate the Cloudflare deployment.

## 4. Deployment interface for Agents A/B/C

This is the proposed handoff. Confirm each row against the owning agent's exact HEAD before
deploying; no business code is changed by this infrastructure PR.

| Owner | Required handoff |
| --- | --- |
| Agent A — execution/model gate | Cloud-hosted executor entrypoint and trigger using the existing durable Turn contract. `EMBER_MODEL_EXECUTION=disabled` must create no provider client/call. Provide an observable durable disabled state and evidence that no model request was made. Do not use Fake Model in Staging. |
| Agent B — API/persistence | Exact API + migration HEAD; keep the existing B1 routes, idempotency, tenant isolation, transcript and Unknown-ACK read semantics. Specify which Turn state is expected when execution is disabled. No claim of completion from a persisted `running` row. |
| Agent C — Cloudflare API | Exact Worker/Wrangler HEAD, deployed version ID, Hyperdrive target, staging environment marker, and post-role-rotation `/readyz` evidence. Reconcile the stale README and confirm that no DNS/custom route is required. |
| Agent D — release | Pin the reviewed HEADs, apply only separately approved direct migrations/credential updates, deploy the exact cloud artifacts, run the acceptance checks below, and record SHA/version/evidence for the iOS Lead. |

The current Cloudflare API Worker exposes B1 routes and durable repositories but has no
background responder or model path. It can create a message and `running` Turn; it cannot
complete the Turn asynchronously. PR #133's Queues/Workflows PoC is not integrated/deployed.
Therefore the current system does not meet the no-Mac backend or asynchronous Turn DoD. PR
#138's API role does not grant the model budget/execution tables introduced in migrations
`0014`–`0016`; if the cloud executor needs them, provide a separate least-privilege identity and
grants rather than broadening the API role.

The HTTP acceptance contract from the current API is:

| Call | Expected result |
| --- | --- |
| `GET /healthz` | 200 liveness response. |
| `GET /readyz` | 200 only when the database readiness query succeeds. |
| `GET /v1/me` without a session | 401. |
| `POST /v1/auth/session` | Accept a valid Apple identity token for audience `com.basicv8vc.ember`; reject nonce replay. |
| `POST /v1/conversations/{conversationId}/messages` | 201 for a new submission; 200 for an identical `client_submission_id` replay. Message and durable Turn are committed atomically. |
| `GET /v1/message-submissions/{clientSubmissionId}` and `GET /v1/conversations/{conversationId}/messages` | Resolve an Unknown ACK and confirm the message is persisted. |
| `GET /v1/conversations/{conversation_id}/turns/{turn_id}` | Read the persisted Turn state. A `running` row alone is not proof of async execution. |
| Second tenant reads first tenant's submission/conversation | 404. |

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
3. **Recheck identities.** Through a direct Neon login, verify the runtime role's non-admin
   attributes, memberships and exact grants; verify TLS and 5-second timeouts. Confirm that the
   Hyperdrive origin password matches the current role without printing it. Keep the direct
   migrator credentials separate from the runtime role.
4. **Migrate only if needed.** Inspect the current migration version/checksums and backup first.
   Apply reviewed forward migrations over a direct/unpooled Neon connection only, then verify
   `0017` and checksums. Migration execution requires its own explicit approval; deployment
   never runs migrations implicitly. Do not reset, truncate, or delete Staging data.
5. **Build and deploy.** Run the repository's locked Worker dry-run (`pnpm build:api:worker`),
   inspect the generated binding/config, then run `pnpm deploy:api:worker` only after separate
   approval. Keep `workers.dev`; do not add/change a route or DNS record. Record source SHA,
   Wrangler version, deployment ID and Worker version ID. Cloudflare tracks Worker versions and
   deployments separately ([version/deployment model](https://developers.cloudflare.com/workers/versions-and-deployments/)).
6. **Verify health and identity.** Require `GET /healthz` = 200, `GET /readyz` = 200 with a
   database query, and unauthenticated `GET /v1/me` = 401. Verify Apple sessions against the
   exact audience using two disposable Apple test identities; keep tokens/nonces in memory or
   stdin only and do not print them.
7. **Verify B1 persistence and tenant boundaries.** Submit one uniquely identified synthetic
   message; expect 201 for first submission and 200 for identical idempotent replay. Read the
   submission receipt/Unknown-ACK result, transcript and durable Turn; verify a second Apple
   tenant receives 404 for the first tenant's resources. Retain smoke rows; do not delete them.
8. **Verify the cloud executor.** Confirm the Turn reaches the documented durable execution
   state through a Cloudflare-hosted queue/workflow/Worker, with no Mac process. While model
   execution is disabled, prove no provider call occurs. A completed assistant reply is outside
   the acceptance claim until the model gate, budget and one paid smoke are separately approved.
9. **Capture evidence.** Save timestamp, exact Git SHA(s), Worker deployment/version IDs, the
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

| Operation | Approval needed |
| --- | --- |
| Read-only inventory and local docs | Completed; no resource changed. |
| Deploy or roll back a Worker version | Confirm the exact source SHA and target Worker for that deployment. |
| Neon migrations, role/password changes, Hyperdrive credential update, or Worker Secret changes | Confirm each operation and the exact Staging database/Worker independently. |
| New DNS/custom hostname/route | Not part of this plan; requires explicit separate approval. |
| Paid Neon/Workers/Queues/Workflows upgrade or other billable resource | Requires explicit approval; do not auto-create. If always-on Neon compute is required, price and approve it first. |
| Enable a model/provider or perform the first real LLM E2E | CTO approval of model, exact published pricing/budget, and one paid smoke, separately from deployment approval. |

## 7. Readiness decision

**BLOCKED — not `STAGING READY`.** The existing HTTPS URL is an observed Worker URL, not an
iOS-approved Base URL yet. The blockers are: (1) no cloud asynchronous executor; (2) the
deployed Worker is labeled `EMBER_ENV=production`, with the intended Staging environment still
to be confirmed; (3) current Hyperdrive credentials, role memberships and migration head are
not verified against Neon; (4) PR #138 remains Draft and its resource README is stale; (5) no
valid Apple/B1/tenant-isolation/Turn-executor smoke has been performed; and (6) GitHub checks
have not executed workflow steps. Do not send the URL to the iOS Lead as accepted until these
gates pass.

After the gates pass, the Base URL candidate is `https://ember-cloud-api.10kpaper.workers.dev`.
Record the exact deployment SHA and acceptance evidence alongside it before marking `STAGING
READY`.
