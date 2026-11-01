# M2-C Task Flow preview

This directory is reserved for Task Flow UI automation. The feature is currently exposed as the self-contained `TaskJourneyDemoContainer` SwiftUI preview because the App composition root is Lead-owned and this task does not modify it. The running app therefore does not launch this flow yet.

## Compose acknowledgement behavior

- A valid receipt moves the compose flow to **已接收**. A new 202-style receipt and a 200-style replay stay distinct, and neither means the task is complete.
- A lost or invalid receipt shows **尚未确认**, keeps the submitted note and idempotency key frozen in memory, and offers an exact same-key retry. Transport errors, timeouts, 5xx responses, and unclassified errors are treated as ambiguous.
- Only local preflight failures and explicit server rejections are definite failures. They keep the note editable; a retry allocates a fresh key, including after an idempotency conflict. User-facing errors use fixed copy and never include a repository error description or note text.
- A valid create receipt remains accepted if the follow-up task snapshot/event read fails; the flow stays on Compose when no Inbox record could be hydrated, so it does not invite a duplicate POST.

Open `TaskJourneyDemoContainer.swift` in Xcode and select either **Task Flow · Light** or **Task Flow · Dark · Large Text** in the preview canvas. The container injects the local mock repository and the bundled `MockScenarioProvider`; it has no production transport or account.

## Manual preview walkthrough

1. On **新任务**, leave the note blank and confirm submission is disabled. Fill the sample note and review the local-only and future-cloud-processing explanation.
2. Enable **演示回执丢失**, submit, and confirm the page says **尚未确认** while retaining the draft and its retry intent. Retry without changing the input. The same idempotency key returns a replayed receipt; the UI labels the result as a local mock 200 replay, not completion.
3. Open **我的承诺**. The created task appears under **本机会话任务**. Fixed state records appear in a separate **独立状态 fixture** section; the Inbox explicitly says it is neither full cloud history nor cross-device sync.
4. Open **处理中 fixture** in **详情**. Disconnect and reconnect; verify the task stays running while only the local connection label changes. The timeline comes from the fixture and has no timer-driven progress.
5. Open **完成与样例成果 fixture**. Copy/share controls contain only the `MockScenarioProvider` outcome fixture. Open **完成但无成果 fixture** and verify the empty-result message.
6. Open **取消竞态 fixture** and request cancellation. The fixture snapshot/event should show completion won; it must not say cancelled. On a queued/running fixture, cancellation remains pending until a terminal snapshot exists.
7. Open **审批不可用 fixture**. The page explains that the digest lacks readable action details and keeps **批准** disabled.
8. From the Inbox menu, show empty history, 401, 404, and offline states. These are local presentation scenarios and make no API calls. Background and reactivate the preview container to exercise scene-resume refresh for the selected local record.

## Integration request for iOS Lead

- Add a Lead-owned preview/demo route or test launch argument that presents `TaskJourneyDemoContainer` without changing this feature's repository contract.
- Once that route exists, add `EmberUITests/TaskFlow` UI automation for receipt replay, fixture detail, disconnect/reconnect, cancellation race, missing outcome, approval-disabled, 401/404, and scene resume.
- The current `completed.json` text is a generic fixture sentence, not a structured action list. A readable checklist must be authored by the owner of `Networking/Fixtures` and remain explicitly fixture-only before this preview can demonstrate the product-shaped outcome.

## Current validation boundary

The view and its light/dark/large-text previews compile in the shared `Ember` scheme. Visual screenshots, dynamic-type inspection, and UI automation of this container require the Lead-owned route above; until then, record them as **NOT RUN**. The existing `LaunchSmokeUITests` only covers the current Foundation launch screen.

Focused `EmberTests/TaskExperience/TaskComposeSubmissionModelTests.swift` covers accepted receipts, transport and 5xx failures after possible acceptance, malformed-receipt recovery, exact same-key replay, definite conflict recovery with a fresh key, duplicate-submit prevention, follow-up-read failure after receipt, and error-text redaction.
