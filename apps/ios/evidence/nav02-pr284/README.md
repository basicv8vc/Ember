# NAV-02 PR #284 Simulator Verification Evidence

Verified on commit `f2296549f9cf40c890b39a3ab2cf2e6caf2acd57` (`feat/ios-nav02-sidebar-directory`), and additionally verified in a clean temporary local merge (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ f2296549f9cf40c890b39a3ab2cf2e6caf2acd57`).

## Interaction & Visual Design Highlights
- **Interactive Edge-Swipe Drawer (ChatGPT / Shua CoPaper style):**
  - Removed the top-left hamburger toggle button from Chat and Tasks headers and removed the drawer header close (`X`) button — Chat retains its clean monochrome emblem, and Tasks keeps `tasks-open-schedules` cleanly in `.topBarLeading`.
  - **Left-edge swipe to open (`x <= 40pt`, left-to-right):** UIKit `UIPanGestureRecognizer` bridge (`SidebarSwipeBridge`) attached seamlessly on `UIWindow` tracks the finger 1:1 with `Transaction(disablesAnimations: true)` and settles cleanly with `.interpolatingSpring(stiffness: 320, damping: 34, initialVelocity: ...)` while shifting the main `TabView` horizontally in sync and dimming the exposed peek.
  - **Right-to-left swipe to close (anywhere) + scrim tap:** Tracks 1:1 from open back to closed; preserves vertical scrolling inside `ScrollView` (via `shouldBeRequiredToFailBy` / velocity direction lock) and keeps pushed child detail views (`TaskDetailView`) free for native iOS interactive swipe-back (`canSwipeOpenFromEdge` checks empty navigation paths and no presented modal).
- **Visual V1 Monochrome & Localization:**
  - `EmberSidebarOverlay` matches the Black / White / Grayscale palette (`#FFFFFF`/`#202020`, `#F3F3F3`/`#292929`, `#E9E9E9`/`#383838`, `#E3E3E3`/`#454545`), preserving amber `MOCK ONLY` disclosure and red Sign Out outside Mock mode.
  - All Sidebar labels (`"你的个人 AI 助手"`, `"标签页"`, `"工具"`) resolve natively in `zh-Hans` and adapt under `AXLarge` and Dark Mode.

## Test Commands & Observed Results (iOS 27.2 Simulator)

1. **PR #284 (`f2296549f9cf40c890b39a3ab2cf2e6caf2acd57`) — `iPhone 18 Pro` (`402pt`, Light, EN + `zh-Hans` `AXLarge`):**
   - `EmberSidebarUITests`: **3/3 passed** (0 failures)
   - `B3ChatTasksIntegrationUITests`: **5/5 passed** (0 failures)
   - `ConversationRootLaunchUITests`: **4/4 passed** (0 failures)
   - Total: **12/12 passed** (`** TEST SUCCEEDED **`)

2. **PR #284 — Genuine System Dark Mode (`xcrun simctl ui ... appearance dark`, `zh-Hans`, `AXLarge`, `402pt`):**
   - `EmberSidebarUITests/testSidebarSwipeInZhHansDarkAndAccessibilityTextRemainsDismissable`: **1/1 passed** (`** TEST EXECUTE SUCCEEDED **`)

3. **PR #284 — Small Screens:**
   - `iPhone SE (3rd generation)` (`375pt`): `EmberSidebarUITests` **3/3 passed** (`** TEST EXECUTE SUCCEEDED **`)
   - `iPhone 16` (`393pt`): `EmberSidebarUITests/testChatLeftEdgeSwipeOpensSidebarWithoutTopLeftButtonAndPreservesDraft` **1/1 passed** (`** TEST EXECUTE SUCCEEDED **`)

4. **Combined Integration (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ f2296549f9cf40c890b39a3ab2cf2e6caf2acd57`):**
   - Shared files reduced to **2** (`Conversation.xcstrings` and `LiveConversationHost.swift`), with **0 textual merge conflicts** (`git merge-tree --write-tree` tree `7bbeeaaa216ab7206c13e76fd2d71bf9f9a9e878`).
   - Combined `test` on `iPhone 18 Pro` (`402pt`):
     - `EmberChatMonochromeTokensTests`: **2/2 passed**
     - `EmberMonochromeChatUITests`: **4/4 passed**
     - `B3ChatTasksIntegrationUITests`: **5/5 passed**
     - `EmberSidebarUITests`: **3/3 passed**
     - Total: **14/14 passed** (`** TEST SUCCEEDED **`)

## Screenshots
- `01-sidebar-chat-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`1206x2622`), edge-swipe Sidebar open alongside shifted Chat
- `02-sidebar-tasks-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`1206x2622`), edge-swipe Sidebar open alongside shifted Tasks
- `03-sidebar-chat-dark-zhhans-axlarge-402pt.png` — System Dark Mode, `zh-Hans`, `AXLarge`, `iPhone 18 Pro` (`1206x2622`)
- `04-sidebar-chat-light-393pt-iphone16.png` — Light Mode, EN, `iPhone 16` (`393pt`)
- `05-sidebar-chat-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`)
- `06-sidebar-tasks-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`)
- `07-combined-pr287-pr284-chat-sidebar-light-402pt.png` — Combined `#287 + #284`, Light Mode, EN, `iPhone 18 Pro`, monochrome Chat shifted cleanly beside edge-swipe Sidebar
- `08-combined-pr287-pr284-chat-monochrome-header-402pt.png` — Combined `#287 + #284`, Light Mode, EN, `iPhone 18 Pro`, active Chat header cleanly restored without top-left toggle button
