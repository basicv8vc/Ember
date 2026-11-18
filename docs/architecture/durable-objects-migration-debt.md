# Technical Debt: Cloudflare Durable Objects Migration Dependencies & Blockers

> Status: **Technical Debt / Future Migration Reference Only** (No DO/D1 migration implemented)
> Context: Recorded during the Neon idle-Compute remediation on `apps/cloud-async-runtime` and `apps/api`.

## 1. Current Architecture Summary

Ember Cloud currently runs a stateless Cloudflare Workers tier (`apps/api` and `apps/cloud-async-runtime`) backed by Neon PostgreSQL via Hyperdrive (`HYPERDRIVE`) and Cloudflare Queues (`TURN_DISPATCH_QUEUE`, `AGENT_TASK_QUEUE`, and their DLQs).

With the queue-first dispatch path (`onTurnCommitted` in `apps/api/src/cloudflare-worker.ts` with bounded `waitUntil` Queue retries, and immediate delegation sends in `apps/cloud-async-runtime/src/runtime.ts`), Cloudflare Queues drive steady-state execution, while `apps/cloud-async-runtime/src/index.ts` separates Cron Triggers into latency-sensitive Turn outbox recovery (`* * * * *`, preserving `B1_TURN_DEADLINE_SECONDS = 60` while `model.kind === 'enabled'`), async Task reconciliation (`*/30 * * * *`), and maintenance GC (`0 */6 * * *`, running 4x/day even when model execution is disabled). Retaining `* * * * *` Turn recovery while model execution is enabled keeps an enabled environment's Neon endpoint awake because no atomic cross-worker external dirty signal exists without provisioning new infra or moving state into Durable Objects.

Moving the runtime state/orchestration from Neon PostgreSQL into Cloudflare Durable Objects (with SQLite-backed DO storage / D1 / R2) aligns with Cloudflare Native Architecture, but the current codebase has five structural dependencies on PostgreSQL semantics that block a drop-in migration.

---

## 2. Key Migration Dependencies & Blockers

### 2.1 Global Cross-Tenant Budget & Halt Serialization (`b2-spend-ledger.ts`)

- **Current mechanism**: `packages/postgres/src/repositories/b2-spend-ledger.ts` uses a single global cluster-wide transaction advisory lock (`lockBudgetHalt` -> `pg_advisory_xact_lock(782, 0)`) and multi-row ACID updates spanning `model_global_spend_days`, `model_spend_days` (`tenant` and `principal` scopes), and `model_budget_incidents`.
- **DO blocker**: If DOs are sharded per tenant or per conversation (`ConversationDO` / `TaskDO`), no single tenant DO can atomically enforce the global daily spend ceiling (`globalDailyMicroUsd`) or propagate global `model_budget_incidents` halts without a separate coordinating singleton (`GlobalBudgetDO`) introducing cross-DO 2PC/compensation complexity (or async lease budgets).

### 2.2 Multi-Aggregate ACID Transactions Spanning Conversations, Turns, Tasks & Outbox

- **Current mechanism**:
  - `PostgresB1ConversationWriteRepository.submitUserMessage` (`packages/postgres/src/repositories/b1-conversation-write.ts`) atomically locks `conversations` (`FOR UPDATE`), enforces rolling 24h message quota (`B1_MESSAGE_QUOTA_LIMIT = 200`), enforces tenant-wide `client_submission_id` idempotency (`conversation_messages_tenant_submission_unique`), bumps `last_sequence`, inserts `conversation_messages` + `assistant_turns`, binds attachments, and writes `b1_turn_dispatch_outbox` in one PostgreSQL transaction.
  - `PostgresLeaseQueue` (`packages/postgres/src/lease-queue/postgres-lease-queue.ts`) and task executors atomically update `tasks`, `runs`, `task_events`, `task_results`, `artifacts`, and `blobs` using `lease_epoch` fencing.
- **DO blocker**:
  - `client_submission_id` uniqueness is **tenant-wide** (`(tenant_id, client_submission_id)`), whereas `sequence` ordering is **conversation-scoped**. Placing state inside a per-conversation DO leaves tenant-wide idempotency uncoordinated across conversations unless a tenant-level DO owns submission dedup or routing.
  - Task scheduling, lease epochs, and terminal `outcome_reference` publication currently share one DB transaction with conversation messages/turns; splitting Conversation DO and Task DO requires an explicit idempotent cross-DO saga/outbox protocol instead of single-DB `COMMIT`.

### 2.3 Cross-Tenant Scanning for Outbox, Lease Reaping, and Recovery

- **Current mechanism**: `publishDueTurnDispatches`, `publishDueNotesTaskDispatches`, and `publishDueAgentDispatches` (`apps/cloud-async-runtime/src/relay.ts`) execute cross-tenant PostgreSQL scans (`claimDue` with `FOR UPDATE SKIP LOCKED`, `reapExpired`, `listDueNotesTaskDispatches`) to recover dropped Queue wakeups and DLQ returns.
- **DO blocker**: Durable Objects have no global SQL query across all instances. Once state moves into per-tenant/per-conversation/per-task DOs, each DO must own its own alarm (`state.storage.setAlarm()`) for lease expiration, deadline timeout (60s Turn deadline, Task deadlines), and retry backoff—eliminating Cron polling altogether, but requiring reliable DO alarm scheduling/renewal migration for every active entity.

### 2.4 Binary `bytea` Attachments & Artifacts Stored Inline in PostgreSQL

- **Current mechanism**: `PostgresB3StagedUploadRepository` (`packages/postgres/src/repositories/b3-staged-upload-repository.ts`) and `PostgresByteaBlobStore` (`packages/postgres/src/storage/bytea-blob-store.ts`) store binary file payloads (up to 256 KiB) in `user_staged_uploads`, `bytea_staged_blobs`, and `bytea_blobs`, synchronized with `pg_advisory_xact_lock(hashtextextended(...))` during orphan GC (`sweepOrphans`).
- **DO blocker**: Staged uploads created before task delegation (`POST /v1/uploads`) and task artifacts downloaded later must not bloat DO SQLite storage or hit per-object storage limits, and tenant-wide upload quotas/cleanup currently rely on relational queries (`COUNT_UNBOUND_UPLOADS_SQL`, `SWEEP_EXPIRED_UPLOADS_SQL`).
- **Prerequisite**: Move payload bytes to Cloudflare R2 (separating metadata pointers in SQL/DO from immutable objects in R2) before migrating runtime state off PostgreSQL.

### 2.5 API & Auth Coupling to PostgreSQL via Hyperdrive

- **Current mechanism**: `apps/api/src/cloudflare-worker.ts` constructs per-request repositories over `HYPERDRIVE` for Apple session provisioning (`PostgresB1ConsumerProvisioningRepository`, `PostgresB1ConsumerSessionRepository`), nonce replay prevention (`createCloudflareAppleNonceReplayStore`), conversation reads (`PostgresB1ConversationReadRepository`), turn/task reads, and upload endpoints.
- **DO blocker**: Even if Turn/Task execution moved to DO alarms/state, Neon would still be queried on every authenticated HTTP request unless auth/session state (or D1 read replicas) and API read projections migrate concurrently. In addition, Cloudflare Workers Free vs Paid constraints apply (DOs + SQLite storage require Workers Paid plan billing considerations, already required today by `limits.cpu_ms = 30000` in `apps/cloud-async-runtime/wrangler.staging.jsonc`).

---

## 3. Recommended Sequencing When Resuming Migration

1. **R2 Migration First**: Move `user_staged_uploads`, `bytea_staged_blobs`, and `bytea_blobs` bytes out of PostgreSQL into R2 (eliminating `sweepOrphans` / `sweepExpiredUnboundUploads` DB scans).
2. **Per-Entity Alarms for Leases & Deadlines**: Replace Cron-based `reapExpired` and turn deadline sweeps with per-DO `setAlarm()` timers while keeping Queue delivery idempotency.
3. **Tenant-Scoped Partitioning + Global Budget Strategy**: Decide whether `GlobalBudgetDO` or cached budget quotas handle `model_global_spend_days`, and split tenant-wide `client_submission_id` dedup cleanly from conversation serialization.
4. **Dual-Write / Cutover Plan for API Reads & Auth**: Ensure `/v1/me`, Apple nonce replay store, and conversation/task reads migrate cleanly so Neon can be fully decommissioned without splitting source-of-truth across Postgres and DOs.
