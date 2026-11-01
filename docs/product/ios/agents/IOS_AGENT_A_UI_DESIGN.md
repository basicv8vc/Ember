# DRAFT Agent A — iOS Design System & Onboarding

> IOS-LEAD-001 / M2 planning only. **DO NOT EXECUTE before CTO approves PRD, architecture, target, shared protocols and implementation gate.**

## Role & first instruction after authorization

You own the iOS visual foundation and short onboarding/privacy explanation. Fetch `origin/main`, record actual base SHA, create your own independent worktree and branch. Read `docs/product/ios/IOS_PRODUCT_LEAD.md`, `IOS_MVP_PRD.md`, `IOS_USER_JOURNEY.md`, `IOS_ARCHITECTURE_PROPOSAL.md` and `IOS_UI_REFERENCE_AUDIT.md`. Use Shua as a design reference only; do not copy source/assets/config.

**Allowed modifications**, after CTO confirms path: `apps/ios/EmberApp/DesignSystem/**`, `apps/ios/EmberApp/Features/Onboarding/**`, and `apps/ios/EmberUITests/DesignSystem/**`. No other files; don't claim unowned Xcode project integration.

**Forbidden**: `apps/ios/EmberApp/Domain/**`, `Networking/**`, `Persistence/**`, `Features/Compose/**`, `Inbox/**`, `TaskDetail/**`, `App/**`, `Ember.xcodeproj`, platform `apps/api/**`, `apps/worker/**`, `packages/**`, `migrations/**`; no external SDK, payments, authorization policy or secret.

## Build scope

- Stateless `PromiseComposerCard` (draft / focus / submit-enablement bindings; no network call; 44pt accessible target, full card focus), `TaskStatusBadge` (text+icon), `ActivityRow`, small recoverable `InlineNotice`, empty/error views.
- Welcome screen: a single product promise, cloud-processing explanation placeholder **pending CTO-approved wording**; do not fake user consent authorization or account session.
- Native adaptive layout for Dynamic Type, VoiceOver, Reduce Motion, English/Simplified Chinese, dark/light. Visual style warm, quiet and semantic, no fancy persistent motion or faux percentage progress.
- Mock-preview surfaces bear prominent, persistent “MOCK ONLY · No real AI execution” banner/watermark; status labels must not be driven by animations.

## Delivery & checks

- Component previews: empty/long Chinese/English/error/queued/waiting/completed, minimum iPhone width and iPad split-view.
- Accessibility audit: labels and hints, focus order, large type clipping, colors nonexclusive, control targets and contrast.
- Simulator UI tests for onboarding navigation and component accessibility. If unavailable, record NOT RUN, never fake pass.
- One Draft PR only, with exact actual base/head SHAs, manifest, screenshots / screen recording, test command and real results, risks, rollback (“revert feature PR”), no auto-merge.
- Coordinate with B for DTO enum names; no shared file edits. Any auth/consent or iOS-target question goes to Lead→CTO before implementation.
