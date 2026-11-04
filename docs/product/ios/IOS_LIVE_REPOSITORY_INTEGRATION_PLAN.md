# iOS Live Repository Integration Plan — Beta V1

> **Status:** Integration plan only — no live networking or production authentication is implemented or authorized by this document.
> **Owner:** iOS Lead
> **Repository:** `basicv8vc/Ember`
> **Historical source-audit baseline:** `main@154860a82402648ce0548573a3db1a85b5b45e37` (PR #89 merge; the source inventory in this plan was audited at that commit).
> **Current Platform baseline:** `main@38dd69b38a3f9c2dad5730b6902080a1ca3b4c1a` (PR #97 / B1-1 merged 2026-11-04).
> **Frozen wire contract:** ADR-0004, merged via [PR #92](https://github.com/basicv8vc/Ember/pull/92) at `8f7dc1934e508b9a7e6a551ef19fbe9cf6bc6026`; normative annex blob `2e06b47691b71b05e3903f0bd65d5b9f381776c0`.
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

## 2. Contract status — frozen; runtime implementation remains gated

The Beta V1 Live Platform wire contract is **approved and frozen**:

- [ADR-0004](../../adr/0004-beta-v1-live-platform-contract.md) was merged via [PR #92](https://github.com/basicv8vc/Ember/pull/92), merge commit `8f7dc1934e508b9a7e6a551ef19fbe9cf6bc6026`.
- Its normative annex is `docs/product/B1_PLATFORM_CONTRACT.md`, pinned to blob `2e06b47691b71b05e3903f0bd65d5b9f381776c0`.
- [PR #97](https://github.com/basicv8vc/Ember/pull/97) delivered B1-1 and merged to `main` at `38dd69b38a3f9c2dad5730b6902080a1ca3b4c1a`.

B1-1 adds migrations `0011`–`0013`, strict B1 schemas and typed tenant-scoped PostgreSQL repository interfaces. It does **not** add concrete B1 runtime repositories, application transactions, HTTP routes, production Apple authentication, the responder/polling/sweeper runtime, or iOS Live networking.

This distinction governs the rest of the plan:

- The **wire semantics are no longer open questions**. iOS types, URLProtocol fixtures and repository adapters must follow ADR-0004 and its annex exactly; older proposals are not competing authorities.
- The **runtime is not yet live**. A frozen route specification is not an implemented or deployed endpoint. Do not enable Live composition until the corresponding B1 server slice is implemented, tested and deployed.
- **PR #90 remains an iOS integration plan**, not a second contract and not permission to call guessed or not-yet-implemented endpoints.
- Real model-backed replies and delegated Task execution additionally require their separate B2/B3 implementation and CTO gates. No provider credentials, model egress or paid calls are authorized by this plan.

## 3. Platform capability baseline after B1-1

The first source inventory below was audited at the PR #89 baseline (`154860a`). The current main commit is `38dd69b` after PR #97. The key change is that B1 persistence contracts now exist, but their runtime is still unimplemented.

| Capability                           | Current source / contract status                                                                                                                                                                                               | iOS consequence                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Consumer identity and session        | ADR-0004 freezes Apple identity verification, session mint/refresh/logout, and server-owned consumer → tenant/principal mapping. PR #97 adds identity/session tables and schemas; no production auth route/runtime exists yet. | Implement the client contract and Keychain lifecycle, but do not call Live until B1 auth runtime is available.                 |
| Main Agent / Conversation bootstrap  | Frozen `GET /v1/me` contract returns the consumer, default Agent, main Conversation and `transcript_epoch`. B1-1 adds persistence/schema/ports, not the route or provisioning transaction.                                     | Do not invent a get-or-create endpoint or hard-code IDs; bootstrap through the contract when implemented.                      |
| Conversation messages                | Frozen POST/page/submission-lookup contracts; B1-1 adds message tables, schemas and repository interfaces. No HTTP handlers or concrete runtime repository yet.                                                                | Implement against `client_submission_id`, server sequence and `transcript_epoch`; keep Live disabled until server routes land. |
| Assistant Turns                      | Frozen separate Turn lifecycle and poll endpoint; B1-1 adds Turn persistence/schema/ports. No responder, route, poller or sweeper runtime yet.                                                                                 | Do not treat Task status or Task SSE as assistant-turn delivery.                                                               |
| Task create/detail/events/SSE/cancel | Existing authenticated routes remain unchanged; Task creation still accepts only the current mock kinds.                                                                                                                       | Existing Task infrastructure can be reused, but it is not a real model-backed capability.                                      |
| Task Results                         | Frozen typed `GET /v1/tasks/{task_id}/result` contract; PR #97 adds `task_results` migration/schema/port, but no writer/read route runtime.                                                                                    | Do not render a result until the server reports the authoritative result state and the read path exists.                       |
| Artifacts / Commitment outcomes      | Existing artifact and Commitment outcome routes remain available; they are not a substitute for the new Task Result contract.                                                                                                  | Keep these domain types distinct.                                                                                              |
| Model Gateway / real inference       | No production Model Gateway, provider credential path or approved real inference runtime exists.                                                                                                                               | No real model execution, provider egress or spend from iOS.                                                                    |

The frozen annex is the source of truth for wire semantics. Existing route presence does not assert deployment or production readiness; the B1-1 merge likewise does not make its proposed routes live.

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
       └─ protected pending-send outbox (required by B1; storage implementation security-reviewed)

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

The wire contract is now frozen in ADR-0004 and the normative annex; B1-1 has also checked in the matching DTO schemas and repository ports. Revise the iOS repository boundary around those exact server-owned identities and semantics—do not create a parallel client contract.

Minimum semantic operations (the names below describe repository responsibilities, not new HTTP endpoints):

- Bootstrap through the contract's `GET /v1/me`, which resolves the authenticated consumer, default Agent, main Conversation and current `transcript_epoch`. There is no client-side get-or-create operation.
- Fetch ascending Conversation pages using the server cursor and stable message IDs/sequences.
- Send with a client-generated `client_submission_id` and the last-read `transcript_epoch`; the message route does **not** use the Task `Idempotency-Key` header. Adopt the canonical message and Turn receipt returned by the server.
- Recover an unknown ACK through `GET /v1/message-submissions/{client_submission_id}`; reconcile pages by the echoed `client_submission_id`, never by text or timestamp heuristics.
- Fetch the authoritative assistant Turn state through `GET /v1/conversations/{conversation_id}/turns/{turn_id}` at the contract's polling cadence. B1 uses polling; token streaming/SSE is not part of this first Chat contract.
- Fetch the current Task snapshot/events through the existing Task repository boundary, then fetch the typed Task Result only through its approved authenticated result route.
- Keep assistant response, Task lifecycle and Task Result availability as separate states.

Keep AssistantTurn state, TaskStatus, transport connection state and local send-command state orthogonal. A completed assistant turn is not proof that a linked Task completed; a completed Task is not proof that a readable Outcome is available.

## 5. Authentication and transport

Implement only against the identity/session contract frozen in ADR-0004 §5:

1. Apple is the only real identity provider in B1. The client obtains an Apple identity token and nonce, then exchanges them through `POST /v1/auth/session`; the server verifies the assertion and provisions the consumer, tenant, owner principal, default Agent and main Conversation.
2. Refresh uses `POST /v1/auth/session/refresh` with the current Ember session token; logout uses `DELETE /v1/auth/session`. Do not send the Apple assertion again during refresh/logout.
3. Store the opaque Ember session token in Keychain using the contract's `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` accessibility. Never put it in UserDefaults, source, Info.plist, build settings, URLs or logs.
4. Coalesce concurrent refreshes and implement the contract's bounded refresh path. A revoked/rotated token must not trigger blind write retries.
5. The client never sends `tenant_id` or `principal_id`; the server derives `AuthContext { tenantId, principalId, policyVersion }` from the session.
6. Keep `EmberAPIClient` as the low-level URLSession transport or add a narrowly scoped authenticated wrapper. Redact Authorization headers, tokens, message bodies and sensitive response payloads from logs and diagnostics.

The identity provider and session semantics are no longer open design questions. Their implementation and deployment are still a B1 runtime gate; do not ship a dev token or enable Live composition against a route that has not landed.

## 6. Idempotent send and force-quit recovery

B1 freezes the send and unknown-ACK protocol; iOS must implement it literally:

1. Before the first attempt, persist a pending outbox entry containing the exact message, a fresh `client_submission_id` and the current `transcript_epoch`. Reuse that submission ID for retries of the same intent.
2. Submit `POST /v1/conversations/{conversation_id}/messages` with `client_submission_id`, text and `transcript_epoch`. Do **not** send an `Idempotency-Key` header on this route; that header remains the existing Task protocol.
3. On timeout or transport failure, call `GET /v1/message-submissions/{client_submission_id}`. A 200 means adopt the original message + Turn receipt. On 404, compare the stored epoch with a fresh `GET /v1/me`: retry the POST with the same ID and epoch only if the epoch is unchanged; if it advanced, treat the entry as pre-deletion and discard it rather than retrying.
4. On resume, page messages and reconcile by the returned `client_submission_id`; never use text, timestamp or message length as a deduplication heuristic.
5. A 409 `IDEMPOTENCY_CONFLICT` is not an automatic retry signal. Refresh `GET /v1/me`, reload the page, clear the affected outbox entry and preserve the text only as an unsent draft. A new ID is created only after the user explicitly chooses to send it as a new message.
6. On transcript deletion, clear the outbox and retire in-flight sends. The server increments `transcript_epoch`; a stale entry must never be replayed into the cleared transcript.

The outbox is part of the frozen client contract, not an optional alternative to server reconciliation. Protect its contents at rest, exclude them from logs/diagnostics, and clear private pending data on logout and transcript deletion. The exact iOS persistence implementation still needs a security review.

## 7. Assistant turns, Task progress and Outcomes

These are three distinct server facts:

- **Assistant turn:** `running/completed/failed/cancelled`, with authoritative status and durable retrieval through the B1 Turn route. B1 specifies polling no more frequently than once per 1000 ms; token streaming and assistant-turn SSE are deferred.
- **Task:** use authoritative Task snapshots and event sequence. The existing Task SSE parser/reconnect approach can be reused only for the Task event contract. It must not be treated as assistant-token streaming. Existing Task event payloads intentionally contain no free text; user-readable progress needs an approved safe summary field/event or a separate display contract.
- **Outcome:** fetch a typed result/manifest using authenticated reads after Task status is completed. Validate task/result association, content type, size and integrity before rendering/copy/share. The existing Commitment outcomes route is not a substitute for Task result retrieval.

The current Task create route returns a receipt (202 new / 200 replay), but the currently accepted Task kinds are mock-only. A real delegated capability requires a separately approved non-mock task kind and Model Gateway policy before the UI can call it Live.

## 8. Offline, persistence and error behavior

- Server is authoritative for Conversation identity, message order, transcript epoch, Turn state, Tasks and Task Results.
- On relaunch, restore the Keychain session, refresh if required, call `GET /v1/me`, load message pages, then reconcile the protected outbox by submission ID and epoch.
- A local optimistic message has no server sequence until acknowledged. Never display it as durably accepted.
- Show explicit offline/session-expired/server-error states. Do not silently switch Live to fixtures or show mock replies as real output.
- Protect the required pending-send outbox at rest. Clear it on logout and transcript deletion; on a newer server epoch, discard stale optimistic/outbox entries before rendering.
- Distinguish session expired/revoked, offline/timeout, `BUDGET_EXCEEDED`, server unavailable, idempotency conflict, not found/tenant-masked and malformed response.
- Never fabricate progress, receipt, assistant output or result. A Turn completion does not imply Task completion; Task completion does not imply a readable result.

## 9. Delivery slices and merge gates

| Slice                                | Deliverable                                                                                                                           | Gate / dependency                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| L0 — Contract freeze                 | **Complete.** ADR-0004 + normative annex are merged and pinned; B1 schemas/ports are present after PR #97.                            | Historical gate; no longer blocks client contract work.                                                       |
| L1 — Authenticated transport         | Apple Sign in integration, session exchange/refresh/logout, Keychain lifecycle, authenticated URLSession wrapper and redacted errors. | Implement only when B1 auth/session routes and provisioning runtime are available; security review required.  |
| L2 — Live Conversation repository    | `GET /v1/me`, message paging/send, unknown-ACK lookup, transcript-epoch fencing and Turn polling.                                     | B1 conversation/message/Turn routes and concrete transactional repositories implemented, tested and deployed. |
| L3 — Live Task repository and Result | Task linkage, safe progress and typed authenticated Task Result retrieval.                                                            | B1-6/B1-7 runtime plus a separately approved non-mock task capability and B2 Model Gateway gate.              |
| L4 — Continuity                      | Relaunch restore, active-Turn/Task reconciliation and protected pending-send outbox.                                                  | Contract-defined outbox/epoch behavior implemented; local persistence and data-protection review complete.    |
| L5 — Internal Alpha gate             | End-to-end signed-in iPhone flow, offline/retry, duplicate suppression, tenant isolation and no Mock/Live confusion.                  | All corresponding server slices deployed; CTO release approval and consolidated device QA.                    |

Run thin vertical slices against the frozen contract. The first Live slice remains **persistent multi-turn Chat**: sign in → resolve the main Conversation → send a message → receive a real assistant Turn → persist the transcript → force quit/relaunch → restore the same history. B1-1 alone is only persistence/schema/ports and cannot satisfy this milestone. Notes → Action Items is a later bounded capability, not the app home or a prerequisite for Chat.

## 10. Required acceptance tests

- Auth: missing/expired/revoked session, refresh single-flight, logout clears credentials and pending private data.
- Tenant isolation: foreign Conversation/Task/Outcome IDs are indistinguishable from not found.
- Send: same tenant-wide `client_submission_id` + same conversation/text/current epoch replays one canonical message/Turn; cross-conversation reuse within a tenant or changed text conflicts; different tenants may reuse the same ID.
- Assistant turn delivery: authoritative status, duplicate suppression, durable retrieval/polling or resumable-event semantics, and terminal-state authority.
- Task: receipt is not completion; progress comes only from server facts; cancellation pending is distinct from cancelled.
- Outcome: unavailable before completion; authenticated result association and integrity validation; no stale result.
- Continuity: force-quit after send-before-ACK, after ACK-before-reply, during stream, and while Task is running.
- Offline: no false success, no fake assistant reply, explicit recoverable state.
- Mode isolation: Mock and Live compositions are explicit; Live failures never render fixture data or mock replies; release builds cannot access dev bearer credentials.

## 11. Remaining implementation coordination

The wire-level decisions are closed by ADR-0004; do not reopen them in this client plan. The remaining work is implementation and release coordination:

1. **B1 runtime readiness:** Platform must report when Apple session provisioning, `GET /v1/me`, Conversation/message routes, submission lookup, Turn polling and transcript deletion are implemented, tested and deployed. A schema or repository interface alone is not a live endpoint.
2. **iOS auth implementation:** integrate Apple Sign in nonce handling, the frozen session DTOs, refresh single-flight, Keychain storage and logout/revocation behaviour.
3. **Outbox implementation:** select the protected iOS persistence mechanism for the contract-required pending-send record; review data protection, logout cleanup, transcript deletion and stale-epoch handling.
4. **Task/Result readiness:** wait for B1-6/B1-7 runtime and a separately approved non-mock capability before enabling Live Task/Outcome UI.
5. **Model execution:** real assistant replies require the separate B2 implementation and explicit provider, pricing, privacy and operational approval. This iOS plan grants none of those permissions.

Until the relevant server slice is deployed and the iOS acceptance tests pass, keep the app in explicit MOCK ONLY mode. Never call guessed production endpoints, ship dev bearer credentials, or present simulated output as Live.
