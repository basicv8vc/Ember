# NAV-02 PR #284 Simulator Verification Evidence

Verified on commit `bbda443a4c68c1ee7a91f17ec8c290bfeb15d4fb` (`feat/ios-nav02-sidebar-directory`), and additionally verified in a clean temporary local merge (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ bbda443a4c68c1ee7a91f17ec8c290bfeb15d4fb`).

## Review P1 / P2 Fixes & Interaction Highlights
- **P1 — Discoverable & Assistive-Tech Accessible Sidebar Entry (without top-left toggle buttons):**
  - Preserved the clean monochrome header without adding a top-left toggle button (`ConversationScreen.swift` untouched; `TaskInboxView.swift` keeps `tasks-open-schedules` in `.topBarLeading`).
  - Added a visually discreet monochrome left-edge pull cue pill (`ember-sidebar-edge-hint`, `3pt × 36pt` at `padding(.leading, 3)`, fading `(1 - progress)`, `.allowsHitTesting(false)`, `.accessibilityHidden(true)`) so sighted users discover the left-edge swipe naturally without blocking touches.
  - Added focusable native `Menu` items to open the Sidebar (`"sidebar.open"`) on both root tabs: `live-conversation-open-sidebar` inside Chat's `>= 44x44pt` `live-conversation-menu` (`...`), and `tasks-open-sidebar` inside Tasks' `.topBarTrailing` `tasks-navigation-menu` (`...`), alongside `ember-sidebar-backdrop` (`>= 44pt`) and `.accessibilityAction(.escape)` for closing.
- **P2 — Initial-Touch Position Edge Detection & Scroll Coexistence:**
  - Replaced recognition-time `pan.location(in: window).x` with `EdgeStartPanGestureRecognizer.initialTouchX` captured immediately in `touchesBegan` (cleared in `reset()`) for both `gestureRecognizerShouldBegin` and `shouldBeRequiredToFailBy`.
  - Added automated boundary tests proving an outer-edge start at `x ≈ 35pt` (`<= 40pt`, crossing `x > 40pt` before recognition) opens the Sidebar reliably, while content-area starts (`x ≈ 120pt`), left-edge vertical scrolls, and horizontal `ScrollView` preset chips inside sheets stay unaffected.
- **Visual V1 Monochrome & Navigation:**
  - `EmberSidebarOverlay` matches the Black / White / Grayscale palette (`#FFFFFF`/`#202020`, `#F3F3F3`/`#292929`, `#E9E9E9`/`#383838`, `#E3E3E3`/`#454545`), preserving amber `MOCK ONLY` disclosure and red Sign Out outside Mock mode; preserves Chat drafts and Tasks state across Sidebar navigation.

## Test Commands & Observed Results (iOS 27.2 Simulator)

1. **PR #284 (`bbda443a4c68c1ee7a91f17ec8c290bfeb15d4fb`) — `iPhone 18 Pro` (`402pt`, Light, EN + `zh-Hans` `AXLarge`):**
   - `EmberSidebarUITests`: **4/4 passed** (0 failures)
   - `B3ChatTasksIntegrationUITests`: **5/5 passed** (0 failures)
   - `ConversationRootLaunchUITests`: **4/4 passed** (0 failures)
   - Total: **13/13 passed** (`** TEST SUCCEEDED **`)

2. **PR #284 — Genuine System Dark Mode (`xcrun simctl ui ... appearance dark`, `zh-Hans`, `AXLarge`, `402pt`):**
   - `EmberSidebarUITests/testSidebarSwipeInZhHansDarkAndAccessibilityTextRemainsDismissable`: **1/1 passed** (`** TEST EXECUTE SUCCEEDED **`)

3. **Earlier Small-Screen Edge-Swipe Verification (`f2296549` baseline before P1/P2 menu & `initialTouchX` refinement):**
   - `iPhone SE (3rd generation)` (`375pt`): `EmberSidebarUITests` **3/3 passed**
   - `iPhone 16` (`393pt`): `EmberSidebarUITests` **1/1 passed** (`04`, `05`, `06` screenshots)

4. **Combined Integration (`PR #287 @ 9b407260eddc30ff717373a3d083a23a8d4dc46e` + `PR #284 @ bbda443a4c68c1ee7a91f17ec8c290bfeb15d4fb`):**
   - Shared files with `#287`: **2** (`Conversation.xcstrings` and `LiveConversationHost.swift`), **0 textual conflicts** (`git merge-tree --write-tree` tree `cc3c0846d05ca7a43f96fc3150c285be49d9c301`).
   - Combined `test` on `iPhone 18 Pro` (`402pt`):
     - `EmberChatMonochromeTokensTests`: **2/2 passed**
     - `EmberMonochromeChatUITests`: **4/4 passed**
     - `B3ChatTasksIntegrationUITests`: **5/5 passed**
     - `EmberSidebarUITests`: **4/4 passed**
     - Total: **15/15 passed** (`** TEST SUCCEEDED **`)

## Screenshots
- `01-sidebar-chat-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`bbda443`), edge-swipe Sidebar open alongside shifted Chat
- `02-sidebar-tasks-light-402pt.png` — Light Mode, EN, `iPhone 18 Pro` (`bbda443`), edge-swipe Sidebar open alongside shifted Tasks
- `03-sidebar-chat-dark-zhhans-axlarge-402pt.png` — System Dark Mode, `zh-Hans`, `AXLarge`, `iPhone 18 Pro` (`bbda443`)
- `04-sidebar-chat-light-393pt-iphone16.png` — Light Mode, EN, `iPhone 16` (`393pt`, `f2296549`)
- `05-sidebar-chat-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, `f2296549`)
- `06-sidebar-tasks-light-375pt-iphonese3.png` — Light Mode, EN, `iPhone SE (3rd generation)` (`375pt`, `f2296549`)
- `07-combined-pr287-pr284-chat-sidebar-light-402pt.png` — Combined `#287 + #284` (`bbda443`), Light Mode, EN, `iPhone 18 Pro`
- `08-combined-pr287-pr284-chat-monochrome-header-402pt.png` — Combined `#287 + #284` (`bbda443`), Light Mode, EN, `iPhone 18 Pro`
