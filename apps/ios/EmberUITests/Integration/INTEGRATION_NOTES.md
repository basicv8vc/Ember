# M2 app integration

`AppCompositionRoot` now routes first launch through `WelcomeOnboardingView`. Tapping **View the mock demo** records only a local Boolean in `UserDefaults` and opens `TaskJourneyDemoContainer` with one in-memory `TaskJourneySession`. Subsequent launches go directly to the Task Journey unless onboarding is explicitly forced for review.

The container's existing Compose action uses B0 `FakeTaskRepository`. After the session receives and records a local receipt, the App-owned receipt sheet shows the task ID and says that the task is not complete and no note was uploaded or sent to an AI service. Continuing closes the sheet onto the container's Inbox tab. The fixture rows remain separately identified as independent examples; no fixture is presented as the task just submitted.

## Stable UI automation entry

- `--ember-show-onboarding` always opens onboarding, even when the first-run Boolean was already set. Tapping its demo button still advances into Task Journey.
- `--ember-start-task-flow` opens Task Journey directly, without changing the first-run Boolean.

`MockTaskJourneyLaunchUITests` demonstrates both launch paths and exercises English and Simplified Chinese onboarding. It also submits a local note, checks the receipt, and continues to the local-session Inbox.

## Localization status

Onboarding and the Agent A Design System have English and Simplified Chinese strings. The App-owned receipt acknowledgement selects English or Simplified Chinese from the system locale. Agent C's Compose, Inbox and Task Detail screens, tab labels, and fixture descriptions are still hard-coded primarily in Simplified Chinese; these are not fully localized and remain so in an English system locale. Accessibility and visual QA across both languages is still required on the shared main checkpoint.

## Mock boundaries and known gaps

- No production API, authentication, approval action, APNs, external write, or credential path is configured. Approval remains disabled by the existing feature view.
- Task status and fixture events are supplied by the Fake repository or independent bundled fixtures. The app adds no timer or synthetic progress.
- The completed fixture is explicitly labeled as fixture-only, but its content is a generic sample sentence rather than a readable action checklist. Issue #55 / the fixture owner must provide that outcome before checklist acceptance.
- The receipt sheet proves only that the local fake returned a receipt. It does not claim execution, completion, or a real notes-to-actions result.
- The Compose feature handles unknown receipt and retry; runtime handling and its visual presentation remain unverified here.

## Verification

Environment: macOS 26.5.1, Xcode 26.3 (17C529), installed iOS Simulator SDK 26.2.

- `xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` — PASS, exit 0 (`** BUILD SUCCEEDED **`).
- `xcodebuild -project apps/ios/Ember.xcodeproj -scheme Ember -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build-for-testing` — PASS, exit 0 (`** TEST BUILD SUCCEEDED **`); this compiled the UI test target and did not execute tests or launch a Simulator.
- The logs contain non-fatal local Xcode provisioning-profile and device build-number diagnostics. They did not prevent either build.
- UI test execution, Simulator interaction, screenshots, VoiceOver and visual QA remain **NOT RUN** for this integration branch, per the active Issue #54 single-owner main test window. The PR must stay Draft and must not merge until the current main checkpoint is complete and accepted.
