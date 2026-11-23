# NAV-02 PR #284 Simulator Verification Evidence

Verified on commit `7402e2945c76385e80f182586962fc0f74965804` (`feat/ios-nav02-sidebar-directory`), and additionally verified in a clean temporary local merge (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ 7402e2945c76385e80f182586962fc0f74965804`).

## Highlights Fixed & Verified
- **Visual V1 Monochrome Unification**: Aligned `EmberSidebarOverlay`, `ConversationScreen` Chat sidebar trigger, and `TaskInboxView` Tasks sidebar trigger with the Founder-selected Black / White / Grayscale palette while keeping amber `MOCK ONLY` disclosure and red destructive Sign Out action outside mock mode.
- **Backdrop Hit-Testing & Dismissal**: Constrained `ember-sidebar-backdrop` interactive hit/accessibility frame to the exposed trailing scrim strip (`x >= drawerWidth`) so tapping the dimmed backdrop never overlaps the Sidebar drawer rows while the full-screen dim scrim continues to absorb taps cleanly, alongside close button (`>= 44pt`), left-drag gesture, and `.accessibilityAction(.escape)`.
- **Navigation, Localization & Tasks Toolbar Separation**: Moved `ember-sidebar-open-tasks` cleanly into `.topBarLeading` and `tasks-open-schedules` into `.topBarTrailing` when Sidebar wiring is active; fixed `zh-Hans` localization (`"你的个人 AI 助手"`, `"标签页"`, `"工具"`); and verified unsent Chat draft + mutated Tasks state persist across Sidebar switches (`Chat <-> Tasks <-> Memory <-> Schedules`).

## Test Commands & Observed Results (iOS 27.2 Simulator)

1. **PR #284 (`7402e2945c76385e80f182586962fc0f74965804`) — `iPhone 18 Pro` (`402pt`, Light, EN + `zh-Hans` AXLarge):**
   ```bash
   xcodebuild test -project apps/ios/Ember.xcodeproj -scheme Ember \
     -destination "platform=iOS Simulator,id=8A4CCF42-FD5C-4CCE-B6B8-05E967E552EF" \
     -derivedDataPath /tmp/ember-pr284-deriveddata \
     -only-testing:EmberUITests/EmberSidebarUITests \
     -only-testing:EmberUITests/B3ChatTasksIntegrationUITests \
     -only-testing:EmberUITests/ConversationRootLaunchUITests
   ```
   - `EmberSidebarUITests`: **3/3 passed** (0 failures)
   - `B3ChatTasksIntegrationUITests`: **5/5 passed** (0 failures)
   - `ConversationRootLaunchUITests`: **4/4 passed** (0 failures)
   - Total: **12/12 passed** (`** TEST SUCCEEDED **`)

2. **PR #284 — Genuine Dark Mode (`xcrun simctl ui ... appearance dark`, `zh-Hans`, `UICTContentSizeCategoryAccessibilityLarge`, `402pt`):**
   - `EmberSidebarUITests/testSidebarInZhHansDarkAndAccessibilityTextRemainsDismissable`: **1/1 passed** (`** TEST EXECUTE SUCCEEDED **`)

3. **PR #284 — Small Screens (`375pt` `iPhone SE (3rd generation)` & `393pt` `iPhone 16`):**
   - `iPhone SE (3rd generation)` (`375pt`): `EmberSidebarUITests` **3/3 passed** (`** TEST EXECUTE SUCCEEDED **`)
   - `iPhone 16` (`393pt`): `EmberSidebarUITests/testChatSidebarOpensShowsOnlyActualDestinationsAndPreservesDraft` **1/1 passed** (`** TEST EXECUTE SUCCEEDED **`)

4. **Combined Integration (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ 7402e2945c76385e80f182586962fc0f74965804`):**
   - `git merge-tree --write-tree origin/feat/ios-ux04-chat-monochrome-v1 7402e2945c76385e80f182586962fc0f74965804` exited `0` (tree `a3ddafe779e91c8257de7fd0fcba6be511551a1e`) with **0 textual merge conflicts** across all 3 shared files (`Conversation.xcstrings`, `ConversationScreen.swift`, `LiveConversationHost.swift`).
   - Combined `test-without-building` on `iPhone 18 Pro` (`402pt`):
     - `EmberChatMonochromeTokensTests`: **2/2 passed**
     - `EmberMonochromeChatUITests`: **4/4 passed**
     - `B3ChatTasksIntegrationUITests`: **5/5 passed**
     - `EmberSidebarUITests`: **3/3 passed**
     - Total: **14/14 passed** (`** TEST EXECUTE SUCCEEDED **`)

## Screenshots
- `01-sidebar-chat-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`1206x2622`), Sidebar open over Chat tab
- `02-sidebar-tasks-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`1206x2622`), Sidebar open over Tasks tab (`tasks-open-schedules` moved to trailing, Sidebar selected on Tasks)
- `03-sidebar-chat-dark-zhhans-axlarge-402pt.png` — System Dark Mode, `zh-Hans`, `AXLarge`, `iPhone 18 Pro` (`1206x2622`)
- `04-sidebar-chat-light-393pt-iphone16.png` — Light Mode, EN, `iPhone 16` (`393pt`)
- `05-sidebar-chat-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, Sidebar open over Chat)
- `06-sidebar-tasks-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, Sidebar open over Tasks)
- `07-combined-pr287-pr284-chat-sidebar-light-402pt.png` — Combined `#287 + #284` build, Light Mode, EN, `iPhone 18 Pro`, expanded monochrome Sidebar over Visual V1 monochrome Chat
- `08-combined-pr287-pr284-chat-monochrome-header-402pt.png` — Combined `#287 + #284` build, Light Mode, EN, `iPhone 18 Pro`, active Chat showing monochrome `ember-sidebar-open-chat` header button and timeline cards
