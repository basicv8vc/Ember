# iOS M3 Conversation API Proposal

> **PROPOSED — CTO / Platform review required.** This document records a source audit and proposes a minimum Beta V1 API. It is not an approved contract and adds no API implementation.
>
> Audit source: `main` at `a36f7d64337083647ae246538705245f72419686` (2026-11-02). Evidence was checked in `apps/api/src/**`, `apps/worker/src/**`, and `packages/contracts/src/**` at that commit. “Existing” means source code and its contracts exist; it does not assert production deployment or consumer readiness.

## Current Platform audit

| Capability                      | Current source behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Beta V1 gap                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent                           | `POST /v1/agents` creates an Agent and `GET /v1/agents/:agentId` reads one. Both are tenant-authenticated. There is no collection or “my default Agent” route. (`apps/api/src/agents/routes.ts`, `apps/api/src/app.ts`)                                                                                                                                                                                                                                                                         | **PROPOSED:** consumer-scoped default Agent resolution and stable Agent ownership.                                                                                                         |
| Task                            | `POST /v1/tasks` accepts only `mock.chat`, `mock.compute`, `mock.file`, and `mock.approval`; it requires `Idempotency-Key`, returns 202 for a new accepted Task and 200 for a replay. `GET /v1/tasks/:taskId`, event page, SSE stream, and cancel routes exist. The event page is capped at 100; SSE resumes with a numeric event cursor. There is no Task collection/list route. (`apps/api/src/tasks/routes.ts`, `apps/api/src/tasks/constants.ts`, `packages/contracts/src/task-schemas.ts`) | **PROPOSED:** a conversation-linked, non-mock text request and consumer Task inbox/recovery contract. Task acceptance, execution, cancellation, and readable output remain separate facts. |
| Task status                     | The Task vocabulary is `queued`, `running`, `waiting_approval`, `retryable_failed`, `completed`, `failed`, and `cancelled`. A 202 cancellation response may mean cancellation is still pending.                                                                                                                                                                                                                                                                                                 | Existing Task lifecycle is usable as Task truth; it is not an assistant-turn lifecycle.                                                                                                    |
| Commitment                      | `POST /v1/commitments`, paginated/filterable `GET /v1/commitments`, `GET /v1/commitments/:id`, pause, resume, cancel, and paginated `GET /v1/commitments/:id/outcomes` exist. Creation is idempotent. Outcomes contain IDs, a bounded `summary`, `result_status`, and timestamp. (`apps/api/src/commitments/routes.ts`, `packages/contracts/src/commitment-schemas.ts`)                                                                                                                         | **PROPOSED:** conversation message links to Commitment IDs. The existing Commitment API is not a general conversation or Task result API.                                                  |
| Authentication                  | `/v1` uses a configured development bearer-token authenticator. It maps environment-configured tokens to internal `tenantId`, `principalId`, and `policyVersion`; the default app rejects requests without configured credentials, and dev-auth configuration refuses `NODE_ENV=production`. There is no consumer sign-in, refresh, account lifecycle, or mobile session contract. (`apps/api/src/auth/dev-auth-config.ts`, `apps/api/src/auth/bearer-authenticator.ts`, `apps/api/src/app.ts`) | **PROPOSED:** consumer identity and revocable mobile sessions. `principalId` in the current local auth context is not a consumer account system.                                           |
| Conversation / thread / message | No conversation, thread, or message routes or shared DTOs were found in the audited API, Worker, or contract source. `mock.chat` is a Task input kind, not a conversation API.                                                                                                                                                                                                                                                                                                                  | **PROPOSED:** durable main Conversation, ordered heterogeneous Messages, history, and recovery.                                                                                            |
| Model gateway                   | No real model/provider gateway was found. Worker source explicitly excludes a real LLM; `mock.chat` is simulated.                                                                                                                                                                                                                                                                                                                                                                               | **PROPOSED:** a bounded, centrally controlled model gateway, contingent on separate safety, privacy, and cost approval.                                                                    |
| Readable results                | `GET /v1/tasks/:taskId/artifacts` returns artifact metadata and `GET /v1/artifacts/:artifactId` returns verified bytes. There is no general `GET task result` with readable model output. Commitment outcome summaries are readable only for Commitment outcomes.                                                                                                                                                                                                                               | **PROPOSED:** a typed Task Outcome/result manifest and safe readable content retrieval. A completed Task or artifact metadata alone is not a readable answer.                              |
| Consumer identity               | No consumer account or device identity exists in the audited API. A local configured principal is only an auth-context field.                                                                                                                                                                                                                                                                                                                                                                   | **PROPOSED:** account identity, default-Agent ownership, session revocation, and account-scoped data access.                                                                               |
| Retention and deletion          | The audited conversation API does not exist; Task/Artifact APIs expose no consumer conversation export/deletion contract. Existing Task cancel and Commitment cancel are lifecycle operations, not account or content deletion.                                                                                                                                                                                                                                                                 | **PROPOSED:** retention, export, deletion, and content-free operational logging rules.                                                                                                     |
| Quota and model cost            | Worker has internal execution-budget plumbing, but there is no consumer-facing quota contract or real model spend in the audited mock path.                                                                                                                                                                                                                                                                                                                                                     | **PROPOSED:** per-consumer rate/quota policy and model-cost accounting before any real model request is enabled.                                                                           |

The audit confirms that current APIs are tenant-scoped service contracts, not a complete Beta V1 consumer conversation platform. `GET /v1/commitments/:id/outcomes` can supply a short readable Commitment summary, but it does not fill the missing Task result or conversation history contract. Artifact reads return bytes after integrity checks; callers still need a typed result manifest and display semantics.

## Minimum Beta V1 contract to review

All routes, fields, statuses, and guarantees below are **PROPOSED**. Names are placeholders for review, not URLs that an iOS client may call today. The iOS Lead owns client adapters after CTO / Platform approval.

### 1. Consumer identity and session — PROPOSED

- **PROPOSED** `POST /v1/auth/session` exchanges the approved identity-provider assertion for a short-lived access session and a rotatable refresh credential. The identity provider and exact exchange are CTO decisions.
- **PROPOSED** `POST /v1/auth/refresh` rotates a session; `DELETE /v1/auth/session` revokes the current session. Account deletion/revocation must invalidate refresh credentials and active sessions.
- **PROPOSED** responses expose a stable opaque `consumer_id` and server-owned tenant mapping. The client cannot choose `tenant_id`, `principal_id`, or policy. Tokens are stored in Keychain, never embedded in the app or logged.
- **PROPOSED** every conversation, message, Task, Commitment, and result read is authorized against the authenticated consumer/tenant; inaccessible and missing IDs return the same not-found shape.

### 2. Default Agent resolution — PROPOSED

- **PROPOSED** `GET /v1/me/default-agent` returns the single stable default Agent ID, display name, and approved capability flags for the signed-in consumer.
- **PROPOSED** first-session setup creates or assigns this Agent server-side and idempotently. Beta V1 does not need a multi-Agent roster or client-side policy selection.

### 3. Conversation creation and retrieval — PROPOSED

- **PROPOSED** `POST /v1/conversations` creates or returns the consumer’s one main Conversation for the default Agent; repeated create requests must not create duplicate main conversations.
- **PROPOSED** `GET /v1/me/conversation` resolves that main Conversation after launch or relaunch. `GET /v1/conversations/{conversation_id}` returns its identity, Agent reference, timestamps, and current history cursor.
- **PROPOSED** conversation IDs are server-generated, immutable, and scoped to the authenticated consumer. Pagination uses an opaque, stable cursor and a bounded page size.

### 4. Message append and history — PROPOSED

- **PROPOSED** `POST /v1/conversations/{conversation_id}/messages` accepts a bounded user-text message and returns a durable message receipt plus an `assistant_turn_id` when work is accepted.
- **PROPOSED** `GET /v1/conversations/{conversation_id}/messages?before={cursor}&limit={n}` returns a stable, server-ordered timeline of typed user, Ember, activity, Task-reference, Commitment-reference, and Outcome/Artifact-reference messages.
- **PROPOSED** each message has a stable ID, server sequence, timestamp, type, and typed references. The server validates that linked entities belong to the same authorized consumer. Unknown message kinds are rejected by the adapter or represented as an explicit unsupported item; they are never coerced into user prose.
- **PROPOSED** user text and model output are not written to routine logs, traces, or error messages. Request size and content limits are enforced before model routing.

### 5. Idempotency and Unknown ACK recovery — PROPOSED

- **PROPOSED** each append carries an `Idempotency-Key` unique within the authenticated consumer and Conversation. The server binds the key to a canonical request hash and the original message/turn receipt.
- **PROPOSED** retrying the same key and same body returns the original receipt; reusing the key with a different body returns a stable 409 conflict. Clients reuse the exact key and payload after timeout, connection loss, or an ambiguous response; they do not create a fresh send.
- **PROPOSED** a consumer-scoped submission lookup keyed by the client submission ID returns `not_found`, `accepted`, or the original receipt. This allows relaunch recovery using an opaque operation ID without persisting raw message text locally.
- **PROPOSED** accepted receipt means the message is durably stored; it does not mean the assistant turn or any linked Task is complete.

### 6. Assistant turn lifecycle — PROPOSED

- **PROPOSED** `GET /v1/conversations/{conversation_id}/turns/{assistant_turn_id}` returns an independent assistant-turn state (`queued`, `streaming`, `completed`, `failed`, or `cancelled`), timestamps, and emitted message IDs.
- **PROPOSED** stopping an assistant response changes only that assistant turn. It does not cancel a linked Task; Task cancellation remains an explicit Task API operation.
- **PROPOSED** an assistant turn reaching `completed` never implies a linked Task reached `completed`, and Task completion never implies that a readable Outcome exists.

### 7. Streaming and reconnection — PROPOSED

- **PROPOSED** an authenticated event stream is scoped to a Conversation or assistant turn and emits durable, monotonically sequenced events with stable event IDs. Event types include message appended, safe activity update, turn state change, and typed entity link.
- **PROPOSED** reconnect accepts one resume cursor (for example `Last-Event-ID`) and replays events after that cursor. A paginated event/history endpoint backfills gaps; heartbeat frames do not advance the cursor.
- **PROPOSED** clients commit a cursor only after validating the event ID, sequence, Conversation association, and typed payload. Stream closure or transport failure means reconnecting, not assistant failure or Task failure. A fetched snapshot remains authoritative for current state.

### 8. Task and Commitment linkage — PROPOSED

- **PROPOSED** message timeline items reference durable `task_id` or `commitment_id`; they do not copy lifecycle fields into chat text or become authoritative status.
- **PROPOSED** link creation is server-controlled and tenant-checked. The server returns structured references and the existing Task/Commitment IDs; duplicate links are idempotent.
- **PROPOSED** the Task API remains authoritative for Task status and events. The Commitment API remains authoritative for Commitment status and scheduled outcomes. Conversation activity may summarize approved facts but cannot change their status.

### 9. Readable Outcome / Artifact retrieval — PROPOSED

- **PROPOSED** `GET /v1/tasks/{task_id}/result` returns a typed result state (`available`, `missing`, or `failed`), title/summary, and optional artifact references. It is consumer/tenant-scoped and distinguishes Task completion from result availability.
- **PROPOSED** readable content is returned as bounded text or through an artifact manifest with media type, size, checksum, and authenticated content retrieval. Missing, unsafe, or unsupported content remains explicitly unavailable.
- **PROPOSED** existing Commitment outcome summaries may be linked into the Conversation without treating them as generic Task results. The existing artifact byte endpoint remains a content transport, not a complete presentation contract.

### 10. Retention, deletion, and privacy — PROPOSED

- **PROPOSED** publish explicit retention periods for user messages, assistant output, activity events, Tasks, Commitments, outcomes, and artifacts, including the handling of backups and provider retention.
- **PROPOSED** provide authenticated export and deletion operations for a Conversation and the consumer account. Deletion returns a durable receipt and clearly states any separately retained Task/Commitment records or legally required audit metadata.
- **PROPOSED** enforce tenant isolation, encrypt stored content, redact content from logs/traces, disclose model-provider processing, and define whether message content is used for training (default: no, pending policy approval).
- **PROPOSED** local iOS state stores only what is required by the approved contract; any durable pending-operation record contains an opaque ID and idempotency metadata, not raw message text unless a separately reviewed encrypted outbox is approved.

### 11. Per-user quota and model cost controls — PROPOSED

- **PROPOSED** enforce per-consumer request rate, message size, daily/monthly usage, and concurrency limits server-side, with tenant-wide kill switches and budgets.
- **PROPOSED** return stable quota/rate-limit errors with retry guidance and expose a minimal authenticated usage view. Do not return provider credentials, hidden routing details, or sensitive cost internals.
- **PROPOSED** place every model request behind a centrally controlled gateway with provider/model allowlists, maximum input/output limits, timeout/cancellation policy, and per-request spend accounting. No model spend or provider integration is authorized by this proposal.

## CTO / Platform decisions requested

1. Approve or revise the consumer identity/session and tenant-mapping boundary.
2. Approve one default Agent and one main Conversation semantics, including create/recovery behavior.
3. Approve message submission idempotency, Unknown ACK lookup, and assistant-turn lifecycle semantics.
4. Approve stream cursor/replay behavior and safe activity fields.
5. Approve the Task/Commitment linkage and typed readable-result contract.
6. Set retention, deletion, provider-data, quota, and cost boundaries before any production implementation.

Until those decisions are recorded, these capabilities remain **PROPOSED** and must not be called from an iOS network adapter or implemented as production API behavior.
