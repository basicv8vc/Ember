# Ember P0-C3A — Commitment Persistence & HTTP API Coding Agent Prompt (v0.1)

> Role: Coding Agent A / Persistence + API Engineer.
>
> Status: PROPOSED. **Do not begin implementation until CTO explicitly approves the P0-C3 doc PR, PR #43 is merged, and C3-0 contracts are frozen.**
>
> First read: docs/P0-C3-ARCHITECTURE-AND-TASK-SPEC.md. Current main SHA must be resolved at kickoff, not copied from this prompt.

## Mission

Build the **durable, tenant-scoped promise/commitment record and outcome read API** so Ember can remember a user's standing request between worker restarts. Do not implement the scheduler loop, real network connectors, AI model calls, or iOS views.

A Commitment is a durable intention; an existing Ember Task remains a single execution attempt. The HTTP API must make this distinction explicit.

## Ownership / exact edit boundary

Allowed:

- migrations/0008_p0c3_commitments.sql (new; never edit historical SQL).
- packages/contracts/src/commitment-schemas.ts and only necessary append-only exports in packages/contracts/src/index.ts.
- packages/postgres/src/repositories/commitment*.ts, packages/postgres/src/index.ts and narrowly relevant test fixtures.
- apps/api/src/commitments/** (new), and the minimum route mount/DI registration in apps/api/src/app.ts or existing app context.
- tests/unit/p0c3-commitment*.test.ts, tests/integration/p0c3-commitment*.test.ts, tests/e2e/p0c3-commitment*.test.ts.
- docs/P0C3-A-COMMITMENT-API.md.

Forbidden: apps/worker/**, packages/execution/**, packages/credentials/**, packages/connectors/**, apps/ios/**, root package manifests/lockfile, historical migrations, P0-C2 acceptance artifacts, CI, real auth middleware.

Shared-file boundary: A is the initial sole owner of contracts/index, postgres/index and apps/api/src/app.ts. Do not touch execution/index or worker/index. Record any requested change outside this set as an Integration Pass handoff.

## Build requirements

1. Schema and migration
   - Persist commitment_id, tenant_id, agent_id, bounded title, authoritative source_profile_id, active/paused/completed/cancelled, one-shot or interval schedule, next_due_at, version, timestamps.
   - Persist occurrences keyed uniquely by (commitment_id, scheduled_for) and their task_id, plus append-only outcomes mapped to occurrence/task lineage.
   - Include appropriate tenant foreign keys, state/check constraints and indexes for due scheduling and tenant-scoped retrieval. Never store a bearer token or raw OAuth secret in these tables.
   - New migration must apply twice idempotently under existing migration machinery.

2. Freeze explicit wire schemas in @ember/contracts
   - Strict Zod input/output DTOs; UUID and RFC3339 time conventions; bounded title and source_profile_id; explicit schedule vocabulary; safe pagination bounds.
   - User body cannot assert tenant_id, principal_id, worker_id, lease_epoch, internal state, generated IDs or arbitrary SQL fields.
   - Choose one conservative minimum interval (proposed >= 15 minutes in real clock). Inject a controlled clock for tests; never make real time sleeps a correctness dependency.
   - Document request/response examples and any deviation from the master spec before proceeding to implementation.

3. Authenticated HTTP facade
   - POST /v1/commitments accepts an Idempotency-Key and returns 201 on create; repeated identical submission returns the same id without another row; conflicting replay fails via the existing error contract.
   - GET list/detail/outcomes, POST pause/resume/cancel. All use only verified AuthContext; foreign-tenant and nonexistent IDs produce indistinguishable 404 responses.
   - Version/CAS for concurrent edits and explicit terminal state behavior. Cancel stops *future scheduling* without deleting previously completed Task/Outcome.
   - No new authentication modes and no exposure of internal prompt, SQL, worker, or credential details.

4. Transactional repository interface for B lane
   - Provide narrow ports: findDueCommitments(now, limit), reserveOccurrence(commitmentId, scheduledFor, expectedVersion), markDispatched(occurrenceId, taskId), appendOutcomeIfAbsent(occurrenceId, taskId, result), applyPauseOrCancel(...).
   - Ensure row locks and unique constraints prevent two schedulers from reserving the same slot.
   - Distinguish **single occurrence record** from at-least-once execution; never promise exactly-once external side effects.
   - Fail closed on stale version, expired/cancelled commitment and cross-tenant access.
   - Keep no direct import of @ember/execution or @ember/credentials in persistence layer.

## Required tests

- Unit: strict DTO acceptance/rejection including extra tenant fields; schedule bounds; state transitions; idempotency conflict; page bounds; cancellation behavior.
- PostgreSQL integration: real migration; 2 concurrent reserve attempts produce exactly 1 slot; duplicate outcome append yields 1 visible outcome; stale CAS blocked; future slot suppressed after pause/cancel; process clock vs DB clock boundary.
- E2E: authenticated POST/list/detail/pause/resume/cancel/outcomes over HTTP, tenant B resource invisibility, missing/wrong token 401, replayed idempotency 200/201 semantics per approved API contract.
- Run on real test PostgreSQL only via an isolated test schema. Do not drop historical schemas or use a non-test URL.

Mandatory quality gates (show actual exit codes): pnpm install --frozen-lockfile, pnpm format:check, pnpm lint, pnpm typecheck, pnpm build, pnpm test:unit, pnpm test:integration, pnpm test:chaos, pnpm test:e2e, pnpm demo --scenario fast. No need to run the heavy benchmark on each PR; merged-main gate owns that.

If the independent branch lacks B/C modules, use repository ports and tests to prove your own invariants. Mark full scheduler/inbox product loop NOT INTEGRATED until Gate 3.

## Done criteria

- 0 cross-tenant metadata leakage, 0 duplicate due records, 0 future dispatch reservation after committed cancellation.
- Full tenant-scoped read API returns durable state after cold restart.
- B receives frozen repository port signatures; C receives frozen source_profile_id type.
- No live source reads, provider network calls, real credentials, paid API calls or deployment.

## Delivery protocol

Use a clean dedicated worktree from the **actual post-docs-merge origin/main SHA**, feature/p0c-3a-commitment-api. Do not modify the primary checkout, force-push unrelated refs, auto-merge, or deploy.

Open Draft PR titled “feat(commitments): P0-C3A durable commitment state and API”. Include base/head full SHA, file diff, schema/transaction notes, strict test counts and exit codes, redacted evidence, interface handoffs, risk and rollback. Leave Review pending for CTO; stop on any requested scope expansion.