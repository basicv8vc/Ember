# iOS Live Repository Integration Plan — Beta V1

> **Status:** Integration plan only — no live networking or production authentication is implemented or authorized by this document.
> **Owner:** iOS Lead
> **Repository:** `basicv8vc/Ember`
> **Planning base:** `main@154860a82402648ce0548573a3db1a85b5b45e37`
> **Related:** CTO Task — Ember V1 Alpha / iOS Integration; [#91 B1 Live Platform Contract Freeze](https://github.com/basicv8vc/Ember/issues/91); [#75 Beta V1 Roadmap](https://github.com/basicv8vc/Ember/issues/75); [#73 Conversation state and API proposal](https://github.com/basicv8vc/Ember/issues/73)

## 1. Current iOS baseline

PR #89 is already merged. The merged-main Simulator QA completed on iPhone 17 Pro Max / iOS 26.3.1 with **95/95 tests passing (88 unit, 7 UI)**. The merge commit is `154860a82402648ce0548573a3db1a85b5b45e37`.

The app is now Conversation-first, with a shared `TaskJourneySession` for the local Task Detail path. The current conversation experience remains **MOCK ONLY**.

Relevant source boundaries:

- `Domain/Conversation/ConversationRepositoryProtocol.swift` currently exposes local `fetchConversation`, `appendMessage`, and `upsertAssistantTurn`.
- `Domain/Conversation/InMemoryConversationRepository.swift` is process-memory only; conversation IDs, message IDs and assistant-turn IDs are deliberately not Codable.
- `Features/Conversation/Screen/ConversationHostIntegration.swift` defaults to `ConversationFixtures`, creates client-side IDs/sequences, and produces replies with a local delay and `mockReply(for:)`.
- `Networking/Protocols/EmberAPIClient.swift` is a URLSession transport wrapper with no authentication/session policy.
- `Networking/Protocols/TaskRepositoryProtocol.swift` is the existing Task boundary.
- `Networking/MockTaskAPIRepository.swift` is explicitly mock-only and restricts its base URL to loopback/reserved test hosts. It must not be repurposed as a production repository.

Do not redesign the UI. Preserve the existing SwiftUI Conversation, typed timeline cards, Task Detail navigation and explicit MOCK ONLY disclosure.

## 2. Contract status — implementation gate

CTO has confirmed that the repository currently has **no approved Beta V1 Live Platform wire contract**. The source documents below are proposals/dependency records, not approved endpoints:

- `docs/product/ios/IOS_API_DEPENDENCIES.md`
- `docs/product/ios/IOS_M3_CONVERSATION_API_PROPOSAL.md`
- `docs/product/ios/IOS_CONTRACT_FREEZE.md`
- `docs/product/BETA_V1_ROADMAP.md`

The P0 contract work is tracked by [Issue #91](https://github.com/basicv8vc/Ember/issues/91). Platform must create `docs/adr/0004-beta-v1-live-platform-contract.md` in a separate PR. That ADR will be the single versioned CTO decision record after review and merge; machine-checked DTOs under `packages/contracts/src/**` must agree with it.

**PR #90 is only the iOS client integration plan.** It is not a wire-contract authority. iOS Live HTTP/session implementation remains gated until the Platform PR is reviewed, merged, and explicitly approved by CTO. This plan does not infer endpoint names or approval from existing proposals.

## 3. Existing Platform capabilities (source-audited)

| Capability                   | Current source status                                                                                                        | iOS consequence                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Task create                  | Existing authenticated route `POST /v1/tasks`; requires `Idempotency-Key`; returns 202 for new acceptance and 200 for replay | Request kinds are currently only `mock.chat`, `mock.compute`, `mock.file`, `mock.approval`; this is not a real LLM task |
| Task detail                  | Existing `GET /v1/tasks/:taskId`                                                                                             | Returns lifecycle metadata, not a human-readable final answer                                                           |
| Task event page              | Existing `GET /v1/tasks/:taskId/events?after=N`, max 100 events/page                                                         | Payload is a strict typed allowlist and contains no free-text progress summary                                          |
| Task SSE                     | Existing `GET /v1/tasks/:taskId/stream`; resume with `Last-Event-ID` or `after` (if both are supplied, they must match)      | Task progress only; it is not an assistant Conversation stream                                                          |
| Task cancel                  | Existing `POST /v1/tasks/:taskId/cancel`                                                                                     | 202 means cancellation is pending; it is not terminal completion                                                        |
| Artifact read                | Existing task artifact list and authenticated artifact-byte read routes                                                      | No general typed Task result/Outcome manifest or user-readable result contract                                          |
| Commitment outcomes          | Existing tenant-authenticated `GET /v1/commitments/:id/outcomes`                                                             | Commitment outcomes are not general Task Outcomes                                                                       |
| Consumer auth                | Development bearer-token configuration only; it refuses `NODE_ENV=production`                                                | Not safe mobile sign-in/session auth; never ship a dev token                                                            |
| Main Conversation/messages   | No production routes or shared wire DTOs found                                                                               | Live Conversation is blocked on Platform contract and implementation                                                    |
| Default Agent / Task Inbox   | No consumer-facing resolver/list route found                                                                                 | Do not hard-code Agent or invent a list endpoint                                                                        |
| Real model gateway/task kind | No approved consumer model-backed text-task path found                                                                       | No real model execution or spend from iOS                                                                               |

The source-level audit is consistent with the current `IOS_API_DEPENDENCIES.md`; route existence does not assert deployment or production readiness.

## 4. Minimal target architecture

Keep the UI and domain projections independent of HTTP details:

```
AppCompositionRoot
  ├─ MockComposition (explicit demo/preview selection; fixtures + local reply)
  └─ LiveComposition (only after CTO/Platform gates)
       ├─ AuthSessionProvider
       ├─ Authenticated API transport (URLSession)
       ├─ LiveConversationRepository
       ├─ LiveTaskRepository
       └─ protected pending-send/cache store (only if retention policy approves)

ConversationHostModel
  └─ ConversationRepositoryProtocol
       ├─ InMemoryConversationRepository (Mock)
       └─ LiveConversationRepository (Live; server-authoritative)

Task cards / Task Detail
  └─ TaskRepositoryProtocol
       ├─ FakeTaskRepository / MockTaskAPIRepository (Mock)
       └─ LiveTaskRepository (Live; only for approved real task contracts)
```

Composition must be explicit. A Live request failure must render an offline/error state; it must **never silently fall back to fixtures or a simulated reply**. A Mock session must remain visibly marked MOCK ONLY. Do not let one repository switch modes implicitly based on reachability.

### Repository interface implications

The current `ConversationRepositoryProtocol.appendMessage(ConversationMessage)` accepts a client-assigned message ID and sequence. That is suitable for the deterministic in-memory model, but it must not define server-authoritative ordering for Live.

After the wire contract is frozen, revise the repository boundary around server-owned identity and ordering. Minimum semantic operations (names are illustrative, not API endpoints):

- Resolve the authenticated user's one main Conversation (get-or-create semantics decided by Platform).
- Fetch a paginated Conversation snapshot/history with stable server message IDs, sequence/order and timestamps.
- Send a user-message command with a stable idempotency key; receive the canonical persisted message ID/sequence and assistant-turn ID/status.
- Resolve an uncertain send after an unknown ACK without generating a new key or duplicate message.
- Fetch/observe an assistant turn through the simplest Platform-approved durable mechanism. Polling is acceptable; resumable events are optional. Token streaming is not required for the first Alpha.
- Fetch the current Task snapshot and validated Task events through the existing Task repository boundary.
- Fetch a typed, authenticated readable Outcome/Artifact only after the authoritative Task state is completed.

Keep AssistantTurn state, TaskStatus, transport connection state and local send-command state orthogonal. A completed assistant turn is not proof that a linked Task completed; a completed Task is not proof that a readable Outcome is available.

## 5. Authentication and transport

Implement only against the approved identity/session contract:

1. A provider-neutral `AuthSessionProvider` supplies a short-lived access token, refreshes it, exposes signed-in/expired/revoked states, and supports logout.
2. Store refresh/session credentials in Keychain, not UserDefaults, source, Info.plist, build settings or logs. Access tokens remain memory-only where practical.
3. Coalesce concurrent refreshes; define one bounded 401-refresh-retry path. Do not retry non-idempotent writes unless the approved idempotency contract makes the exact replay safe.
4. Scope all repository calls to the authenticated principal; the client never sends a caller-selected tenant ID. Server-side tenant authorization remains authoritative.
5. Keep `EmberAPIClient` as the low-level URLSession transport or add a narrowly scoped authenticated wrapper. It must not absorb Conversation business semantics.
6. Redact Authorization headers, tokens, message bodies and sensitive response payloads from logs and diagnostics.

Sign in with Apple may be evaluated as an identity provider, but the provider-neutral server session exchange, refresh/revocation and tenant mapping must be decided by CTO/Platform first.

## 6. Idempotent send and force-quit recovery

A send operation needs a stable client-generated idempotency key, created once per user intent:

1. Create a pending-send record with the exact message payload and idempotency key.
2. Submit the request with that key.
3. On a definitive rejection, show a retryable/non-retryable error according to the contract.
4. On timeout, disconnect or process death with unknown ACK, reconcile the same key; never create a new key for the same intent.
5. Replace optimistic local state with the server's canonical message ID, sequence and assistant-turn reference after acknowledgement.

Platform must choose and specify one recovery mechanism:

- **Preferred:** an authenticated idempotency-status/reconciliation operation, so the client can recover after the original process and in-memory key are gone; or
- **Alternative:** an explicitly approved protected local outbox containing the exact pending text and key, with encryption/data-protection class, retention/expiry, deletion and logout semantics.

A volatile in-memory key alone does not satisfy force-quit recovery. Persisting raw text without a reviewed privacy/retention policy is not allowed. Do not invent an idempotency lookup route.

## 7. Assistant turns, Task progress and Outcomes

These are three distinct server facts:

- **Assistant turn:** accepted/generating/completed/failed/cancelled, with authoritative status and durable retrieval. Platform may choose polling or resumable events; token streaming is not required for the first Alpha.
- **Task:** use authoritative Task snapshots and event sequence. The existing Task SSE parser/reconnect approach can be reused only for the Task event contract. It must not be treated as assistant-token streaming. Existing Task event payloads intentionally contain no free text; user-readable progress needs an approved safe summary field/event or a separate display contract.
- **Outcome:** fetch a typed result/manifest using authenticated reads after Task status is completed. Validate task/result association, content type, size and integrity before rendering/copy/share. The existing Commitment outcomes route is not a substitute for Task result retrieval.

The current Task create route returns a receipt (202 new / 200 replay), but the currently accepted Task kinds are mock-only. A real delegated capability requires a separately approved non-mock task kind and Model Gateway policy before the UI can call it Live.

## 8. Offline, persistence and error behavior

- Server is the source of truth for Conversation, message order, assistant turns, Tasks and Outcomes.
- On relaunch, authenticate/refresh, resolve the same main Conversation, load a server snapshot/page, then reconcile any pending send and active assistant turns.
- If offline, keep the last approved local view if caching has been approved; show an explicit offline state and do not claim fresh server state.
- Keep a draft locally only under an approved storage/retention policy. Never log raw text.
- Distinguish session expired/revoked, offline/timeout, rate limited, server unavailable, idempotency conflict, not found/tenant-masked and malformed response.
- Never fabricate progress, receipt, assistant output or result. Do not mark a Task complete from stream closure or an assistant message.

## 9. Delivery slices and merge gates

| Slice                                 | Deliverable                                                                                                                                                                | Gate / dependency                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| L0 — Contract freeze                  | Versioned OpenAPI/DTOs and decisions for identity, main Conversation, messages, idempotency reconciliation, assistant turn/stream, Task linkage/result, privacy and quotas | CTO + Platform approval; **blocks Live implementation**                        |
| L1 — Authenticated transport          | Auth session provider, Keychain-backed credential lifecycle, authenticated URLSession wrapper, redacted errors                                                             | Approved identity/session contract + security review                           |
| L2 — Live Conversation repository     | Server-authoritative main Conversation, history, idempotent send, ACK reconciliation, durable assistant turn retrieval                                                      | Approved Conversation/message/turn contracts; polling or resumable events as specified by Platform |
| L3 — Live Task repository and Outcome | Real bounded task receipt, safe progress events, typed authenticated result retrieval                                                                                      | Approved non-mock task kind, progress and result contracts, Model Gateway gate |
| L4 — Continuity                       | Relaunch restore, active-turn/task reconciliation, protected pending outbox/cache                                                                                          | Approved retention and local-storage policy                                    |
| L5 — Internal Alpha gate              | End-to-end signed-in iPhone flow, offline/retry, duplicate suppression, tenant isolation, no Mock/Live confusion                                                           | CTO release approval and consolidated device QA                                |

Run thin vertical slices; do not create all abstractions in advance of the approved wire contract. The first Live slice is **persistent multi-turn Chat**: sign in → resolve the main Conversation → send a message → receive a real assistant turn → persist the transcript → force quit/relaunch → restore the same history. Notes → Action Items is one bounded capability to add later, not the app home or a prerequisite for Chat. Add delegated Task execution after the Conversation path is real and stable.

## 10. Required acceptance tests

- Auth: missing/expired/revoked session, refresh single-flight, logout clears credentials and pending private data.
- Tenant isolation: foreign Conversation/Task/Outcome IDs are indistinguishable from not found.
- Send: same key + same payload replays one canonical message/turn; same key + different payload conflicts; timeout/unknown ACK does not duplicate.
- Assistant turn delivery: authoritative status, duplicate suppression, durable retrieval/polling or resumable-event semantics, and terminal-state authority.
- Task: receipt is not completion; progress comes only from server facts; cancellation pending is distinct from cancelled.
- Outcome: unavailable before completion; authenticated result association and integrity validation; no stale result.
- Continuity: force-quit after send-before-ACK, after ACK-before-reply, during stream, and while Task is running.
- Offline: no false success, no fake assistant reply, explicit recoverable state.
- Mode isolation: Mock and Live compositions are explicit; Live failures never render fixture data or mock replies; release builds cannot access dev bearer credentials.

## 11. Decisions needed from CTO / Platform

Please attach or approve the authoritative contract version and answer:

1. What immutable merged commit SHA identifies the CTO-approved `docs/adr/0004-beta-v1-live-platform-contract.md` and matching `packages/contracts/src/**` schemas?
2. What consumer identity/session provider and refresh/revocation lifecycle are approved?
3. What are the authoritative main Conversation, message, assistant-turn and polling or resumable-event contracts?
4. What is the unknown-ACK reconciliation mechanism: server lookup or approved protected outbox?
5. Which non-mock Task kind and Model Gateway policy are approved for the first real delegated capability?
6. What safe Task progress summary and typed Outcome/result manifest can iOS render?
7. What local cache/outbox retention and deletion policy is approved?

Until these decisions are linked and frozen, iOS can implement contract tests, mock adapters and non-sensitive UI states, but must not call guessed production endpoints, add a production bearer token, or present Mock output as Live.
