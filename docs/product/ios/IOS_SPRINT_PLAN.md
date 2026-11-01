# Ember iOS — Milestones & First Sprint Plan

> Planning-only draft · 2026-11-01 · Base `f02075b7d8139149efdb6bc28ac05d7f5d764ae5`
> **All Coding Agent prompts are drafts; none may start implementation before CTO approval.**

## Roadmap as independently demoable thin slices

| Gate/milestone                    | Deliverable                                                                                                                                                  | Dependency and exit condition                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **M0 / now**                      | PRD, journey, API gap audit, Shua UI audit, technical architecture, three prompts                                                                            | This Draft PR reviewed by Jia + CTO, no app code                                                                |
| **M1 / UI Contract Freeze**       | CTO approves `apps/ios`, deployment target, local privacy and Auth boundaries; Platform agrees DTO fixtures/required gap sequence                            | Signed-off contract snapshot; no production credentials                                                         |
| **M2 / Sprint 1 — Mock-first UI** | Simulator Demo: Welcome → Compose → receipt-styled task details → event timeline → mock approval/cancel/error; explicit and persistent `MOCK ONLY` watermark | UI/State/Feature agents on separate worktrees; all test claims honest                                           |
| **M3 / real controlled pilot**    | Authorized mobile identity + server inbox + real bounded notes→actions task/result, actual cloud run/status                                                  | CTO Platform security/model/budget gates, user privacy/terms, safe integration environment, end-to-end evidence |
| **M4 / recovery & notifications** | Reinstall/cross-device recovery, APNs result intent, deep-link auth, approval-grade action explanation                                                       | Dedicated CTO-approved API/security review; notifications only after tested                                     |
| **Later / Mac Hero**              | Optional Mac executor controls                                                                                                                               | Device ownership/authorization/Executor Gateway; never required for cloud core                                  |

No date commitment before cross-team estimates. M2 is a **simulated UI milestone**, not a production MVP. M3 is the first candidate true-value pilot.

## Sprint 1 contract freeze (single owner before parallel)

CTO-designated iOS Lead freezes interfaces (not implementation): `EmberAPIClient`, `TaskRepositoryProtocol`, `TaskDTO/TaskEventDTO/ApprovalDTO` from audited code, `TaskPresentationState` + `ConnectionPhase`, `MockScenarioProvider`, deterministic fixture JSON, theme tokens. These live under `apps/ios/EmberApp/Domain` and `.../Networking/Protocols` once target path approved. **One owner: API/State Agent B**, other agents can only consume finalized frozen interfaces. If DTO changes are needed, Agent B submits a protocol PR and all lanes pause integration until reviewed. First freeze validation is paper/spec only at M0.

## Three non-overlapping Coding Agent lanes

| Lane                       | Owned files (after approved layout)                                                                                          | Forbidden files / boundaries                                                                           | Independently demonstrable DoD                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — UI / Design System** | `apps/ios/EmberApp/DesignSystem/**` and `.../Features/Onboarding/**`, `EmberUITests/DesignSystem/**`                         | `Domain/**`, `Networking/**`, `TaskDetail/**`, `Compose/**`, all platform/security files; no login SDK | Composer, status chip, activity row, empty/error views, welcome/privacy static UI; Dynamic Type, dark, VoiceOver, Reduce Motion, screenshots                                         |
| **B — API / State**        | `apps/ios/EmberApp/Domain/**`, `.../Networking/**`, `.../Persistence/**` (non-sensitive minimal index only), `EmberTests/**` | UI views, all `apps/api/**` / `packages/**`, Keychain real tokens/auth flows without CTO sign-off      | Stub/Fake TaskRepository, correct wire DTO parsing, SSE incremental parser, cursor/replay, idempotency-state tests, Cancel race; all network integration against local fixtures only |
| **C — Task Experience**    | `apps/ios/EmberApp/Features/Compose/**`, `.../Features/Inbox/**`, `.../Features/TaskDetail/**`, `EmberUITests/TaskFlow/**`   | DesignSystem implementation, Network/Domain models, Onboarding, all platform files                     | End-to-end simulator navigation and state-aware task detail using B's fake + A components; failure/reconnect/unknown ack/approval mock with honest labels                            |

**Composition root and Xcode project ownership:** a dedicated single-owner integration window held by iOS Lead **after** A/B/C Draft PRs are ready. No concurrent PR may edit `Ember.xcodeproj` or `App/**`; each lane delivers source components compiled in isolation / added to a preapproved baseline and documents any project-file integration needed. Use three independent Git worktrees from actual current `origin/main`, unique branches, no direct main pushes; do not create them before approval.

## Task prompts, dependencies, acceptance

Draft prompts: `agents/IOS_AGENT_A_UI_DESIGN.md`, `agents/IOS_AGENT_B_API_STATE.md`, `agents/IOS_AGENT_C_TASK_EXPERIENCE.md`.

1. **B first freezes protocols/fixtures** (must be reviewed, includes exact empty/error/replay shapes). A can prepare isolated design tokens without touching B; C may only sketch until freeze.
2. A and C then implement against those stable protocols; overlapping modifications require explicit handoff, no parallel edits to shared files.
3. PRs are Draft with linked planned Issue (create Issue after CTO approves actual scope), exact base/head SHA, ownership manifest, screenshot/demo, simulator and tests (or NOT RUN), unresolved risk, rollback. Merge order recommended B → A → C → Lead integration; merging requires explicit review, never automatic.
4. M2 review requires repeatable `xcodebuild test` simulator command for approved scheme, contract unit tests, accessibility screenshots, reconnect demo, visual “MOCK ONLY” audit; cannot claim iPhone device, APNs, production LLM or paid cloud tests.

## Definition of Done for a genuinely valuable P0 pilot (M3)

- A real user can create/recover an account, delegate notes-to-action-items, receive durable receipt, switch away, return, understand status, retrieve a real cloud-generated and persisted Markdown result, and cancel safely; no Mac needed.
- No false indication of real action when using Mock. Failures have stable state recovery and retry semantics; receipts/requests are idempotent under ambiguous network ACK.
- Tested tenant isolation; no test tokens distributed; model gateway/egress/cost and sensitive-data retention approved by CTO; user-facing privacy text matches actual implementation.
- Traces/test logs include no prompt contents/token values; simulator unit/UI tests and authorized integration evidence attached.
- Deferred approval/push features are either correctly gated, or entirely hidden; they cannot be “papered over” with fake notifications or fake action detail.

## Blocking approvals and risk register

1. **CTO:** project placement/target/one-owner baseline and approval of native-only dependency stance.
2. **CTO + Platform:** identity + inbox + real safe task/result contracts, privacy/cost/security gate, API backlog ownership.
3. **CTO:** how to handle unknown POST ACK across app termination and production approval/notification gate ordering.

See `IOS_STATUS.md` for exactly three CTO decisions consolidated at review level. No Agent has been assigned/started and no Issue/PR for implementation should be created before M0 sign-off. Bounded UI/SwiftUI choices after approval belong to iOS Lead.
