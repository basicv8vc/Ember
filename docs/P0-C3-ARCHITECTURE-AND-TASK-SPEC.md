# Ember P0-C3 — Persistent Promise Loop: Architecture & Task Spec (v0.1)

> Status: **PROPOSED — CTO review required; no coding authorization yet.**
>
> Owner: Ember CTO (backend/platform). iOS implementation remains delegated to iOS Lead.
>
> Reference repository: basicv8vc/Ember. Resolve the **actual origin/main SHA at coding kickoff**. The P0-C2 evidence PR #43 must be merged and confirmed before any P0-C3 implementation worktree is created.
>
> P0-C2 evidence boundary: composition-root Credential Broker wiring is present, runtime credential execution and real network egress are **not implemented**. A local single-run benchmark is **not** production SLA proof.

## 1. Outcome, not infrastructure for its own sake

North-star promise: **Ember remembers something it agreed to do, safely resumes it without repeated user prompts, and shows honest progress and a result in the iOS Inbox.**

P0-C3 reference story: “Keep an eye on a topic I care about and let me know when something meaningful changes.” The initial implementation uses deterministic, non-sensitive fixture snapshots. A narrowly allowlisted, read-only public-source pilot may be prepared behind a disabled-by-default feature gate; **activating real outbound traffic requires separate CTO security approval**.

The core user loop is:

1. User creates a persistent commitment (title, bounded schedule, source profile).
2. Cloud scheduler finds a due occurrence and durably creates an existing Ember Task.
3. Worker processes the occurrence through authoritative Sentinel, budget, lease, and checkpoint guards.
4. A minimal, non-sensitive outcome and audit event are stored; a user can fetch them in the Inbox.
5. User can pause, resume, or cancel the commitment; the system never runs a cancelled future occurrence.

Cloud operation must not depend on a user's Mac. A future Mac app is optional execution capacity. iOS M2 remains mock-first; P0-C3 must not modify iOS code or assume APNs, physical devices, or production accounts.

## 2. Existing components to reuse

- Authenticated tenant-scoped API middleware and the existing HTTP error mapping in apps/api.
- Durable Task and Run queue, PostgreSQL leases, fencing epochs, reaper, checkpoints, workspace CAS, task events and cancellation.
- The P0-C2 Sentinel gate in both Worker handlers. A new task kind is **not** added merely to bypass the closed action matrix.
- Budget Guard and persistent budget accounting; zero reservation before an admission denial.
- Provider-neutral SandboxAdapter and FakeSandboxProviderFactory, with honest UNKNOWN leak status.
- The P0-C2 CredentialBroker and PostgresRunExecutionContextReader interfaces. Do not claim production credential usage.

A commitment is **long-lived intent**; a Task is **one execution occurrence**. Never conflate their statuses or claim exactly-once external effects.

## 3. Contract freeze proposal (C3-0)

Lane A is the sole initial owner of the shared TypeScript contract; B and C consume it only after the freeze, or code against private structural ports without modifying shared files. Suggested minimal shape:

~~~text
Commitment:
  commitment_id, tenant_id, agent_id, title,
  status (active|paused|completed|cancelled),
  schedule_kind (once|interval), interval_seconds?, next_due_at?,
  source_profile_id, version, created_at, updated_at

CommitmentOccurrence:
  occurrence_id, commitment_id, scheduled_for, task_id?,
  status (pending|dispatched|completed|failed|cancelled),
  created_at, updated_at

SourceSnapshot:
  source_profile_id, observed_at, digest, bounded_safe_items

CommitmentOutcome:
  commitment_id, occurrence_id, task_id, summary,
  result_status, created_at
~~~

Internal persistence can use more columns but may not leak them into wire DTOs. IDs are server generated; the tenant is always from authenticated server context. Human-provided text is bounded and sanitized in audit/logs. Source snapshots and summaries must not carry credential strings or raw provider errors.

Suggested HTTP surface (exact wire schemas to be frozen in C3-0 before parallel coding):

| Operation | Route | Contract |
| :-- | :-- | :-- |
| Create | POST /v1/commitments | 201 created; validated body and Idempotency-Key |
| List | GET /v1/commitments | tenant-scoped, cursor/pagination bounded |
| Detail | GET /v1/commitments/:id | 200 own resource, uniform 404 otherwise |
| Pause/resume | POST /v1/commitments/:id/pause or /resume | optimistic version; idempotent, server-authoritative |
| Cancel | POST /v1/commitments/:id/cancel | stop future dispatch; do not erase completed history |
| Outcomes | GET /v1/commitments/:id/outcomes | ordered, paginated, tenant-scoped |

Existing Task receipt, Task detail, event-page and SSE APIs remain unchanged. **Do not silently revise iOS B0 TaskRepositoryProtocol, existing task schemas, or enum spellings.** A future iOS commitment repository is a separate iOS Lead-reviewed contract.

## 4. Durable scheduling invariants

- Use PostgreSQL as authoritative clock and durable source of truth; virtual/controlled clocks only in tests.
- Implement one-shot and bounded interval schedules, not arbitrary user-supplied cron or sub-minute unbounded polling. Production minimum interval proposal: 15 minutes, subject to CTO review.
- A unique occurrence identity (commitment_id, scheduled_for) and transactional claim prevents duplicate **dispatch records**. At-least-once work may re-run after crashes; no false exactly-once guarantee for external side effects.
- Claim uses lease/row locks and fencing; reaper can recover missed/expired work. A stale worker cannot publish or advance the commitment.
- Pause/cancel checks are repeated immediately before dispatch and publication. Already-committed outcomes remain visible; no future work executes after a committed cancel.
- Repeated scheduler ticks, process SIGKILL, concurrent schedulers and DB reconnect cannot create two visible outcomes for the same occurrence.
- Every due occurrence has an attributable task/run/event trail, with explicit failure and retry status. No fabricated success.

## 5. Execution and source safety

- Default execution path is deterministic Fake-only with zero paid cloud spend, zero real credentials, zero outbound sockets, and no vendor SDK.
- Sentinel hard-denies network.egress, host.exec and credential.use in the current release. **No lane may weaken these defaults** to achieve a demo. A future read-only exception requires a dedicated reviewed policy gate and an explicit activation decision.
- Read-only public-source fixtures are untrusted content, **never instructions**. Prompt injection, HTML, URLs and metadata from a source must not override system policies or request secrets.
- Any future live HTTP reader must be host allowlisted, HTTPS-only, bounded in response bytes/time/redirects, resistant to SSRF/private IP and DNS rebinding, and use no user credentials. It stays disabled until separate approval.
- Users can see the non-secret source profile associated with a commitment and pause/cancel it. Fake consent revocation must fail closed during retries; durable OAuth grant storage/revocation is future work and must not be claimed as implemented.
- Neither test logs nor user-facing events may contain raw prompts, access tokens, credential refs, SQL connection strings, full URLs with sensitive paths/query, or provider exception messages.
- Real Gmail/GitHub private OAuth, secret vault persistence, production LLM API consumption, APNs and external mutating actions are **out of scope** without later authorization.

## 6. Three coding lanes and shared-file ownership

| Lane | Exclusive initial scope | Product deliverable |
| :-- | :-- | :-- |
| C3A — Commitment Persistence & API | migrations/0008*; packages/postgres commitment repositories; packages/contracts commitment DTOs; apps/api/src/commitments; related API mount only | Durable tenant-scoped commitment CRUD, occurrence/ outcome storage, idempotency |
| C3B — Scheduler & Outcome Runtime | packages/execution/src/commitment-*; apps/worker/src/commitment-*; related tests | Due-work dispatch and deterministic processing through existing controls |
| C3C — Source & Consent Boundary | packages/connectors/** (new); tests/unit/p0c3-source-*; docs/P0C3-C-*; narrowly allocated root package references | Fake source snapshots, strict read-only source-policy interface, permissions/revocation and zero-network proof |

**Shared owner / integration window:** packages/contracts/index and packages/postgres/index belong to A. packages/execution/index and apps/worker/** belong to B. Root tsconfig, unit Vitest config, pnpm-lock.yaml and any new package manifest wiring belong to C. apps/api/src/app.ts belongs to A. If a required edit crosses ownership, stop and describe a small Integration Pass change rather than editing another lane's file.

No lane may touch apps/ios/**, historical migrations, P0-C2 acceptance artifacts, production auth middleware, production cloud deployment config, or environment secrets.

## 7. Release sequence and acceptance gates

- **Gate 0 — Archive:** PR #43 actually merged; latest origin/main and resulting main-push CI recorded.
- **Gate 1 — C3-0 contract freeze:** a short docs/contract agreement is reviewed; no parallel code that imports nonexistent shared interfaces.
- **Gate 2 — Parallel A/B/C:** independent clean Git worktrees from frozen SHA; Draft PR each; no auto-merge.
- **Gate 3 — Integration Pass:** cherry-pick/merge in dependency order chosen by CTO, then wire scheduler → Task → guarded Worker → outcome API. No autonomous production scheduling or external egress enabled.
- **Gate 4 — Merged-main verification:** lint, format, typecheck, build, unit, PostgreSQL integration, chaos/SIGKILL, E2E, 4 demos, local sandbox smoke, isolated benchmark regression and source/audit redaction tests.

Minimum new evidence matrix:

| ID | Test | DoD |
| :-- | :-- | :-- |
| C3-T01 | Create/list/detail | Tenant isolation, bounded inputs, idempotent 201/replay |
| C3-T02 | Two schedulers racing | Exactly one occurrence/dispatch record per due slot |
| C3-T03 | Pause/cancel race | No future occurrence after committed pause/cancel |
| C3-T04 | SIGKILL/reaper | Resume without duplicate visible outcome; stale lease rejected |
| C3-T05 | Sentinel deny / budget | No source callback or new budget reservation on deny |
| C3-T06 | Source-policy & revoke | Revoked/unknown source fails closed; no network in default tests |
| C3-T07 | API to Inbox contract | Outcome pagination/order and Task link remain stable |
| C3-T08 | Reconciliation | Every outcome maps to one persisted occurrence and task lineage |

**Acceptance labels:** Promise-loop Fake Integration may be PASS; real live source fetching, real LLM reasoning, actual credential execution, APNs delivery, multi-day soak and production SLA remain NOT IMPLEMENTED / NOT VERIFIED. Do not collapse these into one marketing PASS.

## 8. PR delivery convention

Each Coding Agent must submit a Draft PR with: base and head full SHA; exact changed files and forbidden-path check; design tradeoffs; test command, exit code and pass counts; known limitations; data/cost/network attestations; rollback plan; integration dependency; no self-merge, no deployment. CI success is evidence, not a substitute for reviewing the trust boundary.

CTO retains approval of shared server contracts, auth/security, external network/credential/cost activation and P0-C3 merged-main DoD. iOS Lead owns day-to-day iOS M2 review and integration.