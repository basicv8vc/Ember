# Ember P0-C3B — Durable Scheduler & Guarded Promise Runtime Coding Agent Prompt (v0.1)

> Role: Coding Agent B / Worker Runtime + Reliability Engineer.
>
> Status: PROPOSED. **Do not code until CTO approves the P0-C3 doc PR, PR #43 is merged, and C3-0 shared contracts are frozen.**
>
> Required reading: docs/P0-C3-ARCHITECTURE-AND-TASK-SPEC.md; P0-C2B Sentinel and durable Worker implementation. Resolve actual origin/main SHA at coding kickoff.

## Mission

Implement the **cloud-side, restart-safe loop** that notices a due commitment, dispatches one existing durable Task for a scheduled occurrence, and records an honest result in the commitment's Inbox timeline. Reuse existing lease, retry/reaper, Sentinel, Budget Guard and checkpoint semantics.

This is a guarded deterministic proof, **not** permission to call paid LLM APIs, external network, shell, host.exec, private OAuth or real credential.use.

## Ownership / edit boundary

Allowed:

- packages/execution/src/commitment-orchestrator.ts, commitment-summary-engine.ts and limited export append in packages/execution/src/index.ts.
- apps/worker/src/commitment-scheduler.ts, commitment-handler.ts, commitment-ports.ts and narrowly scoped Worker composition/config support after the A/C integration window.
- tests/unit/p0c3-scheduler*.test.ts, tests/unit/p0c3-commitment-runtime*.test.ts, tests/integration/p0c3-worker*.test.ts, tests/chaos/p0c3-worker*.test.ts.
- docs/P0C3-B-SCHEDULER-RUNTIME.md.

Forbidden: migrations/**, packages/postgres/**, packages/contracts/**, packages/credentials/**, packages/connectors/**, apps/api/**, apps/ios/**, P0-C2 evidence/benchmarks, root lockfile/manifests, production secret/deployment settings.

B is sole owner of apps/worker/** and packages/execution/src/index.ts during this lane. If A's DB repository or C's source adapter is not merged, use **local structural ports** and Fake implementations. Do not create a second persistence repository or modify another lane's files to force compilation.

## Build requirements

1. Scheduler service
   - Configurable, bounded poll interval, batch size and concurrent slots; default disabled in production until CTO Gate 3.
   - A narrow injected CommitmentDueStore port returning due, authenticated/tenant-owned records as trusted server data, never user-supplied worker identity.
   - Use the occurrence reservation primitive from A after integration. Reserve first; dispatch a durable Task under a stable idempotency key tied to occurrence_id; bind task_id to occurrence atomically or with recoverable reconciliation.
   - Repeated ticks and competing workers must converge to one occurrence and one visible outcome for each due slot.
   - Default execution is cooperative and controlled by AbortSignal; fail shutdown and transient DB loss safely.

2. Guarded execution
   - Create no new TaskKind just to bypass Sentinel. Use only existing mock task kinds and closed action mappings.
   - Admission occurs before any budget reservation or source callback; preserve denial reason and zero side effects on deny. Never route network.egress or credential.use into a mock allow branch.
   - Existing run lease epoch, deadline, cancel flag, committed checkpoint and approval status remain authoritative.
   - A resumed occurrence may re-execute a deterministic, idempotent read/compute step, but must not re-publish an already committed outcome. Old Worker cannot publish on a stale lease.
   - Maintain a bounded FakeSummaryEngine interface: deterministic string output from supplied, bounded SourceSnapshot. A source is untrusted DATA, never executable instructions.

3. Outcome and observability
   - An outcome references commitment_id, occurrence_id and existing task_id; chronological ordering uses server-generated event/sequence, not client time.
   - Separate statuses for a scheduled occurrence, its Task and the long-lived commitment. Explicit failure/retry events; no fabricated success.
   - Avoid raw prompt/source payload/credential URL/headers in diagnostics. Audit shows category, policy version, operation ID, outcome and sanitized failure code.
   - Support test clock injection without changing production DB authoritative-time rules.

4. Integration contract
   - Define minimal ports at module boundaries: DueCommitmentStore, ExistingTaskDispatcher, SourceReader, CommitmentOutcomeWriter and Clock.
   - Keep ports separate from the concrete C adapter and A DB repository until the integration pass. **Any missing cross-lane interface is a handoff request**, not an excuse to edit A/C-owned files.
   - Document the exact wiring points needed in apps/worker/src/index.ts and the expected A/C exports. Do not claim those wires are live while on an independent branch.

## Required tests

- Unit: due/no-due, interval bounds, cancellation before and during dispatch, race between two scheduler instances, task idempotency replay, bounded clock and retry behavior.
- Unit: Sentinel deny before budget and source callback (both exactly 0), malformed data rejection, prompt-injection-as-data, no raw provider messages, no accidental network calls.
- Integration: when A DB contract is available, real PostgreSQL due-slot race, restart/reconciliation and ordered outcome visibility.
- Chaos: real Worker OS SIGKILL after an occurrence is reserved and again after Task/Outcome commit; new process resumes without a second visible outcome; stale lease fails closed.
- Existing test: Fast Path remains 0 sandbox allocations; the four original demo scenarios must not regress.
- Report unexecuted cross-lane tests as NOT RUN / BLOCKED, never PASS.

Mandatory quality gates with actual exit codes: pnpm install --frozen-lockfile, pnpm format:check, pnpm lint, pnpm typecheck, pnpm build, pnpm test:unit, pnpm test:integration, pnpm test:chaos, pnpm test:e2e, pnpm demo. Heavy 1,000-Agent benchmark belongs to merged-main Gate 4 only.

## DoD

- Restart safe and bounded; no double-dispatch record or duplicate visible outcome.
- Fail-closed Sentinel and Budget Guard pre-side-effect invariant preserved.
- Old/fenced Worker cannot write; cancellation stops future work.
- A and C can be integrated through documented ports without circular packages.
- Real LLM execution, live network egress, external mutation and production credential use remain **NOT IMPLEMENTED**.

## Delivery protocol

Clean dedicated worktree from actual post-docs-merge origin/main, feature/p0c-3b-promise-runtime. Draft PR title “feat(worker): P0-C3B durable commitment scheduler and safe outcome runtime”.

PR must include exact base/head full SHA, diff, architecture, deterministic evidence, genuine test counts and exit codes, crash/fencing and revocation assertions, budget/network/credential statement, cross-lane handoffs, rollback. Do not merge, deploy, or enable production scheduling.