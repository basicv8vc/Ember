# iOS L2 — Live Conversation Integration

Status: Draft PR #121. Base: `main@c6c9c3d`. Owner: iOS Lead.

This is a B1-only cloud conversation path. It does not authorize live model inference, change ADR-0004, or modify the server.

The default App Root stays Mock. Live Alpha launch requires both `--ember-live-cloud` and an HTTPS `EMBER_CLOUD_BASE_URL`; invalid configuration fails closed rather than falling back to Mock.

## Data flow

- L1 Apple sign-in and Keychain authentication provide a server-scoped Bearer token.
- `GET /v1/me` provides the authoritative default Agent, Conversation and transcript epoch.
- A fresh UUIDv4 `client_submission_id`, its exact text and the current epoch are persisted to a protected Application Support journal **before** the first POST.
- `POST /v1/conversations/{id}/messages` is accepted only after verifying the server receipt matches the intent, consumer-scoped Conversation, text, ID and epoch.
- A lost acknowledgement stays unresolved. On relaunch, bootstrap the latest epoch, then `GET /v1/message-submissions/{id}`. Only a confirmed 404 allows a POST with the **same** immutable id/body/epoch.
- A definitive HTTP 409 transitions the original submission atomically from the pending outbox to a durable rejected draft. App relaunch neither looks up nor replays that terminal ID, even if the receipt endpoint would answer 404. A new UUID is minted only when the user explicitly sends another message. Reconciled receipts and server-issued IDs remain authoritative.
- Paginated history uses `after` and `limit` from the frozen B1 schema; no locally generated message ID or sequence is displayed as canonical.
- `GET /v1/conversations/{id}/turns/{id}` is limited to one poll per Conversation per second. Cancellation uses the frozen POST cancel route. The active Turn ID is saved across relaunch.
- A response with `simulated: true` visibly carries the `[SIMULATED]` label. No local Mock responder is reachable from Live composition.
- L1 logout invokes a narrow Journal cleanup hook to prevent previously unsent text from crossing sessions. That hook is passed to `LiveAuthSessionCoordinator.Dependencies.signOutCleanupHooks` **at construction**, so it exists before any logout can run; `registerSignOutCleanup` is only used afterwards for process-local caches, which are rebuilt by `bootstrap()`.

## Security and scope

The journal stores private pending message text in an app-local protected file, excluded from backup. Tokens, Apple assertions, nonces and authorization headers are never put in it. No client-supplied tenant/principal/policy identity is sent. The pending send is isolated by the authenticated, server-issued consumer ID.

This branch deliberately leaves existing Mock UI, frozen backend contracts, cloud runtime and model providers unchanged.

## Validation boundaries

GitHub Actions `iOS L2 Validation` on `5c6e517` is green: strict-concurrency `build-for-testing`, signed Simulator
**Unit Tests** and **UI Tests**, and the UI screenshot `.xcresult` artifact. It does **not** certify a real Mac run,
a real Cloud origin, or a physical device.

### Local Mac QA (2026-11-06, `5c6e517` + this commit)

Run on Xcode 26.3 (17C529) / iOS 26.2 Simulator (build `23C52`), dedicated simulator `Ember-L2-Final-QA`,
ad-hoc (`CODE_SIGN_IDENTITY=-`) signed so the Keychain tests are live:

| Gate                     | Command shape                                            | Result                                |
| ------------------------ | -------------------------------------------------------- | ------------------------------------- |
| Strict concurrency build | `build-for-testing`, `SWIFT_STRICT_CONCURRENCY=complete` | passed                                |
| Unit tests               | `-only-testing:EmberTests`, signed                       | **304 executed, 0 failed, 0 skipped** |
| UI tests                 | `-only-testing:EmberUITests`, signed                     | **10 executed, 0 failed, 0 skipped**  |

`OTHER_SWIFT_FLAGS="-Xfrontend -disable-sandbox"` is required locally: without it the Swift macro plugin server
cannot expand `@Observable` and the build dies with `produced malformed response`.

The host Simulator runtime had to be re-matched before any destination resolved: the installed iOS 26.2 runtime is
build `23C52` while the SDK expects `23C57`, so `xcodebuild` reported "iOS 26.2 is not installed" and enumerated
zero simulator destinations for **every** project on the machine. `xcrun simctl runtime match set iphoneos26.2 23C52`
fixed it. This is a host-environment repair, not a repository change; reverse it with
`xcrun simctl runtime match set iphoneos26.2 --clear` once a matching runtime is installed.

### What a simulator cannot prove

Live chat states — sending, waiting for a Turn, failure, cancellation, and a real `simulated: true` reply — need an
authenticated session. Sign in with Apple needs the `com.apple.developer.applesignin` entitlement and a development
team, and **neither is configured in `Ember.xcodeproj`**; the verified screens therefore stop at the Live entry and
configuration-failure screens. Do not read the UI screenshot as staging chat evidence.

For iPhone staging E2E, CTO must provide a deployed HTTPS origin, configured Apple Sign in
entitlement/provisioning, valid session verification, the approved Fake Responder, and reachable B1 routes. The Apple
account must be real, and `simulated: true` must stay visible.
