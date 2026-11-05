# iOS L1 — Live Authentication Foundation

> **Status:** Implemented behind an isolated entry point. Live conversation is **not** enabled.
> **Owner:** iOS Lead
> **Repository:** `basicv8vc/Ember`
> **Frozen contract:** ADR-0004 + `docs/product/B1_PLATFORM_CONTRACT.md` §5, §10 (annex blob
> `2e06b47691b71b05e3903f0bd65d5b9f381776c0`). Where this note and the annex disagree, the annex wins.
> **Related:** Issue #115 (cloud runtime composition), Issue #116 (real HTTP + PostgreSQL E2E).
> This slice owns iOS authentication and the authenticated transport boundary only.

## 1. What this slice delivers

**Sign in with Apple → Ember session → Keychain → authenticated `GET /v1/me` → restore / refresh /
logout**, as reusable components rather than a one-off demo:

| File                                    | Responsibility                                                 |
| --------------------------------------- | -------------------------------------------------------------- |
| `Auth/AuthFailure.swift`                | Closed, payload-free error taxonomy + truthful `LogoutOutcome` |
| `Auth/AppleNonce.swift`                 | CSPRNG nonce, SHA-256 representation, bounded lifetime         |
| `Auth/AppleSignInAuthorizing.swift`     | Credential value, attempt ledger, credential validation        |
| `Auth/AppleSignInAuthorizer.swift`      | Native `ASAuthorizationController` adapter                     |
| `Auth/EmberSessionDTO.swift`            | Strict `Codable` DTOs for both frozen responses                |
| `Auth/EmberSessionAPI.swift`            | Typed client over the existing `EmberAPIClient`                |
| `Auth/KeychainSessionStore.swift`       | `SecItem` store + in-memory store                              |
| `Auth/AuthenticatedTransport.swift`     | Authenticated request boundary and idempotency rules           |
| `Auth/LiveAuthSessionCoordinator.swift` | Actor: sign-in, restore, single-flight refresh, logout         |
| `Auth/UI/LiveAuthEntryView.swift`       | Isolated native Sign in with Apple entry point                 |
| `Auth/UI/LiveAuthEntryModel.swift`      | Its state machine                                              |

**Not changed:** `AppCompositionRoot` still runs the Mock experience. `AuthSessionProvider` is
unchanged and the coordinator conforms to it. No Conversation request exists in this slice, and
`apps/api/**`, `packages/**` and migrations are untouched.

## 2. Apple identity flow

1. **Nonce per attempt.** `AppleNonceGenerator` draws 32 bytes from `SecRandomCopyBytes`
   (256 bits, matching the session-token entropy requirement in annex §5.1 I-5) and renders them as
   lower-case hex. No PRNG seeding, no reuse, no cached nonce.
2. **Hash to Apple, raw to Ember.** `request.nonce` receives the SHA-256 hex (CryptoKit); the raw
   value is sent to `POST /v1/auth/session`. Apple signs the hash; the server compares it.
3. **Attempt binding.** `AppleSignInAttemptLedger` allows one live attempt, refuses a second, and
   exposes the nonce's `issuedAt + lifetime` window. A completion is accepted only for the current
   attempt id and only inside that window; a stale or late callback is refused and its credential is
   discarded. A bounded timer tears down an attempt that outlives its nonce.
4. **Cancellation ≠ failure.** `ASAuthorizationError.canceled` (domain-checked, not a bare integer
   comparison) surfaces as `appleCancelled`; every other authorization error becomes
   `appleAuthorizationFailed`.
5. **Invalid assertion.** A missing, empty, whitespace-only or non-UTF-8 identity token is
   `appleCredentialInvalid` and never reaches the network.
6. **No client trust policy.** The JWT is never parsed. `credential.user` (the Apple subject) is never
   read into a stored value. Verification and provisioning belong to the server.
7. **No identity from email or display name.** `requestedScopes` is empty: the app does not request,
   receive or store either.

## 3. Session HTTP contract

| Operation | Route                      | Method | Success | Notes                                                                  |
| --------- | -------------------------- | ------ | ------- | ---------------------------------------------------------------------- |
| Create    | `/v1/auth/session`         | POST   | **201** | Body: `provider: "apple"`, `identity_token`, `nonce`                   |
| Refresh   | `/v1/auth/session/refresh` | POST   | **200** | Bearer only; **no body**, no assertion, no nonce                       |
| Logout    | `/v1/auth/session`         | DELETE | **204** | Bearer only; no body                                                   |
| Bootstrap | `/v1/me`                   | GET    | **200** | Server-authoritative consumer, Agent, Conversation, `transcript_epoch` |

Implementation rules:

- The success status is matched **exactly**. A 200 where 201 is specified is `unexpectedStatus(200)`:
  the contract changed and the client should say so rather than guess.
- Any other status maps into a closed set: 400 `invalidRequest`, 401 `unauthenticated`,
  404 `notFound`, 429 `rateLimited`, 5xx `serverUnavailable`, else `unexpectedStatus`.
- Bodies are decoded by strict DTOs that reject unknown keys. `tenant_id`, `principal_id` or
  `policy_version` appearing in a response is a decoding failure, not a field to ignore.
- `access_token` must match `ems_[A-Za-z0-9_-]+`; ids must be UUIDs; timestamps must be RFC 3339 with
  an offset.
- URLs are assembled from the injected origin plus **literal** route segments (session routes) or
  validated segments (transport). Server-returned strings never become a URL.
- The origin must be `https` with no credentials, query or fragment. There is no ATS exception and no
  TLS override anywhere in this slice.
- An HTTP failure is never converted into an authenticated state.

## 4. Keychain storage

- `kSecClassGenericPassword`, service `com.basicv8vc.ember.session`, account `ember.session.v1`,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `synchronizable = false`.
- One item holds the minimum needed to restore and expire: session id, consumer id, token, expiry,
  write time. No assertion, nonce, email, display name, tenant or principal is stored.
- `load()` distinguishes three outcomes: `nil` (no session → unauthenticated),
  `keychainUnavailable` (locked/unavailable → **not** a sign-out), `storedSessionCorrupt` (a record
  exists but cannot be decoded).
- `replace()` is a single `SecItemUpdate` when a record exists, falling back to `SecItemAdd`. The
  Keychain replaces the value in place, so a rotation never leaves the store empty.
- `delete()` is idempotent.
- **The store API is synchronous.** The Keychain is a local, fast, synchronous facility, and an `async`
  store would place a suspension point inside every credential commit — the exact window in which a
  logout, a new sign-in or a stale refresh could interleave with a write that had already been decided.
  Synchronous calls let the coordinator perform _validate generation → write → commit_ as one
  uninterrupted actor step.
- Tokens are never written to `UserDefaults`, files, the Info.plist, build settings, URLs or logs.
  `EmberAccessToken`, `AppleNonce`, `AppleSignInCredential` and `EmberSessionRecord` all redact
  `description`, `debugDescription` and `Mirror`.

## 5. Session coordinator

`LiveAuthSessionCoordinator` is an `actor` and also conforms to the existing `AuthSessionProvider`.

### Cold start

`restoreSession()` loads the record once (synchronously, so N concurrent callers cannot each install
the record and bump the generation twice), rotates it when it is expired or within `refreshLeeway`, then
calls `GET /v1/me` and returns the server's projection. No id is ever synthesised.

### Interleaving rules

Every `await` in the coordinator is a network call or a UI presentation — never credential storage.
Each await is followed by a re-validation before any mutation:

- `signInWithApple()` bumps `signInSequence` before presenting the sheet and re-checks it after the
  authorization and after the session exchange. A completion that lost the race throws `superseded` and
  mutates nothing, so a logout that lands mid-exchange cannot be undone by the login it raced.
- `settle()` re-checks `generation` after the rotation returns and before touching the store. A stale
  rotation writes nothing — in particular it does not delete the credential a newer sign-in just stored.
- Revocation is keyed to the token that actually failed (`revokeLocally(ifCurrent:)`). A delayed 401 for
  a token that has since been replaced is a no-op, so it cannot sign out the newer session; the same 401
  still revokes when the rejected token is current.

### Single-flight refresh

- One `RefreshOperation` per session generation. Concurrent callers join it.
- The network call lives in the operation's task; the Keychain write and the commit live in a single
  **settlement** task claimed by exactly one caller before any suspension. Every other caller awaits
  that same task's value, so a token is rotated once and written once.
- After a rotation the generation advances, so the old token can never start a second refresh.
- A settlement that is in flight when a logout or a newer sign-in lands fails its generation check and
  writes nothing at all, so it cannot overwrite or delete the credential that replaced it.

### Revocation (401)

Local state is dropped immediately and nothing retries: subsequent calls fail with `sessionMissing`
without touching the network. Reads recover from a 401 with **one** rotation and **one** replay; a
second 401 revokes. `GET /v1/me` follows the same one-rotation rule, then ends the session rather than
looping. Reuse of a rotated token is a server security event, so the client never deliberately
presents one twice.

### Transient failure

For a **read**, `offline`, `timedOut`, `transportFailure`, `serverUnavailable` and
`keychainUnavailable` never revoke. The stored record stays and `AuthSessionState.unavailable` is
reported when a credential exists but cannot be validated — never `unauthenticated`.

For a **rotation** the rule is narrower, because the request itself is a state change. Only a failure
that proves the server never rotated keeps the session; see §8c. A timeout, a dropped connection or a 5xx
during `POST /v1/auth/session/refresh` ends it, because the token may already be dead and replaying it
would be reuse.

### Logout

Order: clear local state and delete the stored credential synchronously → attempt `DELETE` exactly once
→ run registered cleanup hooks → report the truthful outcome. Local credential removal happens _before_
the network call, so from that instant no request can be authorized with the departing token, an
in-flight rotation fails its generation check, and a crash mid-logout leaves nothing behind. Outcomes are
`revokedRemotely` (204), `alreadyInvalidated` (401 / nothing stored), `remoteUnconfirmed(error)` and
`localCleanupFailed(error)`. `registerSignOutCleanup` is the narrow hook for the L4 outbox; no outbox is
implemented here.

## 6. Authenticated transport

`EmberAuthenticatedRequest` carries method, validated path segments, optional body and an
`EmberRequestIdempotency`:

- `.idempotentRead` — one replay after a 401 (with the rotated token) and one replay after a transient
  transport failure.
- `.nonIdempotent(clientSubmissionID:)` — never replayed. A 401 becomes
  `requestRejectedBeforeExecution`; an unknown transport outcome becomes
  `unknownWriteOutcome(clientSubmissionID:)`, so L2 can reconcile through
  `GET /v1/message-submissions/{id}` instead of a blind retry.

The existing Task API's legacy authentication is untouched.

## 7. UI boundary

`LiveAuthEntryView` wraps the native `ASAuthorizationAppleIDButton`, shows progress, cancellation and
error states, and says plainly that Live chat is not enabled. It is **not** referenced by
`AppCompositionRoot`; composition stays explicit, and nothing switches to Live because a token exists
or because the network is reachable.

## 8. Prerequisites for real Apple-account sign-in

These are deliberately **not** invented in this PR:

1. **Entitlement.** `com.apple.developer.applesignin` (array `["Default"]`) in an
   `EmberApp.entitlements` file, wired through `CODE_SIGN_ENTITLEMENTS`. It requires a real Apple
   Developer team; adding it with the current identifier-less configuration would break every
   unsigned/CI build, so it is left out and documented.
2. **Capability + provisioning.** The Sign in with Apple capability must be enabled on the App ID that
   matches `PRODUCT_BUNDLE_IDENTIFIER` (`com.basicv8vc.ember`) with a provisioning profile that
   includes it.
3. **Server `aud` alignment.** The API's Apple verifier must expect that same bundle id as `aud`.
   Changing the bundle id without updating the server rejects every assertion with 401.
4. **A real base URL.** `LiveEmberSessionAPI` refuses anything but `https`. Nothing in the app
   currently sets one; a Live composition must inject it explicitly.
5. **B1 auth runtime deployed.** Issues #115/#116 own the runtime and the real-database E2E. This slice
   is verified against deterministic `URLProtocol` fixtures, not a live server.

Until all five hold, real-account sign-in stays gated and the app stays Mock-only.

## 8a. Review follow-up (PR #119 round 1)

Three reported interleavings were all real, and all three shared one root cause: the credential store
was `async`, so `check state → write → commit` contained a suspension in the middle. The fix is
structural rather than three local patches:

| Reported risk                                                                              | Root cause                                                 | Fix                                                                                                           | Regression test                                                                                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Logout while the login's Keychain write was in flight could restore an authenticated state | `store.save` awaited between the last guard and the commit | Store is synchronous; after the exchange the guard, the write and the commit are one uninterrupted actor step | `testLogoutDuringSignInExchangeLeavesNoCredential`                                                               |
| An old refresh's cleanup could delete the newly signed-in session                          | Stale settlement unconditionally deleted the store         | Stale settlement writes nothing and deletes nothing                                                           | `testStaleRefreshDoesNotDeleteANewerSignInsCredential`                                                           |
| A delayed 401 could revoke an already-replaced session                                     | Revocation was unconditional                               | `revokeLocally(ifCurrent:)` only acts on the token that is still current                                      | `testDelayedUnauthorizedForAnOldTokenDoesNotRevokeANewSession`, `testUnauthorizedForTheCurrentTokenStillRevokes` |

Because the intra-store window no longer exists, the deterministic tests gate the suspension that
remains reachable — the network call — and assert the observable outcome (stored credential, in-memory
state, store write/delete counts) rather than an internal implementation detail.

## 8b. Review follow-up (PR #119 round 2) — a rotated token that could not be persisted

### The defect

`settle()` wrote the replacement and then adopted it unconditionally:

```swift
do { try store.replace(rotated) } catch { storageError = ... }
record = rotated          // adopted even when the write failed
```

The server has already invalidated the old token by that point. So a failed write produced the worst
possible pair: the **dead** token on disk, the **live** one only in memory. A force-quit, a jetsam kill
or a crash between them loses the live token and keeps the dead one. The next launch presents it, and
`reuse_detected` — the backend's theft signal — revokes every session for that consumer. One failed
Keychain write would sign the person out of every device they own.

### The rule that replaces it

**A credential that is not durable is not adopted.** A token the store does not hold cannot become the
session, because the session is defined by what survives a relaunch.

`settle()` therefore ends the session on a storage failure, in one uninterrupted actor step (no
suspension has occurred since the generation check):

1. **Arm the fence first.** A crash between here and the delete must not leave an unmarked stale
   credential.
2. **Drop local state.** No caller can obtain the replacement, so no request is ever sent with a
   credential this device cannot vouch for after a relaunch.
3. **Delete the stale item.** This is what makes the next launch clean rather than merely fenced; the
   fence is cleared only when the delete is confirmed.
4. **Hand the replacement back** with a single best-effort `DELETE /v1/auth/session`. Refusing to keep a
   credential is not a reason to leave the session alive where nobody can reach it. It is not retried:
   the outcome cannot change local state, and a loop here would be a request storm for a token no device
   holds.

### `SessionRecoveryFence`

Step 3 can fail for the same reason step's write did. The fence is the second line of defence, and it
must outlive the process, so it cannot live in the Keychain — the Keychain is the component that is
failing in exactly this scenario.

It is a single marker file (`Application Support/EmberAuth/rotation-in-flight`, payload `{"version":1}`).
It carries no token, session id, consumer id, assertion or nonce: it cannot be replayed, identifies
nobody, and says only "what is in the Keychain right now belongs to a session the server already rotated
away". The annex §5.1 I-8 prohibition is about the credential itself leaving the Keychain, and this does
not move it. Its durability requirements are in §8c.

A cold start that finds it armed destroys the stored item without ever loading it, then clears the
fence and reports a signed-out consumer. If the deletion fails, the thrown `keychainUnavailable` keeps
the state `unavailable` rather than claiming a sign-out the device cannot verify.

The same rule is applied wherever a known-dead credential cannot be removed: `logout()` arms the fence
when its delete fails, and `revokeLocally(ifCurrent:)` arms it when a 401-driven delete fails. A
successful `save`, `replace` or `delete` clears it, and a successful sign-in clears it unconditionally —
without that, a fence left over from an earlier failure would delete the next valid session.

### Tests

| Scenario                                                     | Test                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Rotation succeeds, write fails → no in-memory session        | `testRotationThatCannotBePersistedDoesNotAdoptTheNewToken`                |
| Write and delete both fail → fence armed, dead item retained | `testUnremovableStaleCredentialArmsTheFence`                              |
| **Rotation → write fails → force-quit → cold start**         | `testColdStartAfterAnUnpersistedRotationNeverPresentsTheRotatedAwayToken` |
| Fenced launch with a locked Keychain                         | `testAFencedColdStartWithALockedKeychainIsUnavailableRatherThanSignedOut` |
| Sign-in after a fenced recovery                              | `testSignInAfterAFencedRecoveryIsNotDeferredToTheFence`                   |
| Logout whose delete fails                                    | `testLogoutThatCannotRemoveTheItemFencesTheStore`                         |

The force-quit test does not mock the relaunch: it builds a **second coordinator** over the same store
and fence, so nothing that lived only in the first one's memory survives. It then asserts the dead token
was never sent — `refreshCallCount == 0`, `bootstrapCallCount == 0` — which is the property that
actually matters, rather than the shape of the state machine.

**These tests were verified against the defect.** Re-introducing the pre-fix `record = rotated` on the
failure path fails three of them (12 assertion failures across 271 tests); restoring the fix returns the
suite to green. The guard is therefore load-bearing, not decorative.

## 8c. Review follow-up (PR #119 round 3) — a rotation whose outcome is never heard

### The window

§8b covers "the server rotated and the write failed". This round closes the window in front of it: the
server may rotate and the **answer** may never arrive — a timeout, a dropped connection, a process kill
while the request is outstanding. The stored token is then dead on the server and unmarked on disk.

The fence could not help, because it was only armed after a rotation was known to have succeeded.

### Why there is no safe probe

I checked the backend before assuming anything: reuse detection is not confined to rotation. Both
`findActiveSession` (`b1-session-repository.ts:179`) and `rotateSession` revoke **every** active session
for the consumer when they see a digest whose `revocation_reason` is `rotated`. So presenting a
suspected token to `GET /v1/me` to see whether it still works is itself the attack the backend punishes.
There is no read-only way to ask. The only correct behaviour is to never present the token again.

### The rule

**The marker is durable before the request exists.** `performRefresh` arms the fence, and only then
creates the task that sends `POST /v1/auth/session/refresh`.

- If `arm()` throws, the rotation is **not attempted**. `AuthError.recoveryFenceUnavailable` is returned
  and the session is untouched. Sending a rotation that cannot be recorded would recreate the exact
  window.
- On a **persisted** rotation the marker is cleared (§8b's success path).
- On a failure that **proves** no rotation happened — `.offline`, `.invalidBaseURL`, `.invalidRequest`,
  `.unauthenticated`, `.rateLimited` — the marker is cleared and the session survives. This is
  `AuthError.credentialUnaffectedByRefresh`, and it is deliberately narrower than
  `preservesLocalSession`.
- On any other failure — timeout, connection lost, 5xx, malformed 2xx, unmodelled status — the outcome
  is unknown. The session ends, the stored credential is destroyed without being presented again, and
  `AuthError.rotationOutcomeUnknown` is returned. The cause is not forwarded: a caller told "your session
  was kept, try again when you are online" would be told a lie.

`.networkConnectionLost` moved out of the `.offline` bucket for this reason. It strikes mid-exchange and
says nothing about whether the server committed, so it must not be read as "the request never left".

### Durability

`FileSessionRecoveryFence` writes a one-line payload (`{"version":1}`) to
`Application Support/EmberAuth/rotation-in-flight`, then:

1. `fsync` the file,
2. `fsync` the containing directory, so the rename that published it is durable,
3. read the file back and compare.

Only then does `arm()` return. The write uses `.atomic`, so a crash never leaves a half-written marker
that reads as "not armed". The directory is excluded from backup, because a verdict about a session
should not travel to a device whose Keychain never carried that session.

This is why the marker is not a `UserDefaults` boolean: `set(_:forKey:)` returns before the preferences
daemon has necessarily reached the platter, which is not a claim that can be made about a crash. A file
with an `fsync` and a read-back is.

### The cost, stated plainly

A timeout or a 5xx during rotation now signs the person out instead of retrying. That is the deliberate
trade: the client cannot distinguish "the server declined" from "the server committed and then failed to
answer", and guessing wrong is the difference between one re-authentication and revoking every session
the consumer owns. Offline is still free, because the request provably never left the device.

### Tests

| Scenario                                                     | Test                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| The marker exists while the request is outstanding           | `testFenceIsArmedBeforeTheRefreshIsSent`                                 |
| **Process killed mid-request → cold start must not replay**  | `testProcessDeathDuringRefreshLeavesTheNextLaunchUnableToReplayTheToken` |
| Lost response (timeout) ends the session, no replay anywhere | `testLostRefreshResponseEndsTheSessionWithoutReplayingTheToken`          |
| Pre-send failure keeps the session and withdraws the marker  | `testPreSendFailureKeepsTheSessionAndClearsTheFence`                     |
| 5xx during rotation is an unknown outcome                    | `testServerErrorDuringRotationIsAnUnknownOutcome`                        |
| Marker cannot be persisted → no request is sent              | `testRotationIsRefusedWhenTheFenceCannotBePersisted`                     |
| Marker survives a fresh reader; carries no credential        | `SessionRecoveryFenceTests` (5 cases)                                    |

The process-death test does not mock the kill. It holds the refresh behind a gate that is never opened
— nothing ever resumes the first coordinator, exactly as a force-quit leaves it — then builds a **second
coordinator** over the same store and fence and asserts `refreshCallCount == 0`, `bootstrapCallCount ==
0`, `logoutCallCount == 0`.

**Verified against the defect.** Removing the pre-request `arm()` and restoring the pre-fix failure
handling fails five of these (19 assertion failures across 282 tests); restoring the fix returns the
suite to 282/282.

## 9. Verification

See the PR description for the exact run of the final HEAD. The recipe used on this host:

```bash
# Build (target-based: destination enumeration fails on this host)
xcodebuild -project Ember.xcodeproj -alltargets -configuration Debug \
  -sdk iphonesimulator26.2 -arch arm64 build \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  CONFIGURATION_BUILD_DIR=... \
  OTHER_SWIFT_FLAGS='$(inherited) -Xfrontend -disable-sandbox'

# Test (hand-generated .xctestrun; build-for-testing cannot resolve a destination here)
xcodebuild test-without-building -xctestrun <unit|ui>.xctestrun \
  -destination 'platform=iOS Simulator,id=<udid>' \
  -parallel-testing-enabled NO -resultBundlePath <run>.xcresult
```

Two host facts worth recording:

- `-Xfrontend -disable-sandbox` is required for SwiftUI's `#Preview` macro; without it
  `swift-plugin-server` fails with "produced malformed response".
- The build must be **ad-hoc signed**. With `CODE_SIGNING_ALLOWED=NO` the bundle has no
  application-identifier entitlement, every Keychain call returns `keychainUnavailable`, and the three
  real-Keychain tests silently become skips instead of verifying `SecItem`.
