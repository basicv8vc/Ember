# Ember Beta V1 — Product & Delivery Roadmap

> **Status:** Active roadmap  
> **Product owner:** Jia (Founder)  
> **iOS Product Lead:** iOS product direction, UX, mobile architecture within approved boundaries, sprint execution, integration and day-to-day Coding Agent coordination  
> **CTO:** cross-platform architecture, API contracts, identity, security, privacy, model execution, cost controls and release gates  
> **Planning baseline:** main at f5be8276ac3df15a0f0f3c694ba6ed8442311e1e  
> **Tracking issue:** [#75 — Beta V1 Delivery Roadmap](https://github.com/basicv8vc/Ember/issues/75)  
> **Founder decision:** [#71 — Conversation-first Beta V1](https://github.com/basicv8vc/Ember/issues/71)

This document is the product and delivery source of truth for Ember Beta V1. GitHub Issues and PRs track implementation work; they must not silently redefine the product direction or cross-platform contracts recorded here.

---

## 1. Product vision

Ember is a **Personal AI Agent and persistent AI partner**, not a task-submission form and not merely a chatbot.

The defining experience:

> A user opens Ember, talks naturally with one persistent partner, asks it to take responsibility for useful work, leaves the app, and returns later to understand what Ember remembers, what it promised, what it has actually done, what result is ready, and what still needs attention.

**Conversation is the primary interface. Task and Commitment are the durable work system.**

A user should not need to understand agents, tools, workers, queues, prompts or execution infrastructure. They should be able to express an intention in ordinary language and see truthful, understandable progress and outcomes.

The experience must work for an iPhone-only user. A Mac is optional and must never be a prerequisite for core Beta V1 value.

### Product principles

1. **One partner first.** Start with one default Ember identity and one persistent main conversation. Do not build a multi-agent or persona marketplace in Beta V1.
2. **Conversation-first, not chat-only.** The transcript can contain messages, activity updates, linked Tasks/Commitments, approvals when authorized, and durable Outcomes/Artifacts.
3. **Work persists beyond a turn.** A user can send a follow-up while a task is running. Ending a model response is not the same as cancelling a Task.
4. **Truthful state over impressive animation.** Accepted, running, completed, failed, cancelled and result-available are distinct facts. Never invent progress.
5. **Memory is controlled continuity.** Chat history is not the same thing as saved memory. Users must be able to understand and control what is retained as memory.
6. **Cloud-first, Mac-optional.** Core conversation and bounded task execution must work without a Mac app or local computer.
7. **Trust before autonomy.** Authentication, tenant isolation, explicit authorization, privacy and cost boundaries precede external side effects or broad autonomy.
8. **Ship thin vertical slices.** Prefer a small real end-to-end capability over a large collection of disconnected mock features.

## 2. Beta V1 product definition

### Primary experience

The app opens into one long-lived conversation with Ember. The user can:

- ask questions and have a natural multi-turn conversation;
- share notes or context in the same composer;
- ask Ember to perform a bounded task;
- clarify or change the request through follow-up messages;
- see meaningful task activity and status in the conversation;
- open a task or outcome for more detail;
- leave and return without losing the conversation or work state;
- understand when Ember needs input or when a result is actually ready.

The existing **Notes → Action Items** path remains the first bounded delegated-work capability. It becomes an action Ember can perform from the conversation, not the app's primary home screen or a separate submission workflow.

### Conversation timeline

The main conversation is a heterogeneous, ordered timeline. It may contain:

| Timeline item           | Meaning                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| User message            | Text or context submitted by the user                                                         |
| Ember message           | A persisted assistant response                                                                |
| Activity update         | A concise, user-readable event grounded in actual execution state                             |
| Task card               | A link to a durable Task and its authoritative status                                         |
| Commitment card         | A link to a durable ongoing Commitment                                                        |
| Approval card           | A structured authorization request, only after the ActionIntent/security contract is approved |
| Outcome / Artifact card | A link to a readable, durable result                                                          |

Do not flatten Tasks or Commitments into chat text. A message can reference a Task, but it is not the source of truth for that Task's status.

### Beta V1 scope

**In scope:**

- one default Ember partner;
- one persistent main conversation;
- text-first multi-turn conversation;
- consumer sign-in and authenticated cloud session;
- durable conversation/message history;
- one real, bounded delegated task capability;
- structured, truthful Task activity and readable Outcome;
- same-account, same-installation force-quit/relaunch recovery;
- bounded, user-visible memory controls;
- clear cloud-processing, privacy and failure states;
- a private, invited-user Beta on iPhone.

**Explicitly deferred unless Founder reprioritizes:**

- multiple Bots, personas or agent marketplace;
- voice conversations and real-time audio;
- arbitrary file/attachment ingestion beyond the selected first task;
- general-purpose autonomous web browsing;
- external write actions and broad third-party integrations;
- production approvals before ActionIntent and Sentinel/security gates;
- APNs background notifications before privacy and delivery gates;
- Mac/local execution as a requirement;
- complex autonomous planning or opaque long-term profiling.

## 3. Current baseline and capability truth

The following is the audited planning baseline, not a claim that every capability is production-ready. Re-check the relevant source and PR before implementation.

### iOS baseline

- The previous M2 experience was Compose → Inbox → Task Detail, with a local Mock-first journey.
- The M3 direction is to replace that form-first mental model with a conversation-first main screen.
- Current M3 work is split across:
  - [#72 — Conversation UI](https://github.com/basicv8vc/Ember/issues/72)
  - [#73 — Conversation state and Platform API proposal](https://github.com/basicv8vc/Ember/issues/73)
  - [#74 — Activity / Task / Outcome cards](https://github.com/basicv8vc/Ember/issues/74)
- [#69 — stale Launch Smoke assertion](https://github.com/basicv8vc/Ember/issues/69) is a separate M2 QA cleanup. It must not block M3 prototype work.
- M2 merged-main QA did not receive a formal all-green PASS. Do not represent it as fully passed. Preserve known test and visual QA limitations in the QA issue.

### Platform capability ledger

Use these labels in product specs, UI, PRs and API proposals:

- **EXISTING** — verified implementation exists in the current baseline.
- **MOCK** — local fixture, fake repository or deterministic demo only.
- **PROPOSED** — documented design; not an implemented or approved production contract.
- **APPROVED** — explicitly approved by CTO for implementation within a defined scope.
- **BLOCKED** — cannot proceed until a named dependency or approval is satisfied.

| Capability                              | Baseline assessment                         | Important boundary                                                                           |
| --------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Task create/detail/events/SSE/cancel    | EXISTING API surface                        | Existing request kinds and current UX are not yet the complete real consumer task experience |
| Task list / consumer inbox              | GAP / PROPOSED                              | Do not invent a production endpoint from the iOS UI                                          |
| Commitment lifecycle and outcomes       | EXISTING API surface                        | Not equivalent to general conversation or assistant memory                                   |
| Commitment scheduler/runtime            | Separate implementation/approval track      | A scheduler is not a general-purpose Agent runtime                                           |
| Consumer identity and mobile session    | GAP / BLOCKED                               | Development bearer-token configuration is not production consumer authentication             |
| Conversation/thread/message persistence | GAP / PROPOSED                              | No production conversation contract may be assumed                                           |
| Model gateway and real assistant turn   | GAP / CTO GATE                              | No unapproved provider key, spend or model endpoint                                          |
| Local conversation prototype            | MOCK                                        | Must remain visibly identified as demo/mock                                                  |
| Task/Outcome inline cards               | MOCK until backed by real readable entities | UI must never imply fixture results came from a live model                                   |
| Push notifications / APNs               | BLOCKED / later gate                        | No production notification claim or integration without approval                             |
| User-controlled long-term memory        | PROPOSED                                    | Must have explicit controls, retention and deletion semantics                                |

The current Task API, Commitment API, development auth and Worker implementation must be re-audited against source before B1 contract approval. This table is a planning ledger, not a substitute for the CTO's technical review.

## 4. Delivery roadmap

Milestones are **capability gates, not calendar promises**. Each milestone should produce a demonstrable result. Work may proceed in parallel where ownership and contracts are clear.

### B0 — Conversation Prototype

**Status:** In progress  
**Owners:** iOS Lead + iOS Agents A/B/C  
**Issues:** [#72](https://github.com/basicv8vc/Ember/issues/72), [#73](https://github.com/basicv8vc/Ember/issues/73), [#74](https://github.com/basicv8vc/Ember/issues/74)

**Goal:** Deliver an integrated, usable conversation-first iOS prototype with deterministic Mock data.

Deliverables:

- one default Ember partner and one main conversation screen;
- native SwiftUI transcript with multiple user/Ember turns;
- composer with draft, send, recoverable error and retry states;
- suggested prompts that seed the composer without auto-sending;
- inline Task, Commitment, Activity and Outcome card components;
- separate conversation-turn state and Task state;
- deterministic Mock scenarios, persistently labelled MOCK ONLY;
- iOS Lead-owned App Root integration.

**Exit criteria:**

- A/C components compose into one integrated conversation;
- user can send multiple follow-up turns in the prototype;
- cards link to structured entity facts rather than inferred chat prose;
- no fake network, model response, progress, notification or external action;
- final-Head generic Simulator SDK build, build-for-testing and CI pass;
- one consolidated Simulator QA at the integration gate, not a full Simulator run per PR.

**Not part of B0:** production login, real cloud conversation, background execution, APNs or persistence of raw conversation text.

### B1 — Platform Contract & Trust Foundation

**Status:** Design/review is the next Platform critical path  
**Owners:** CTO + Platform; iOS Agent B supplies the mobile gap analysis  
**Input:** [#73 — Conversation state and API proposal](https://github.com/basicv8vc/Ember/issues/73)

B1 freezes the cross-platform contracts before production integration. iOS may continue UI and Mock work while B1 is reviewed.

The CTO must explicitly approve:

1. **Consumer identity/session:** account identity, tenant binding, sign-in, token refresh/revocation, logout, account deletion and default Ember Agent resolution. Sign in with Apple may be evaluated as an iOS identity provider, but the server identity contract must remain provider-neutral.
2. **Conversation:** create/get/list main conversation; append/read/list messages; stable IDs, ordering, pagination, retention and deletion.
3. **Send and acknowledgement:** idempotency key, status lookup, unknown-ack recovery, duplicate suppression, retry and timeout semantics.
4. **Assistant turn:** queued/generating/completed/failed/cancelled states; streaming or polling; reconnect cursor; server-authoritative terminal state.
5. **Work linkage:** link messages/turns to Task and Commitment IDs without duplicating their authoritative state.
6. **Readable results:** result title, summary, content/artifact metadata, authenticated read/download and expiration semantics.
7. **Model execution:** approved Model Gateway, provider abstraction, timeouts/retries, prompt/data boundaries, per-user quota, budget reservation and cost observability.
8. **Privacy/security:** tenant isolation, encryption, retention, export/delete, logging redaction, memory consent/control and abuse limits.

**B1 exit criteria:**

- API schemas and lifecycle state machines are documented;
- all endpoints and capabilities are marked EXISTING / MOCK / PROPOSED / APPROVED;
- threat model and data-flow boundaries are reviewed;
- idempotency and unknown-ack recovery are specified;
- cost/quota and privacy/deletion semantics are specified;
- CTO records an explicit approval decision before production implementation begins.

**Allowed before approval:** UI, previews, fixtures, in-memory repositories, protocol boundaries, documentation, threat modeling and tests against fakes.

**Not allowed before approval:** production API routes, migrations, auth/session implementation, real provider spend, credential storage, APNs, approval execution or external egress.

### B2 — Real Conversation

**Goal:** Deliver the first real cloud-backed multi-turn conversation.

User journey:

1. User signs in and receives a consumer session.
2. App resolves the same default Ember Agent and main Conversation.
3. User sends a plain-text message.
4. Server persists the message and returns an idempotent acknowledgement.
5. Approved Model Gateway generates a real response.
6. Response streams or is safely polled, then is persisted.
7. App reconnects and restores the same transcript after force quit/relaunch.

**Exit criteria:**

- real responses are distinguishable from Mock, loading, failure and retry states;
- timeout/retry does not create duplicate user messages or assistant turns;
- tenant isolation and auth expiry are verified;
- ordering is stable across reconnect/relaunch;
- server state is authoritative; no hidden local-only source of truth;
- model usage and cost are measured and bounded;
- failure and offline states are understandable and recoverable.

Do not add multi-Bot, voice, attachments, browsing or external actions to this slice.

### B3 — Delegate Work inside Conversation

**Goal:** Make Ember perform one useful, bounded task from a natural-language conversation.

First capability: **Notes → Action Items**.

User journey:

1. User asks Ember to organize notes.
2. Ember asks for missing information when required.
3. User confirms any required scope or data transfer.
4. Server creates a durable Task linked to the originating message/turn.
5. Ember returns a real receipt and a Task Activity card.
6. A controlled Worker executes only the approved task kind through the approved model/runtime path.
7. Durable server events update the inline Task card.
8. A readable result is stored and rendered as an Outcome card.
9. User can follow up in the same conversation.

**Exit criteria:**

- accepted receipt ≠ execution started ≠ completed ≠ readable result available;
- progress events are server facts, not client animations;
- unknown-ack retries preserve the original key and payload;
- stopping a response and cancelling a Task are distinct actions;
- Task state and result survive app relaunch;
- result is shown only after authenticated result retrieval succeeds;
- task failure, cancellation and missing result have truthful UI states.

General-purpose browsing, arbitrary shell/code execution, external writes and multi-step third-party actions are out of scope for this first Beta V1 task.

### B4 — Continuity, Memory & Proactive Updates

**Goal:** Make Ember feel like the same partner over time without building an opaque or uncontrolled memory system.

**Required continuity:**

- durable main conversation and server-backed history;
- durable Task/Commitment references in the timeline;
- same-account, same-installation force-quit/relaunch recovery;
- later turns can refer to unfinished work using actual server state;
- user can see what is active, blocked or waiting for input.

**Bounded Memory V1:**

- user-visible saved facts/preferences only;
- explicit save/forget controls;
- inspect, edit and delete;
- source and timestamp metadata;
- tenant isolation and retention rules;
- no silent high-sensitivity inference or unrestricted background profiling.

**Proactive updates:**

- in-app updates on reconnect are required;
- APNs is a separate CTO approval gate;
- push requires opt-in, privacy-safe generic payloads, authenticated deep links, device-token lifecycle, notification preferences and delivery/revocation tests;
- until approved and implemented, do not claim that Ember can notify users while the app is closed.

Reinstall and cross-device recovery must be separately tested before being claimed.

### B5 — Private Beta Readiness

**Goal:** Invite a small group of external users to a secure, cost-bounded, reliable iPhone-only Beta.

Required gates:

- **Security:** auth/session review, tenant isolation, deletion, logging redaction, prompt-injection boundaries, abuse/rate limits and incident/kill-switch plan.
- **Privacy:** cloud-processing disclosure, retention/deletion path, memory controls and support contact.
- **Cost:** per-user quotas, budget ceilings, model routing policy, spend alerts and runaway-loop protection.
- **Reliability:** idempotent sends, unknown-ack recovery, stream reconnect, server-side task continuation and readable failure states.
- **Product QA:** onboarding, multi-turn conversation, delegated task, relaunch recovery, result retrieval, offline/retry, empty/error states.
- **Device QA:** supported iOS version coverage, at least one real iPhone pass, VoiceOver and Dynamic Type on core journeys.
- **Operations:** privacy-reviewed telemetry, crash/error visibility, support/feedback path, kill switches and rollback.
- **Distribution:** signing, TestFlight and beta release approval by CTO.

Cosmetic P2 issues, including extreme Dynamic Type refinements, should not block Beta if the core journey remains usable and accessible. P0/P1 correctness, privacy, security and data-loss defects do block.

## 5. Parallel workstreams and ownership

### iOS workstream

Run at most three iOS Coding Agents concurrently. Keep file ownership disjoint.

| Lane         | Ownership                                                                         | Deliverable                                   |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------- |
| **iOS A**    | Conversation shell, transcript, composer, welcome/empty states                    | Conversation-first UI                         |
| **iOS B**    | Conversation state model, in-memory repository, fixtures, API gap proposal        | Deterministic state + Platform contract input |
| **iOS C**    | Task/Commitment/Activity/Outcome cards                                            | Reusable structured timeline components       |
| **iOS Lead** | App Root, Xcode project, shared interfaces, integration, roadmap and PR decisions | Integrated iOS app                            |

iOS Lead owns shared-file changes and App Root integration. Agents must not independently edit the Xcode project, frozen contracts or shared integration surfaces without coordination.

### Platform workstream

Platform design can proceed in parallel with B0. Implementation must respect the CTO-approved contract and shared schema ownership.

| Lane            | Ownership                                                                                | Deliverable                                   |
| --------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Platform P1** | Consumer identity/session, default Agent, tenant-scoped conversation/message persistence | Authenticated durable conversation foundation |
| **Platform P2** | Model Gateway, assistant turn lifecycle, streaming/reconnect, quotas/cost                | Real assistant responses with bounded spend   |
| **Platform P3** | Task orchestration linkage, durable events, readable outcomes, recovery                  | Real delegated-work loop                      |

P1/P2/P3 may conduct discovery and design concurrently. Do not allow concurrent backend agents to independently change shared schemas, auth, migrations or API contracts before a single owner and CTO-approved interface are established.

### Cross-team dependency order

B0 Conversation Prototype and B1 Identity/Conversation Contract can proceed in parallel. B2 Real Conversation requires both the integrated client experience and the approved identity, conversation and model contracts. B3 can be designed while B2 is being built, but the first integrated delegated-work journey depends on approved conversation, identity, model execution and task/result contracts. B4 continuity and memory build on durable conversation and work state. B5 follows successful end-to-end validation.

## 6. Engineering delivery rules

### Fast Lane for ordinary PRs

- Every PR is isolated in its own branch/worktree.
- Every PR states exact Base and final Head SHA.
- Every PR must include a real final-Head Xcode generic Simulator SDK build, build-for-testing result, exit codes and log locations.
- GitHub CI must pass.
- Review scope and ownership before merge.
- Do not run the full Simulator suite for every ordinary PR.
- Do not let multiple Coding Agents contend for the same Simulator.
- Use one exclusive Simulator window for integrated milestone QA.
- Preserve actual test counts and failures; never describe an unrun or hung test as passed.

### Milestone QA

Run consolidated Simulator QA after meaningful integration points:

- integrated B0 conversation prototype;
- B2 real conversation;
- B3 delegated-work vertical slice;
- B5 Beta candidate.

Use a clean detached worktree at the exact merged-main SHA. Capture build/test commands, numeric exit codes, .xcresult, logs and screenshots. Test on a real iPhone before external Beta release.

### PR and approval boundaries

iOS Lead may review and merge ordinary iOS changes within the approved product/architecture boundaries.

CTO approval is required for:

- cross-platform API/schema or state-machine changes;
- authentication, identity, tenant isolation and credentials;
- privacy, retention, deletion and memory policy;
- model provider, model gateway, external egress and material cost decisions;
- production approval/action execution;
- APNs and background delivery;
- sandbox/runtime security boundaries;
- release/signing/TestFlight and production deployment gates.

No agent may merge its own PR automatically, deploy production or activate an unapproved paid service.

## 7. Beta V1 end-to-end acceptance

Beta V1 is ready only when a new invited user can complete this journey on an iPhone:

1. Install and onboard without a Mac.
2. Sign in and open one persistent Ember partner.
3. Have a real multi-turn cloud conversation.
4. Ask Ember to perform at least one bounded, useful task.
5. See the task linked to the conversation with truthful server-backed progress.
6. Receive and open a readable result in the same conversation.
7. Leave the app, return later and recover the conversation and actual work state.
8. Understand what Ember has saved as memory and inspect, edit or delete it.
9. Recover safely from network loss, unknown acknowledgement, expired session and task failure.
10. See no fabricated progress, fake model response, misleading notification or unsupported approval.

**The Beta V1 gate is a real end-to-end journey against approved Platform services. A complete-looking Mock UI is not Beta V1.**

## 8. Immediate next actions

1. Continue [#72](https://github.com/basicv8vc/Ember/issues/72), [#73](https://github.com/basicv8vc/Ember/issues/73) and [#74](https://github.com/basicv8vc/Ember/issues/74) in parallel. Do not add unrelated UI polish.
2. Agent B completes the Platform gap proposal and labels each capability EXISTING / MOCK / PROPOSED / BLOCKED.
3. iOS Lead prepares the B0 integration plan and a thin repository/client boundary without inventing production routes.
4. Send the consolidated B1 proposal to CTO as soon as #73 is ready. Request one coherent decision covering identity, conversation, model gateway/cost, task linkage and privacy.
5. CTO/Platform begins B1 discovery in parallel with B0 implementation.
6. Keep [#69](https://github.com/basicv8vc/Ember/issues/69) as a separate small M2 QA cleanup; it does not block M3.
7. Defer APNs, external action approvals, voice, attachments, multi-Bot, Mac executor and complex memory until the core live conversation plus one real delegated task works end-to-end.

## 9. Roadmap governance

This document records **what we are building and why**. GitHub Issues record **who is doing what now**. PRs record **what changed and what evidence supports it**.

- Update milestone status and linked Issues when a milestone changes.
- Update this document when Founder changes product scope or CTO approves/rejects a cross-platform contract.
- Do not use this document to imply an API or capability is approved when it is only proposed.
- Record material product, architecture, privacy and cost decisions in GitHub.
- Keep milestone dates out until owners have estimated dependencies and delivery capacity; prefer evidence-based exit gates over speculative dates.

---

**Founder direction:** Ember Beta V1 is conversation-first. Conversation is the primary interface; Task and Commitment remain the durable work system. The goal is a partner that remembers what it agreed to do, keeps making progress, and reports back truthfully.
