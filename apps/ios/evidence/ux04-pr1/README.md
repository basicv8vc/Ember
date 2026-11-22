# UX-04 PR 1 — Unified Header & Environment-Aware Empty State Evidence

Captured on iOS 27.2 Simulator (`iPhone 18 Pro` runtime, `3x` scale) using `LiveConversationHost` + `ConversationScreen` + `LiveConversationHostModel` backed by `StubURLProtocol` responses:

| Screenshot | Viewport / Appearance | What it shows |
| --- | --- | --- |
| `pr1-320-v2-empty.png` | `320×568pt` · Light | Single-row unified header (`Ember` + `V2 STAGING` + `⋯`), confirmed V2 capabilities (`/v2/memories` & `/v2/schedules` 200), 3 V2 starter prompt cards |
| `pr1-375-v2-empty.png` | `375×667pt` · Light | Unified header and V2 empty state at `375pt` |
| `pr1-393-v2-empty.png` | `393×852pt` · Light | Unified header and V2 empty state at `393pt` |
| `pr1-393-v1-empty.png` | `393×852pt` · Light | `LIVE CLOUD` pill + V1-honest prompts (`Organize notes`, `Plan your priorities`, `Analyze a file or draft`) + explicit unavailable-capability notice when `/v2/memories` and `/v2/schedules` return `404` |
| `pr1-320-v1-dark-a11y.png` | `320×568pt` · Dark · `Accessibility Large` | Responsive `ViewThatFits` / AX wrapped header placing `LIVE CLOUD` cleanly under title while keeping `⋯` at `44×44pt`, plus wrapped V1 empty state |
| `pr1-393-mock-chat.png` | `393×852pt` · Light | Compact high-contrast `MOCK ONLY` pill permanently visible in unified Chat header alongside `⋯` menu |
