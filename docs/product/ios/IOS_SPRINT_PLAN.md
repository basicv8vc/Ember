# Ember iOS — Milestones & First Sprint Plan

> **M2 delivery gate updated · CTO APPROVED 2026-11-01:** [IOS_M2_FAST_LANE.md](IOS_M2_FAST_LANE.md) ([Issue #50](https://github.com/basicv8vc/Ember/issues/50)).
> This supersedes the older M2 per-lane Simulator test/screenshot text below. M1, B0, security and production gates are unchanged.

> Planning-only draft · 2026-11-01 · Base `f02075b7d8139149efdb6bc28ac05d7f5d764ae5`
> **All Coding Agent prompts are drafts; none may start implementation before CTO approval.**

## Roadmap as independently demoable thin slices

| Gate/milestone                             | Deliverable                                                                                                                                                               | Dependency and exit condition                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **M0 / now**                               | PRD, journey, API gap audit, Shua UI audit, technical architecture, three prompts                                                                                         | This Draft PR reviewed by Jia + CTO, no app code                                                                                     |
| **M1 / Build & Contract Baseline**         | One Lead-owned, compilable `apps/ios/` SwiftUI Xcode project, shared app/unit/UI-test schemes, reproducible local Mac Simulator smoke; then B freezes DTO protocols       | M0 approved and merged; Xcode project baseline Draft PR verified and merged _before_ any A/B/C coding                                |
| **M2 / Sprint 1 — Mock-first UI**          | On the M1 buildable foundation, three lanes deliver labeled mock Welcome → Compose → receipt → timeline → outcome / cancellation / mock approval                          | B protocol freeze plus repeatable per-lane simulator build/test from independent worktree; Platform API work may proceed in parallel |
| **M3 / real controlled pilot**             | Authorized mobile identity, server inbox and real bounded notes→actions result; server-backed recovery **after force quit/relaunch on the same installed device/account** | Identity/Task list/result security and cloud model gate passed; no reinstall or second-device recovery claim yet                     |
| **M4 / extended recovery & notifications** | Authenticated recovery after **uninstall/reinstall and on a second device**, plus APNs result intent, secure deep links, approval-grade action explanation                | Additional account-linking, privacy and device-loss tests; notifications only after separate CTO gate                                |
| **Later / Mac Hero**                       | Optional Mac executor controls                                                                                                                                            | Device ownership/authorization/Executor Gateway; never required for cloud core                                                       |

No date commitment before cross-team estimates. M2 is a **simulated UI milestone** that may progress alongside CTO-owned Platform API implementation, not a production MVP. M3 is the first candidate true-value pilot; M4 adds reinstall/second-device restoration and push security.

## M1 mandatory bootstrap — one Owner before three Agent branches

**Owner: iOS Product Lead (single integration owner)**. Once M0 PR is approved **and merged**, make a separate M1 branch/worktree and Draft PR containing **only** a minimal, buildable skeleton: `apps/ios/Ember.xcodeproj`, shared scheme `Ember`, `EmberApp/App/**` composition entry, placeholder `Features/**`/`DesignSystem/**` groups or synchronized folder references, an empty native launch screen with permanent `MOCK ONLY` label, `EmberTests` and `EmberUITests` targets with one deterministic smoke test each, and an `apps/ios/README.md` build command. No real Auth, provider key, networking, analytics, paid service or sensitive test fixture.

**Proposed toolchain pin for M1**: local **Apple silicon Mac**, **macOS Tahoe 26.6+**, **Xcode 27.1** (stable release) and its available **iOS 27.1 Simulator runtime**, with **deployment target iOS 17.0**. Apple requirements: https://developer.apple.com/xcode/system-requirements/. This is a **planning baseline, not a claim that Jia's Mac has this setup**. At M1 start first record actual `sw_vers`, `xcodebuild -version`, `xcode-select -p` and `xcrun simctl list devices available`. If exact setup/runtime unavailable, stop and ask CTO to pin an approved compatible alternative (for example Xcode 26.6/macOS Tahoe 26.x) **before** writing production iOS code.

**Test execution location**: the authorized **local Mac** initially; existing Linux/Node GitHub CI cannot compile Xcode targets. Do not add paid GitHub-hosted macOS runners or Xcode Cloud without CTO cost approval. Add macOS CI only after costs, signing/secrets and simulator matrix are approved. M1 smoke uses an available simulator UDID from `simctl` (do not guess a device name):

```bash
xcodebuild -list -project apps/ios/Ember.xcodeproj
xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=<verified-UDID>' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'platform=iOS Simulator,id=<verified-UDID>' CODE_SIGNING_ALLOWED=NO test
```

M1 Draft PR must include exact Base/Head SHAs, OS/Xcode/Simulator versions, executable commands/log exit statuses, launch screenshot, app/unit/UI test target proof, source-file discovery strategy so A/B/C can add files **without touching `Ember.xcodeproj`**, limitations and revert plan. If no Mac toolchain is available, mark the entire build gate **BLOCKED / NOT RUN**; **do not start** the three coding lanes. After a verified, reviewed M1 bootstrap merges, B alone freezes shared DTO/protocols, then A/B/C start from that merged baseline in independent worktrees. Lead retains exclusive ownership of project file and `App/**`; any unavoidable project-file integration receives a Lead-only sequential window **before** claiming a lane independently buildable.

## Sprint 1 contract freeze (single owner before parallel)

CTO-designated iOS Lead freezes interfaces (not implementation): `EmberAPIClient`, `TaskRepositoryProtocol`, `TaskDTO/TaskEventDTO/ApprovalDTO` from audited code, `TaskPresentationState` + `ConnectionPhase`, `MockScenarioProvider`, deterministic fixture JSON, theme tokens. These live under `apps/ios/EmberApp/Domain` and `.../Networking/Protocols` once target path approved. **One owner: API/State Agent B**, other agents can only consume finalized frozen interfaces. If DTO changes are needed, Agent B submits a protocol PR and all lanes pause integration until reviewed. First freeze validation is paper/spec only at M0.

## Three non-overlapping Coding Agent lanes

| Lane                       | Owned files (after approved layout)                                                                                          | Forbidden files / boundaries                                                                           | Independently demonstrable DoD                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — UI / Design System** | `apps/ios/EmberApp/DesignSystem/**` and `.../Features/Onboarding/**`, `EmberUITests/DesignSystem/**`                         | `Domain/**`, `Networking/**`, `TaskDetail/**`, `Compose/**`, all platform/security files; no login SDK | Composer, status chip, activity row, empty/error views, welcome/privacy static UI; Dynamic Type, dark, VoiceOver, Reduce Motion, screenshots                                         |
| **B — API / State**        | `apps/ios/EmberApp/Domain/**`, `.../Networking/**`, `.../Persistence/**` (non-sensitive minimal index only), `EmberTests/**` | UI views, all `apps/api/**` / `packages/**`, Keychain real tokens/auth flows without CTO sign-off      | Stub/Fake TaskRepository, correct wire DTO parsing, SSE incremental parser, cursor/replay, idempotency-state tests, Cancel race; all network integration against local fixtures only |
| **C — Task Experience**    | `apps/ios/EmberApp/Features/Compose/**`, `.../Features/Inbox/**`, `.../Features/TaskDetail/**`, `EmberUITests/TaskFlow/**`   | DesignSystem implementation, Network/Domain models, Onboarding, all platform files                     | End-to-end simulator navigation and state-aware task detail using B's fake + A components; failure/reconnect/unknown ack/approval mock with honest labels                            |

**Composition root and Xcode project ownership:** the iOS Lead establishes the minimal `Ember.xcodeproj`, test targets and App entry **in M1, before the three lanes**. The shared project remains Lead-owned; file discovery or predeclared groups allow A/B/C to build/test each worktree independently. Lead accepts explicit sequential project-file changes only when unavoidable. No Agent edits `App/**` or `Ember.xcodeproj`. Each lane branches from the actual approved, merged M1/DTO baseline, not the older M0 SHA.

## Task prompts, dependencies, acceptance

Draft prompts: `agents/IOS_AGENT_A_UI_DESIGN.md`, `agents/IOS_AGENT_B_API_STATE.md`, `agents/IOS_AGENT_C_TASK_EXPERIENCE.md`.

1. **M1 Lead first ships a compilable project and test targets with successful local Simulator smoke; B then freezes protocols/fixtures** (must be reviewed, includes exact empty/error/replay shapes). A can prepare isolated design tokens without touching B; C may only sketch until freeze.
2. A and C then implement against those stable protocols; overlapping modifications require explicit handoff, no parallel edits to shared files.
3. PRs are Draft with linked planned Issue (create Issue after CTO approves actual scope), exact base/head SHA, ownership manifest, screenshot/demo, simulator and tests (or NOT RUN), unresolved risk, rollback. Merge order recommended B → A → C → Lead integration; merging requires explicit review, never automatic.
4. M2 review requires repeatable `xcodebuild test` simulator command for approved scheme, contract unit tests, accessibility screenshots, reconnect demo, visual “MOCK ONLY” audit; cannot claim iPhone device, APNs, production LLM or paid cloud tests.

## Definition of Done for a genuinely valuable P0 pilot (M3)

- A real user can authenticate and regain the same server Task/Agent after force quit/relaunch **within the same installation**, delegate notes-to-action-items, receive durable receipt, return, understand status, retrieve a real cloud-generated persisted Markdown result, and cancel safely; no Mac needed. Uninstall/reinstall and a second device are **M4**, not M3.
- No false indication of real action when using Mock. Failures have stable state recovery and retry semantics; receipts/requests are idempotent under ambiguous network ACK.
- Tested tenant isolation; no test tokens distributed; model gateway/egress/cost and sensitive-data retention approved by CTO; user-facing privacy text matches actual implementation.
- Traces/test logs include no prompt contents/token values; simulator unit/UI tests and authorized integration evidence attached.
- Deferred approval/push features are either correctly gated, or entirely hidden; they cannot be “papered over” with fake notifications or fake action detail.

## Blocking approvals and risk register

1. **CTO:** project placement/target/one-owner baseline and approval of native-only dependency stance.
2. **CTO + Platform:** identity + inbox + real safe task/result contracts, privacy/cost/security gate, API backlog ownership.
3. **CTO:** how to handle unknown POST ACK across app termination and production approval/notification gate ordering.

See `IOS_STATUS.md` for exactly three CTO decisions consolidated at review level. No Agent has been assigned/started and no Issue/PR for implementation should be created before M0 sign-off. Bounded UI/SwiftUI choices after approval belong to iOS Lead.
