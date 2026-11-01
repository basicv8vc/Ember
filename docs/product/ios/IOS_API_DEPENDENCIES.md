# Ember iOS — API Dependency & Gap Audit

> PROPOSED · 2026-11-01 · Ember code snapshot `f02075b7d8139149efdb6bc28ac05d7f5d764ae5` (main)
> This is **not** a production API guarantee. Sources: `apps/api/src/app.ts`, `apps/api/src/{agents,tasks,approvals,artifacts}/*.ts`, `packages/contracts/src/*.ts` and listed tests.

## Audit classification

**EXISTING (code + local tests)** means implemented in the TypeScript API with PostgreSQL injection and test coverage; not deployed or consumer-auth-ready. **MOCK ONLY** means persistence is real but execution/results are simulated. **PROPOSED** means nonexistent in this SHA and must not be called by the mobile client.

| Dependency | Exact current route and contract | Evidence | Status / iOS consequence |
| --- | --- | --- | --- |
| Liveness | `GET /healthz` 200; readiness `GET /readyz` 200/503 | `apps/api/src/app.ts`, `apps/api/src/readiness.ts` | EXISTING; internal diagnostics, not a user session |
| Agent create | `POST /v1/agents` JSON `{"name":"Ember"}` → 201 `{agent_id,name,policy_version,workspace_id,workspace_version,created_at,updated_at}` | `apps/api/src/agents/routes.ts`, `dto.ts`, `tests/unit/api-agent-http.test.ts` | EXISTING; tenant from auth, no client-supplied policy |
| Agent get | `GET /v1/agents/:agentId` → 200 or masked 404 | same as above | EXISTING; **no** list or get-my-default agent |
| Task create | `POST /v1/tasks` with header `Idempotency-Key` (8–128 allowed chars), strict `{agent_id,kind,input,deadline_at?}` → 202 first, 200 replay; body `{task_id,status,accepted_at,replayed}` + `Location` | `apps/api/src/tasks/routes.ts`, `packages/contracts/src/task-schemas.ts`, `tests/unit/api-task-create.test.ts`, `tests/integration/task-idempotency.test.ts` | EXISTING, but kinds only mock; no natural-language “real task” |
| Task detail | `GET /v1/tasks/:taskId` → 200 `{task_id,agent_id,kind,status,current_run_id,attempt_count,created_at,updated_at,deadline_at}` | `apps/api/src/tasks/dto.ts`, `routes.ts`, `tests/integration/http-task-api.test.ts` | EXISTING; no title, original prompt, final answer, progress description |
| Event page | `GET /v1/tasks/:taskId/events?after=N`, max 100, ascending exclusive sequence, `{task_id,events:[...]}` | `apps/api/src/tasks/routes.ts`, `event-stream.ts`, `tests/integration/http-task-sse.test.ts` | EXISTING; paginate until fewer than 100; no server next cursor |
| Event SSE | `GET /v1/tasks/:taskId/stream`; `Last-Event-ID: N` **or** `?after=N` (if both match), `event: task`, numeric `id`, JSON `data`; `: keep-alive` heartbeat | `apps/api/src/tasks/routes.ts` `parseStreamCursor`, `event-stream.ts`, `tests/unit/api-task-stream.test.ts` | EXISTING; long-lived **foreground** connection; replays durable events |
| Task cancel | `POST /v1/tasks/:taskId/cancel` → 202 while in progress, 200 when terminal; `{task_id,status,cancel_requested,cancel_requested_at,terminal,updated_at}` | `apps/api/src/tasks/routes.ts`, `dto.ts`, `tests/unit/api-task-cancel.test.ts` | EXISTING; 202 is not completion |
| Task approvals | `GET /v1/tasks/:taskId/approvals`; `GET /v1/approvals/:approvalId` | `apps/api/src/approvals/routes.ts`, `packages/contracts/src/approval-schemas.ts`, `tests/unit/api-approval-http.test.ts` | EXISTING for **mock** approval; returns hash, run/lease/status/expiry, not action human-readable detail |
| Decision | `POST /v1/approvals/:approvalId/decision` body `{"decision":"approve"|"deny"}` → 200 `{approval_id,task_id,status,task_status,decided_at,replayed}` | same, `tests/integration/persistent-mock-approval.test.ts` | MOCK ONLY; not production capability for external effects |
| Artifact list/read | `GET /v1/tasks/:taskId/artifacts` returns metadata; `GET /v1/artifacts/:artifactId` bytes with integrity validation | `apps/api/src/artifacts/routes.ts`, `tests/integration/http-artifact-api.test.ts` | EXISTING for produced demo artifacts; no general “final answer” content DTO |
| Errors | `{error:{code,message,request_id?}}`; stable mapping 400/401/403/404/409/429/502/503/504; unexpected 500 `internal_error` | `apps/api/src/http/error-mapping.ts`, `packages/contracts/src/error-schemas.ts` | EXISTING; sanitized; don't expose raw internal diagnostics |

**Request constraints:** authenticated tenant for all `/v1` routes; agent names 1–128 characters; task body stream cap 64 KiB (`apps/api/src/tasks/constants.ts`) **and** separate canonical persistence cap; mock chat prompt max 8,000 chars; `mock.compute` SHA-256 only; UUIDs server-generated. `CreateTaskRequest` rejects unknown tenant/principal/policy fields. `TaskEventDto` = `{task_id,sequence,phase,occurred_at,trace_id,payload}`; phases `accepted,leased,started,progress,waiting_approval,approval_granted,approval_denied,retry_scheduled,completed,failed,cancelled`. Payload is strictly enum/UUID/number/boolean, **no text content** (`packages/contracts/src/event-schemas.ts`, `packages/domain/src/types.ts`).

**Task status set:** `queued, running, waiting_approval, retryable_failed, completed, failed, cancelled`; `waiting_external` is RFC-only, not in P0B `TASK_STATUSES`. `accepted` is receipt/event fact, never a Task status. `packages/domain/src/task-state-machine.ts` controls transitions.

## Auth and security — not a consumer contract

`apps/api/src/auth/dev-auth-config.ts` loads only local environment bearer tokens, **throws for `NODE_ENV=production`**; `bearer-authenticator.ts` resolves a tenant from a configured token. This is **not** Sign in with Apple/OIDC, token refresh, Keychain contract, tenant membership, account creation, or safe mobile credential distribution. `apps/api/src/index.ts` uses local PostgreSQL repositories and optional local blob store; listener defaults loopback (`README.md`, `apps/api/src/env.ts`). Never embed a test bearer token in a distributed iOS build. No iOS app currently exists in the tracked repository tree.

## Gaps requiring CTO/Platform owner — proposed contracts, not implemented

| Proposed dependency | Minimal request/response semantics to review | Security / recovery requirement | Priority |
| --- | --- | --- | --- |
| **Identity/session** | [PROPOSED] `POST /v1/auth/apple` or OIDC exchange → short-lived mobile session; refresh/revoke; account→tenant and default agent | Apple identity validation, issuer/audience, device revocation, Keychain, logout, rate limiting; exact scheme CTO to choose | P0 blocker |
| **My Agent + Task Inbox** | [PROPOSED] `GET /v1/me/agent` and `GET /v1/tasks?cursor=...&limit=...` → stable ordered TaskSummary including display title, timestamps, status, next cursor | Tenant scoping, opaque cursor, 404 masking, cross-device/reinstall recovery, retention & delete policy | P0 blocker |
| **Real bounded text task** | [PROPOSED] distinct non-mock type, e.g. `text.action_items.v1` input `{source_text,instruction}` and approved max lengths; server-routed, user-visible output | Controlled Model Gateway, privacy/content retention, no arbitrary tool/egress, budget/quota, safe logs; only after CTO Gate A | P0 blocker |
| **Displayable result** | [PROPOSED] result ref/manifest or typed `GET /v1/tasks/:id/result`, including output media, integrity, error/no-result semantics; may reuse Artifact | Immutable committed outcome, no replay fabricated, readable content & content policy | P0 blocker |
| **Human-readable Activity/Approval** | [PROPOSED] safe progress summary or approved public event fields; Approval ActionIntent view: action, target, account, scope, effect, expiry, policy version, digest binding | Do not send hidden SQL/token; approval must bind exact action/lease/capability, stale/expired/replayed semantics | Gate for real approval, later than note summarization |
| **Submission reconciliation** | [PROPOSED] idempotency-key lookup/status scoped by auth, or explicitly approved secure pending-outbox policy | Avoid two tasks on unknown ACK after app kill; no new key for retry | P0 reliability review |
| **Notifications** | [PROPOSED] device registration, per-account/task opt-in, de-register; APNs payload minimal, backend delivery/expiry | Permission timing, privacy on lock screen, dedupe, deep link auth, no assumed guaranteed delivery | Post-core gate |
| **Mac execution** | [PROPOSED] devices/consent, capability, placement, secure gateway and device approval flow | Device ownership, signed identity, no raw DB credentials, never upload private files silently | Post-MVP Hero |

Do not implement or invent endpoint URLs above; names are **discussion placeholders**. API naming, transport, SSE auth/reconnect specifics, idempotency lookups and persistent model changes need CTO contract approval.

## SSE client algorithm (current contract)

1. Read task snapshot, then request event pages from last confirmed `sequence`, ignoring duplicates and failing closed on invalid order.
2. Connect stream with **one** resume source: header `Last-Event-ID`; omit query `after` (server requires matching values if both sent).
3. Parse frames incrementally; commit cursor only after DTO validation/association to same task; comments/heartbeat do not advance it.
4. When stream drops, keep last known status and present “reconnecting”; backoff, resync snapshot + event pages; no timer-generated progress.
5. Terminal status is authoritative; final output requires Artifact/result fetch; never infer complete from stream closing alone.

## Versioned evidence and current caveats

- Full SHA `f02075b7d8139149efdb6bc28ac05d7f5d764ae5` incorporates merged P0B-10A/B/C and P0-C1 local security foundations. `README.md` contains **stale historical claims** that “/v1 doesn't exist” and P0B-10 is in progress; route code and merged PRs #25–#28 are stronger current evidence.
- P0-C2 kickoff prompts are merged (PR #33/#34) but **P0-C2C PR #35 is Draft/unmerged** as of this audit. Do not count its worker context wiring as current main. `docs/prompts/p0-c2/P0-C2-THREE-LANE-KICKOFF.md` still explicitly blocks live egress, host exec, credential use and paid cloud execution.
- Tests establish local code behavior, not production deployment or security approval; iOS-specific API contract integration tests are **NOT RUN**.

## Approval asks

Treat first four gap rows as an integrated Platform P0 interface contract package; iOS Lead owns client needs, CTO owns auth/security/API/financial and Platform scheduling. See `IOS_STATUS.md` for consolidated top-three decisions.
