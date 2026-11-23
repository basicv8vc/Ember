# UX-04: Conversation-First Experience Redesign — Phase 1 Design Proposal

> **2026-11-23 design amendment (Visual V1):** The Founder selected **black/white/grayscale minimalism**. For UX-04 PR 3, follow [Ember Visual V1](EMBER_VISUAL_V1_FOUNDER_REVIEW.md) and [UX Foundation V1](EMBER_MUSE_UX_FOUNDATION_V1.md): use **two quiet neutral chat bubbles** (not the earlier \"Assistant no bubble\" proposal), a monochrome brand mark, and lightweight **real** activity. Preserve all server-authoritative Task/Result cards, MOCK/cloud disclosures, UX-02 scrolling and UX-03 delivery/recovery semantics. Historical alternatives below remain for context and are **superseded** where they conflict.


- **Ticket / Workstream:** UX-04 — Conversation-First Experience Redesign (Phase 1: Design Proposal)
- **Author:** Agent A (Senior iOS Product Designer & SwiftUI Engineer)
- **Reviewers:** UI/UX Lead, iOS Lead, CTO
- **Baseline:** `main` @ [`f37ffc6`](https://github.com/basicv8vc/Ember/commit/f37ffc6bc5b64ed2ac70744997b8f1f672f1abcd)
- **Philosophy:** **Less Chatbot. More Personal Agent.** — Warm, Quiet, Competent.
- **Scope:** Design proposal, Before simulator captures, Before/After wireframes (`320pt`, `375pt`, `393pt`), interaction/accessibility/localization specs, and Phase 2 PR breakdown. **No Swift code, navigation/API/DB/auth changes are included in this design-only PR.**

---

## 1. Executive Summary

Ember's Chat screen already has solid functional foundations: live conversation persistence, V2 SSE streaming with B1 polling fallback (UX-03), reading-position-aware smart scrolling with Jump-to-Latest (UX-02), file/photo attachments, inline `TaskActivityCard` and `OutcomeCard` surfaces, and Personal Memory / Proactive Schedules sheets.

However, inspecting the current `main` implementation and simulator captures reveals that the Chat surface still **looks and feels like a developer utility wrapped around a generic chatbot**:

1. **Stacked double header & control crowding:** `LiveConversationHost` renders a utility/banner row (`LIVE CLOUD` / `V2 STAGING` or a full `MockOnlyBanner` + `Schedules` + `Memory` + `Sign out`) *above* `ConversationScreen`'s own `"Ember / Your personal AI partner"` header. At `375pt` with Dark Mode and Accessibility Large Dynamic Type (`before-375-chat-dark-a11y.png`), this double header consumes over half the viewport height before a single message appears. At `320pt`, horizontal competition forces truncation/wrapping and leaves header buttons well below the `44×44pt` touch target minimum.
2. **Flat visual hierarchy in the transcript:** Assistant replies, inline system activity, task cards, and status notices all use the exact same `cardBackground` + `1pt` border box, creating visual clutter. Meanwhile, the user message bubble renders its `"You"` / `"你"` header in `.secondary` gray text *inside* the `Color.accentColor` blue background, creating a severe contrast defect.
3. **Environment-blind empty state:** Currently `LiveConversationHostModel.screen` suggests Personal Memory, Daily Morning Brief, and 15-Minute Reminder prompts even on **V1 (`LIVE CLOUD`)**, where `/v2/memories` and `/v2/schedules` return `.endpointNotReady` (404). Tapping the composer also hides the entire empty state abruptly.
4. **Composer friction in active/long chats:** The Stop control lives only inside the timeline (`ConversationReplyStatusView`), disappearing when the user scrolls up in a long conversation; the `+` trigger (`42×42pt`) and chip remove button (`24×24pt`) fall below `44×44pt`; and the persistent storage caption consumes vertical space on every turn.

**Design direction:** Keep the existing **Chat / Tasks two-tab architecture**, **UX-02 smart scrolling**, and **UX-03 reliability/idempotency behavior**. Consolidate the top chrome into one calm, brand-anchored header with a compact overflow menu (`...`), render Ember's replies as open editorial prose rather than boxed cards, reserve cards for authoritative Task & Result surfaces, refine the composer's Send/Stop clarity and hit targets, and tailor the empty state truthfully to the active V1/V2 environment.

---

## 2. Current Presentation Hierarchy & Verified Issues (`main` @ `f37ffc6`)

### 2.1 Current View Hierarchy

```text
AppCompositionRoot.makeRootView()
└─ LiveConversationHost (TabView: .chat | .tasks)
   └─ NavigationStack (chatTab, navigationBar hidden)
      └─ VStack(spacing: 0)
         ├─ [Header Tier 1] LiveConversationHost utility bar
         │   ├─ Mock mode: HStack { MockOnlyBanner(), Schedules btn, Memory btn }
         │   └─ Live mode: HStack { environmentBadge ("LIVE CLOUD" / "V2 STAGING"),
         │                          Spacer, Schedules(N), Memory, Sign out }
         ├─ [Transient Banners] model.status | model.refreshErrorMessage | model.isPollingPaused
         └─ ConversationScreen
             ├─ [Header Tier 2] HStack { 42×42 sparkle circle, partnerName, subtitle }
             ├─ [Mock ACK] "MOCK ACK · Message accepted" (isMockMode only)
             ├─ ConversationTimelineView (ScrollView + LazyVStack, maxWidth: 680)
             │   ├─ ConversationEmptyStateView (hidden immediately when composerIsFocused)
             │   ├─ .message(.user)  -> right-aligned accentColor bubble (with .secondary "You" inside!)
             │   ├─ .message(.ember) -> left-aligned cardBackground + 1pt border bubble
             │   ├─ .activity        -> cardBackground + 1pt border ("Cloud activity" hardcoded)
             │   ├─ .taskReference   -> TaskActivityCard (or SessionTaskPendingReferenceCard w/ raw UUID)
             │   ├─ .commitmentReference -> hardcoded "Commitment reference" + UUID (tracked in UX-01)
             │   ├─ .outcomeReference -> OutcomeCard + external "Open N files" button below card
             │   └─ ConversationReplyStatusView (sending / generating+Stop / failed+Retry)
             └─ [safeAreaInset(.bottom)] ConversationComposer
                 ├─ attachmentErrorBanner (optional)
                 ├─ attachmentChipsRow (optional, 24×24 remove button)
                 ├─ floatingComposerBar (+ 42×42 glass button, TextField + 32×32 arrow.up pill)
                 └─ note ("Sent messages are saved in your Ember Cloud conversation.")
```

### 2.2 Actual Simulator Captures (Before)

Captured directly from `main` (`f37ffc6`) using `--ember-mock-chat-tasks --ember-mock-chat-tasks-reset` on iOS 27.2 Simulators (`iPhone 16` at `393pt` and `iPhone SE (3rd generation)` at `375pt`):

| 393pt Light (`en`) | 375pt Light (`en`) | 375pt Dark + Large Dynamic Type (`AX1` / `en`) | 393pt Dark (`zh-Hans`) |
| --- | --- | --- | --- |
| ![Before 393pt Light](assets/ux04/before-393-chat-light.png) | ![Before 375pt Light](assets/ux04/before-375-chat-light.png) | ![Before 375pt Dark A11y](assets/ux04/before-375-chat-dark-a11y.png) | ![Before 393pt Dark zh-Hans](assets/ux04/before-393-chat-dark-zh.png) |

**Observed defects confirmed in captures & source:**
1. **Header collapse at narrow width + large text (`before-375-chat-dark-a11y.png`):** `MockOnlyBanner` wraps to 5 lines next to vertically stacked `Schedules` + `Memory` controls, followed by the second `Ember (Mock)` header—consuming >50% of vertical screen space. In Live mode (`LiveConversationHost.swift#L2045-L2096`), `LIVE CLOUD` + `Schedules (N)` + `Memory` + `Sign out` share one tight `HStack(spacing: 10)` with `.caption` buttons lacking `44pt` hit areas.
2. **User bubble label contrast (`before-393-chat-light.png`, `before-393-chat-dark-zh.png`):** `ConversationTimelineView.swift#L343-L347` places `"You"` / `"你"` in `.foregroundStyle(.secondary)` on top of `Color.accentColor`, making the label barely legible in both Light and Dark mode.
3. **Card monotony:** `ConversationMessageBubble` (Ember), `ConversationActivityRow`, `TaskActivityCard`, `OutcomeCard`, and `ConversationReplyStatusView` all share the same `EmberDesignTokens.cardBackground` + `1pt` `separator` border container.
4. **Detached Outcome file CTA (`before-393-chat-light.png`):** `"Open 1 file"` renders below `OutcomeCard` as a standalone bordered button (`LiveConversationHost.swift#L1366-L1380`), while `OutcomeCard` nests a white box inside a white card (`OutcomeCard.swift#L63`).
5. **Raw UUID & unlocalized strings:** `LiveConversationHost.swift#L1174` hardcodes `"Cloud activity"`; `#L1830` (`SessionTaskPendingReferenceCard`) renders `taskID.uuidString.lowercased()`; `#L1183` renders `"Commitment reference"` + UUID (neutral fallback tracked separately under [UX-01](../product/ios/UX01_COMMITMENT_MAPPING_RESEARCH.md)).
6. **V1 capability mismatch in empty state:** `LiveConversationHost.swift#L1220-L1225` injects Memory, 8:00 AM Brief, and 15-min Reminder prompts whenever `!isMockMode`, even when connected to V1 (`ember-api.slowfast.dev`) where `/v2/memories` and `/v2/schedules` return `.endpointNotReady`.

---

## 3. Visual Language & Design Tokens (Warm · Quiet · Competent)

Rather than introducing a heavy custom theme or animated mascot, UX-04 refines `EmberDesignTokens` with calm, native-feeling SwiftUI tokens that adapt seamlessly across Light Mode, Dark Mode, High Contrast, and Dynamic Type:

| Token | Light Mode | Dark Mode | Usage |
| --- | --- | --- | --- |
| `emberMarkTint` | Warm Amber/Terracotta (`#C86428` / `Color.orange` blended with system accent) | Warm Amber (`#E8874A`) | Subtle Ember emblem (`flame.fill` / refined Ember mark) in header & empty state; quiet warmth without loud neon gradients |
| `emberSoftSurface` | `emberMarkTint.opacity(0.10)` | `emberMarkTint.opacity(0.16)` | Ember identity badge backing & soft empty-state icon halo |
| `userBubbleFill` | `Color.accentColor.opacity(0.12)` + `.primary` text (soft pill shown in §5.3) or solid `Color.accentColor` + `.white` | `Color.accentColor.opacity(0.24)` + `.primary` text (or solid `Color.accentColor`) | User message bubble only; soft tint keeps transcript quiet while preserving high contrast |
| `groupedBackground` | `UIColor.systemGroupedBackground` | `UIColor.systemGroupedBackground` | Primary Chat canvas; Ember prose sits directly on this canvas |
| `cardBackground` | `UIColor.secondarySystemGroupedBackground` | `UIColor.secondarySystemGroupedBackground` | Reserved strictly for structured **Task**, **Result**, **Empty Prompt**, and **Recovery** cards |
| `outcomeWellBackground` | `Color.primary.opacity(0.035)` | `Color.white.opacity(0.05)` | Subtle content well inside `OutcomeCard` (replaces harsh inner `systemBackground` box) |
| `readingMaxWidth` | `680pt` | `680pt` | Preserved reading column max-width for transcript & composer |
| `minTapTarget` | `44pt × 44pt` | `44pt × 44pt` | Enforced on all header controls, menu trigger, composer `+`, Send/Stop, Jump-to-Latest, and card buttons |

**What we deliberately avoid:**
- No pulsing orbs, particle/shimmer animations, or typing bounce animations.
- No multi-column dashboard cards, fake progress bars, or synthetic percentages.
- No extra bottom tab (strictly preserves the **Chat / Tasks** two-tab bar).

---

## 4. Redesign Specification

### Objective A: Unified Chat Header

Replace the two stacked headers (`LiveConversationHost` utility bar + `ConversationScreen.header`) with **one unified, single-row header** (~52pt base height at standard Dynamic Type, expanding gracefully without truncation at `AX` sizes).

#### Structure

```text
Leading                                                        Trailing
┌──────────────────────────────────────────────────────────┐
│ [🔥]  Ember                          [env pill]   [ ⋯ ]  │
│       Personal AI agent (or status)                      │
└──────────────────────────────────────────────────────────┘
```

1. **Identity Anchor (Leading):**
   - `34×34pt` warm Ember circle (`emberSoftSurface` fill + `emberMarkTint` glyph) — compact enough for `320pt` screens, warm and recognizable.
   - Primary title: `state.partnerName` (e.g., `"Ember"` or configured agent `displayName`; `.headline`, `lineLimit(1)`, `truncationMode(.tail)`).
   - Compact subtitle (`.caption`, `.secondary`, `lineLimit(1)`):
     - Normal idle state: `"Personal AI agent"` (localized, calm context) — or replaced *in-place* during transient connection/turn states (`"Message received"`, `"Waiting for reply"`, `"Checking connection…"`), eliminating extra stacked `model.status` rows!
2. **Explicit Environment / Simulation Indicator (Preserved & Always Visible):**
   - **Never hidden inside a menu** in Founder/Test/Mock builds.
   - Positioned cleanly before the trailing `⋯` menu (or wrapping onto a compact second sub-line under the title at `320pt` + `AX` Dynamic Type via `ViewThatFits`):
     - **V2 Staging:** `V2 STAGING` compact tinted capsule (`accessibilityIdentifier("live-cloud-mode")`, teal/indigo tint, `fixedSize`).
     - **V1 Live Cloud:** `V1 CLOUD` or `LIVE CLOUD` compact neutral capsule (`accessibilityIdentifier("live-cloud-mode")`).
     - **Custom Cloud:** `CUSTOM` / `CUSTOM CLOUD` capsule (`accessibilityIdentifier("live-cloud-mode")`).
     - **Mock (`isMockMode`):** Compact `MOCK ONLY` orange capsule (`accessibilityIdentifier("mock-only-banner")`) directly in the header, replacing the giant 90pt orange card in the Chat header! (The full `MockOnlyBanner` remains on Onboarding and Task Detail/Inbox where needed, or an optional collapsible/single-line disclosure note on first mock launch—preserving `mock-only-banner` identifier in the hierarchy).
3. **Compact Secondary Menu (`⋯` / `ellipsis.circle` — `44×44pt` target):**
   - Consolidates utility actions out of the horizontal bar:
     - **Proactive Schedules** (`calendar.badge.clock`): `"Schedules"` + active count (e.g., `"Schedules (2)"`) when supported, or `"Schedules (V2 only)"` disabled/informational status if V1 `.endpointNotReady`—or opens the sheet which truthfully explains V1 unavailability. *Recommendation:* Keep tappable when `hasRepository` (matches current behavior) and append `"· Active (N)"` when `activeCount > 0` or `"· V1 unavailable"` if `scheduleStore.isEndpointUnavailable`, plus show a small `6pt` accent dot on the `⋯` icon when `scheduleStore.hasInFlightRun`.
     - **Personal Memory** (`brain.head.profile`): `"Memory"` (with item count if loaded, or `"V1 unavailable"` hint if `memoryStore.isEndpointUnavailable`).
     - **Divider**
     - **Environment Info (non-interactive label):** Shows active mode (`V2 Staging · Streaming & Tools` vs `V1 Live Cloud · Chat & Tasks` vs `Local Mock Demo`) so Founder/QA builds are 100% transparent.
     - **Divider**
     - **Sign Out** (`rectangle.portrait.and.arrow.right`, `.destructive` role): triggers the existing sign-out confirmation alert (Live mode only).
4. **Transient Error / Recovery Bar (below unified header, only when needed):**
   - `refreshErrorMessage` (orange `wifi.slash` + Retry button) and `isPollingPaused` ("Check again") remain immediately visible below the unified header when active, using `ViewThatFits` so Retry never clips at `320pt`.

---

### Objective B: Conversation Presentation (6-Tier Visual Hierarchy)

Distinguish every timeline role visually so the transcript reads like a calm conversation with an agent rather than a stack of identical gray-bordered boxes:

| # | Entry Type | Visual Treatment | Data & Reliability Rules |
| --- | --- | --- | --- |
| 1 | **User Message** | Right-aligned pill/bubble (`cornerRadius: 18`), `userBubbleFill` (`Color.accentColor`), `Color.white` body text, max width ~78% (min leading spacer `32pt` on compact, `56pt` on `393pt`). **Remove** the low-contrast gray `"You"` text inside the bubble; keep `"You"` in VoiceOver `accessibilityLabel`. Timestamp (or pending `"Sending…"` / `"Checking delivery…"`) sits in crisp `Color.white.opacity(0.8)` inside footer or muted `.caption2` just below the bubble. | Preserves `conversation-message-user` and `conversation-message-user-pending` identifiers and single-element iOS 27 accessibility tree. |
| 2 | **Assistant Text Response (Ember)** | **No bubble box / no border.** Open editorial prose directly on `groupedBackground`, full column up to `680pt` (right breath margin `16pt`). Compact header line: `16pt` warm Ember glyph + `"Ember"` (`.caption.weight(.semibold)`, `.secondary`) + optional `MOCK` pill if simulated. Markdown body (`ConversationMarkdownText`) with comfortable `6pt` block spacing; timestamp in `.caption2` `.tertiary` below. | Preserves `conversation-message-ember` & `conversation-streaming-reply` identifiers; smooth streaming without card-box reflow jitter. |
| 3 | **Tool / Execution Activity (`.activity`)** | **Lightweight inline status row** (no card box): `2pt` vertical accent rule or `16pt` `circle.dotted` / `sparkles` icon + single `.footnote` `.secondary` line + inline timestamp. Localize hardcoded `"Cloud activity"` (`LiveConversationHost.swift#L1174`) via `Conversation.xcstrings`. | Never impersonates an interactive card or assistant prose. Commitment references follow UX-01 neutral fallback (zero raw UUIDs). |
| 4 | **Task References & Progress (`TaskActivityCard`)** | **Interactive Execution Card**: `cardBackground`, `1pt` `separator` border, `cornerRadius: 16`, leading teal/status accent glyph, `"Task"` overline, authoritative `task.displayTitle`, `TaskStatusBadge` + subtle spinner when `.queued`/`.running`, latest server event (`progressDetail`), updated timestamp, artifact count chip, trailing chevron (`≥44pt` height). **Pending/unavailable task card:** hide raw `taskID.uuidString` from the subtitle; show neutral `"Checking task status…"` / `"Task details unavailable"` without exposing UUIDs. | Strictly uses `SessionTaskDTO` / `SessionTaskEventDTO` / `TaskPresentationState`. Zero invented progress % or synthetic status. |
| 5 | **Final Results & Artifacts (`OutcomeCard`)** | **Deliverable Card**: `cardBackground` with subtle green/emerald top or leading indicator (`checkmark.seal.fill` / `doc.text.image`), `"Result"` overline, `title`, optional `summary`, and readable markdown inside a soft `outcomeWellBackground` well (not double-boxed). **Unified footer bar:** `Copy`, `ShareLink`, and `"Open N files"` (`tasks.artifacts.open_files_count`) live **together inside the card footer** using `ViewThatFits` / wrapping `HStack` (`minHeight: 44`). | Only displays readable content/files returned by `SessionTaskResultDTO` and `TaskArtifactItemDTO`. |
| 6 | **Errors & Recovery States** | **Calm Recovery Surface** inside timeline bottom (`ConversationReplyStatusView`): **Amber** (`systemOrange.opacity(0.09)`) for retryable / uncertain network states (Unknown ACK, stream interrupted, checking connection) vs **Soft Red** (`red.opacity(0.07)`) for non-retryable failed/rejected turns. Clear `44pt`-tall inline `Retry` or `Dismiss` button. | Preserves exact UX-03 copy (`LiveConversationCopy`) and Unknown ACK idempotency (never auto-resends). |

---

### Objective C: Composer Refinements

Keep the existing Hielo-style morphing `+` attachment menu, `B3AttachmentLimits` validation, and upload transport semantics untouched while resolving ergonomics and Send/Stop clarity:

1. **`44×44pt` Minimum Hit Targets:**
   - `+` attachment trigger: keep `40–42pt` visual glass circle centered inside a **`44×44pt` tappable frame** (`.frame(minWidth: 44, minHeight: 44)`).
   - Trailing Send/Stop control inside the pill: `34pt` visual circle centered inside a **`44×44pt` hit target** (`contentShape(Rectangle())`).
   - Attachment chip remove (`xmark`) button: `24pt` visual badge inside a **`44×44pt` hit area** (or `36×44pt` trailing hit zone on the chip) so users don't accidentally miss on 320pt/375pt screens.
2. **Send / Stop Control Clarity (Fixes Long-Scroll Stop Blindness):**
   - Currently, when `isGenerating == true` (streaming or waiting for cloud reply), the Composer's `arrow.up` button simply turns gray and disables, while the Stop button sits inside the timeline (`ConversationReplyStatusView`) — invisible if the user scrolled up!
   - **New behavior:**
     - When `isGenerating && !state.isSubmitting && draftTrimmed.isEmpty`: the trailing circular control transforms into a clear **Stop** button (`stop.fill`, `Color.primary` / soft charcoal circle, `accessibilityLabel` = `"Stop reply"` / `"Cancel reply"`), invoking `actions.stopGenerating`.
     - If the user already started typing a follow-up draft while generating, keep the Send icon visibly disabled (`opacity 0.4`) or show a subtle `"Wait for reply"` hint so typing doesn't trigger an accidental cancel, while the timeline's Stop button remains available at the bottom.
     - During `isSubmitting` (before cloud ACK), show a small `ProgressView()` inside the trailing circle (preventing duplicate submission).
3. **Lightweight Helper Footnote:**
   - Show `composerNote` (`"Sent messages are saved in your Ember Cloud conversation."` / `"Your message stays in this local demo."`) **only when `timeline.isEmpty`** (first-run reassurance). Once the user has an active conversation (`!timeline.isEmpty`), hide the footnote to reclaim `~22pt` of vertical space and reduce visual noise. *(Note: confirm no test requires `composerNote` after first turn—verified in §7).*
4. **320pt Narrow-Width Safety for `+` Morphing Menu:**
   - Ensure `ConversationAttachmentPopoverOverlay` clamps `destinationRect` width to `min(272, containerSize.width - 28)` so the morphing menu never crowds edges at `320pt`.

---

### Objective D: Environment-Aware Empty State

Answer **"What can Ember actually do for me?"** with a warm, restrained invitation and **truthful, capability-gated starter prompts**:

1. **Header & Framing:**
   - Soft `48×48pt` Ember emblem (`emberSoftSurface` + `emberMarkTint` glyph).
   - Title: `"How can I help today?"` / `"今天想一起推进什么？"` (`.title3.weight(.semibold)`).
   - 1-sentence value framing:
     - **V2 / Mock:** `"Ask a question, hand off a task or file, save a preference, or set a scheduled check-in."`
     - **V1 Live Cloud:** `"Ask a question, organize notes into next steps, or share a file to analyze together."` (Strictly omits Memory and Schedules!)
2. **Capability-Gated Starter Prompts (3 compact cards, icon + short title + 1-line prompt preview):**
   - **When V2 capabilities are active (`isV2Capable` — i.e., `V2 STAGING` / `CUSTOM` where endpoints are available, or `isMockMode`):**
     1. `brain.head.profile` **Remember a preference** — `"Remember that I prefer concise bullet-point summaries with clear next steps."`
     2. `sun.horizon` **Set a morning brief** — `"Prepare a daily morning brief for me at 8:00 AM."`
     3. `checklist` **Turn notes or files into action** — `"Turn these notes into clear, prioritized action items."`
     *(Note: `15-minute follow-up` remains available via chat or Schedules sheet; keeping 3 prompts prevents scrolling overflow on 320pt/375pt.)*
   - **When V1 Live Cloud (`LIVE CLOUD` / `!isV2Capable` or `scheduleStore.isEndpointUnavailable`):**
     1. `checklist` **Organize notes** — `"Turn these notes into clear, prioritized action items."`
     2. `calendar.day.timeline.left` **Plan your priorities** — `"Help me break down today’s priorities into three concrete steps."`
     3. `doc.text.magnifyingglass` **Analyze a file or draft** — `"Summarize the attached document and highlight key risks or next steps."`
3. **Focus Continuity (Fixes Abrupt Disappearance):**
   - Currently `showsSuggestions: state.showsEmptyState && state.timeline.isEmpty && !composerIsFocused` blanks the entire screen when tapping the input bar.
   - **New behavior:** Keep the Empty State visible inside the scrollable area when `composerIsFocused` (with `.scrollDismissesKeyboard(.interactively)`), collapsing only optional extra vertical padding so the welcome title and starter prompts remain accessible if the user scrolls or hasn't typed yet!

---

## 5. Before / After Designs (`320pt`, `375pt`, `393pt`) & Required States

### 5.1 Responsive Width Comparison (`320pt` · `375pt` · `393pt`)

#### State 1: Empty Conversation (V2 Staging vs V1 Live Cloud)

```text
BEFORE (320pt / 375pt — Live V1 or V2)          AFTER (320pt — Narrowest Phone)
┌──────────────────────────────────┐            ┌──────────────────────────────────┐
│ LIVE CLOUD  Sched(2) Mem Signout │ <- clips!  │ [🔥] Ember  [V2 STAGING]   [ ⋯ ] │ <- single row, 44pt hits
├──────────────────────────────────┤            ├──────────────────────────────────┤
│ [✨] Ember Cloud                 │            │                                  │
│      Your personal AI partner    │            │        ┌────────────────┐        │
├──────────────────────────────────┤            │        │   🔥 Ember     │        │
│                                  │            │        └────────────────┘        │
│ I'm here with you.               │            │  How can I help today?           │
│ Bring a question, a thought...   │            │  Ask a question, hand off a task │
│                                  │            │  or file, save a preference, or  │
│ Suggestions                      │            │  set a scheduled check-in.       │
│ ┌──────────────────────────────┐ │            │                                  │
│ │ ✨ Remember that I prefer... │ │ <- shown   │  ┌────────────────────────────┐  │
│ └──────────────────────────────┘ │    even on │  │ 🧠 Remember a preference   │  │
│ ┌──────────────────────────────┐ │    V1!     │  │ "Concise bullet-point..."  │  │
│ │ ✨ Prepare a daily morning.. │ │            │  └────────────────────────────┘  │
│ └──────────────────────────────┘ │            │  ┌────────────────────────────┐  │
│ ┌──────────────────────────────┐ │            │  │ 🌅 Set a morning brief     │  │
│ │ ✨ Remind me in 15 minutes.. │ │            │  │ "Daily brief at 8:00 AM"   │  │
│ └──────────────────────────────┘ │            │  └────────────────────────────┘  │
│                                  │            │  ┌────────────────────────────┐  │
│                                  │            │  │ ☑ Turn notes into action   │  │
│                                  │            │  │ "Prioritized action items" │  │
├──────────────────────────────────┤            │  └────────────────────────────┘  │
│ [+] [ Message Ember...      (↑)] │            ├──────────────────────────────────┤
│  Sent messages are saved in...   │            │ [+] [ Message Ember...      (↑)] │
├──────────────────────────────────┤            │  Saved in your Ember Cloud chat. │
│     [ Chat ]        [ Tasks ]    │            ├──────────────────────────────────┤
└──────────────────────────────────┘            │     [ Chat ]        [ Tasks ]    │
                                                └──────────────────────────────────┘

Note for V1 LIVE CLOUD (`320pt` / `375pt` / `393pt`):
Header pill reads [LIVE CLOUD] (or [V1 CLOUD]); the 3 starter prompts are strictly
"Organize notes", "Plan your priorities", and "Analyze a file or draft" — ZERO Memory
or Schedule promises!
```

#### State 2: Normal Chat (`375pt` & `393pt` Comparison)

Look at [before-375-chat-light.png](assets/ux04/before-375-chat-light.png) and [before-393-chat-light.png](assets/ux04/before-393-chat-light.png) compared against the redesigned `375pt` / `393pt` layout:

```text
BEFORE (375pt — Current main)                   AFTER (375pt / 393pt — Redesigned)
┌─────────────────────────────────────┐         ┌─────────────────────────────────────┐
│ ┌────────────────────┐ 📅 Schedules │         │ [🔥] Ember  [MOCK ONLY]       [ ⋯ ] │
│ │ 🧪 MOCK ONLY       │ 🧠 Memory    │         │      Personal AI agent              │
│ │ Simulated preview  │              │         ├─────────────────────────────────────┤
│ └────────────────────┘              │         │                                     │
├─────────────────────────────────────┤         │          ┌────────────────────────┐ │
│ [✨] Ember (Mock)                   │         │          │ Please pull out Q4     │ │
│      Your personal AI partner       │         │          │ launch action items    │ │
├─────────────────────────────────────┤         │          │ from my meeting notes. │ │
│ ┌─────────────────────────────────┐ │         │          │               9:10 AM  │ │ <- crisp white
│ │ ✨ Ember · MOCK                 │ │         │          └────────────────────────┘ │
│ │ I started a Notes action-items  │ │         │                                     │
│ │ task. Track persisted status... │ │         │ 🔥 Ember  [MOCK]                    │
│ │ 9:10 AM                         │ │         │ I started a Notes action-items      │ <- open prose,
│ └─────────────────────────────────┘ │         │ task. You can track persisted       │    NO bubble box!
│ ┌─────────────────────────────────┐ │         │ status in the card below.           │
│ │ ⚡ Task  MOCK ONLY           >  │ │         │ 9:10 AM                             │
│ │ Extract Q4 launch action items  │ │         │                                     │
│ │ [✓ Processing ended] · 9:12 AM  │ │         │ ┌─────────────────────────────────┐ │
│ └─────────────────────────────────┘ │         │ │ ⚡ Task · MOCK               >  │ │ <- distinct
│ ┌─────────────────────────────────┐ │         │ │ Extract Q4 launch action items  │ │    Task card
│ │ 📄 Result  MOCK ONLY            │ │         │ │ [✓ Processing ended] · 9:12 AM  │ │
│ │ Extract Q4 launch action items  │ │         │ └─────────────────────────────────┘ │
│ │ ┌─────────────────────────────┐ │ │         │                                     │
│ │ │ 1. Confirm App Store review │ │ │         │ ┌─────────────────────────────────┐ │
│ │ └─────────────────────────────┘ │ │         │ │ ✓ Result · MOCK                 │ │ <- unified Result
│ │ [Copy] [Share]                  │ │         │ │ Extract Q4 launch action items  │ │    card + well +
│ └─────────────────────────────────┘ │         │ │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ │    integrated
│ [📄 Open 1 file]                    │         │ │ ░ 1. Confirm App Store review ░ │ │    file CTA
│          ┌────────────────────────┐ │         │ │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ │
│          │                    You │ │ <- gray │ │ [Copy]  [Share]  [Open 1 file]  │ │
│          │ Also summarize the...  │ │   on    │ └─────────────────────────────────┘ │
│          └────────────────────────┘ │   blue! │                                     │
├─────────────────────────────────────┤         ├─────────────────────────────────────┤
│ [+] [ Message Ember...         (↑)] │         │ [+] [ Message Ember...         (↑)] │ <- no redundant
│  Your message stays in this demo.   │         │                                     │    footer note
├─────────────────────────────────────┤         ├─────────────────────────────────────┤
│       [ Chat ]      [ Tasks (1) ]   │         │       [ Chat ]      [ Tasks (1) ]   │
└─────────────────────────────────────┘         └─────────────────────────────────────┘
```

#### State 3: Streaming Response (`393pt` — V2 Staging SSE)

```text
┌───────────────────────────────────────────┐
│ [🔥] Ember  [V2 STAGING]            [ ⋯ ] │
│      Personal AI agent                    │
├───────────────────────────────────────────┤
│              ┌──────────────────────────┐ │
│              │ Summarize the Q4 launch  │ │
│              │ risks from my notes.     │ │
│              │                 9:14 AM  │ │
│              └──────────────────────────┘ │
│                                           │
│ 🔥 Ember                                  │
│ Here are the three main risks from your   │
│ meeting notes:                            │
│ • App Store review timing if the metadata │
│   checklist isn't finalized by Friday▌    │ <- open streaming prose; no box reflow
│                                           │
│   ◐ Streaming reply…                      │ <- quiet inline indicator (non-boxed)
│                                           │
├───────────────────────────────────────────┤
│ [+] [ Message Ember...              (■) ] │ <- Composer Stop button always reachable!
├───────────────────────────────────────────┤
│        [ Chat ]         [ Tasks (1) ]     │
└───────────────────────────────────────────┘
```

#### State 4: Active Task Reference + Inline Activity + Error Recovery (`375pt`)

```text
┌─────────────────────────────────────┐
│ [🔥] Ember  [V2 STAGING]      [ ⋯ ] │
│      Waiting for Ember's reply      │ <- transient status integrated in subtitle
├─────────────────────────────────────┤
│          ┌────────────────────────┐ │
│          │ Analyze sales.csv and  │ │
│          │ summarize anomalies.   │ │
│          │               9:15 AM  │ │
│          └────────────────────────┘ │
│                                     │
│ ┆ Cloud activity · Checking device  │ <- quiet inline activity (no heavy card)
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ ⚡ Task                      >  │ │ <- TaskActivityCard (DTO truth only)
│ │ Analyze sales.csv anomalies     │ │
│ │ [⚙ In progress] ◐ · Task started│ │
│ │ Updated 9:15 AM                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │ <- Recovery state (UX-03 copy preserved)
│ │ ⚠ Connection interrupted while  │ │    amber for uncertain/retryable;
│ │   waiting for Ember's reply.    │ │    soft red for failed/rejected
│ │   [ ↻ Retry ]                   │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ [+] [ Message Ember...         (■)] │
├─────────────────────────────────────┤
│       [ Chat ]      [ Tasks (1) ]   │
└─────────────────────────────────────┘
```

#### State 5: Long Conversation (`393pt` — Scrolled Up Reading History, UX-02 Preserved)

```text
┌───────────────────────────────────────────┐
│ [🔥] Ember  [V2 STAGING]            [ ⋯ ] │
│      Personal AI agent                    │
├───────────────────────────────────────────┤
│ 🔥 Ember                                  │
│ 2. Once the CSV is parsed, we'll compare  │
│    regional retention week-over-week...   │
│ 9:02 AM                                   │
│                                           │
│              ┌──────────────────────────┐ │
│              │ Can you focus on APAC    │ │
│              │ cohorts specifically?    │ │
│              │                 9:03 AM  │ │
│              └──────────────────────────┘ │
│                                           │
│ 🔥 Ember                                  │
│ Yes — APAC retention stabilized at...     │
│                                           │
│                    (↓)                    │ <- 44×44pt UX-02 Jump-to-Latest floats
│                                           │    above composer while reading older text
├───────────────────────────────────────────┤
│ [+] [ Message Ember...              (■) ] │ <- User can still Stop active stream
├───────────────────────────────────────────┤    without jumping to bottom first!
│        [ Chat ]         [ Tasks (1) ]     │
└───────────────────────────────────────────┘
```

#### State 6: Dark Mode & Large Dynamic Type (`AX3` at `320pt` / `375pt`)

Look at [before-375-chat-dark-a11y.png](assets/ux04/before-375-chat-dark-a11y.png) where the double header took >50% of the screen. Under the redesign:

```text
AFTER (375pt / 320pt — Dark Mode + Accessibility Large / AX3)
┌─────────────────────────────────────┐
│ [🔥] Ember                    [ ⋯ ] │ <- Header uses ViewThatFits: at AX sizes,
│      [V2 STAGING]                   │    env pill moves neatly onto line 2;
├─────────────────────────────────────┤    NO horizontal button crowding!
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Analyze sales.csv and           │ │
│ │ summarize key anomalies.        │ │
│ │                        9:15 AM  │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 🔥 Ember                            │ <- Open prose uses full column width
│ I started the analysis task.        │    (no wasted card padding + inner indent!)
│ 9:15 AM                             │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ ✓ Result                        │ │
│ │ Sales anomalies summary         │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ • Region B dipped 14%...    │ │ │
│ │ └─────────────────────────────┘ │ │
│ │ [ Copy ]                        │ │ <- OutcomeCard action buttons stack
│ │ [ Share ]                       │ │    vertically via ViewThatFits at AX3
│ │ [ Open 1 file ]                 │ │    so labels never truncate!
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ [+] [ Message Ember...         (↑)] │ <- 44pt targets preserved; no footer note
├─────────────────────────────────────┤
│       [ Chat ]      [ Tasks (1) ]   │
└─────────────────────────────────────┘
```

### 5.3 Rendered iOS 27.2 Prototype Visual Comparisons (Before vs. After)

> [!NOTE]
> **Render Provenance:** **Before** panels render the unmodified production SwiftUI views (`LiveConversationHost` header, `ConversationScreen`, `ConversationTimelineView`, `ConversationComposer`, `TaskActivityCard`, `OutcomeCard`) from `main` @ `f37ffc6`. **After** panels render non-committed SwiftUI prototype views on the iOS 27.2 Simulator (`iPhone 18 Pro` runtime, `2x` scale) at exact `320×568pt`, `375×667pt`, and `393×852pt` viewports. Temporary snapshot harness code was removed after capture so this PR remains strictly design-only.

#### Width Comparison: Empty State (`320pt` / `375pt` / `393pt` — V2 Staging)

| Width | Before (`main` @ `f37ffc6`) | After (UX-04 Prototype) |
| --- | --- | --- |
| **320pt** (`320×568`) | ![Before 320pt V2 Empty](assets/ux04/before-320-v2-empty.png) | ![After 320pt V2 Empty](assets/ux04/after-320-v2-empty.png) |
| **375pt** (`375×667`) | ![Before 375pt V2 Empty](assets/ux04/before-375-v2-empty.png) | ![After 375pt V2 Empty](assets/ux04/after-375-v2-empty.png) |
| **393pt** (`393×852`) | ![Before 393pt V2 Empty](assets/ux04/before-393-v2-empty.png) | ![After 393pt V2 Empty](assets/ux04/after-393-v2-empty.png) |

#### Environment-Honest Empty State (`393pt` — V2 Staging vs. V1 Live Cloud)

| V2 Staging (Memory, Briefs, Schedules Enabled) | V1 Live Cloud (No Memory / Schedule Promises) |
| --- | --- |
| ![After 393pt V2 Empty](assets/ux04/after-393-v2-empty.png) | ![After 393pt V1 Empty](assets/ux04/after-393-v1-empty.png) |

#### Width Comparison: Normal Chat + Active Task + Outcome (`320pt` / `375pt` / `393pt`)

| Width | Before (`main` @ `f37ffc6`) | After (UX-04 Prototype) |
| --- | --- | --- |
| **320pt** (`320×568`) | ![Before 320pt Chat Task](assets/ux04/before-320-chat-task.png) | ![After 320pt Chat Task](assets/ux04/after-320-chat-task.png) |
| **375pt** (`375×667`) | ![Before 375pt Chat Task](assets/ux04/before-375-chat-task.png) | ![After 375pt Chat Task](assets/ux04/after-375-chat-task.png) |
| **393pt** (`393×852`) | ![Before 393pt Chat Task](assets/ux04/before-393-chat-task.png) | ![After 393pt Chat Task](assets/ux04/after-393-chat-task.png) |

#### Key Conversation States (`393pt` — Streaming, Long/Recovery, Dark Mode) & `320pt` Accessibility Large

| Scenario | Before (`main` @ `f37ffc6`) | After (UX-04 Prototype) |
| --- | --- | --- |
| **Streaming Response (`393pt`)** | ![Before 393pt Streaming](assets/ux04/before-393-streaming.png) | ![After 393pt Streaming](assets/ux04/after-393-streaming.png) |
| **Long Chat + Jump-to-Latest + Recovery (`393pt`)** | ![Before 393pt Long Error](assets/ux04/before-393-long-error.png) | ![After 393pt Long Error](assets/ux04/after-393-long-error.png) |
| **Dark Mode (`393pt`)** | ![Before 393pt Dark](assets/ux04/before-393-dark.png) | ![After 393pt Dark](assets/ux04/after-393-dark.png) |
| **Accessibility Large Dynamic Type (`320pt`)** | ![Before 320pt A11y Large](assets/ux04/before-320-a11y-large.png) | ![After 320pt A11y Large](assets/ux04/after-320-a11y-large.png) |

---

## 6. Interaction, Accessibility, & Localization Notes

### 6.1 Preserved Contracts & Behaviors
- **UX-02 Smart Scrolling (`ConversationTimelineScrollState`):** Unchanged. Near-bottom auto-follow, user scroll-up detachment, `Jump to Latest` `44×44pt` button, and foreground/Dynamic Type bottom settling remain intact. Note: removing the card border on Ember replies reduces vertical height changes per streaming token and keeps scroll anchor math cleaner.
- **UX-03 Reliability & Copy (`LiveConversationCopy`):** Unchanged. `pendingOutgoingText` bubble, `unknownAcknowledgement` caution banner, rejected-draft restoration, SSE-to-polling fallback, and server-authoritative cancellation remain untouched.
- **Data Truthfulness:** `TaskActivityCard`, `OutcomeCard`, and `SessionTaskPendingReferenceCard` only render verified DTO fields. Pending/unavailable `task_reference` and `commitment_reference` rows never leak raw UUIDs in primary text (and `commitmentReference` follows [UX-01](../product/ios/UX01_COMMITMENT_MAPPING_RESEARCH.md)).
- **Attachments & Transport:** `B3AttachmentLimits`, photo/camera/file pickers, and upload staging (`LiveConversationHostModel`) remain unchanged.

### 6.2 Accessibility (VoiceOver, Dynamic Type, Reduce Motion)
- **Single-element message grouping (iOS 27 UI test & VoiceOver stability):** Keep `.accessibilityElement(children: .combine)` and `.accessibilityIdentifier("conversation-message-user")` / `"conversation-message-ember"` on each message container, with `"You"` / `"Ember"` included in the accessibility label even though `"You"` is no longer drawn visibly inside the blue bubble.
- **Minimum `44×44pt` hit areas:** Applied to header `⋯` menu, composer `+`, composer Send/Stop, attachment chip remove buttons, Jump-to-Latest, and inline card action buttons.
- **Dynamic Type (`320pt`–`393pt`):** Header uses `ViewThatFits` so `environmentBadge` drops below `"Ember"` when horizontal space is exhausted; `OutcomeCard` footer buttons (`Copy`, `Share`, `Open N files`) wrap via `ViewThatFits` / vertical fallback at `AX` sizes; composer `TextField` keeps `.lineLimit(1...6)`.
- **Reduce Motion:** Respect `@Environment(\.accessibilityReduceMotion)` for composer pill transitions, Jump-to-Latest reveal, and attachment menu collapse (already respected in `ConversationAttachmentPopoverOverlay` & `ConversationTimelineView`).

### 6.3 Localization (`en` & `zh-Hans`)
- Localize hardcoded `"Cloud activity"` (`LiveConversationHost.swift#L1174`) via `conversation.activity.cloud` (`"Cloud activity"` / `"云端动态"`).
- Add localized keys in `Conversation.xcstrings` for:
  - Header subtitle (`"Personal AI agent"` / `"个人 AI 伙伴"`)
  - Menu items (`"Environment"`, `"Stop reply"`, etc.)
  - V2 vs V1 empty-state titles, value framing, and starter prompts (`en` & `zh-Hans`).

---

## 7. Phase 2 Implementation Plan (3 Focused, Reversible PRs)

Phase 2 begins **only after UI/UX Lead + CTO approval** of this proposal, split into 3 small PRs:

1. **PR 1: Unified Header + Environment-Aware Empty State**
   - Files: `LiveConversationHost.swift`, `ConversationScreen.swift`, `ConversationScreenState.swift`, `ConversationTimelineView.swift`, `EmberDesignTokens.swift`, `Conversation.xcstrings`.
   - Changes:
     - Merge `LiveConversationHost` top utility bar + `ConversationScreen.header` into one compact unified header with Ember emblem, always-visible environment pill (`live-cloud-mode` / `mock-only-banner`), and `⋯` `Menu` (`Schedules`, `Memory`, Environment info, `Sign out`).
     - Integrate `model.status` cleanly into header subtitle slot.
     - Add `isV2Capable` / endpoint-aware `suggestedPrompts` (no Memory/Schedule prompts on V1) and keep empty state visible on composer focus.
   - Validation: Update UI tests (`B3ChatTasksIntegrationUITests`, `LiveModeLaunchUITests`) for menu-based Memory/Sign Out access (see §8.1), add unit tests for V1 vs V2 starter prompt selection, and capture `375pt`/`393pt` + Dark/AX screenshots.

2. **PR 2: Composer Ergonomics & Send/Stop Clarity**
   - Files: `ConversationComposer.swift`, `ConversationScreen.swift`, `Conversation.xcstrings`.
   - Changes:
     - Enforce `44×44pt` hit areas on `+`, Send/Stop, and chip remove controls.
     - Surface Stop control in the composer pill while `isGenerating` and draft is empty (respecting `isSubmitting` guard).
     - Show `composerNote` only when `timeline.isEmpty`; clamp `+` morphing popover width for `320pt`.
   - Validation: Unit/UI tests for Send/Stop state transitions, attachment chip removal hit targets, and `320pt` layout verification.

3. **PR 3: Conversation Presentation Polish**
   - Files: `ConversationTimelineView.swift`, `TaskActivityCard.swift`, `OutcomeCard.swift`, `ConversationCardFormatting.swift`, `LiveConversationHost.swift`, `Conversation.xcstrings`, `ConversationCards.xcstrings`.
   - Changes:
     - Fix user bubble `"You"` contrast bug (remove `.secondary` visible header inside blue bubble; keep VoiceOver label).
     - Render Ember replies as open editorial prose on `groupedBackground` (preserving `conversation-message-ember` & `conversation-streaming-reply`).
     - Replace `.activity` card box with quiet inline row + localized `"Cloud activity"`.
     - Integrate `"Open N files"` inside `OutcomeCard` footer, soften inner well, and remove raw UUID from `SessionTaskPendingReferenceCard`.
   - Validation: Regression tests for `ConversationSmartScrollingUITests`, `ConversationRootLaunchUITests`, `LiveConversationRecoveryCopyTests`, and Before/After screenshot comparison.

---

## 8. Questions Requiring UI/UX Lead & CTO Approval

1. **Header `⋯` Menu vs Direct Shortcuts (Test Impact):** Moving `Memory`, `Schedules`, and `Sign out` into the header `⋯` menu resolves `320pt`/`375pt` crowding and sub-`44pt` tap targets, and requires updating `B3ChatTasksIntegrationUITests` (`live-conversation-open-memory`) and `LiveModeLaunchUITests` (`live-conversation-sign-out`) to open `live-conversation-menu` first. **Approve moving all three into `⋯` (with optional subtle dot indicator on `⋯` when a schedule run is in flight)?**
2. **Mock Disclosure Placement in Chat (`MockOnlyBanner` vs Compact Header Pill):** In `--ember-mock-chat-tasks`, replacing the full 90pt `MockOnlyBanner` at the top of Chat with a compact `MOCK ONLY` header pill (`accessibilityIdentifier("mock-only-banner")`) prevents the `375pt` header collapse seen in `before-375-chat-dark-a11y.png` while keeping `MOCK ONLY` permanently visible (and keeping full `MockOnlyBanner` on Onboarding, Task Detail, and Sheets). **Approve compact `MOCK ONLY` pill in Chat header?**
3. **V1 Empty-State Prompts:** Confirm the 3 V1-only starter prompts (*Organize notes*, *Plan priorities*, *Analyze a file*) and confirm whether V1 should hide Memory/Schedules from the `⋯` menu or keep them visible with an explicit `"V1 unavailable"` state inside the sheet.
4. **Hiding `composerNote` After First Turn:** Confirm showing `"Sent messages are saved in your Ember Cloud conversation."` only when `timeline.isEmpty` (and hiding it once conversation begins to keep the composer light).
5. **User Message Bubble Treatment (Soft Tinted Pill vs. Solid Accent Fill):** The §5.3 prototype renders demonstrate a soft-tinted user pill (`Color.accentColor.opacity(0.12)` light / `0.24` dark with `.primary` text) on a `systemBackground` canvas so Ember's editorial prose and structured Result/Task cards remain calm. **Approve the soft-tinted pill + `systemBackground` chat canvas, or prefer keeping solid `Color.accentColor` user bubbles on `systemGroupedBackground`?**
