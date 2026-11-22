# UX-06: Memory & Proactive Schedules Experience Redesign

- **Author:** Agent C (Senior iOS Product Designer & SwiftUI Engineer)
- **Reports to:** UI/UX Lead, iOS Lead, CTO
- **Date:** 2026-11-22
- **Baseline:** `origin/main` @ [`f37ffc6bc5b64ed2ac70744997b8f1f672f1abcd`](https://github.com/basicv8vc/Ember/commit/f37ffc6bc5b64ed2ac70744997b8f1f672f1abcd)
- **Deliverable Type:** Phase 1 Design Proposal (design-only PR — no Swift, Cloud Runtime, database, or API changes)

---

## Executive Summary

**Product Philosophy:** *Remember what matters. Show what's next.*

Today, both [`PersonalMemorySheetView.swift`](../../apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift) and [`ProactiveSchedulesSheetView.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift) open with **developer-oriented creation forms at the top of the screen**, pushing the user's saved memories and existing schedules below the fold. On a 320pt iPhone SE or with large Dynamic Type, a user opening Memory or Schedules to check *"What does Ember remember about me?"* or *"What will Ember do next?"* must scroll past segmented pickers, text inputs, and date pickers before seeing any personal content.

This proposal shifts both sheets from **form-first** to **content-first** while:

1. **Zero new backend capabilities or API contracts:** Reuses existing `PersonalMemoryContracts.swift`, `PersonalMemoryStore.swift`, `ProactiveScheduleContracts.swift`, and `ProactiveScheduleStore.swift`.
2. **Strict truthfulness:** Never fabricates inferred memories, next execution times, task completion for in-flight `once` triggers, or exact chat scroll claims unless wired to authoritative `resultMessageId`.
3. **Calm, native SwiftUI language (coordinated with UX-04 / PR #274):** Aligns with Agent A's *Warm, Quiet, Competent* Chat redesign (`docs/design/UX04_CHAT_EXPERIENCE_REDESIGN.md`, PR `#274`) and `EmberDesignTokens` — clean typography, reduced card density (single-surface `16pt` cards with soft inline result wells rather than nested bordered boxes), `44×44pt` hit targets, `ViewThatFits` narrow-width adaptation at `320pt`, hidden raw internal `key` strings on Memory cards, and preserved V1 `.endpointNotReady` and `MockOnlyBanner` honesty. Note that UX-04 moves the Chat-tab entry points for Memory and Schedules into the compact `⋯` header menu (complementing the `Tasks`-tab toolbar button), so these redesigned sheets act as focused, content-first destinations.

---

## Before / After Structural Comparison

### Summary of Changes

| Surface | Before (`main` @ `f37ffc6`) | After (UX-06 Proposal) |
| --- | --- | --- |
| **Memory Sheet Top** | Subtitle → inline `composerCard` (Type picker + multiline TextField + char count + Save) → Saved list below | Toolbar `+ Add` + `Close` → concise subtitle → **Saved Memory list first** (Empty / Loading / Error / Items) |
| **Memory Creation** | Always occupies top ~220pt above saved items | Secondary entry (`+ Add` in toolbar; primary CTA in Empty state) opens a focused `AddMemorySheet` |
| **Memory Row Content** | Shows `[Preference/Fact pill] [monospaced raw key] [pencil] [trash]`, content, `source · updatedAt` | **Hides raw `key` from primary card**; shows `[Preference/Fact pill]`, `44×44pt` Edit/Delete actions, readable `content`, truthful `source · updatedAt` |
| **Memory Copy Honesty** | Empty state refers to `"Add a preference or fact above..."` | Empty state refers to `"Add Memory"`; subtitle and delete alert remain explicit that editing/deleting only affects future conversations and never alters past chat history |
| **Schedules Sheet Top** | Subtitle → tall `composerCard` (Kind + Title + Prompt + Frequency + DatePicker + 4 preset chips + Timezone + Create) → flat schedule list below | Toolbar `+ New` + `Close` → concise subtitle → **Existing Schedules first**, grouped lightly by **Active ("Up next")**, **Paused**, and **Recent History** |
| **Schedule Creation** | Always occupies top ~360–420pt above existing schedules | Secondary entry (`+ New` in toolbar; primary CTA in Empty state) opens a focused `CreateScheduleSheet` |
| **Schedule Status Truth** | `once` schedule shows `Completed` pill while `latestRun.status` is still `queued`/`running`; `Cancel` hidden when `schedule.status.isTerminal`; `waiting_approval`/`cancelled` run states fall into generic branch | **Authoritative paired status**: a `once` schedule whose `latestRun` is still `queued`, `running`, or `waiting_approval` displays `Queued` / `In progress` / `Needs confirmation` (never premature `Completed`) and keeps `Cancel` enabled; handles all 7 backend `ProactiveScheduleRunSnapshot.status` values |
| **Schedule Next / Last Run** | Displays `Next: <date> (Asia/Shanghai)` with raw IANA string in parens; `"View in Chat"` only dismisses sheet | Displays `Next: <date>` in `schedule.timezone` (showing timezone name cleanly when it differs from device timezone or in secondary metadata); `"View in Chat"` either scrolls to authoritative `resultMessageId` (Decision #1) or uses honest `"Open Chat"` copy |

---

## Part A — Personal Memory Experience

### 1. Information Hierarchy

1. **Navigation Bar:**
   - **Leading:** `+ Add` (`accessibilityIdentifier: "memory-add-button"`, disabled when `store.isEndpointUnavailable || store.isAtCapacity`)
   - **Title:** `Memory` / `记忆` (`.inline`)
   - **Trailing:** `Close` (`"memory-sheet-close"`)
2. **Environment & Status Context (top of scroll, only when active):**
   - `MockOnlyBanner` if `store.isMockOnly`
   - Quiet 2-line subtitle explaining persistence scope (explicit items carry into future conversations; past chat transcript is unchanged)
   - `InlineNotice` (`"memory-endpoint-unavailable"`) if V1 backend returns `.endpointNotReady`
   - `InlineNotice` (`"memory-error-notice"`) if `store.errorMessage != nil` (plus inline Retry button when items are empty)
   - `InlineNotice` (`"memory-capacity-notice"`) if `store.isAtCapacity` (`items.count >= limits.maxItems`)
3. **Primary Content — Saved Memories ("What Ember remembers"):**
   - Section header: `Saved Memory` + compact count (`3 / 50`)
   - Ordered newest-updated first (`PersonalMemoryStore.sortItems`)
   - Each card (`"memory-item-<uuid>"`):
     1. **Header:** Kind badge (`Preference` / `Fact`) + Edit (`44×44pt` min hit area) + Delete (`44×44pt` min hit area)
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

1. **Inspect what Ember remembers:** Open Memory sheet from Chat header → `store.refresh()` loads `GET /v2/memories` → user immediately sees saved preferences/facts with source and timestamp.
2. **Add a memory:** Tap `+ Add` in toolbar (or `Add Memory` button in Empty state) → `AddMemorySheet` opens → choose `Preference` or `Fact`, enter text → tap `Save` → `store.save(...)` waits for server `200/201` confirmation (with idempotent `clientRequestID` retry if needed) → sheet dismisses on success and new item appears at top of list. On error, sheet stays open and displays `store.errorMessage` inside the sheet.
3. **Edit a memory:** Tap Edit (`pencil`) on a card → `EditMemorySheet` opens pre-filled with `item.kind` and `item.content`, plus read-only provenance footnote → tap `Save` → `store.update(id:kind:content:)` awaits server `200` → sheet dismisses (or if `404 notFound`, removes stale item and surfaces localized message).
4. **Delete a memory:** Tap Delete (`trash`) on a card → native `.alert` asks `"Delete this memory?"` explaining Ember will stop using it in **future** conversations (without claiming past chats are deleted) → confirm `Delete` → `store.delete(id:)` awaits server `200` → row removed.

### 4. Memory Wireframes (320pt / 375pt / 393pt)

#### State M1: Saved Items Present

**320pt (iPhone SE — Compact width)**
```text
┌──────────────────────────────────┐
│ + Add       Memory         Close │  <- 320pt inline nav bar
├──────────────────────────────────┤
│ Explicit items Ember uses in new │
│ chats. Past chats stay unchanged.│
│                                  │
│ Saved Memory               2 / 50│
│ ┌──────────────────────────────┐ │
│ │ [Preference]        [✎] [🗑] │ │  <- No raw key! 44x44pt buttons
│ │ Keep morning briefs concise  │ │
│ │ with bullet points and clear │ │
│ │ next steps.                  │ │
│ │ 💬 Saved from chat · Nov 20  │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ [Fact]              [✎] [🗑] │ │
│ │ Based in Shanghai (UTC+8);   │ │
│ │ prefer metric units.         │ │
│ │ ✎ Saved in Memory · Nov 21   │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

**375pt (iPhone 13 mini / SE 3rd) & 393pt (iPhone 15/16)**
```text
┌───────────────────────────────────────────┐  (375pt / 393pt: wider line measure,
│ + Add             Memory            Close │   same single-column 16pt inset,
├───────────────────────────────────────────┤   capped at maxWidth: 720pt on iPad)
│ Explicit preferences and facts Ember      │
│ remembers across new conversations.       │
│                                           │
│ Saved Memory                        2 / 50│
│ ┌───────────────────────────────────────┐ │
│ │ [Preference]                 [✎] [🗑] │ │
│ │ Keep morning briefs concise with      │ │
│ │ bullet points and clear next steps.   │ │
│ │ 💬 Saved from chat · Nov 20, 08:00    │ │
│ └───────────────────────────────────────┘ │
│ ┌───────────────────────────────────────┐ │
│ │ [Fact]                       [✎] [🗑] │ │
│ │ Based in Shanghai (UTC+8); prefer     │ │
│ │ metric units.                         │ │
│ │ ✎ Saved in Memory · Nov 21, 09:15     │ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

#### State M2: Empty
```text
┌──────────────────────────────────┐  (320pt; scales cleanly to 375/393pt)
│ + Add       Memory         Close │
├──────────────────────────────────┤
│ Explicit items Ember uses in new │
│ chats. Past chats stay unchanged.│
│                                  │
│ ┌──────────────────────────────┐ │
│ │          [🧠 icon]           │ │
│ │    No saved memories yet     │ │
│ │ Save a preference or fact so │ │
│ │ Ember can use it in future   │ │
│ │ conversations.               │ │
│ │                              │ │
│ │       [ + Add Memory ]       │ │  <- .borderedProminent primary CTA
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

#### State M3: Adding Memory (`AddMemorySheet`)
```text
┌──────────────────────────────────┐
│ Cancel     Add Memory       Save │  <- Save disabled until valid; shows
├──────────────────────────────────┤     spinner while store.isSaving
│ ┌──────────────┬───────────────┐ │
│ │  Preference  │     Fact      │ │  <- Segmented picker
│ └──────────────┴───────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ e.g. Keep morning briefs     │ │
│ │ concise with bullet points   │ │
│ │                              │ │
│ └──────────────────────────────┘ │
│ 0 / 500                          │
│                                  │
│ Ember will use this in future    │
│ conversations. You can edit or   │
│ delete it anytime.               │
│                                  │
│ (Error InlineNotice shown here   │
│  if store.save() fails)          │
└──────────────────────────────────┘
```

#### State M4: Editing & Deleting
- **Editing (`EditMemorySheet`):** Identical structure to `AddMemorySheet` with title `Edit Memory`, pre-populated `kind` + `content`, `Save` disabled when unchanged or invalid (`trimmed == item.content && editSelectedKind == item.kind`), plus read-only footer: `Source: Saved from chat · Past chat messages stay unchanged.`
- **Deleting (Confirmation Alert over Memory Sheet):**
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

#### State M5: Loading / Error / Unavailable
- **Loading (`isLoading && items.isEmpty`):** `LoadingPlaceholder("Loading…")` centered below subtitle; `+ Add` stays secondary/disabled only if unavailable.
- **Error when list empty (`!isLoading && items.isEmpty && errorMessage != nil`):** `ErrorPlaceholder` with `store.errorMessage` and `[ Try Again ]` button calling `store.refresh()`.
- **Error when items cached (`!items.isEmpty && errorMessage != nil`):** `InlineNotice(.warning)` above the saved list so cached items remain visible and inspectable, with dismiss or pull-to-refresh recovery.
- **V1 Server Unavailable (`isEndpointUnavailable`):**
```text
┌──────────────────────────────────┐
│             Memory         Close │  <- + Add hidden/disabled
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │
│ │ ⓘ Memory is not enabled on   │ │
│ │   this server                │ │
│ │   Connect to a V2 Ember      │ │
│ │   Cloud environment to       │ │
│ │   inspect and manage         │ │
│ │   personal memory.           │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```
- **Mock Mode (`isMockOnly`):** `MockOnlyBanner` pinned at top of scroll view (`MOCK ONLY` orange disclosure).

---

## Part B — Proactive Schedules Experience

### 1. Information Hierarchy

1. **Navigation Bar:**
   - **Leading:** `+ New` (`"schedules-add-button"`, disabled when `store.isEndpointUnavailable`)
   - **Title:** `Schedules` / `定时任务` (`.inline`)
   - **Trailing:** `Close` (`"schedules-sheet-close"`)
2. **Environment & Status Context:**
   - `MockOnlyBanner` if `store.isMockOnly`
   - Quiet 2-line subtitle (`schedules.subtitle`)
   - `InlineNotice` (`"schedules-endpoint-unavailable"`) if V1 server returns `.endpointNotReady`
   - `InlineNotice` (`"schedules-error-notice"`) if `store.errorMessage != nil`
3. **Primary Content — Existing Schedules First (Lightweight Grouping):**
   - **Group 1 — Active & In-Flight (`Active` / `进行中`):**
     - Includes `status == .active`, **plus** any `once` schedule where `status == .completed` while `latestRun?.status` is still `"queued"`, `"running"`, or `"waiting_approval"` (so an active follow-up never prematurely disappears into History!).
     - Ordered by soonest authoritative `nextFireAt` ascending (in-flight / `nil` `nextFireAt` sorted before or after? In-flight first, then soonest `nextFireAt` ascending, then `updatedDate` descending).
   - **Group 2 — Paused (`Paused` / `已暂停`):**
     - Shown only when `paused` schedules exist.
   - **Group 3 — History (`Completed & Cancelled` / `历史记录`):**
     - Shown only when terminal schedules with non-in-flight runs exist. Keep compact (collapsed prompt to 1–2 lines, concise last-run status).
4. **Schedule Card Anatomy (`"schedule-item-<uuid>"`):**
   1. **Meta Row:** `[Kind label + icon]` · `[Effective Status Capsule]` · `[Spacer]` · `[Cadence label]`
   2. **Title:** `schedule.title` (`.body.weight(.semibold)`)
   3. **Instructions (`schedule.prompt`):** `.subheadline`, `.secondary` (capped to 3 lines with `"Show more"` toggle on long prompts to keep cards scannable, or full text if <= 3 lines)
   4. **Next Execution ("What's next"):** Only rendered when `schedule.nextFireAt != nil` and parseable. Shows clock icon + `Next: <formatted in schedule.timezone>` (+ timezone identifier when it differs from `TimeZone.current.identifier`, or as subtle caption). **Never fabricated for paused/cancelled/completed or missing `nextFireAt`.**
   5. **Latest Run ("What happened recently"):** Rendered when `schedule.latestRun != nil`. Truthfully displays all 7 run states (`queued`, `running`, `waiting_approval`, `completed`, `failed`, `retryable_failed`, `cancelled`) + `displayResultText` preview box when present.
   6. **Actions Row (wrapping cleanly on 320pt via `ViewThatFits` / adaptive `HStack`):**
      - `Pause` (when `status == .active`) / `Resume` (when `status == .paused`)
      - `Cancel` (when `!schedule.status.isTerminal || isLatestRunInFlight`) with confirmation `.alert`
      - `View in Chat` / `Open Chat` (when `schedule.latestRun?.resultMessageId != nil && onOpenChat != nil`)
5. **Secondary Creation Surface (`CreateScheduleSheet`):**
   - Presented via `.sheet(isPresented: $isShowingCreateSheet)`.
   - Reuses existing `ProactiveSchedulesSheetView` form controls (`Kind` picker, `Title`, `Prompt`, `Frequency: One-time | Daily`, `DatePicker`, 4 preset chips, timezone indicator, `Create` button) with `Cancel` in `.cancellationAction`.

### 2. Authoritative Data Fields & Truthfulness Rules

| `ProactiveScheduleDTO` / `ProactiveScheduleRunDTO` | Authoritative Backend Semantics | UX-06 Display Rule |
| --- | --- | --- |
| `status` (`active`, `paused`, `completed`, `cancelled`) + `latestRun?.status` | In `packages/runtime-v2`, a `once` schedule transitions `status` to `completed` **at materialization**, while `latestRun.status` can still be `queued`, `running`, `waiting_approval`, `failed`, `retryable_failed`, or `cancelled`. | **Never equate `schedule.status == .completed` with downstream task success.** Derive an **effective badge**: e.g. `completed` + `running` → `In progress`; `completed` + `queued` → `Queued`; `completed` + `waiting_approval` → `Needs confirmation`; `completed` + `failed`/`retryable_failed` → `Run failed`; `completed` + `cancelled` → `Run cancelled`; `completed` + `completed` → `Completed`; `completed` + `latestRun == nil` → `Triggered`. |
| `nextFireAt: String?` | Backend sets `nextFireAt` only when `status == 'active'`; `null` otherwise. | Render `Next:` **only** when `nextFireAt` parses via `ConversationCardFormatting.date(from:)`. Never compute cron/interval dates locally. |
| `timezone: String` | IANA zone (e.g. `Asia/Shanghai`, `America/New_York`). | Always format `nextFireAt` and `completedAt` in `schedule.timezone` (`Self.formatNextFireAt`). Show `schedule.timezone` explicitly whenever `schedule.timezone != TimeZone.current.identifier` (and include in VoiceOver label). |
| `scheduleKind` (`once`, `interval`, `cron_tz`), `cronExpr`, `intervalSeconds` | Recurrence metadata. | Reuse `Self.formattedCadence(for:)` (`Daily 08:00`, `Every 2h`, `Every 15m`, raw cron fallback, or `One-time` badge). |
| `latestRun.reasonCode` | Failure reason code (`budget_exceeded`, `model_unauthorized_tenant`, `recurring_real_model_unauthorized`, `model_timeout`, etc.). | Reuse `Self.localizedFailureReason(for:)`. |
| `latestRun.resultMessageId` | Linked `conversation_messages.id` when the proactive run committed a message. | Button shown only when `resultMessageId != nil && onOpenChat != nil`. Must not claim exact message scroll unless wired to `ScrollViewReader` (see Decision #1). |
| `status.isTerminal` vs `latestRun` in-flight | Backend `POST /v2/schedules/:id/cancel` allows cancelling a `completed` `once` schedule if a linked task is still non-terminal (`proactive-schedule-service.ts#L817-L830`). | Keep `Cancel` action available when `!schedule.status.isTerminal || isLatestRunInFlight`. |

### 3. Schedules Wireframes (320pt / 375pt / 393pt)

#### State S1: Active & Paused Schedules + Latest Run Available

**320pt (iPhone SE)**
```text
┌──────────────────────────────────┐
│ + New      Schedules       Close │
├──────────────────────────────────┤
│ Ember runs these in the cloud    │
│ even when the app is closed.     │
│                                  │
│ Active                           │
│ ┌──────────────────────────────┐ │
│ │ ☀ Brief · [Active]   Daily   │ │
│ │ Morning Brief         08:00  │ │  <- Clean wrap on 320pt
│ │ Summarize today's priorities │ │
│ │ and open follow-ups…         │ │
│ │ 🕒 Next: Nov 23, 08:00       │ │
│ │ ✓ Last run: Nov 22, 08:00    │ │
│ │ ┌──────────────────────────┐ │ │
│ │ │ Top 3 priorities today:  │ │ │
│ │ │ 1. Review UX-06 PR…      │ │ │
│ │ └──────────────────────────┘ │ │
│ │ [Pause] [Cancel]             │ │
│ │ [View in Chat]               │ │  <- Wraps cleanly on 320pt
│ └──────────────────────────────┘ │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ ↪ Follow-up · [In progress]  │ │  <- once schedule fired,
│ │ Check flight gate   One-time │ │     task still running!
│ │ Look up Terminal 2 gate info │ │
│ │ ◌ Running in Ember Cloud…    │ │
│ │ [Cancel]                     │ │  <- Still cancellable!
│ └──────────────────────────────┘ │
│                                  │
│ Paused                           │
│ ┌──────────────────────────────┐ │
│ │ 🔔 Reminder · [Paused]       │ │
│ │ Weekly review      Every 7d  │ │
│ │ [Resume] [Cancel]            │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

**375pt / 393pt (Standard iPhone)**
```text
┌───────────────────────────────────────────┐
│ + New           Schedules           Close │
├───────────────────────────────────────────┤
│ Ember runs briefs and reminders in the    │
│ cloud even when the app is closed.        │
│                                           │
│ Active                                    │
│ ┌───────────────────────────────────────┐ │
│ │ ☀ Morning Brief · [Active] Daily 08:00│ │
│ │ Morning Brief                         │ │
│ │ Summarize today's priorities and open │ │
│ │ follow-ups in 3 concise bullets.      │ │
│ │ 🕒 Next: Nov 23, 08:00                │ │
│ │ ✓ Last run: Nov 22, 08:00             │ │
│ │ ┌───────────────────────────────────┐ │ │
│ │ │ Top 3 priorities today: 1. Review │ │ │
│ │ │ UX-06 PR…                         │ │ │
│ │ └───────────────────────────────────┘ │ │
│ │ [Pause]  [Cancel]  [View in Chat]     │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ Paused                                    │
│ ┌───────────────────────────────────────┐ │
│ │ 🔔 Reminder · [Paused]     Every 24h  │ │
│ │ Evening Check-in                      │ │
│ │ [Resume]  [Cancel]                    │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ Recent History                            │
│ ┌───────────────────────────────────────┐ │
│ │ 🔔 Reminder · [Completed]   One-time  │ │
│ │ Drink water                           │ │
│ │ ✓ Last run: Nov 21, 15:00             │ │
│ │ [View in Chat]                        │ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

#### State S2: Empty
```text
┌──────────────────────────────────┐
│ + New      Schedules       Close │
├──────────────────────────────────┤
│ Ember runs briefs and reminders  │
│ in the cloud even when closed.   │
│                                  │
│ ┌──────────────────────────────┐ │
│ │         [📅⏰ icon]          │ │
│ │       No schedules yet       │ │
│ │ Create a daily morning brief │ │
│ │ or one-time follow-up so     │ │
│ │ Ember can act on time.       │ │
│ │                              │ │
│ │      [ + New Schedule ]      │ │  <- .borderedProminent primary CTA
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

#### State S3: Creating a Schedule (`CreateScheduleSheet`)
```text
┌──────────────────────────────────┐
│ Cancel    New Schedule    Create │  <- Create disabled until valid;
├──────────────────────────────────┤     spinner while store.isCreating
│ ┌──────────┬──────────┬────────┐ │
│ │  Brief   │Follow-up │Reminder│ │
│ └──────────┴──────────┴────────┘ │
│ [ Title (e.g. Morning Brief)   ] │
│ ┌──────────────────────────────┐ │
│ │ What should Ember prepare or │ │
│ │ follow up on?                │ │
│ └──────────────────────────────┘ │
│ ┌──────────────┬───────────────┐ │
│ │   One-time   │     Daily     │ │  <- Hidden for Follow-up
│ └──────────────┴───────────────┘ │
│ Run at      [Nov 22, 15:35 ▾]    │
│ [In 1m] [In 15m] [In 1h] [9:00]  │  <- Horizontal scroll presets
│                                  │
│ Timezone: Asia/Shanghai          │
│                                  │
│ (403 policyDenied / validation   │
│  InlineNotice shown right here   │
│  without losing typed draft)     │
└──────────────────────────────────┘
```

#### State S4: Latest Run Failed / Result Edge States
- **Failed run (`failed` / `retryable_failed`):**
  - Effective status capsule on a `once` schedule reads `Run failed` (orange), NOT `Completed`.
  - Shows `⚠ Last run failed · Nov 22, 08:00` + localized `reasonCode` explanation (e.g., daily budget limit reached, recurring AI brief not enabled for account, model timeout, provider unavailable).
- **Waiting approval (`waiting_approval`):**
  - Effective status capsule reads `Needs confirmation` (orange), with helper line `"Check Tasks or Chat to review and approve this run."`
- **Cancelled run (`cancelled`):**
  - Effective status capsule reads `Run cancelled` (secondary).

#### State S5: Loading / Error / Unavailable
- **Loading (`isLoading && schedules.isEmpty`):** `LoadingPlaceholder("Loading…")`.
- **Error when empty (`!isLoading && schedules.isEmpty && errorMessage != nil`):** `ErrorPlaceholder` with Retry calling `store.refresh()`.
- **Error when list non-empty:** `InlineNotice(.warning)` above the grouped list (`schedules-error-notice`).
- **V1 Server Unavailable (`isEndpointUnavailable`):** `InlineNotice(.neutral)` (`schedules-endpoint-unavailable`: `"Schedules are not enabled on this server — Connect to a V2 Ember Cloud environment..."`); `+ New` disabled/hidden.
- **Mock Mode (`isMockOnly`):** `MockOnlyBanner` pinned at top.

---

## Edge States & Invariants Checklist

| Edge Case | Expected Behavior |
| --- | --- |
| **Account isolation / sign-out** | `LiveConversationHostModel` calls `memoryStore.clear()` and `scheduleStore.clear()` on sign-out (`generation &+= 1`). Re-entering sheet refreshes from current authenticated session only. |
| **V1 default server (`ember-api.slowfast.dev`)** | `404`/`405`/`501` maps to `.endpointNotReady` → shows honest neutral `InlineNotice`; hides/disables creation CTA. Never fakes empty success. |
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
  - Memory card header (`Kind` pill + `Edit`/`Delete` buttons) and Schedule card header/action bars use `ViewThatFits` or `AnyLayout` (`HStackLayout` -> `VStackLayout` when `dynamicTypeSize.isAccessibilitySize`) so labels never truncate or collide at 320pt + AX3.
  - Composer sub-sheets use `.presentationDetents([.medium, .large])` and internal `ScrollView` so fields remain reachable when keyboard is open at large font sizes.
- **Touch Targets:**
  - Memory `Edit` and `Delete` icon buttons enforce `.frame(minWidth: 44, minHeight: 44)` and `.contentShape(Rectangle())`.
  - Schedule action buttons use `.bordered` style with `.frame(minHeight: 36)` / accessible spacing and wrap cleanly onto a second row at 320pt.
- **VoiceOver:**
  - Decorative SF Symbols use `.accessibilityHidden(true)`.
  - Toolbar `+ Add` / `+ New` buttons have explicit `.accessibilityLabel` (`"Add Memory"`, `"New Schedule"`).
  - Memory `Edit` / `Delete` buttons include item context or clear labels (`"Edit"`, `"Delete"`) inside `.accessibilityElement(children: .contain)` cards (`memory-item-<uuid>`).
  - Schedule `Next:` line includes full formatted date and timezone in VoiceOver readout; `In progress` spinner announces `"Running in Ember Cloud"` rather than `"Completed"`.
- **Dark Mode:**
  - Uses `EmberDesignTokens.groupedBackground`, `EmberDesignTokens.cardBackground`, `EmberDesignTokens.separator`, and semantic `Color(uiColor: .systemGreen/.systemOrange/.systemRed/.systemBlue)` — no hardcoded light-only colors.
- **Localization (`en` & `zh-Hans`):**
  - All new strings go into `apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings` (table `"Conversation"`), coordinated with Agent A/B to avoid key collisions.
  - Existing `memory.*` and `schedules.*` keys are reused where copy remains valid; `memory.empty.message` and `schedules.empty.message` are updated so they no longer say `"above"` (`在上方`).

---

## Smallest Possible Implementation Breakdown (Phase 2)

After UI/UX Lead & CTO approval, implement in **two independent PRs**:

### PR 1 — Memory Redesign (`feat/ios-ux06-memory-redesign`)
- **Scope:**
  - [`PersonalMemorySheetView.swift`](../../apps/ios/EmberApp/Features/Memory/PersonalMemorySheetView.swift)
  - [`Conversation.xcstrings`](../../apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings) (only `memory.*` keys)
  - [`PersonalMemoryTests.swift`](../../apps/ios/EmberTests/Memory/PersonalMemoryTests.swift)
  - [`B3ChatTasksIntegrationUITests.swift`](../../apps/ios/EmberUITests/Integration/B3ChatTasksIntegrationUITests.swift) (update `testMemorySheetSaveEditDeleteInMockConversation` to tap `"memory-add-button"` before filling `"memory-composer-input"`, and assert saved list visibility before creation)
- **Changes:**
  1. Reorder `PersonalMemorySheetView` body so saved memories render first (`EmptyPlaceholder` + `+ Add Memory` CTA when empty).
  2. Move creation composer into `AddMemorySheet` triggered by `+ Add` (`memory-add-button`) / empty-state CTA, preserving `memory-composer-input` and `memory-composer-save` identifiers inside the sheet.
  3. Remove raw `item.key` from `memoryRow`; enlarge `Edit` / `Delete` hit areas (`44×44pt`); refine `EditMemorySheet` provenance note & error isolation.
  4. Add `ErrorPlaceholder` retry when initial load fails with empty list.
- **Risk:** Low–Medium (localized UI restructuring, zero store/API changes; requires updating 1 UI test flow).

### PR 2 — Proactive Schedules Redesign (`feat/ios-ux06-schedules-redesign`)
- **Scope:**
  - [`ProactiveSchedulesSheetView.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveSchedulesSheetView.swift)
  - [`ProactiveScheduleStore.swift`](../../apps/ios/EmberApp/Features/Schedules/ProactiveScheduleStore.swift) (optional grouping/sorting helper only if needed — keeping `activeCount`, `hasInFlightRun`, `nextActiveFireDate` semantics intact)
  - [`Conversation.xcstrings`](../../apps/ios/EmberApp/Features/Conversation/Conversation.xcstrings) (only `schedules.*` keys)
  - [`ProactiveScheduleTests.swift`](../../apps/ios/EmberTests/Schedules/ProactiveScheduleTests.swift)
  - (Optional, per Decision #1) [`LiveConversationHost.swift`](../../apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift) & [`ConversationTimelineView.swift`](../../apps/ios/EmberApp/Features/Conversation/Transcript/ConversationTimelineView.swift) if wiring `resultMessageId` scroll.
- **Changes:**
  1. Reorder `ProactiveSchedulesSheetView` body so existing schedules render first, grouped into **Active** (including in-flight `once` triggers), **Paused**, and **Recent History**.
  2. Move creation form into `CreateScheduleSheet` triggered by `+ New` (`schedules-add-button`) / empty-state CTA.
  3. Implement truthful **effective status** derivation (`status` + `latestRun?.status`) so in-flight or failed `once` runs never render as `Completed` and remain cancellable while in-flight.
  4. Handle all 7 `latestRun.status` values (`waiting_approval`, `cancelled`, etc.) and clean timezone display.
  5. Resolve `"View in Chat"` behavior per Decision #1 below.
- **Risk:** Medium (status truthfulness + schedule grouping + optional timeline scroll hook; independent of PR 1).

---

## Data Limitations & Decisions Requiring Approval

### Verified Data Limitations (Baseline `f37ffc6`)
1. **No client-side `nextFireAt` calculation:** `ProactiveScheduleDTO.nextFireAt` is `nil` whenever `status != .active`; cron/interval next-fire previews cannot and must not be synthesized locally.
2. **One-time schedule `completed` vs task completion:** Backend `ScheduleRepository` sets `v2_schedules.status = 'completed'` as soon as a `once` trigger materializes its task, even while `latestRun.status` is `queued` or `running`. UI must combine `schedule.status` and `latestRun?.status` to avoid false completion.
3. **`"View in Chat"` does not currently scroll to `resultMessageId`:** In [`LiveConversationHost.swift#L2257`](../../apps/ios/EmberApp/Features/Conversation/Screen/LiveConversationHost.swift#L2257) and [`TaskInboxView.swift#L274`](../../apps/ios/EmberApp/Features/Inbox/TaskInboxView.swift#L274), `onOpenChat` only dismisses the sheet / switches to the Chat tab; `ConversationTimelineView` does not currently accept a target message ID scroll request.
4. **Proactive schedule editing not supported by API:** `/v2/schedules` exposes create, list, get, pause, resume, cancel — there is no `PATCH /v2/schedules/:id`. Redesign must not imply inline editing of existing schedules.
5. **Memory key preservation:** `UpdatePersonalMemoryRequestDTO` sends `{ kind, content }` without `key`; hiding `key` in UI preserves existing backend deduplication keys without altering API behavior.

### Decisions Requested from UI/UX Lead & CTO

1. **Decision #1 — `"View in Chat"` Navigation Target (PR 2):**
   - **Option A (Recommended):** Wire `onOpenScheduleResult(UUID)` from `ProactiveSchedulesSheetView` → `LiveConversationHostModel` → `ConversationTimelineView` (`ScrollViewProxy.scrollTo("conversation-message-\(resultMessageId.lowercased())")`) when the message is present in `state.timeline`, falling back gracefully to opening the Chat tab if the message was cleared or outside the loaded window. Keep label `"View in Chat"`.
   - **Option B:** Keep `onOpenChat` as tab-switch + sheet-dismiss only, and rename the button label honestly to `"Open Chat"` (so it never implies exact message scrolling).
2. **Decision #2 — Composer Presentation (`Modal Sub-Sheet` vs `Inline Expandable`):**
   - **Recommendation:** Dedicated modal `.sheet` (`AddMemorySheet` / `CreateScheduleSheet`) triggered from toolbar `+ Add` / `+ New` and empty-state CTA. Keeps the 320pt viewport dedicated to saved items/schedules without scrolling past a tall form. Confirm preference before Phase 2 implementation.
3. **Decision #3 — `B3ChatTasksIntegrationUITests` Update Scope (PR 1):**
   - Approve updating `testMemorySheetSaveEditDeleteInMockConversation` in PR 1 so it opens `memory-add-button` before interacting with `memory-composer-input`.
