# M2-C Task Flow preview

The App composition root now opens `TaskJourneyDemoContainer` after onboarding or through the `--ember-start-task-flow` launch argument. The container uses one in-memory session for Compose, Inbox and Task Detail and keeps a visible `MOCK ONLY` notice throughout the flow.

## Compose acknowledgement behavior

- A valid receipt moves the compose flow to **已接收**. A new receipt and a replayed receipt stay distinct, and neither means the task is complete.
- A lost or invalid receipt shows **尚未确认**, keeps the submitted note and idempotency key frozen in memory, and retries the same submission. Transport errors, timeouts, 5xx responses, and unclassified errors are treated as ambiguous.
- Only local preflight failures and explicit server rejections are definite failures. They keep the note editable; a retry allocates a fresh key, including after an idempotency conflict. User-facing errors use fixed copy and never include a repository error description or note text.
- A valid create receipt remains accepted if the follow-up task snapshot/event read fails; the flow stays on Compose when no Inbox record could be hydrated, so it does not invite a duplicate POST.

Open `TaskJourneyDemoContainer.swift` in Xcode and select either **Task Flow · Light** or **Task Flow · Dark · Large Text** in the preview canvas. The container uses the local mock repository and bundled scenarios; it has no production transport or account.

## Manual preview walkthrough

1. On **新任务**, leave the note blank and confirm submission is disabled. Fill the sample note and review the local-only and future-cloud-processing explanation.
2. Enable **演示回执丢失**, submit, and confirm the page says **尚未确认** while retaining the draft and retry intent. Retry without changing the input. The same idempotency key returns a replayed receipt; the UI confirms the earlier submission without marking the task complete.
3. Open **我的承诺**. The created task appears under **本机会话任务**. Fixed state examples appear in a separate **独立演示样例** section; the Inbox explains that tasks stay in this device's in-memory session and are not synced.
4. Open **处理中 · 演示** in **详情**. Disconnect and reconnect; verify the task stays running while only the local connection label changes. The timeline comes from a fixed example and has no timer-driven progress.
5. Open **完成与结果样例 · 演示**. Copy/share controls contain only the independent prepared sample. Open **完成但无结果 · 演示** and verify the empty-result message.
6. Open **取消状态 · 演示** and request cancellation. The example should show that completion won; it must not say cancelled. On a waiting or running example, cancellation remains pending until a terminal state exists.
7. Open **等待确认 · 演示**. The page explains that readable action details are unavailable and keeps **批准** disabled.
8. From the Inbox menu, show empty history, need-login, task-not-visible and offline states. These are local presentation scenarios and make no API calls. Background and reactivate the preview container to exercise scene-resume refresh for the selected local record.

## Integration status

- The Lead-owned app route and launch arguments are implemented in `AppCompositionRoot`.
- The completed example contains a fixed action checklist and explicitly says it was prepared separately, not generated from a newly submitted note.
- Broad Simulator UI automation for receipt replay, detail scenarios, disconnect/reconnect, cancellation, approval-disabled states and scene resume remains deferred to merged-main M2 QA.

## Current validation boundary

The required final-head `build` and `build-for-testing` commands compile the app and UI test targets. They do not execute XCTest or launch a Simulator. Visual screenshots, dynamic-type inspection and Simulator interaction remain **NOT RUN** in this pass and are deferred to final merged-main M2 QA under the CTO-approved Issue #54 exception.

Focused `EmberTests/TaskExperience/TaskComposeSubmissionModelTests.swift` covers accepted receipts, transport and 5xx failures after possible acceptance, malformed-receipt recovery, exact same-key replay, definite conflict recovery with a fresh key, duplicate-submit prevention, follow-up-read failure after receipt, and error-text redaction.
