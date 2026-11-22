# UX-06 PR 1 — Personal Memory Content-First Redesign Evidence

Captured on iOS 27.2 Simulator (`UX06-iPhone18Pro`, `3x` scale) using `PersonalMemorySheetView` / `MemoryEditorSheet` with `PersonalMemoryStore` backed by `InMemoryPersonalMemoryRepository` (`MOCK ONLY` disclosure banner visible):

| Screenshot | Viewport | What it shows |
| --- | --- | --- |
| `before-memory-320.png` | `320×568pt` (`960×1704px`) | Before (`origin/main` `f4d8ad3`): fixed inline composer pushes saved memories off the initial viewport |
| `before-memory-393.png` | `393×852pt` (`1179×2556px`) | Before (`origin/main` `f4d8ad3`): inline composer above saved list and raw keys (`location.city`, `response.style`) exposed on rows |
| `after-memory-320-saved-first.png` | `320×568pt` (`960×1704px`) | After (PR #276): `MOCK ONLY` banner + Saved Memory list immediately visible first at `320pt` with `+` add button in navigation bar |
| `after-memory-393-saved-first.png` | `393×852pt` (`1179×2556px`) | After (PR #276): content-first list with clean source + timestamp metadata and raw keys hidden |
| `after-memory-320-add-sheet.png` | `320×568pt` (`960×1704px`) | After (PR #276): dedicated `Add Memory` modal composer sheet at `320pt` |
| `after-memory-393-add-sheet.png` | `393×852pt` (`1179×2556px`) | After (PR #276): dedicated `Add Memory` modal composer sheet at `393pt` |
