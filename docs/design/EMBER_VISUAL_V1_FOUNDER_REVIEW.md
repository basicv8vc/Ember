# Ember Visual V1 — Founder Review Spec

**Status:** **Founder-approved monochrome direction (2026-11-23)**; implementation specification, **not** a production or Simulator acceptance report.
**Date:** 2026-11-23
**Code baseline:** `main` @ `c347dc9f4133cb3ed51a18f05a003010e6f0baae`.
**Companion reference:** Three-screen HTML concept + Chromium-rendered board delivered with the Founder conversation on 2026-11-23. The screenshots are **not** Xcode/iOS Simulator captures and are **not** committed to this repo.

This proposal refines [Ember UX Foundation V1](EMBER_MUSE_UX_FOUNDATION_V1.md). It keeps its principles **Quiet · Focused · Reliable**, **Less Chatbot. More Personal Agent**, two real primary destinations, and reversible future customization. The Founder explicitly selected **A: black, white, and grayscale minimalism** over the earlier cream/terracotta exploration.

## 1. Visual thesis

Make the first **five seconds** count without pretending Ember has capabilities it does not ship. A new user should immediately recognize:

1. **Who:** one approachable Agent named Ember, with a restrained warm brand mark.
2. **What:** a single obvious chat Composer and 2–3 capability-aware, concrete starting points.
3. **Where the work goes:** existing Tasks for real progress, approvals and results.
4. **How to recover:** an always-available native navigation and honest environment/capability disclosure.

Treat the submitted Muse walkthrough stills as reference for understated bubbles, navigation hierarchy and purpose-built work surfaces—not permission to copy visual assets or imply equivalent product capabilities.

## 2. Three core screens (illustrative, not server data)

| State | Primary hierarchy | Secondary hierarchy | No-go |
| --- | --- | --- | --- |
| Chat first run | Ember identity → short inviting headline → current-capability examples → Composer | Chat/Tasks native tabs, environment info | Empty fake destinations, misleading broad promises, cluttered hero cards |
| Active conversation | Clear user/Agent turns → small **true** work summary if known → actionable server Task card → Composer | Inline real Activity, stable recovery/cancellation state | Synthetic step count, fabricated ETA, unverified "Done" |
| Tasks | Needs your input → in progress → recently completed with reachable result | Existing detail/actions, contextual status | Raw UUIDs in title area, arbitrary progress %, duplicate approval UI |

**Data integrity:** The reference examples show illustrative task names and counts. In production use the authoritative SessionTaskStore / Task & Run DTOs; hide unknown counts; preserve pending/unknown-ACK and mock badges. On default V1 API, unavailable V2 capabilities must be disclosed, not shown as completed.

## 3. Color and materials — **APPROVED monochrome**

The Founder chose **A: black, white and gray minimalism**. Previous cream, blush and terracotta palettes are rejected. Reference values are targets, not a license to bypass native contrast or accessibility:

| Role | Light reference | Dark reference | Usage |
| --- | --- | --- | --- |
| Canvas | `#FAFAFA` | `#111111` | Neutral Chat background |
| Paper | `#FFFFFF` | `#202020` | Composer / result surfaces |
| Assistant bubble | `#F3F3F3` | `#292929` | Quiet message grouping |
| User bubble | `#E9E9E9` | `#383838` | Distinct, soft, highly readable |
| Hairline | `#E3E3E3` | `#414141` | Only where needed |
| Primary ink | `#171717` | `#F5F5F5` | Body text, icon identity |
| Secondary ink | adaptive semantic secondary | adaptive semantic secondary | Supporting metadata |
| Primary action | `#171717` | `#F5F5F5` | Send / selected CTA; foreground inverses |
| Status | native semantic warning/success/error | native semantic warning/success/error | **Do not** make failure/warnings gray-only |

Ember's flame is **monochrome black/white**, not orange. Brand recognition comes from silhouette, typography, rhythm, and behavior—not an accent color.

**Implementation constraints:** Introduce small adaptive semantic tokens in `EmberDesignTokens.swift`; avoid a global unreviewed restyle. Keep status meaning, contrast, UI test identifiers and environment/MOCK distinctions. Test Dark Mode + Increase Contrast. Other tabs can adopt the tokens in follow-up focused PRs.

## 4. Type, spacing, shapes

- Use native San Francisco/dynamic type, no bundled custom font. Display 30–36pt concept; screen titles ~28pt; body 15–17pt; captions 11–13pt, with Dynamic Type rather than fixed font sizes in implementation.
- 8pt spacing rhythm; horizontal page inset ~16–20pt; 44×44pt minimum actual touch targets; max readable message content ~680pt.
- Soft 16–20pt corners for conversation and Task/Result; Composer pill 26–28pt; subtle shadows *only* if they convey depth, not as decoration.
- Prefer content structure, breathing room and text quality over animated mascots, gradients or bright UI accents. No orange brand surfaces; semantic warnings may retain orange where needed.
- iOS deployment target is **17.0**. Keep the native `TabView` for Chat / Tasks as the V1 baseline. Newer iOS system affordances are progressive enhancements; don't require Liquid Glass or a custom Floating Tab Bar.

## 5. Chat first-run — concrete requirements

- Existing Apple Sign-in, environment/mode badges, Mock-only warnings and cloud availability remain authoritative. Do not show a fictitious welcome screen in a signed-out state.
- Hero text is welcoming, brief and capability-honest. Examples in the concept ("Turn notes into action items", "Help me plan my week", "Stay on top of follow-ups") must be selected/disabled from **actual supported capabilities**; do not imply that all three are always available.
- Tap a suggestion to **populate**, never automatically send, the Composer. Preserve attachment picker, stop/submit state machine, and focused keyboard behavior from #280.
- Keep the first-run headline out of active chat once messages exist; don't permanently reserve hero height.

## 6. Active conversation — concrete requirements

- Conversation bubbles are restrained and distinctly grouped. Preserve streaming, markdown readability, selection/copy, VoiceOver speaker labels and UX-02 smart scrolling.
- Show a tiny contextual status row only when confirmed by an actual event/reply state. Avoid fictional progress steps or fabricated completion.
- Reuse existing `TaskActivityCard` / `OutcomeCard` and existing navigation. The conceptual Chat work summary is consistent with draft PR #285 but must not show stale / endpoint-unavailable state as live data.
- An ongoing Task should not be displayed as completed simply because the Assistant produced a textual acknowledgement.
- Errors, Unknown ACK and Cancel remain visible, accessible and idempotent.

## 7. Tasks — concrete requirements

- Keep existing status groups and backend authority: `.needsIntervention`, `.inProgress`, `.completed`. They map to real `SessionTaskStatusGroup` semantics.
- Section hierarchy: user actions first, underway second, completed/results third. Leading icon color communicates state without relying on color alone.
- Summary should show a human-readable title and one useful status/detail line. Do not surface raw IDs or engineering-only diagnostics in the primary row.
- Completed cards lead to actual Task Detail outcomes/artifacts, not a fake output preview. Pending approvals use existing gated actions.

## 8. Merge / implementation order

1. **Monochrome direction accepted by Founder**; maintain this contract while implementing shared components.
2. **UX-04 PR 3**: Chat bubbles / hierarchy and empty first-run treatment; small, reversible UI changes with 320/375/393pt evidence.
3. **Unify Tasks and Result card materials** through shared adaptive tokens, avoiding a separate extensive redesign.
4. **Reconcile drafts #284 (Sidebar), #285 (Work Status)** against the chosen visual language before merging. Resolve shared-file conflicts rather than stacking them blindly.
5. **Keep #283 Custom Tab Bar experimental / not merged** unless a measured iOS-native limitation justifies it.
6. #281 is a separate High-risk budget/schema safety review, unaffected by these design decisions.

### Actual native acceptance gate (not yet run)

Local `xcodebuild` on the current Ember scheme. Capture **real Simulator** states at 320/375/393pt widths, Light/Dark, English/zh-Hans and large Dynamic Type; compare to the concept board. Check sign-in / V1 unavailable / V2 real / MOCK, keyboard + attachment menu, streaming + Stop, recovery + Unknown ACK, Task detail, and real result / file UI. Preserve VoiceOver / Reduce Motion. Never present the Chromium mockups as native screenshots.

## 9. Founder decisions — accepted 2026-11-23

- **Approved:** black/white/grayscale; no cream/terracotta as dominant brand colors.
- Use low-contrast soft two-sided conversation bubbles (but meaningful interactive cards remain distinct).
- Keep two **native** bottom tabs for now; separate the Sidebar as an optional directory.
- Place the Work Status strip only when real, actionable, known data justifies its vertical cost.

Implement UX-04 PR 3 using these approved color decisions. Independently verify all native behaviors before merging UI code; no requirement to repeat visual palette selection.
