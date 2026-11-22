# UX-05 — Task Detail Result-First Redesign & Collapsible Technical Details Evidence

Captured on **iOS 27.2 Simulator** (`UX05-BeforeAfter`, `iPhone 18 Pro` runtime, `3x` scale):
- **Before (`origin/main` @ `f4d8ad3`)**: Unmodified `main` baseline before UX-05.
- **After (`feat/ios-ux05-task-detail-result-first`)**: Merged with latest `main` (`f4d8ad3`) and localized VoiceOver strings (`en` / `zh-Hans`).

## Before / After Comparison

| State / Viewport | Before (`main` @ `f4d8ad3`) | After (UX-05) | What Changed |
| --- | --- | --- | --- |
| **Completed** (`402×874pt`, `iPhone 18 Pro`) | `before-completed.png` | `after-completed.png`, `after-completed-technical-details.png` | Result (`OutcomeCard`) and Files (`Output` badge + Preview/Export) move to the top; UUID, Attempts, Created, Model, and server truth note move into collapsed-by-default `Technical Details`. |
| **Running** (`402×874pt`, `iPhone 18 Pro`) | `before-running.png` | `after-running.png` | Real Execution Activity + latest sequence-ordered server event headline (`Latest update:`) appear first before `Cancel Task` and pending Outcome (no synthetic progress percentages). |
| **Waiting Approval** (`402×874pt`, `iPhone 18 Pro`) | `before-waiting-approval.png` | `after-waiting-approval.png` | Waiting-approval action notice with honest capability note + `Cancel Task` appear first before Execution Activity. |
| **Failed** (`402×874pt`, `iPhone 18 Pro`) | — | `after-failed.png` | Clear status & safe next-step guidance (`Latest error` + authoritative `TaskErrorCode` when present) appear before Execution Activity. |
| **320pt Small Screen — Completed** (`320×568pt`, `3x`) | `before-320-completed.png` | `after-320-completed.png` | Result & Files fit cleanly without horizontal clipping or metadata clutter above the fold at `320pt` width. |
| **320pt Small Screen — Running** (`320×568pt`, `3x`) | `before-320-running.png` | `after-320-running.png` | Compact summary header + real Execution Activity card fit cleanly at `320pt` width. |
| **320pt Small Screen — Waiting Approval** (`320×568pt`, `3x`) | `before-320-waiting-approval.png` | `after-320-waiting-approval.png` | User-action guidance + `Cancel Task` fit cleanly above Execution Activity at `320pt` width. |
