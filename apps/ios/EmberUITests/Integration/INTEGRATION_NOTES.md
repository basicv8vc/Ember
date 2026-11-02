# M2 app integration

## Entry and navigation

On first launch, `AppCompositionRoot` presents `WelcomeOnboardingView`. Choosing **View the mock demo** records a local first-run flag and opens `TaskJourneyDemoContainer` with one in-memory task session. Later launches go directly to the Task Journey. The `--ember-show-onboarding` launch argument forces onboarding, while `--ember-start-task-flow` opens the Task Journey without changing the first-run flag.

The Task Journey keeps its `MOCK ONLY` disclosure visible in Compose, Inbox and Task Detail. Submitting creates only a local demonstration task. After a valid receipt and successful follow-up reads, the app shows the receipt acknowledgement and opens the Inbox. If a valid receipt is received but its task details cannot be loaded, Compose keeps the accepted receipt visible and does not invite a duplicate submission.

## Receipt and task-state behavior

- Only a receipt with a valid acceptance timestamp changes Compose to **Accepted**. A receipt confirms that the local demonstration received the submission; it does not mean the task is complete.
- A missing, malformed or otherwise uncertain acknowledgement remains **Not confirmed**. The submitted note and original idempotency key stay in memory, and retry uses that same submission. No success receipt is shown until a valid receipt is returned.
- Fixed task and result examples are independent of a newly submitted note. The completed example now says explicitly that its action checklist was prepared in advance and was not generated from the submitted note.
- No real cloud AI, production API, authentication, approval action, APNs, external write or credential path is configured.

## UI automation entry

`MockTaskJourneyLaunchUITests` covers the forced onboarding path, direct Task Journey entry and the English receipt-to-session-Inbox path. These tests are compiled by `build-for-testing`; this integration pass does not execute XCTest or launch a Simulator.

## Localization

Onboarding and the receipt acknowledgement provide English and Simplified Chinese copy. Compose, Inbox, Task Detail and the tab labels remain primarily Simplified Chinese; full app localization is outside this integration pass.

## Final validation boundary

The final PR description records the fetched main SHA, final PR head SHA, exact Xcode build commands, complete log paths, SDK/tool versions and GitHub CI run. The required `build` and `build-for-testing` commands are run against that committed head. XCTest and Simulator runtime UI testing are not run.

**Simulator Runtime UI Testing: UNVERIFIED — deferred to final merged-main M2 QA under CTO-approved Issue #54 exception.**
