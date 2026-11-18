# ADR-0005 — Cloudflare-native Cloud Runtime V2

- Status: Accepted upon merge to main (direction only; implementation not authorized)
- Date: 2026-11-18
- Scope: Ember cloud runtime infrastructure; not a new product release contract
- Related: [V1 architecture baseline](../architecture/v1-architecture-baseline.md), [ADR-0001](0001-cancellation-and-retry-coordination.md), [ADR-0002](0002-preclaim-deadline-failure.md), [ADR-0003](0003-p0b-06-persistence-contract-freeze.md), [ADR-0004](0004-beta-v1-live-platform-contract.md)

## Context

Ember provides one logically long-lived Personal Agent per user, with on-demand execution. The current cloud implementation uses Cloudflare Workers, Hyperdrive, Neon PostgreSQL and Queues; the existing persistence and execution contracts are valuable and must not be weakened. A Neon compute-quota warning motivates investigation of idle database wakeups, not a finding that PostgreSQL is intrinsically unsuitable. The suspected periodic polling cause and savings require runtime evidence.

The owner prefers Cloudflare-native infrastructure where appropriate. A shared D1 database would remove time-based PostgreSQL compute charges but still require substantial SQL/concurrency migration and would not by itself provide per-agent coordination or wakeups. A thin Durable Object (DO) is the preferred V2 direction, subject to feasibility evidence.

## Decision

1. Keep V1 on its existing PostgreSQL runtime. Prioritize product delivery (Notes → Action Items → Daytona, iOS and end-to-end acceptance) and separately mitigate unnecessary Neon wakeups. This ADR does not approve a migration, new cloud resources, paid services, a PoC workstream, or a change to the V1 API contract.
2. Prefer a Cloudflare-native, agent-centric V2: Workers + SQLite-backed Durable Objects + Alarms + Queues + R2. D1 is optional for a minimal global control plane if needed. Retiring Neon is the target, not an unconditional deadline.
3. Use a thin DO for short, durable state transitions and scheduling; execute slow model, sandbox and tool I/O outside the DO in stateless execution Workers. Preserve existing domain/contracts and execution logic wherever practical. Do not rewrite the runtime to adopt Agents SDK; evaluate individual SDK capabilities only if justified.
4. One canonical agent/tenant coordination object is the initial candidate, not an irreversible sharding rule. Derive the object identity from authenticated, server-resolved ownership (never a raw client-supplied user/tenant ID). Preserve current tenant/principal/agent distinctions; validate mapping and isolation before migration. Do not create a global business-data DO.

## Target topology (not implemented)

```text
iOS / Mac / Web
       |
API Worker (auth, routing, existing API contracts)
       |
Thin Agent DO (SQLite, state transitions, budget, Alarms)
       |                         ^
       | durable dispatch        | fenced commit
       v                         |
Cloudflare Queues --> Execution Worker --> LLM / Daytona / tools
                            |
                            v
                           R2 (artifacts)
Optional D1: global identity/routing/entitlements, not shared agent state
```

### Ownership and isolation

- Agent DO: tenant/agent-scoped conversations, messages, turns, tasks, execution records, notes, schedules, usage reservations, approvals and artifact metadata where atomic invariants require co-location.
- R2: large files and execution artifacts; authorize object access against canonical ownership. Immutable or versioned keys, staged upload/commit and orphan cleanup are required; R2 and SQLite cannot share a transaction.
- Optional D1: global identity/routing, subscription metadata or operational indexes. Define entitlement freshness/revocation and reservation rules before introducing a cross-plane dependency. Global budgets cannot be inferred from independently committed user budgets.
- Credentials stay behind existing credential/approval/egress boundaries; no plaintext secrets in business storage, logs, exports or queue payloads.

### Thin DO execution protocol

- Claim: a short SQLite transaction validates authorization, idempotency, cancellation, budget and current execution state; persists reservation, run/epoch and durable dispatch intent.
- Dispatch/detach: publish to Queues via a recoverable outbox or equivalent durable mechanism, with retries/reconciliation. No atomic transaction is assumed between SQLite and Queues. A crash after publication but before marking sent can duplicate delivery; consumers must tolerate it. A crash before publication must not lose committed work.
- Execute: independent Worker handles external I/O, bounded execution and provider cancellation. Use asynchronous submission/callback or durable continuation for long sandbox jobs. Do not rely on HTTP waitUntil alone for reliable execution. Streaming must preserve the client contract without keeping the DO waiting for generation; any progress writes must be bounded.
- Commit: validate current run/lease/epoch, cancellation and ownership; atomically commit result, message/task state, usage and reservation release. Duplicate or stale results must not mutate a newer attempt. External side effects and provider charging cannot be guaranteed exactly-once by local transactions; use provider idempotency, reconciliation and explicit uncertain outcomes rather than blind replay.
- DO single-instance execution does not eliminate async interleaving. No global async mutex or blockConcurrencyWhile spanning network I/O; short transactions protect read-modify-write operations.

### Scheduling

Use a persistent SQLite schedule/outbox/retry table indexed by next due time. Each DO has one Alarm; arm the earliest outstanding wakeup. Recalculate on schedule changes and after bounded batches; handle reentrancy, duplicate alarms, restarts, overdue work and failure isolation. Ensure persisted schedules and wakeup registration have no unrecoverable gap, including retry exhaustion. Alarm dispatches durable work rather than awaiting LLM/Daytona. No custom heap/framework without evidence that SQL ordering is insufficient.

### Schema lifecycle and operations

Per-object SQLite makes schema evolution and fleet observation harder than one PostgreSQL database. Before rollout require versioned, transactional, restart-safe lazy migrations, tests from supported older versions, a rollback/forward-repair strategy, and an inventory/observability plan for dormant objects and failures. Preserve stable IDs, ordering, timestamps, constraints and audit provenance. Define user export/deletion, backup/restore and R2 cleanup; managed SQLite does not imply downloadable database files. Do not log sensitive content.

## V1 engineering guardrails (effective upon merge)

- Keep user-facing business reads/writes tenant-scoped using existing authenticated context and canonical IDs. Explicitly privileged operator/recovery queries may cross tenants when necessary and audited; no new cross-tenant business coupling.
- Keep slow external I/O outside database transactions and preserve fencing, budget reservation, idempotency, authorization, approval, checkpoint and cancellation semantics. Reuse current interfaces; no speculative dual-backend framework.
- Reduce idle polling through reliable event-driven dispatch wherever viable; retain bounded reconciliation for committed-but-undispatched work, expired leases and cleanup as needed. A dirty flag is an optimization, never the sole source of recovery. Do not trade task liveness for compute savings.
- Measure actual idle compute, first-response latency, delivery/recovery latency and cost before claiming improvement. Budget targets are goals, not guarantees.

## Activation and migration gates

Reopen implementation planning when one or more of these conditions is evidenced: optimized Neon remains a material cost/cold-start problem; the product requires high-frequency per-agent scheduling or realtime multi-device state; or V1 has shipped and a bounded migration window is available. A trigger is not authorization; CTO/owner approval of scope and rollout is required.

Before migration approval, a separately authorized, time-boxed feasibility study must demonstrate:

- API and iOS compatibility; tenant isolation, idempotency, cancellation, concurrent budget safety, leases/fencing and atomic task/result writes.
- Fault injection: crash before/after publish, duplicate delivery, stale completion, external unknown outcome, Alarm retry/exhaustion, DO restart and R2 metadata/object mismatch. No lost committed tasks or duplicate committed results; explicit reconciliation of external effects.
- Frontend requests during slow background work; compare tail latency and task recovery against current runtime. Verify execution remains detached and robust on client disconnect.
- Versioned migration and export/import on representative data, long-dormant schemas, backup restore, deletion, controlled cutover and rehearsed rollback without silently losing post-cutover writes.
- Real Cloudflare measurements of DO active wall-clock duration (including any non-hibernating idle windows), requests, SQLite rows/storage, Worker CPU/requests, Queues and R2. Model multiple workloads including streaming and scheduled work; do not assume 0.3 seconds per turn, zero idle spend, or a guaranteed $5 total bill.
- Explicit implementation estimate, operational tradeoffs, acceptance criteria and migration decision. No long-term two-runtime commitment; retain the old backend only during a bounded, reversible cutover as required.

## Consequences and alternatives

Neon remains the V1 source of truth. D1-only and external PostgreSQL remain fallback options if the thin DO design fails the gates; do not adopt them by default. The direction favors agent-local coordination and wakeups, at the cost of per-object migrations, observability and cross-store consistency. Cloudflare concentration and provider lock-in are accepted considerations, not permission to weaken exports or recovery.

This document is an architecture decision, not an implementation report. No runtime, database schema, deployment or test behavior changes are made by this ADR.

## References

- [Durable Objects best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
