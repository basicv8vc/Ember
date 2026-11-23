# Ember UX Foundation V1 — Muse-Informed Visual & Navigation Freeze

**Status:** Design freeze proposal for Founder / UI/UX Lead review; implementation is not authorized by this document alone.
**Date:** 2026-11-23
**Scope:** iOS visual language, information architecture, Chat presentation, navigation personalization boundaries. No runtime/API/schema/auth changes.
**Baseline:** main @ aeab75becab3253c39de3a2fe7f7be2217d403df (UX-04 PR 2 / #280 merged).

## 1. Source and confidence

The Founder supplied seven stills of a Muse app walkthrough on 2026-11-22. We use them as **visual and interaction references**, not a source of truth for implementation details.

| Screenshot observation | Design implication | Not proven by the stills |
| --- | --- | --- |
| Chat uses understated, similarly toned user and assistant bubbles, with a restrained background. | Make conversational turns legible without saturated color blocks. | Exact Muse color values, accessibility contrast, or layout internals. |
| Bottom rounded floating bar shows Chat, Feed, Ideas, Goals, Library; selected item is highlighted. | Separate high-frequency pinned destinations from the complete catalog. | Whether any destination is persistently customizable for every user. |
| In the transcript, a user requests "Remove the tab bar" and then "Reset to normal"; agent replies as if it made these changes. | User-directed, reversible presentation is a compelling interaction model. | Persistent server-side settings, actual tool authorization, or effects beyond the filmed states. |
| Sidebar groups TABS and SPACES; shows a search field and settings/create affordances. | A full navigational directory can coexist with a minimal bottom bar. | Spaces' underlying schema/runtime or automatic creation semantics. |
| Memory Bank is a photo grid and Round Analysis is a specialized analytics view. | Some deliverables deserve dedicated, purpose-built surfaces. | Ember's existing Personal Memory data being equivalent to Muse's Memory Bank Space. |
| Agent avatar appears near the header; a transient "Resetting sidebar" status appears around it. | Agent activity can be shown as small, contextual, trustworthy feedback. | Whether that activity is server-confirmed or durable. |

Do **not** commit or copy the Founder's screenshots into the repository; they are references provided in conversation, not assets licensed for Ember.

## 2. North star and non-negotiable principles

**Warm · Quiet · Competent.** **Less Chatbot. More Personal Agent.**

1. The Agent is the consistent relationship; tasks, memories and tools are destinations in that relationship.
2. The software adapts to the user, but every customization is **discoverable, reversible and recoverable**.
3. Use as few primary destinations as the **actual implemented features** justify. Do not ship empty Feed / Ideas / Library tabs.
4. UI never claims an action is complete until there is an authoritative result. Keep Cloud, staging and MOCK ONLY disclosures visible.
5. Accessibility and reliability are design constraints, not afterthoughts.
6. Prefer native iOS conventions and simple state models; do not build a dynamic UI compiler or an arbitrary LLM-driven SwiftUI editor.

## 3. Frozen information architecture for the next implementation phase

### Primary navigation

- **Main Chat:** permanent first-class destination and the Agent's single ongoing conversation.
- **Tasks:** existing authoritative Task / Result inbox and task details.
- **Bottom bar:** initially exactly **Chat + Tasks**, in a small floating capsule visual treatment. Do not create five fake icons to resemble Muse.
- **Sidebar:** the complete directory, accessible from a 44pt leading header affordance:
  - **TABS:** Chat, Tasks.
  - **TOOLS:** Personal Memory, Schedules (the already-shipped actual views), with V1/V2 availability disclosed.
  - **SETTINGS:** sign-out via existing confirmation; environment info where applicable; navigation preferences in a later PR.
  - **SPACES:** **absent until at least one real Space exists**. A future Spaces section is distinct from Personal Memory; do not relabel Personal Memory as "Memory Bank".
- Each destination has one canonical source of truth and one navigation route. Hiding a pinned tab does not remove its underlying destination.

### Navigation interaction

- The top-left Sidebar control is always reachable in the Chat root and never obscures the required environment/mode badge.
- Opening a Sidebar destination dismisses the Sidebar and preserves the existing Chat/Tasks navigation context.
- Do not introduce a global left-edge swipe until tested against transcript scrolling, interactive back gestures and text selection.
- Keyboard visible: prevent the floating bottom bar from competing with the Composer; prefer temporarily hiding the bar while entering text and restoring it when keyboard dismisses. Do not rely on a manual keyboard-height observer.
- Respect safe areas, iPhone home indicator, split layout, and existing navigation-stack detail presentations.
- Retain the underlying routing and task-authoritative model currently used by LiveConversationHost. Navigation changes are presentation changes, not Task API changes.

### Future navigation personalization (not UX-04 PR 3)

Phase A: an explicit settings UI can show/hide/reorder **eligible pinned tabs** with a local persisted configuration and a one-tap Reset to Default. Chat **cannot be removed**; Tasks must remain accessible in Sidebar even when unpinned. Keep the initial available set Chat/Tasks only.

Phase B: a constrained natural-language intent ("Only show Chat", "Restore default tabs") may call the **same typed navigation-preferences operation** after user-visible feedback. No direct model-generated UI code, secret hidden routes, or unrestricted schema edits. Make the change reversible and accurately acknowledge success/failure; never say "Done" before persistence succeeds.

Spaces is an exploratory **post-V1** product surface, not a hidden requirement for these navigation PRs.

## 4. Frozen presentation language

### Materials and color

Prefer semantic, adaptive system colors first; the following are **design reference values, not hard-coded final replacements**:

| Role | Light reference | Dark reference | Implementation guidance |
| --- | --- | --- | --- |
| Canvas | warm porcelain #FAF7F5 | charcoal #191817 | Adaptive semantic background, not a single always-light RGB |
| Conversation surface | warm gray #EAE5E2 | raised charcoal #292725 | Low saturation; distinct enough from canvas for conversation boundaries |
| Primary text | charcoal #302C2A | soft white #F4F1EF | Validate normal-text contrast at 4.5:1 minimum |
| Secondary text | muted brown-gray #6A6461 | muted light gray #BBB4B0 | Use system secondary where it preserves legibility |
| Ember accent | terracotta #C66A3A | warm amber #E8874A | Reserve for Agent identity, selected emphasis and genuine actions |
| Warning/error | semantic amber/red | semantic amber/red | Preserve actual severity, do not make errors disappear into neutral palette |

Current code uses EmberDesignTokens.groupedBackground, cardBackground, emberMarkTint, emberSoftSurface and minTapTarget (44pt). Extend these **incrementally** with semantic roles rather than replacing every surface throughout the application in one PR.

### Shape and spacing

- Use an 8pt rhythm; 16pt typical horizontal page inset; consistent editorial whitespace.
- Conversational bubbles: soft corners around 18–20pt; visually lightweight and different from interactive Task/Result cards.
- Floating bottom capsule: bounded width based on **actual** tab count, safe-area aware, not full width at all sizes. Each destination retains at least a 44×44pt target.
- Task/Result surfaces: 16–20pt corners, semantically useful hierarchy, and a distinct, actionable footer when appropriate.
- Preserve a readable max-width for long text (current 680pt), Dynamic Type and AX sizing; avoid fixed-height clipping.
- Motion is optional, brief, and disabled/reduced under Reduce Motion. No pulsing orb, gratuitous animation or manufactured progress.

## 5. Revised UX-04 PR 3 conversation decision

**This explicitly supersedes the "Assistant Text Response: no bubble" recommendation in UX04_CHAT_EXPERIENCE_REDESIGN.md §4 Objective B for PR 3.** It does not undo #278/#280 and does not overwrite their reliable behavior.

Use a **hybrid conversation layout**:

| Content type | Presentation | Truth / accessibility |
| --- | --- | --- |
| User turn | Right-aligned soft-tinted neutral bubble, normal primary text; visible speaker label optional, VoiceOver role required. | Preserve pending, unknown-ACK and confirmed delivery distinctions. |
| Short / normal Agent reply | Left-aligned soft neutral bubble, subtly distinct from user turn; avoid an expensive branded gradient or thick border. | Preserve message ID, streaming behavior and accessible speaker label. |
| Long-form Agent writing | Readable markdown in the conversation with calm paragraph rhythm; optional dedicated reading view later, not in PR 3. | Avoid forced fixed-height bubble or truncated response; preserve selection/copy. |
| Live execution / activity | Small contextual row or expandable Activity surface, **only when backed by actual state/event**. | Never invent step count, percent, ETA, or completion. |
| Task reference | Structured actionable Task card, using server-authoritative state and existing route. | Preserve task identity, approvals, and access controls. |
| Result/artifact | Result-first delivery card and existing artifact access. | Preserve server-authored content and file permissions. |
| Retry/failed/unknown | Clear calm recovery panel separated from successful replies. | Preserve UX-03 idempotency, non-automatic resends and accurate status. |

No global auto-generated "thinking" ticker from arbitrary strings. Do not show a fake success bubble for a navigation action before it actually succeeds.

Preserve: existing accessibility IDs, Smart Scrolling UX-02, Unknown ACK / SSE polling recovery UX-03, Composer Stop and draft safety #280, Task Detail #279, Memory #276, Schedules #277.

## 6. Agent identity and activity

- One recognizable Agent avatar or small Ember emblem in the header; no extra competing avatar on every card.
- Transient action status (e.g. "Stopping reply…" or "Updating schedule…") may appear near the header **only if tied to the real operation's state**.
- Task / Run statuses remain distinct from chat-delivery statuses, and never imply the work is finished while still running.
- Do not invent a persistent global Activity page in this phase; use current real Task/Run data where available.

## 7. Small PR delivery order

| Milestone | Owner boundary / file impact | Acceptance |
| --- | --- | --- |
| UX-FDN-00: this design freeze proposal | docs/design only; no Swift change. | Founder + UI/UX Lead direction agreed; deviations documented. |
| UX-04 PR 3: Conversation Presentation | ConversationTimelineView and focused style/tests; update only needed shared tokens/localizations. **No navigation shell edits.** | Distinct user/Agent turns; long content readable; reliable status/recovery; 320/375/393pt, dark, zh-Hans, AX, screenshot comparisons. |
| NAV-01: Floating two-tab shell | LiveConversationHost and new isolated navigation view. **No transcript renderer edits.** | Chat/Tasks routes, badges, back stack, keyboard, VoiceOver and sign-out unchanged; native-safe-area behavior. |
| NAV-02: Sidebar directory | New Sidebar view + minimal host wiring. | Chat, Tasks, Memory, Schedules actual routes; 320pt and AX; V1 unavailable and MOCK disclosure; no empty Spaces tab. |
| NAV-03: Reversible manual pinning | Small local navigation-preference state + settings UI only. | Pin/unpin eligible items, reset to default, survives relaunch, cannot lose Chat access, tests. |
| Later: natural-language nav settings / Spaces | Product + authorization design required first. | Typed, auditable, reversible, capability-aware operations; real user-value pilot. |

UX-04 PR 3 and NAV-01 may be implemented in parallel **after this freeze is accepted** if Agent A owns ConversationTimelineView/style and Agent B owns the navigation host/new component; coordinate shared DesignTokens.xcstrings changes and rebase after first merge. NAV-02 depends on NAV-01. Keep #281 budget/schema migration work isolated.

## 8. Acceptance matrix and explicit non-goals

Acceptance screenshots and tests for actual changed UI: **320 / 375 / 393pt**, EN and zh-Hans, Light/Dark, larger Dynamic Type, VoiceOver, Reduce Motion as applicable. Core scenarios: long history scrolled away from bottom; generating with Stop; attachment menu and keyboard; Task running/waiting approval/completed; Memory and Schedules available/unavailable; unknown ACK and recovery; mock badge visible. Test navigation without losing drafts or breaking deep-linked Task detail. No changes to Cloud cost, task state, permissions, persistence schema or attachment upload semantics.

Do not overengineer: **no artificial five-tab shell, no generalized drag-and-drop UI editor, no dynamic Space runtime, no new backend routes, no hidden environment badges, no production deployment** in this phase.

## 9. Decision log

- D1: Two real primary destinations (Chat, Tasks); full directory via Sidebar; Spaces only when real.
- D2: Floating capsule is a **planned visual/navigation shell change**, not part of UX-04 PR 3.
- D3: Chat uses hybrid soft bubbles + structured Task/Result cards, superseding the earlier pure-editorial Assistant prose proposal.
- D4: Manual reversible preferences precede natural-language customization.
- D5: UI adapts to the user; all customization preserves safe, discoverable recovery.
- D6: Production truth (status, permissions, results) outranks aesthetic imitation.

**Founder review focus:** D1 (navigation catalog), D3 (conversation bubble treatment), D4 (degree and timing of personalization). Once accepted, keep decisions stable for the next focused PRs.
