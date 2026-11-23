# UX-04 PR 3 — Monochrome Chat Visual V1 Local Verification & Visual Acceptance

## 1. Environment & Devices Tested

- **Xcode:** Xcode 27.2 (`Build version 27B52`)
- **iOS Runtime:** `iOS 27.2 (24B8117)`
- **Tested Simulator Devices:**
  - `iPhone 16` (`393×852pt`, `3x`) — Light & Dark, English (`en_US`)
  - `iPhone SE (3rd generation)` (`375×667pt`, `2x`) — Light, Simplified Chinese (`zh-Hans` / `zh_CN`)
  - `iPhone 18 Pro` (`402×874pt`, `3x`) — Automated Unit/UI Test Suite, Dark + `AccessibilityLarge` (`AX`), Streaming + Stop
- **320pt Width Hardware Note:** `iPhone SE (1st generation)` (`com.apple.CoreSimulator.SimDeviceType.iPhone-SE`) cannot be created on the installed iOS 27.2 runtime (`SimError code=403: Incompatible device`). Narrow layout wrapping was verified directly on `375pt` (`iPhone SE (3rd generation)`) and under `UICTContentSizeCategoryAccessibilityLarge` (`ViewThatFits` / AX header wrapping).

## 2. Commands & Results

### Build

```bash
xcodebuild build-for-testing \
  -project apps/ios/Ember.xcodeproj \
  -scheme Ember \
  -destination 'platform=iOS Simulator,id=8A4CCF42-FD5C-4CCE-B6B8-05E967E552EF' \
  -derivedDataPath /tmp/ember-ux04-deriveddata
```

- Result: **`TEST BUILD SUCCEEDED`**

### Targeted Unit & UI Tests

```bash
xcodebuild test-without-building \
  -project apps/ios/Ember.xcodeproj \
  -scheme Ember \
  -destination 'platform=iOS Simulator,id=8A4CCF42-FD5C-4CCE-B6B8-05E967E552EF' \
  -derivedDataPath /tmp/ember-ux04-deriveddata \
  -only-testing:EmberTests/EmberChatMonochromeTokensTests \
  -only-testing:EmberUITests/EmberMonochromeChatUITests \
  -only-testing:EmberUITests/ConversationRootLaunchUITests \
  -only-testing:EmberUITests/ConversationComposerErgonomicsUITests \
  -only-testing:EmberUITests/ConversationSmartScrollingUITests \
  -only-testing:EmberUITests/B3ChatTasksIntegrationUITests
```

- **Unit Tests:** **PASS** — `EmberChatMonochromeTokensTests` (`2/2` passed, `0` failures)
- **UI Tests:** **PASS** — `20/20` passed (`0` failures):
  - `EmberMonochromeChatUITests`: `4/4` passed
  - `ConversationRootLaunchUITests`: `4/4` passed
  - `ConversationComposerErgonomicsUITests`: `4/4` passed
  - `ConversationSmartScrollingUITests`: `3/3` passed
  - `B3ChatTasksIntegrationUITests`: `5/5` passed

## 3. Issues Found & Fixed During Verification

1. **First-run empty chat UI test failure (`EmberMonochromeChatUITests.testFirstRunHeadlineAndStarterPromptKeepSendExplicit`)**:
   - **Cause:** Launching `--ember-show-onboarding` and tapping `View the mock demo` enters `ConversationDemoHost` with `ConversationFixtures.mainConversationID` (9 pre-populated messages), so `ConversationEmptyStateView` was never shown.
   - **Fix:** Added `--ember-mock-empty-chat` flag support in `AppCompositionRoot` / `MockB3ConversationRepository` / `ConversationDemoHost` (default fixtures unchanged), and updated `EmberMonochromeChatUITests` to test the real empty `LiveConversationHost` first-run screen (`More life. Less busywork.`, capability-aware starter prompt cards, explicit send, and composer local note).
2. **`zh-Hans` header subtitle stayed English (`"Personal AI agent"`)**:
   - **Cause:** `ConversationScreen.headerSubtitleView` used `Text("conversation.header.subtitle", tableName: "Conversation")`, which fell back to English when launched with `-AppleLanguages (zh-Hans)` on an English simulator OS. Same applied to `ConversationEmptyStateView` fallback strings.
   - **Fix:** Resolved via `String(localized: ..., table: "Conversation")` matching the rest of `LiveConversationHost` and `ConversationComposer`, and added a `zh-Hans` assertion (`"个人 AI 伙伴"`) in `EmberMonochromeChatUITests`.
3. **44pt minimum tap targets on Timeline / Top-Notice bordered buttons**:
   - **Cause:** `.frame(minHeight: 44)` outside `.buttonStyle(.bordered)` left `conversation-stop-reply` at `32pt` height in XCUITest, and `refreshRetryButton` / `resumePollingButton` used `minHeight: 32`.
   - **Fix:** Moved `.frame(minHeight: EmberDesignTokens.minTapTarget)` inside `Button` labels for `conversation-stop-reply`, `conversation-retry`, `refreshRetryButton`, and `resumePollingButton`, and verified `conversation-stop-reply` >= `44pt` in `EmberMonochromeChatUITests`.
4. **Monochrome Visual V1 consistency polish**:
   - Aligned Composer `.stop` button (`chatActionFill` / `chatActionForeground`), attachment chip file icon (`chatBrandInk` / `chatAgentBubble`), `.cloud` environment pill (`chatPaper` / `chatHairline`), `JumpToLatest` iOS <26 fallback (`chatPaper` / `chatHairline`), and header schedule active dot (`chatBrandInk`), while preserving semantic warning/error/MOCK ONLY disclosures.
   - Added `.multilineTextAlignment(.leading)` on user message text so multi-line user bubbles wrap cleanly inside right-aligned bubbles.

## 4. Captured Real Simulator Screenshots

| File | Device / Size | Appearance / Locale | Coverage |
| --- | --- | --- | --- |
| `chat-first-run-light.png` | `iPhone 16` (`393pt`) | Light · `en_US` | Monochrome header, `MOCK ONLY` pill, first-run headline, capability-aware starter cards, Composer, native Tab Bar |
| `chat-first-run-375-zh-hans.png` | `iPhone SE (3rd gen)` (`375pt`) | Light · `zh-Hans` | Narrow-width Chinese first-run layout (`个人 AI 伙伴`, `多点生活，少点琐事。`, `可以从这里开始`) |
| `chat-conversation-light.png` | `iPhone 16` (`393pt`) | Light · `en_US` | Active Chat conversation with `TaskActivityCard`, `OutcomeCard`, Composer, native Tab Bar |
| `chat-conversation-dark.png` | `iPhone 16` (`393pt`) | Dark · `en_US` | Dark Mode `#111111` canvas, `#202020` composer, contrast & native Dark Tab Bar |
| `chat-zh-hans.png` | `iPhone SE (3rd gen)` (`375pt`) | Light · `zh-Hans` | Active Chinese UI at `375pt` (`个人 AI 伙伴`, `给 Ember 发消息…`, `对话` / `任务`) |
| `chat-dark-zh-hans-ax.png` | `iPhone 18 Pro` (`402pt`) | Dark · `zh-Hans` · `AXLarge` | Wrapped header with `MOCK ONLY` on line 2, `个人 AI 伙伴`, 44pt composer targets |
| `chat-streaming-stop.png` | `iPhone 18 Pro` (`402pt`) | Light · `en_US` | Multi-line user bubble, timeline `Preparing MOCK reply...` + `44pt` Stop button, Composer Stop button |

## 5. Known Limitations / Remaining Items

- **P0:** None.
- **P1:** None.
- **P2:**
  - `320pt` hardware width (`iPhone SE (1st gen)`) could not be booted on Xcode 27.2 / iOS 27.2 Simulator runtime (`SimError 403`).
  - Screenshots and UI tests use local mock repositories (`--ember-mock-chat-tasks`, `--ember-start-conversation`); live cloud V2 SSE streaming and physical-device network acceptance remain governed by separate integration/QA checks.
