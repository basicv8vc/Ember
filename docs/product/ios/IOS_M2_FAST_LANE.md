# Ember iOS — M2 Fast Lane Delivery Gates

> **CTO APPROVED · 2026-11-01 · iOS Lead owner**
>
> Decision: [Issue #50](https://github.com/basicv8vc/Ember/issues/50). Scope: **M2 Mock-first Simulator development only**.
>
> This document supersedes older **M2 per-lane mandatory Simulator test and screenshot wording** in [IOS_SPRINT_PLAN.md](IOS_SPRINT_PLAN.md) and draft A/B/C agent prompts. It does **not** supersede B0 frozen contracts, security/API gates, M1 historical evidence, or M2 final acceptance. No new production authorization is granted.

## Why

Three independent Mac Coding Agents share one developer Mac. Running full `xcodebuild test` suites concurrently causes Simulator resource contention and delays routine SwiftUI work. M2 therefore uses **final-head compile-first PR acceptance** and **batched main-branch Simulator QA**, with targeted tests for high-risk logic.

## Per-PR fast lane (routine UI/mock-only changes)

All must be satisfied **before iOS Lead merges**:

1. One feature branch/worktree and Draft PR linked to an Issue; actual Base SHA, full final Head SHA, owned file manifest, behavior summary, risks and rollback. No edits to other Agent-owned files.
2. **Successful real Xcode build of the final Head SHA** (not just the last nearby commit). Record macOS/Xcode/SDK version, exact command, exit code and an inspectable build log or relevant build-log excerpt in the PR:
   ```sh
   xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
   ```
   The generic Simulator SDK destination compiles without booting a Simulator. If it fails, the PR **cannot merge**.
3. All applicable GitHub CI checks green. Linux/Node CI does **not** substitute for actual Xcode compilation.
4. iOS Lead inspects actual diff, product behavior and visible **MOCK ONLY** boundaries; no contract/auth/privacy/security/cost changes are slipped into UI PRs.
5. Simulator Unit/UI tests and screenshot capture **may be skipped for routine UI-only PRs**. Record `NOT RUN — deferred to main-branch integration` in the PR; never claim a test passed when it did not. Avoid forcing each Agent to launch a Simulator.
6. Lead may mark the reviewed Draft PR ready and squash-merge with explicit final Head SHA after these gates; no auto merge.

## High-risk test gate (cannot be waived by routine UI fast lane)

For networking and reconnection state, incremental SSE parsing, task status/command state machines, unknown POST ACK/idempotency replay, cancellation and completion races, persistence/migrations, and error handling that could lose a task or user input:

- Require deterministic, reviewable **targeted tests** for the changed behavior, with actual passing execution evidence before merging. Do not replace tests with a description of what they would test.
- Use one exclusive Mac Simulator testing slot; stop concurrent A/B/C Simulator runs. Targeted Unit tests are preferred over the entire UI suite for these branches.
- If no reliable test environment is available, keep the PR Draft/blocked or obtain a **specifically documented** Lead/CTO risk disposition appropriate to the change; do not silently downgrade to compile-only.
- Changes to B0 public DTO/protocol, Xcode project/App composition root, persistent data models or important architecture need explicit Lead coordination; changes affecting Platform API, identity, tenant, approval, security, privacy, secrets, paid services or production costs still require CTO approval.

## Batched `main` validation

- **At most three routine iOS PR merges between full validation checkpoints.** Count from the last successful `main` checkpoint; if none exists for this M2 batch, count relevant M2 feature merges already made (including PR #47) rather than resetting opportunistically.
- Also validate at the **A/B/C integration milestone**, before M2 is declared complete, and whenever a regression or risky cross-branch interaction is suspected.
- **One Lead-designated owner, one Simulator** (no parallel test jobs). Record the exact merged `main` SHA, macOS, Xcode, runtime and Simulator UDID. Run real scheme build/test with `-parallel-testing-enabled NO` and capture `.xcresult`, test counts, commands and exit codes.
- Integration QA covers Compose → receipt/unknown ACK → Task Inbox → events/reconnect → mock action-list outcome, cancellation race, missing outcome, approval disabled, `MOCK ONLY` disclosure, English/zh-Hans, light/dark, large text, VoiceOver, and screenshots. All scenarios must be honest about live vs fixture capabilities.
- **If regression is found, stabilize and re-test before merging additional feature PRs.** Compile-only branches do not establish successful runtime behavior.
- M2 is **not accepted** until the recorded merged `main` passes the full Simulator gate and visual/user-journey QA. M3/production readiness remains separately gated.

## Operational tracker

The iOS Lead maintains a current merged-PR count and most recent successful `main` QA SHA in the M2 integration Issue/PR or status document; only **verified** test evidence may reset the counter. The batch containing PR #47 starts with **1 routine M2 feature merge and no post-integration full-suite success** as of this decision.

For the active lanes:

- **Agent A / PR #47:** already merged after technical review, with prior-head test evidence and final-head build recorded honestly. Its merge counts toward the first M2 batch; scroll/VoiceOver and actual App route verification are deferred to integration.
- **Agent C / PR #48:** routine mock presentation may use fast lane, but definitive-error vs ambiguous-ACK code must be reviewed and targeted-tested if its behavior is changed; no false full-journey claim.
- **Agent B / Issue #46:** SSE, lost ACK, cancellation races and state coordination are **high risk** and require focused deterministic tests, scheduled exclusively, before merge.

## Scope and toolchain

For M2 Mock-first only, CTO already allowed macOS 26.5.1, Xcode 26.3 and iOS 27.0 Simulator. The toolchain exception must be re-evaluated before release. No device/signing, production identity, real cloud execution, APNs, App Store submission, third-party paid infrastructure, or new platform API contract is authorized by this policy.
