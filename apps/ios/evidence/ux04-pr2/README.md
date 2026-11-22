# UX-04 PR 2 — Chat Composer Ergonomics & Send/Stop Evidence

Captured on the iOS 27.2 Simulator (`iPhone 18 Pro` runtime):
- `after-320-*.png` and `after-393-*.png` render `ConversationScreen` / `ConversationComposer` in `320×568pt` and `393×852pt` viewports.
- `after-keyboard-open*.png` capture the live `Ember` app during `ConversationComposerErgonomicsUITests` (`--ember-mock-chat-tasks`).

## Before vs. After Highlights

| State | Before Baseline | After (`UX-04 PR 2`) |
| --- | --- | --- |
| **Idle Composer (Active vs. Empty)** | [before-393-chat-task.png](../../../docs/design/assets/ux04/before-393-chat-task.png) (footnote shown on every turn) | `after-393-idle-active.png` (footnote hidden in active chat) · `after-393-idle-empty.png` (environment note shown when empty) |
| **Multiline Composer (1–6 lines)** | — | `after-393-multiline.png` |
| **Active Reply with Stop** | [before-393-streaming.png](../../../docs/design/assets/ux04/before-393-streaming.png) (Send disabled, no Composer Stop) | `after-393-generating-stop.png` (`stop.fill` inside Composer pill, `44×44pt` hit area) |
| **Generating + Nonempty Draft** | Send disabled, no Composer Stop | `after-393-generating-draft-stop.png` (Stop stays prioritized; draft preserved) |
| **Attachment Chips (`320pt` / `393pt`)** | `26×26pt` chip remove target | `after-320-attachment-chips.png` · `after-393-attachment-chips.png` (`44×44pt` remove target) |
| **Attachment Menu (`320pt` Light & Dark AX3)** | `min(316, max(264, w-28))` (`292pt` on `320pt`) | `after-320-attachment-menu.png` · `after-320-attachment-menu-dark-ax3.png` (`272pt` clamped, AX badge stacking) |
| **Keyboard-Open Layout** | — | `after-keyboard-open.png` · `after-keyboard-open-attachment-menu.png` |
