# Ember Design System (M2-A)

These SwiftUI views are presentation components. They do not call networking, persist task input, authenticate, approve work, or decide task state. Keep the app's persistent `MOCK ONLY` disclosure visible anywhere a mock task flow is shown.

## Public component API

```swift
@State private var draft = ""

PromiseComposerCard(text: $draft, isSubmitting: false) {
    // The caller may handle a local demo action. This card does not submit a task.
}

TaskStatusBadge(status: presentationState.taskStatus ?? .queued)
ActivityRow(event: taskEvent)
InlineNotice(title: "connection.offline_title", message: "connection.offline_message", tone: .warning)
MockOnlyBanner()
LoadingPlaceholder()
EmptyPlaceholder(title: "placeholder.no_result_title", message: "placeholder.no_result_message")
ErrorPlaceholder(message: "placeholder.offline_error", onRetry: retryRead)
```

`TaskStatusBadge` takes the frozen `TaskStatus`; `ActivityRow` takes a frozen `TaskEventDTO`. Their labels describe only those inputs. `PromiseComposerCard` binds the draft, owns its text-field focus, disables submit for whitespace-only input or while submitting, and calls the supplied closure only when enabled. A caller owns all command behavior and state.

## Onboarding

`WelcomeOnboardingView(onViewDemo:)` explains Promise → Progress → Outcome and requires the caller to provide the demo-navigation closure. It does not create an account or imply user consent. Its cloud-processing notice says the wording and retention/training/deletion terms are pending review, and that this mock view sends no text.

## Integration guide for C / iOS Lead

1. Add these files through the existing filesystem-synchronized `EmberApp` group; no project-file edit is needed.
2. Pass the existing `TaskPresentationState.taskStatus` into `TaskStatusBadge` and persisted `TaskEventDTO` values into `ActivityRow`. Keep connection health and command-in-flight state separate from server task status.
3. Bind a parent-owned draft to `PromiseComposerCard`. Provide the submit closure and submitting flag from an approved flow; the component has no repository dependency.
4. Use `InlineNotice` for recoverable local connection or command messages, and the placeholders for loading, empty, or error surfaces. Never add a percentage or synthetic activity event.
5. Keep `MockOnlyBanner` in all mock screens. Do not connect the mock action to real cloud APIs, production auth, approval, push, or credentials without the required owner review.

The current M1 root has no onboarding route. Integration belongs to the iOS Lead's app composition root after review; this branch deliberately leaves that root untouched.
