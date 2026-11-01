# DRAFT Agent C — Task Experience (Promise → Progress → Outcome)

> IOS-LEAD-001 / M2 planning only. **DO NOT EXECUTE before CTO approval and Agent B shared protocol freeze.**

## Role & first instruction after authorization

You own the user-facing Task journey, not API contracts or platform services. Fetch current `origin/main`, record actual base SHA, create independent worktree/branch. Read `IOS_MVP_PRD.md`, `IOS_USER_JOURNEY.md` and frozen interfaces produced by B. Use UI components owned by A through stable public initializer; no overlapping edits.

**Allowed** (after app path approved): `apps/ios/EmberApp/Features/Compose/**`, `.../Inbox/**`, `.../TaskDetail/**`, `apps/ios/EmberUITests/TaskFlow/**`. **Forbidden**: `DesignSystem/**`, `Onboarding/**`, `Domain/**`, `Networking/**`, `Persistence/**`, `Security/**`, `App/**`, `Ember.xcodeproj`, every backend/platform/shared/secret file. Request UI component changes from Agent A, DTO changes from Agent B.

## Build scope

- Template “整理笔记成行动清单” with editable input, pre-submit cloud-processing scope text, draft retained in foreground on recoverable error.
- Promise Card: only label “已接收” on 202/200 Receipt; ambiguous POST ACK displays “尚未确认” and same-key retry intent from B.
- Status-first Task Detail: authoritative server snapshot and chronological event timeline; queued/running/waiting_approval/retryable_failed/completed/failed/cancelled visible as text and icons; lost SSE shows reconnect banner, not fake work.
- Mock controlled demo: consume injected Fake repository only, **permanent MOCK ONLY visual** on inbox/detail/outcome/approval/notification placeholder. Completing a fake fixture does not pretend real AI output.
- Outcome panel: read-only persisted Artifact/Result fixture; if status completed but result absent, show “成果暂不可读取”. Copy/Share Sheet uses provided content only.
- Cancel CTA: differentiate pending cancellation and terminal; approval **digest-only** must show “操作详情不足，不能授权” and disable production approve. Provide a clearly marked separate mock approval fixture to exercise interaction.
- Navigation and empty/failed/offline/no-history screens; don't present locally known tasks as a complete cross-device inbox until server list contract exists.

## Demo & DoD

A scripted simulator run: onboarding placeholder → paste example → submit/ack → queued/running → disconnect/reconnect → mock completion and artifact; then cancel race, approval expired, 401/404 errors, missing artifact, app scene resume. All fake response scripts deterministic and labeled.

UI Test evidence: exact xcodebuild command, simulator OS/device, screenshots/video of light/dark and large fonts, VoiceOver semantic inspections, pass/fail and known gaps. If unavailable, mark NOT RUN.

Draft PR only: approved Issue, actual Base/Head SHA, scoped file manifest, tested scenarios vs NOT RUN, risks, rollback, and explicit “no production execution/notification” disclaimer. No paid services, deployment or auto-merge. Any request to expose unsafe approval or unsupported API stops for Lead→CTO review.
