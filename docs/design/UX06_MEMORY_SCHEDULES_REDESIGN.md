# UX-06: Memory & Proactive Schedules Experience Redesign

- **Author:** Agent C (Senior iOS Product Designer & SwiftUI Engineer)
- **Reports to:** UI/UX Lead, iOS Lead, CTO
- **Date:** 2026-11-22
- **Baseline:** `origin/main` @ [`f37ffc6bc5b64ed2ac70744997b8f1f672f1abcd`](https://github.com/basicv8vc/Ember/commit/f37ffc6bc5b64ed2ac70744997b8f1f672f1abcd)
- **Deliverable Type:** Phase 1 Design Proposal (design-only PR — no Swift, Cloud Runtime, database, or API changes)

---

## Executive Summary

**Product Philosophy:** *Remember what matters. Show what's next.*

Today, both [`PersonalMemorySheetView.swift`](../../apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift) and [`ProactiveSchedulesSheetView.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift) open with **developer-oriented creation forms at the top of the screen**, pushing the user's saved memories and existing schedules below the fold. On a `320pt` iPhone SE or with large Dynamic Type, a user opening Memory or Schedules to check *"What does Ember remember about me?"* or *"What will Ember do next?"* must scroll past segmented pickers, text inputs, and date pickers before seeing any personal content.

This proposal shifts both sheets from **form-first** to **content-first** while:

1. **Zero new backend capabilities or API contracts:** Reuses existing `PersonalMemoryContracts.swift`, `PersonalMemoryStore.swift`, `ProactiveScheduleContracts.swift`, and `ProactiveScheduleStore.swift`.
2. **Strict truthfulness:** Never fabricates inferred memories, next execution times, task completion for in-flight `once` triggers, cloud execution guarantees in `MOCK ONLY` / V1 modes, or exact chat scroll claims.
3. **Calm, native SwiftUI language (coordinated with UX-04 / PR `#274`):** Aligns with Agent A's *Warm, Quiet, Competent* Chat redesign (`docs/design/UX04_CHAT_EXPERIENCE_REDESIGN.md`, PR `#274`) and `EmberDesignTokens` — clean typography, reduced card density (single-surface `16pt` cards with soft inline result wells rather than nested bordered boxes), **`≥44×44pt` touch targets**, `ViewThatFits` narrow-width adaptation at `320pt`, hidden raw internal `key` strings on Memory cards, and preserved V1 `.endpointNotReady` and `MockOnlyBanner` honesty. Note that UX-04 moves the Chat-tab entry points for Memory and Schedules into the compact `⋯` header menu (complementing the `Tasks`-tab toolbar button), so these redesigned sheets act as focused, content-first destinations.

---

## Before / After Structural Comparison

| Surface | Before (`main` @ `f37ffc6`) | After (UX-06 Proposal) |
| --- | --- | --- |
| **Memory Sheet Top** | Subtitle → inline `composerCard` (~220pt tall: Type picker + multiline TextField + char count + Save) → Saved list below | Toolbar `+ Add` + `Close` → environment-accurate subtitle → **Saved Memory list first** (Empty / Loading / Error / Items) |
| **Memory Creation** | Always occupies top ~220pt above saved items | Secondary entry (`+ Add` in toolbar; primary CTA in Empty state) opens a focused modal `AddMemorySheet` |
| **Memory Row Content** | Shows `[Preference/Fact pill] [monospaced raw key] [pencil] [trash]`, content, `source · updatedAt`; small icon buttons without `44×44pt` min frame | **Hides raw `key` from primary card**; shows `[Preference/Fact pill]`, **`44×44pt` Edit/Delete actions**, readable `content`, truthful `source · updatedAt` |
| **Memory Copy Honesty** | Empty state refers to `"Add a preference or fact above..."` | Empty state refers to `"Add Memory"`; subtitle and delete alert remain explicit that editing/deleting only affects future conversations and never alters past chat history |
| **Schedules Sheet Top** | Subtitle → tall `composerCard` (~360–420pt: Kind + Title + Prompt + Frequency + DatePicker + 4 preset chips + Timezone + Create) → flat schedule list below | Toolbar `+ New` + `Close` → environment-honest subtitle → **Existing Schedules first**, grouped lightly by **Active ("Up next")**, **Paused**, and **Recent History** |
| **Schedule Creation** | Always occupies top ~360–420pt above existing schedules | Secondary entry (`+ New` in toolbar; primary CTA in Empty state) opens a focused modal `CreateScheduleSheet` |
| **Schedule Subtitle Honesty** | Unconditionally displays `"Ember runs them in the cloud even when the app is closed"` even in `MOCK ONLY` and V1 `endpointNotReady` states | Cloud-execution copy shown **only** when supported on a real V2 environment; `MOCK ONLY` displays local-preview copy and V1 `endpointNotReady` displays neutral availability copy |
| **Schedule State vs Run State** | `once` schedule shows `Completed` pill while `latestRun.status` is still `queued`/`running`; `Cancel` hidden when `schedule.status.isTerminal`; `waiting_approval`/`cancelled` run states fall into generic branch | **Preserves separate Schedule State vs Latest Run State:** recurring active schedules remain `Active` even if a historical run failed (latest run separately shows `Last run failed`), while fired `once` schedules pair `schedule.status` + `latestRun?.status` so in-flight runs read `Triggered · In progress` (never premature `Completed`) and remain cancellable; handles all 7 backend run states |
| **Schedule Actions & Chat Link** | `"View in Chat"` only dismisses sheet / switches tab; raw `(Asia/Shanghai)` in parens next to Next date | Renames **`View in Chat` → `Open Chat`** (Decision #1 — honest tab-switch + sheet-dismiss without implying `resultMessageId` scroll); all action buttons enforce **`≥44pt` height** and wrap cleanly at `320pt`; timezone shown cleanly when different from device timezone |

---

## Part A — Personal Memory Experience

### 1. Information Hierarchy

1. **Navigation Bar:**
   - **Leading:** `+ Add` (`accessibilityIdentifier: "memory-add-button"`, `≥44pt` tap target, disabled when `store.isEndpointUnavailable || store.isAtCapacity`)
   - **Title:** `Memory` / `记忆` (`.inline`)
   - **Trailing:** `Close` (`"memory-sheet-close"`)
2. **Environment & Status Context (top of scroll, strictly gated to actual state):**
   - `MockOnlyBanner` if `store.isMockOnly` (clearly distinguishes simulated local preview from Live Cloud)
   - Quiet 2-line context subtitle:
     - **Live V2:** `"Explicit preferences and facts Ember uses in future conversations. Past chat history stays unchanged."`
     - **Mock Only:** `"Local preview items used only in this simulated session. Past chat history stays unchanged."`
     - **V1 Unavailable:** Omitted or neutral `"Personal memory requires a V2 Ember Cloud environment."`
   - `InlineNotice` (`"memory-endpoint-unavailable"`) if V1 backend returns `.endpointNotReady`
   - `InlineNotice` (`"memory-error-notice"`) if `store.errorMessage != nil` (or `ErrorPlaceholder` with Retry when `items.isEmpty`)
   - `InlineNotice` (`"memory-capacity-notice"`) if `store.isAtCapacity` (`items.count >= limits.maxItems`)
3. **Primary Content — Saved Memories ("What Ember remembers"):**
   - Section header: `Saved Memory` + compact count (`2 / 50`)
   - Ordered newest-updated first (`PersonalMemoryStore.sortItems`)
   - Each card (`"memory-item-<uuid>"`):
     1. **Header:** Kind badge (`Preference` / `Fact`) + Edit (`44×44pt` hit area) + Delete (`44×44pt` hit area)
     2. **Body:** Human-readable `item.content` (`.body`, `.primary`, selectable)
     3. **Footer:** Truthful provenance icon + label (`Saved from chat` vs `Saved in Memory`) + `·` + formatted `updatedAt`
4. **Secondary Creation / Editing Surfaces (Modal Sub-Sheets):**
   - `AddMemorySheet` (`.sheet(isPresented: $isShowingAddSheet)`)
   - `EditMemorySheet` (`.sheet(item: $editingItem)`)
   - Both use `NavigationStack`, `.presentationDetents([.medium, .large])`, `Cancel` (`.cancellationAction`), `Save` (`.confirmationAction`), Kind segmented picker, multiline `TextField`, character counter (`0 / 500`), and in-sheet error banner so failed requests never silently dismiss or lose the user's draft.

### 2. Relevant Data Fields & Constraints

| DTO Field (`PersonalMemoryContracts.swift`) | Usage in Redesign | Constraint / Truth Rule |
| --- | --- | --- |
| `memoryID: UUID` | SwiftUI identity & accessibility IDs (`memory-item-<uuid>`, `memory-edit-<uuid>`, `memory-delete-<uuid>`) | Never displayed as text |
| `kind: PersonalMemoryKind` (`.preference` \| `.fact`) | Category capsule on card; segmented picker in Add/Edit | Preserved verbatim |
| `key: String?` | **Hidden from primary card UI** | Never shown as primary content; server preserves existing `key` on `PATCH /v2/memories/{id}` since `UpdatePersonalMemoryRequestDTO` omits `key` |
| `content: String` | Primary card body (`.body`) | Trimmed non-empty, `<= limits.maxContentChars` (500) |
| `provenance.source` (`.explicitUserRequest` \| `.userSettings`) | Footer attribution (`Saved from chat` vs `Saved in Memory`) | Server-authoritative; never fabricated; retained across edits |
| `provenance.conversationID`, `provenance.messageID` | Reserved (not linked in UX-06) | No broken or speculative deep-link |
| `updatedAt: String` | Formatted via `ConversationCardFormatting.date(from:)` | Omitted gracefully if unparseable |
| `limits.maxItems` / `limits.maxContentChars` | Header count (`N / 50`), char counter (`N / 500`), capacity guard | Disables `+ Add` and shows `memory.error.limit_reached` notice when at capacity |

### 3. Main User Flows

1. **Inspect what Ember remembers:** Open Memory sheet → `store.refresh()` loads `GET /v2/memories` → user immediately sees saved preferences/facts with source and timestamp.
2. **Add a memory:** Tap `+ Add` in toolbar (or `Add Memory` button in Empty state) → `AddMemorySheet` opens → choose `Preference` or `Fact`, enter text → tap `Save` → `store.save(...)` waits for server `200/201` confirmation (with idempotent `clientRequestID` retry if needed) → sheet dismisses on success and new item appears at top of list. On error, sheet stays open, preserves draft, and displays `store.errorMessage` inside the sheet.
3. **Edit a memory:** Tap Edit (`pencil`, `44×44pt`) on a card → `EditMemorySheet` opens pre-filled with `item.kind` and `item.content`, plus read-only provenance footnote → tap `Save` → `store.update(id:kind:content:)` awaits server `200` → sheet dismisses (or if `404 notFound`, removes stale item and surfaces localized message).
4. **Delete a memory:** Tap Delete (`trash`, `44×44pt`) on a card → native `.alert` asks `"Delete this memory?"` explaining Ember will stop using it in **future** conversations (without claiming past chats are deleted) → confirm `Delete` → `store.delete(id:)` awaits server `200` → row removed.

### 4. Memory Before / After Wireframes (`320pt` Side-by-Side + `375pt` / `393pt` Adaptation)

#### State M1: Saved Items Present (`320pt` Side-by-Side — Live V2 vs Mock Distinction)

```text
BEFORE (320pt — Current main, Live V2)         AFTER (320pt — Redesigned, Live V2)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                    Memory  Close │            │ + Add        Memory        Close │ <- 44pt nav actions
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Explicit preferences and facts   │            │ Explicit items Ember uses in new │
│ Ember remembers across new...    │            │ chats. Past chats stay unchanged.│
│ ┌──────────────────────────────┐ │            │                                  │
│ │ [ Preference ]  [   Fact   ] │ │            │ Saved Memory              2 / 50 │ <- Content first!
│ │ ┌──────────────────────────┐ │ │            │ ┌──────────────────────────────┐ │
│ │ │ e.g. Keep morning briefs │ │ │            │ │ [Preference]       [✎]  [🗑] │ │ <- Raw key hidden;
│ │ │                          │ │ │            │ │ Keep morning briefs concise  │ │    44x44pt buttons
│ │ └──────────────────────────┘ │ │            │ │ with bullet points and clear │ │
│ │ 0 / 500             [ Save ] │ │            │ │ next steps.                  │ │
│ └──────────────────────────────┘ │            │ │ 💬 Saved from chat · Nov 20  │ │
│                                  │            │ └──────────────────────────────┘ │
│ Saved Memory              2 / 50 │            │ ┌──────────────────────────────┐ │
│ ┌──────────────────────────────┐ │            │ │ [Fact]             [✎]  [🗑] │ │
│ │ [Preference] brief.fmt [✎][🗑]│ │ <- raw key │ │ Based in Shanghai (UTC+8);   │ │
│ │ Keep morning briefs concise  │ │    clutter │ │ prefer metric units.         │ │
│ │ with bullet points...        │ │            │ │ ✎ Saved in Memory · Nov 21   │ │
│ │ Saved from chat · Nov 20     │ │            │ └──────────────────────────────┘ │
└─┴──────────────────────────────┴─┘            └──────────────────────────────────┘

Mock Prototype Mode Distinction (when store.isMockOnly == true):
┌──────────────────────────────────┐
│ + Add        Memory        Close │
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │
│ │ 🧪 MOCK ONLY                 │ │ <- Persistent orange MockOnlyBanner
│ │ Simulated preview data...    │ │    clearly separates local demo
│ └──────────────────────────────┘ │    from Live Cloud persistence
│ Local preview items used only in │
│ this simulated session...        │
│ Saved Memory              1 / 50 │
│ ...                              │
```

#### State M2: Empty (`320pt` Side-by-Side)

```text
BEFORE (320pt — Current main)                   AFTER (320pt — Redesigned)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                    Memory  Close │            │ + Add        Memory        Close │
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Explicit preferences and facts   │            │ Explicit items Ember uses in new │
│ Ember remembers across new...    │            │ chats. Past chats stay unchanged.│
│ ┌──────────────────────────────┐ │            │                                  │
│ │ [ Preference ]  [   Fact   ] │ │            │ ┌──────────────────────────────┐ │
│ │ ┌──────────────────────────┐ │ │            │ │          [🧠 icon]           │ │
│ │ │ e.g. Keep morning briefs │ │ │            │ │    No saved memories yet     │ │
│ │ └──────────────────────────┘ │ │            │ │ Save a preference or fact so │ │
│ │ 0 / 500             [ Save ] │ │            │ │ Ember can use it in future   │ │
│ └──────────────────────────────┘ │            │ │ conversations.               │ │
│ ┌──────────────────────────────┐ │            │ │                              │ │
│ │          [🧠 icon]           │ │            │ │       [ + Add Memory ]       │ │ <- ≥44pt primary CTA
│ │    No saved memories yet     │ │            │ └──────────────────────────────┘ │
│ │ Add a preference or fact     │ │            │                                  │
│ │ above so Ember can carry...  │ │ <- "above" │                                  │
└─┴──────────────────────────────┴─┘            └──────────────────────────────────┘
```

#### State M3: Adding Memory (`320pt` Side-by-Side — Inline Form vs Modal Sub-Sheet)

```text
BEFORE (320pt — Inline Top Form)                AFTER (320pt — Focused AddMemorySheet)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                    Memory  Close │            │ Cancel     Add Memory       Save │ <- Save shows spinner
├──────────────────────────────────┤            ├──────────────────────────────────┤    while saving
│ (Subtitle + form share scroll    │            │ ┌──────────────┬───────────────┐ │
│  above existing items; keyboard  │            │ │  Preference  │     Fact      │ │ <- Segmented picker
│  pushes saved list off-screen)   │            │ └──────────────┴───────────────┘ │
│ ┌──────────────────────────────┐ │            │ ┌──────────────────────────────┐ │
│ │ [ Preference ]  [   Fact   ] │ │            │ │ e.g. Keep morning briefs     │ │
│ │ [TextField                 ] │ │            │ │ concise with bullet points   │ │
│ │ 14 / 500            [ Save ] │ │            │ │                              │ │
│ └──────────────────────────────┘ │            │ └──────────────────────────────┘ │
│ Saved Memory              2 / 50 │            │ 0 / 500                          │
│ ...                              │            │ Ember will use this in future    │
│                                  │            │ chats. Past chats stay unchanged.│
│                                  │            │ [Error InlineNotice if failed;   │
│                                  │            │  draft stays preserved on error] │
└──────────────────────────────────┘            └──────────────────────────────────┘
```

#### State M4: Editing & Deleting (`320pt`)
- **Editing (`EditMemorySheet`):** Identical sheet chrome to `AddMemorySheet` (`Cancel` / `Edit Memory` / `Save`), pre-filled with `item.kind` + `item.content`, `Save` disabled until changed and valid (`trimmed != item.content || editSelectedKind != item.kind`), plus read-only provenance footnote: `Source: Saved from chat · Past chat messages stay unchanged.`
- **Deleting (Confirmation Alert over Saved List):**
```text
      ┌────────────────────────────┐
      │    Delete this memory?     │
      │ Ember will no longer use   │
      │ this item in future chats. │
      │ Past conversations are not │
      │ changed.                   │
      ├─────────────┬──────────────┤
      │   Cancel    │    Delete    │  <- .destructive role
      └─────────────┴──────────────┘
```

#### State M5: Loading / Error / Unavailable (`320pt` Side-by-Side)

```text
BEFORE (320pt — V1 Unavailable)                 AFTER (320pt — V1 Unavailable / Error)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                    Memory  Close │            │              Memory        Close │ <- + Add omitted/disabled
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Explicit preferences and facts   │            │ Personal memory requires a V2    │
│ Ember remembers across new...    │            │ Ember Cloud environment.         │
│ ┌──────────────────────────────┐ │            │ ┌──────────────────────────────┐ │
│ │ ⓘ Memory is not enabled on   │ │            │ │ ⓘ Memory is not enabled on   │ │
│ │   this server                │ │            │ │   this server                │ │
│ │   Connect to a V2 Ember...   │ │            │ │   Connect to a V2 Ember      │ │
│ └──────────────────────────────┘ │            │ │   Cloud environment to       │ │
│ (Empty state hidden, no items)   │            │ │   inspect and manage memory. │ │
└──────────────────────────────────┘            │ └──────────────────────────────┘ │
                                                │                                  │
  (Loading: LoadingPlaceholder centered;        │ (Error + Empty: ErrorPlaceholder │
   Error + Items: InlineNotice above list)      │  with [ Try Again ] 44pt button) │
                                                └──────────────────────────────────┘
```

#### `375pt` & `393pt` Adaptation Evidence (Memory)

```text
AFTER (375pt / 393pt — Standard iPhone, Live V2)
┌───────────────────────────────────────────┐  Width rules:
│ + Add             Memory            Close │  - 16pt horizontal padding; single-column
├───────────────────────────────────────────┤    card list capped at maxWidth: 720pt.
│ Explicit preferences and facts Ember      │  - At 375pt (content width 343pt) and 393pt
│ uses in future conversations. Past chat   │    (content width 361pt), provenance + time
│ history stays unchanged.                  │    fit on one line:
│                                           │    "💬 Saved from chat · Nov 20, 08:00".
│ Saved Memory                        2 / 50│  - At AX3+ Dynamic Type, card header uses
│ ┌───────────────────────────────────────┐ │    ViewThatFits so [Preference] wraps above
│ │ [Preference]                [✎]  [🗑] │ │    the 44×44pt [Edit] [Delete] buttons cleanly
│ │ Keep morning briefs concise with      │ │    without truncating labels.
│ │ bullet points and clear next steps.   │ │
│ │ 💬 Saved from chat · Nov 20, 08:00    │ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

---

## Part B — Proactive Schedules Experience

### 1. Information Hierarchy

1. **Navigation Bar:**
   - **Leading:** `+ New` (`"schedules-add-button"`, `≥44pt` tap target, disabled when `store.isEndpointUnavailable`)
   - **Title:** `Schedules` / `定时任务` (`.inline`)
   - **Trailing:** `Close` (`"schedules-sheet-close"`)
2. **Environment & Status Context (strictly truthful per active mode):**
   - `MockOnlyBanner` if `store.isMockOnly`
   - Environment-scoped subtitle:
     - **Real Live V2 (`!store.isMockOnly && !store.isEndpointUnavailable`):** `"Recurring morning briefs and one-time follow-ups run in Ember Cloud even when the app is closed."`
     - **Mock Only (`store.isMockOnly`):** `"Preview proactive schedules in local demo mode. Nothing here runs in Ember Cloud."`
     - **V1 Unavailable (`store.isEndpointUnavailable`):** `"Proactive schedules require a V2 Ember Cloud environment."`
   - `InlineNotice` (`"schedules-endpoint-unavailable"`) if V1 server returns `.endpointNotReady`
   - `InlineNotice` (`"schedules-error-notice"`) if `store.errorMessage != nil` (or `ErrorPlaceholder` with Retry when `schedules.isEmpty`)
3. **Primary Content — Existing Schedules First (Lightweight Grouping):**
   - **Group 1 — Active & In-Flight (`Active` / `进行中`):**
     - Includes `status == .active`, **plus** any `once` schedule where `status == .completed` while `latestRun?.status` is still `"queued"`, `"running"`, or `"waiting_approval"` (so an active follow-up never prematurely disappears into History).
     - Ordered with in-flight runs / soonest authoritative `nextFireAt` ascending, then `updatedDate` descending.
   - **Group 2 — Paused (`Paused` / `已暂停`):**
     - Shown only when `paused` schedules exist.
   - **Group 3 — History (`Recent History` / `历史记录`):**
     - Shown only when terminal schedules with non-in-flight runs exist. Keep compact.
4. **Schedule Card Anatomy (`"schedule-item-<uuid>"`):**
   1. **Meta Row:** `[Kind label + icon]` · `[Schedule Status Capsule]` · `[Spacer]` · `[Cadence label]`
   2. **Title:** `schedule.title` (`.body.weight(.semibold)`)
   3. **Instructions (`schedule.prompt`):** `.subheadline`, `.secondary` (cleanly bounded/expandable on long prompts so cards stay scannable)
   4. **Next Execution ("What's next"):** Rendered **only** when `schedule.nextFireAt != nil` and parseable. Shows clock icon + `Next: <formatted in schedule.timezone>` (+ timezone identifier when it differs from `TimeZone.current.identifier`). **Never fabricated for paused/cancelled/completed or missing `nextFireAt`.**
   5. **Latest Run ("What happened recently"):** Rendered independently of the Schedule Status pill when `schedule.latestRun != nil`. Truthfully displays all 7 run states (`queued`, `running`, `waiting_approval`, `completed`, `failed`, `retryable_failed`, `cancelled`) + soft `displayResultText` well when present.
   6. **Actions Row (`≥44pt` button height, wrapping cleanly at `320pt`):**
      - `Pause` (when `status == .active`) / `Resume` (when `status == .paused`)
      - `Cancel` (when `!schedule.status.isTerminal || isLatestRunInFlight`) with confirmation `.alert`
      - **`Open Chat`** (renamed from `"View in Chat"` per Decision #1 — shown when `schedule.latestRun?.resultMessageId != nil && onOpenChat != nil`; dismisses the sheet and switches to Chat without claiming exact message scroll)
5. **Secondary Creation Surface (`CreateScheduleSheet`):**
   - Presented via `.sheet(isPresented: $isShowingCreateSheet)`.
   - Reuses existing `ProactiveSchedulesSheetView` form controls (`Kind` picker, `Title`, `Prompt`, `Frequency: One-time | Daily`, `DatePicker`, 4 preset chips, timezone indicator, `Create` button) with `Cancel` in `.cancellationAction` and in-sheet error preservation.

### 2. Authoritative Data Fields & Schedule vs. Run Truth Matrix

**Critical invariant:** Keep **Schedule State** (whether future occurrences remain armed) strictly separate from **Latest Run State** (the outcome of the most recent occurrence). A failed historical run on a recurring active schedule **never** turns the schedule's own status into `Cancelled` or `Completed`; the schedule remains `Active` while the `Latest Run` block surfaces the orange failure notice. Only `once` schedules (which have no future occurrence after firing) combine `schedule.status == .completed` + `latestRun?.status` in the badge so an in-flight task is never falsely labeled `Completed`.

| `schedule.status` | `scheduleKind` | `latestRun?.status` | Schedule Badge | Latest Run Block | Allowed Actions |
| --- | --- | --- | --- | --- | --- |
| `.active` | any | `nil` or `completed` | **Active** (green) | `✓ Last run: <date>` + soft result well (if `latestRun != nil`) | `Pause`, `Cancel`, (`Open Chat` if `resultMessageId != nil`) |
| `.active` | `cron_tz` / `interval` | `failed` / `retryable_failed` | **Active** (green — still scheduled!) | `⚠ Last run failed · <date>` + `localizedFailureReason` | `Pause`, `Cancel` |
| `.active` | any | `queued` / `running` | **Active** (green) | `◌ Queued…` / `◌ Running in Ember Cloud…` | `Pause`, `Cancel` |
| `.active` | any | `waiting_approval` | **Active** (green) | `✋ Waiting for your confirmation` | `Pause`, `Cancel` |
| `.paused` | any | any | **Paused** (orange) | Reflects latest run truthfully (if present) | `Resume`, `Cancel`, (`Open Chat` if `resultMessageId != nil`) |
| `.completed` | `once` | `queued` / `running` | **Triggered · In progress** (indigo) | `◌ Queued…` / `◌ Running in Ember Cloud…` | `Cancel` (enabled! backend cancels in-flight linked task) |
| `.completed` | `once` | `waiting_approval` | **Triggered · Needs confirmation** (orange) | `✋ Waiting for your confirmation` | `Cancel` |
| `.completed` | `once` | `failed` / `retryable_failed` | **Triggered · Run failed** (orange) | `⚠ Last run failed · <date>` + `localizedFailureReason` | (`Open Chat` if `resultMessageId != nil`) |
| `.completed` | `once` | `cancelled` | **Triggered · Run cancelled** (secondary) | `Run was cancelled` | — |
| `.completed` | `once` | `completed` | **Completed** (secondary/green) | `✓ Last run: <date>` + soft result well | (`Open Chat` if `resultMessageId != nil`) |
| `.completed` | `once` | `nil` | **Triggered** (secondary) | — | — |
| `.cancelled` | any | any | **Cancelled** (red/secondary) | Reflects latest run truthfully (if present) | (`Open Chat` if `resultMessageId != nil`) |

Additional DTO rules:
- **`nextFireAt: String?`:** Rendered **only** when non-`nil` and parseable (`schedule.status == .active`). Always formatted in `schedule.timezone` via `Self.formatNextFireAt`. If `schedule.timezone != TimeZone.current.identifier`, display `schedule.timezone` explicitly beside the timestamp (and always include timezone in VoiceOver readout).
- **`schedule.latestRun?.resultMessageId`:** Gates visibility of **`Open Chat`**. Never implies scrolling directly to that message ID.

### 3. Schedules Before / After Wireframes (`320pt` Side-by-Side + `375pt` / `393pt` Adaptation)

#### State S1: Active & Paused Schedules + Latest Run Available (`320pt` Side-by-Side — Live V2)

```text
BEFORE (320pt — Current main, Live V2)         AFTER (320pt — Redesigned, Live V2)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                 Schedules  Close │            │ + New       Schedules      Close │ <- 44pt nav actions
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Set up recurring morning briefs  │            │ Recurring briefs and follow-ups  │
│ or one-time follow-ups. Ember    │            │ run in Ember Cloud even when the │
│ runs them in the cloud even...   │            │ app is closed.                   │
│ ┌──────────────────────────────┐ │            │                                  │
│ │ [Brief][Follow-up][Reminder] │ │            │ Active                           │ <- Existing first!
│ │ [Title (e.g. Morning Brief)] │ │            │ ┌──────────────────────────────┐ │
│ │ [What should Ember prepare?] │ │            │ │ ☀ Brief · [Active]           │ │
│ │ [  One-time  ][   Daily    ] │ │            │ │               Daily 08:00    │ │
│ │ Run at    [Nov 22, 17:30 ▾]  │ │            │ │ Morning Brief                │ │
│ │ [In 1m][In 15m][In 1h][9:00] │ │            │ │ Summarize today's priorities │ │
│ │ Asia/Shanghai     [ Create ] │ │            │ │ and open follow-ups…         │ │
│ └──────────────────────────────┘ │            │ │ 🕒 Next: Nov 23, 08:00       │ │
│                                  │            │ │ ✓ Last run: Nov 22, 08:00    │ │
│ Your Schedules                   │ <- pushed  │ │ ┌──────────────────────────┐ │ │
│ ┌──────────────────────────────┐ │    ~400pt  │ │ │ Top 3 priorities today:  │ │ │ <- Soft result well
│ │ [Morning Brief] [Active]     │ │    below   │ │ │ 1. Review UX-06 PR…      │ │ │    (no heavy border)
│ │ ...                          │ │    fold!   │ │ └──────────────────────────┘ │ │
│ └──────────────────────────────┘ │            │ │ [  Pause  ]   [  Cancel  ]   │ │ <- ≥44pt height;
│                                  │            │ │ [      Open Chat       ]     │ │    wraps cleanly
└──────────────────────────────────┘            │ └──────────────────────────────┘ │
                                                │                                  │
Mock Prototype Mode Distinction:                │ ┌──────────────────────────────┐ │
- Displays MockOnlyBanner at top AND            │ │ ↪ Follow-up · [Triggered ·   │ │ <- once fired, task
  neutral subtitle ("Preview proactive          │ │                In progress]  │ │    still running!
  schedules in local demo mode. Nothing         │ │ Check flight gate   One-time │ │
  here runs in Ember Cloud.") so demo           │ │ ◌ Running in Ember Cloud…    │ │
  data never claims real cloud runs.            │ │ [  Cancel  ]                 │ │ <- Cancel stays active
                                                │ └──────────────────────────────┘ │
                                                │                                  │
                                                │ Paused                           │
                                                │ ┌──────────────────────────────┐ │
                                                │ │ 🔔 Reminder · [Paused]       │ │
                                                │ │ Weekly review      Every 7d  │ │
                                                │ │ [  Resume  ]  [  Cancel  ]   │ │
                                                │ └──────────────────────────────┘ │
                                                └──────────────────────────────────┘
```

#### State S2: Empty (`320pt` Side-by-Side)

```text
BEFORE (320pt — Current main)                   AFTER (320pt — Redesigned)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                 Schedules  Close │            │ + New       Schedules      Close │
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Set up recurring morning briefs  │            │ Recurring briefs and follow-ups  │
│ or one-time follow-ups...        │            │ run in Ember Cloud even when the │
│ ┌──────────────────────────────┐ │            │ app is closed.                   │
│ │ [Brief][Follow-up][Reminder] │ │            │                                  │
│ │ [Title] / [Prompt] / [Time]  │ │            │ ┌──────────────────────────────┐ │
│ │ ... (~360pt form above)      │ │            │ │         [📅⏰ icon]          │ │
│ └──────────────────────────────┘ │            │ │       No schedules yet       │ │
│ ┌──────────────────────────────┐ │            │ │ Create a daily morning brief │ │
│ │         [📅⏰ icon]          │ │            │ │ or one-time follow-up so     │ │
│ │       No schedules yet       │ │            │ │ Ember can act on time.       │ │
│ │ Create a daily morning brief │ │            │ │                              │ │
│ │ or follow-up reminder above. │ │ <- "above" │ │      [ + New Schedule ]      │ │ <- ≥44pt primary CTA
└─┴──────────────────────────────┴─┘            └─┴──────────────────────────────┴─┘
```

#### State S3: Creating a Schedule (`320pt` Side-by-Side — Inline Form vs Modal Sub-Sheet)

```text
BEFORE (320pt — Inline Top Form)                AFTER (320pt — Focused CreateScheduleSheet)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                 Schedules  Close │            │ Cancel    New Schedule    Create │ <- Create spinner
├──────────────────────────────────┤            ├──────────────────────────────────┤    while creating
│ (Tall form competes with list,   │            │ ┌──────────┬──────────┬────────┐ │
│  presets clip horizontally,      │            │ │  Brief   │Follow-up │Reminder│ │
│  keyboard covers Create button)  │            │ └──────────┴──────────┴────────┘ │
│ ┌──────────────────────────────┐ │            │ [ Title (e.g. Morning Brief)   ] │
│ │ [Brief][Follow-up][Reminder] │ │            │ ┌──────────────────────────────┐ │
│ │ [Title]                      │ │            │ │ What should Ember prepare or │ │
│ │ [Prompt]                     │ │            │ │ follow up on?                │ │
│ │ [One-time][Daily]            │ │            │ └──────────────────────────────┘ │
│ │ Run at [Nov 22, 17:30]       │ │            │ ┌──────────────┬───────────────┐ │
│ │ [In 1m][In 15m][In 1h]...    │ │            │ │   One-time   │     Daily     │ │ <- Hidden for Follow-up
│ │ Asia/Shanghai     [ Create ] │ │            │ └──────────────┴───────────────┘ │
│ └──────────────────────────────┘ │            │ Run at      [Nov 22, 17:30 ▾]    │
│                                  │            │ [In 1m] [In 15m] [In 1h] [9:00]  │ <- Horizontal scroll
│                                  │            │ Timezone: Asia/Shanghai          │
│                                  │            │ [403 policyDenied / validation   │
│                                  │            │  InlineNotice shown here without │
│                                  │            │  losing typed Title/Prompt]      │
└──────────────────────────────────┘            └──────────────────────────────────┘
```

#### State S4: Latest Run Failed / Needs Confirmation (`320pt` — Schedule State vs Run State Separation)

```text
Recurring Active Schedule + Failed Run:         One-time Triggered + Failed Run:
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│ ☀ Brief · [Active]   Daily 08:00 │ <- STILL   │ ↪ Follow-up · [Triggered ·       │ <- NOT "Completed"!
│ Morning Brief                    │    Active! │                  Run failed]     │
│ 🕒 Next: Nov 23, 08:00           │            │ Check Q4 PDF                     │
│ ⚠ Last run failed · Nov 22, 08:00│            │ ⚠ Last run failed · Nov 22, 14:00│
│   Daily model budget limit was   │            │   Execution timed out before     │
│   reached before this run.       │            │   completing.                    │
│ [  Pause  ]   [  Cancel  ]       │            └──────────────────────────────────┘
└──────────────────────────────────┘
```

#### State S5: Loading / Error / Unavailable (`320pt` Side-by-Side)

```text
BEFORE (320pt — V1 Unavailable)                 AFTER (320pt — V1 Unavailable / Error)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│                 Schedules  Close │            │             Schedules      Close │ <- + New hidden/disabled
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ Ember runs them in the cloud     │ <- false   │ Proactive schedules require a V2 │ <- honest V1 copy!
│ even when the app is closed.     │    promise │ Ember Cloud environment.         │    No cloud-run claim
│ ┌──────────────────────────────┐ │    on V1!  │ ┌──────────────────────────────┐ │
│ │ ⓘ Schedules are not enabled  │ │            │ │ ⓘ Schedules are not enabled  │ │
│ │   on this server             │ │            │ │   on this server             │ │
│ │   Connect to a V2 Ember...   │ │            │ │   Connect to a V2 Ember      │ │
│ └──────────────────────────────┘ │            │ │   Cloud environment...       │ │
└──────────────────────────────────┘            │ └──────────────────────────────┘ │
                                                │ (Loading: LoadingPlaceholder;    │
                                                │  Error+Empty: ErrorPlaceholder   │
                                                │  with [ Try Again ] 44pt button) │
                                                └──────────────────────────────────┘
```

#### `375pt` & `393pt` Adaptation Evidence (Schedules)

```text
AFTER (375pt / 393pt — Standard iPhone, Live V2)
┌───────────────────────────────────────────┐  Width adaptation rules:
│ + New           Schedules           Close │  - 16pt horizontal padding; single-column
├───────────────────────────────────────────┤    card list capped at maxWidth: 720pt.
│ Recurring morning briefs and one-time     │  - At 375pt (content width 343pt) and 393pt
│ follow-ups run in Ember Cloud even when   │    (content width 361pt), card meta header
│ the app is closed.                        │    fits on 1 line:
│                                           │    "☀ Morning Brief · [Active]   Daily 08:00".
│ Active                                    │  - Action bar uses ViewThatFits / wrapping flow:
│ ┌───────────────────────────────────────┐ │    at 375pt/393pt, [Pause] [Cancel] [Open Chat]
│ │ ☀ Morning Brief · [Active] Daily 08:00│ │    sit on 1 row (44pt min height); at 320pt or
│ │ Morning Brief                         │ │    large Dynamic Type, [Open Chat] wraps cleanly
│ │ Summarize today's priorities and open │ │    onto row 2 without label truncation.
│ │ follow-ups in 3 concise bullets.      │ │
│ │ 🕒 Next: Nov 23, 08:00                │ │
│ │ ✓ Last run: Nov 22, 08:00             │ │
│ │ ┌───────────────────────────────────┐ │ │
│ │ │ Top 3 priorities today: 1. Review │ │ │
│ │ │ UX-06 PR…                         │ │ │
│ │ └───────────────────────────────────┘ │ │
│ │ [  Pause  ]  [  Cancel  ] [Open Chat] │ │ <- All buttons minHeight: 44pt
│ └───────────────────────────────────────┘ │
│                                           │
│ Paused                                    │
│ ┌───────────────────────────────────────┐ │
│ │ 🔔 Reminder · [Paused]     Every 24h  │ │
│ │ Evening Check-in                      │ │
│ │ [  Resume  ]  [  Cancel  ]            │ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

---

## Edge States & Invariants Checklist

| Edge Case | Expected Behavior |
| --- | --- |
| **Account isolation / sign-out** | `LiveConversationHostModel` calls `memoryStore.clear()` and `scheduleStore.clear()` on sign-out (`generation &+= 1`). Re-entering sheet refreshes from current authenticated session only. |
| **V1 default server (`ember-api.slowfast.dev`)** | `404`/`405`/`501` maps to `.endpointNotReady` → shows honest neutral `InlineNotice`; hides/disables creation CTA; omits `"runs in the cloud"` subtitle promise. Never fakes empty success. |
| **Mock Mode (`store.isMockOnly`)** | Shows `MockOnlyBanner` and neutral local-preview subtitle copy (never implies real cloud execution). |
| **Memory capacity limit (`50 / 50`)** | Disables `+ Add` / `Add Memory`, displays `memory-capacity-notice`, keeps Edit & Delete fully enabled so user can prune items. |
| **Save/Create failure with draft** | Modal composer sheet remains open, preserves user input, shows `store.errorMessage` inside the sheet, and keeps `PendingSaveAttempt.clientRequestID` / `idempotencyKey` safety intact. |
| **Recurring `model_brief` 403 policy denial** | `CreateScheduleSheet` stays open, preserves title/prompt, displays `schedules.error.policy_denied` prompting user to switch to `One-time` or `Reminder`. |
| **409 Conflict on Schedule Pause/Resume/Cancel** | Shows `schedules.error.conflict` (`"Refresh and try again"`); pull-to-refresh or Retry updates authoritative version. |
| **404 Not Found on Memory Edit/Delete** | Removes stale item from `store.items`, closes Edit sheet if open, and displays `memory.error.not_found` on main sheet. |
| **Timezone mismatch** | Schedule times always format in `schedule.timezone`; when `schedule.timezone != TimeZone.current.identifier`, display timezone identifier clearly beside the formatted timestamp. |
| **Scene foreground return (Schedules)** | Preserves `.onChange(of: scenePhase)` refresh while sheet is open and `handleSchedulesSheetDismissed()` arrival polling on dismiss. |

---

## Accessibility, Dynamic Type & Dark Mode

- **Dynamic Type (`.large` through `.accessibility5`):**
  - No fixed-height card containers; all multi-line text uses `.fixedSize(horizontal: false, vertical: true)`.
  - Memory card header (`Kind` pill + `Edit`/`Delete` buttons) and Schedule card header/action bars use `ViewThatFits` or `AnyLayout` (`HStackLayout` → `VStackLayout` when `dynamicTypeSize.isAccessibilitySize`) so labels never truncate or collide at `320pt` + AX3.
  - Composer sub-sheets use `.presentationDetents([.medium, .large])` and internal `ScrollView` so fields remain reachable when keyboard is open at large font sizes.
- **Touch Targets (`≥44×44pt` everywhere):**
  - Memory `Edit` and `Delete` icon buttons enforce `.frame(minWidth: 44, minHeight: 44)` and `.contentShape(Rectangle())`.
  - Schedule action buttons (`Pause`, `Resume`, `Cancel`, `Open Chat`) and Empty-state primary CTAs (`Add Memory`, `New Schedule`) enforce `.frame(minHeight: 44)` and wrap cleanly across rows on `320pt`.
- **VoiceOver:**
  - Decorative SF Symbols use `.accessibilityHidden(true)`.
  - Toolbar `+ Add` / `+ New` buttons have explicit `.accessibilityLabel` (`"Add Memory"`, `"New Schedule"`).
  - Memory `Edit` / `Delete` buttons include clear labels (`"Edit"`, `"Delete"`) inside `.accessibilityElement(children: .contain)` cards (`memory-item-<uuid>`).
  - Schedule `Next:` line includes full formatted date and timezone in VoiceOver readout; `In progress` spinner announces `"Running in Ember Cloud"` rather than `"Completed"`.
- **Dark Mode:**
  - Uses `EmberDesignTokens.groupedBackground`, `EmberDesignTokens.cardBackground`, `EmberDesignTokens.separator`, and semantic `Color(uiColor: .systemGreen/.systemOrange/.systemRed/.systemBlue)` — no hardcoded light-only colors.
- **Localization (`en` & `zh-Hans`):**
  - All new strings go into `apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings` (table `"Conversation"`), coordinated with Agent A/B to avoid key collisions.
  - Existing `memory.*` and `schedules.*` keys are reused where copy remains valid; `memory.empty.message` and `schedules.empty.message` are updated so they no longer say `"above"` (`在上方`); `schedules.action.view_in_chat` is updated to `"Open Chat"` / `"打开对话"`.

---

## Smallest Possible Implementation Breakdown (Phase 2)

After UI/UX Lead & CTO merge approval of this design PR, implement in **two independent PRs**:

### PR 1 — Memory Redesign (`feat/ios-ux06-memory-redesign`)
- **Scope:**
  - [`PersonalMemorySheetView.swift`](../../apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift)
  - [`Conversation.xcstrings`](../../apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings) (only `memory.*` keys)
  - [`PersonalMemoryTests.swift`](../../apps/ios/EmberTests/Memory/PersonalMemoryTests.swift)
  - [`B3ChatTasksIntegrationUITests.swift`](../../apps/ios/EmberUITests/Integration/B3ChatTasksIntegrationUITests.swift) (update `testMemorySheetSaveEditDeleteInMockConversation` to tap `"memory-add-button"` before filling `"memory-composer-input"`, preserving full save/edit/delete coverage)
- **Changes:**
  1. Reorder `PersonalMemorySheetView` body so saved memories render first (`EmptyPlaceholder` + `+ Add Memory` CTA when empty).
  2. Move creation composer into `AddMemorySheet` triggered by `+ Add` (`memory-add-button`) / empty-state CTA, preserving `memory-composer-input` and `memory-composer-save` identifiers inside the sheet, with draft preservation on failure.
  3. Remove raw `item.key` from `memoryRow`; enforce `44×44pt` `Edit` / `Delete` hit areas; refine `EditMemorySheet` provenance note & error isolation; keep environment-honest subtitle copy.
  4. Add `ErrorPlaceholder` retry when initial load fails with empty list.
- **Risk:** Low–Medium (localized UI restructuring, zero store/API changes; requires updating 1 UI test flow).

### PR 2 — Proactive Schedules Redesign (`feat/ios-ux06-schedules-redesign`)
- **Scope:**
  - [`ProactiveSchedulesSheetView.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift)
  - [`ProactiveScheduleStore.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveScheduleStore.swift) (optional grouping/sorting helper only, keeping `activeCount`, `hasInFlightRun`, `nextActiveFireDate` semantics intact)
  - [`Conversation.xcstrings`](../../apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings) (only `schedules.*` keys)
  - [`ProactiveScheduleTests.swift`](../../apps/ios/EmberTests/Schedules/ProactiveScheduleTests.swift)
  - **No edits** to `LiveConversationHost.swift` or `ConversationTimelineView.swift`.
- **Changes:**
  1. Reorder `ProactiveSchedulesSheetView` body so existing schedules render first, grouped into **Active** (including in-flight `once` triggers), **Paused**, and **Recent History**.
  2. Scope subtitle copy honestly to real V2 cloud vs `MOCK ONLY` vs V1 `endpointNotReady`.
  3. Move creation form into `CreateScheduleSheet` triggered by `+ New` (`schedules-add-button`) / empty-state CTA, preserving drafts on failed submit.
  4. Implement separate **Schedule State** vs **Latest Run State** truth mapping (`once` + in-flight/failed never renders as `Completed` and keeps `Cancel` enabled; recurring `Active` schedule stays `Active` when `latestRun` failed).
  5. Handle all 7 `latestRun.status` values, enforce `≥44pt` wrapping action buttons, clean timezone display, and rename `"View in Chat"` → `"Open Chat"`.
- **Risk:** Medium (status truthfulness + schedule grouping + 320pt wrapping layout; independent of PR 1).

---

## Resolved Decisions (Per UI/UX Lead Review on PR #275)

1. **Decision #1 — `"Open Chat"` Label & Scope (PR 2):** **Option B approved.** Rename `"View in Chat"` → `"Open Chat"` (`打开对话`). It only dismisses the sheet and switches to Chat without deep-linking to `resultMessageId`. Do not modify `LiveConversationHost` or `ConversationTimelineView` in UX-06.
2. **Decision #2 — Modal Sub-Sheets (`AddMemorySheet` / `CreateScheduleSheet`):** **Approved**, with accessible dismissal, draft preservation on failed save/create, and keyboard + `320pt` verification.
3. **Decision #3 — `B3ChatTasksIntegrationUITests` Update (PR 1):** **Approved** to tap `memory-add-button` first while preserving the rest of the save/edit/delete coverage.
