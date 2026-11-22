# UX-06 PR 2 — Proactive Schedules Existing-First Redesign Evidence

Captured on iOS 27.2 Simulator (`UX06-iPhone18Pro`, `3x` scale) using `ProactiveSchedulesSheetView` / `CreateScheduleSheet` with `ProactiveScheduleStore` backed by `InMemoryProactiveScheduleRepository` (`MOCK ONLY` disclosure banner visible):

| Screenshot | Viewport | What it shows |
| --- | --- | --- |
| `before-schedules-320.png` | `320×568pt` (`960×1704px`) | Before (`origin/main` `f4d8ad3`): inline create form fills the `320pt` viewport and hides all existing schedules |
| `before-schedules-393.png` | `393×852pt` (`1179×2556px`) | Before (`origin/main` `f4d8ad3`): inline create form pushes `Your Schedules` down the page |
| `after-schedules-320-existing-first.png` | `320×568pt` (`960×1704px`) | After (PR #277): `MOCK ONLY` banner + grouped `Active` schedule list immediately visible first at `320pt` with `+` create action |
| `after-schedules-393-existing-first.png` | `393×852pt` (`1179×2556px`) | After (PR #277): existing-first grouped sections (`Active`, `Paused`) with delivery cadence, latest run summary, and `Pause`/`Resume`/`Cancel`/`Open Chat` actions |
| `after-schedules-393-once-in-flight.png` | `393×852pt` (`1179×2556px`) | After (PR #277): `.once` schedule with running `latestRun` rendered as `Triggered · In progress`, `Running in Ember Cloud…`, and `Cancel` |
| `after-schedules-320-create-sheet.png` | `320×568pt` (`960×1704px`) | After (PR #277): dedicated `New Schedule` sheet at `320pt` with `>=44pt` quick-preset chips |
| `after-schedules-393-create-sheet.png` | `393×852pt` (`1179×2556px`) | After (PR #277): dedicated `New Schedule` sheet at `393pt` with `>=44pt` quick-preset chips (`In 1 min`, `In 15 min`, `In 1 hour`, `Tomorrow 9:00`) |
