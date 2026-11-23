# NAV-02 PR #284 Simulator Verification Evidence

Verified on commit `f04725bbe747443f8aed6f2e593e99687236468e` (`feat/ios-nav02-sidebar-directory`), and additionally verified in a clean temporary local merge (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ f04725bbe747443f8aed6f2e593e99687236468e`).

## Review P1 / P2 Fixes & Spot-Check Verification
- **P1 — Discoverable & Assistive-Tech Accessible Sidebar Entry (without top-left toggle buttons):**
  - Preserved the clean monochrome header (`ConversationScreen.swift` untouched; `TaskInboxView.swift` keeps `tasks-open-schedules` in `.topBarLeading`).
  - Discreet monochrome left-edge pull cue pill (`ember-sidebar-edge-hint`, `3pt × 36pt` at `padding(.leading, 3)`, fading `(1 - progress)`, `.allowsHitTesting(false)`, `.accessibilityHidden(true)`).
  - Focusable native `Menu` items on both root tabs (`live-conversation-open-sidebar` inside Chat's `>= 44x44pt` `live-conversation-menu`, and `tasks-open-sidebar` inside Tasks' `.topBarTrailing` `tasks-navigation-menu`), plus `ember-sidebar-backdrop` (`>= 44pt`, non-empty accessibility label) and `.accessibilityAction(.escape)` for closing.
- **Keyboard & Draft Spot-Check (Review Item #3):**
  - `setSidebarPresented(_ present: Bool, ...)` now sends `resignFirstResponder` whenever `present == true` (covers menu open, VoiceOver action, and programmatic open in addition to interactive swipe), verified with `app.keyboards.count == 0` and preserved unsent Chat draft after menu-triggered open on both 402pt and 375pt.
- **P2 — Initial-Touch Edge Boundary & Scroll Coexistence:**
  - `EdgeStartPanGestureRecognizer.initialTouchX` captured in `touchesBegan` (`reset()` on finish) across both `gestureRecognizerShouldBegin` and `shouldBeRequiredToFailBy`.
  - Automated boundary tests pass on **402pt** (`iPhone 18 Pro`) and **375pt** (`iPhone SE 3rd gen`): `x ≈ 32–35pt` (`<= 40pt`) opens cleanly even when movement crosses `40pt` before recognition; content-area horizontal swipes, left-edge vertical scroll, pushed `TaskDetailView` pop back, and horizontal `ScrollView` preset chips inside sheets stay unaffected.

## Test Commands & Observed Results (iOS 27.2 Simulator)

1. **PR #284 (`f04725bbe747443f8aed6f2e593e99687236468e`) — `iPhone 18 Pro` (`402pt`, Light, EN + `zh-Hans` `AXLarge`):**
   - `EmberSidebarUITests`: **4/4 passed** (0 failures)
   - `B3ChatTasksIntegrationUITests`: **5/5 passed** (0 failures)
   - `ConversationRootLaunchUITests`: **4/4 passed** (0 failures)
   - Total: **13/13 passed** (`** TEST SUCCEEDED **`)

2. **PR #284 (`f04725bbe747443f8aed6f2e593e99687236468e`) — `iPhone SE (3rd generation)` (`375pt`, Mock Mode):**
   - `EmberSidebarUITests`: **4/4 passed** (0 failures — leading Schedules + trailing `+`, `refresh`, and `tasks-navigation-menu` open/close cleanly without overlap; `deviceMonitor` is nil in mock mode).

3. **Combined Integration (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ f04725bbe747443f8aed6f2e593e99687236468e`):**
   - Shared files with `#287`: **2** (`Conversation.xcstrings` and `LiveConversationHost.swift`), **0 textual conflicts** (`git merge-tree --write-tree` tree `753216a00fe5997d752e63cc9eb20cf43fac2b53`).
   - Combined `test` on `iPhone 18 Pro` (`402pt`):
     - `EmberChatMonochromeTokensTests`: **2/2 passed**
     - `EmberMonochromeChatUITests`: **4/4 passed**
     - `B3ChatTasksIntegrationUITests`: **5/5 passed**
     - `EmberSidebarUITests`: **4/4 passed**
     - Total: **15/15 passed** (`** TEST SUCCEEDED **`)

## Screenshots
- `01-sidebar-chat-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`f04725b`)
- `02-sidebar-tasks-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`f04725b`)
- `03-sidebar-chat-dark-zhhans-axlarge-402pt.png` — System Dark Mode, `zh-Hans`, `AXLarge`, `iPhone 18 Pro` (`bbda443`, UI unchanged in `f04725b`)
- `04-sidebar-chat-light-393pt-iphone16.png` — Light Mode, EN, `iPhone 16` (`393pt`, `f2296549`)
- `05-sidebar-chat-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, `f04725b`)
- `06-sidebar-tasks-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, `f04725b`)
- `07-combined-pr287-pr284-chat-sidebar-light-402pt.png` — Combined `#287 + #284` (`f04725b`), Light Mode, EN, `iPhone 18 Pro`
- `08-combined-pr287-pr284-chat-monochrome-header-402pt.png` — Combined `#287 + #284` (`f04725b`), Light Mode, EN, `iPhone 18 Pro`
