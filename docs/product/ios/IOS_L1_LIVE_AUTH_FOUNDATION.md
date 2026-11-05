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

| File | Responsibility |
| ---- | -------------- |
| `Auth/AuthFailure.swift` | Closed, payload-free error taxonomy + truthful `LogoutOutcome` |
| `Auth/AppleNonce.swift` | CSPRNG nonce, SHA-256 representation, bounded lifetime |
| `Auth/AppleSignInAuthorizing.swift` | Credential value, attempt ledger, credential validation |
| `Auth/AppleSignInAuthorizer.swift` | Native `ASAuthorizationController` adapter |
| `Auth/EmberSessionDTO.swift` | Strict `Codable` DTOs for both frozen responses |
| `Auth/EmberSessionAPI.swift` | Typed client over the existing `EmberAPIClient` |
| `Auth/KeychainSessionStore.swift` | `SecItem` store + in-memory store |
| `Auth/AuthenticatedTransport.swift` | Authenticated request boundary and idempotency rules |
| `Auth/LiveAuthSessionCoordinator.swift` | Actor: sign-in, restore, single-flight refresh, logout |
| `Auth/UI/LiveAuthEntryView.swift` | Isolated native Sign in with Apple entry point |
| `Auth/UI/LiveAuthEntryModel.swift` | Its state machine |

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

| Operation | Route | Method | Success | Notes |
| --------- | ----- | ------ | ------- | ----- |
| Create | `/v1/auth/session` | POST | **201** | Body: `provider: "apple"`, `identity_token`, `nonce` |
| Refresh | `/v1/auth/session/refresh` | POST | **200** | Bearer only; **no body**, no assertion, no nonce |
| Logout | `/v1/auth/session` | DELETE | **204** | Bearer only; no body |
| Bootstrap | `/v1/me` | GET | **200** | Server-authoritative consumer, Agent, Conversation, `transcript_epoch` |

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
- Tokens are never written to `UserDefaults`, files, the Info.plist, build settings, URLs or logs.
  `EmberAccessToken`, `AppleNonce`, `AppleSignInCredential` and `EmberSessionRecord` all redact
  `description`, `debugDescription` and `Mirror`.

## 5. Session coordinator

`LiveAuthSessionCoordinator` is an `actor` and also conforms to the existing `AuthSessionProvider`.

### Cold start

`restoreSession()` loads the record once (a shared task, so N concurrent callers cause one Keychain
read and one generation bump), rotates it when it is expired or within `refreshLeeway`, then calls
`GET /v1/me` and returns the server's projection. No id is ever synthesised.

### Single-flight refresh

- One `RefreshOperation` per session generation. Concurrent callers join it.
- The network call lives in the operation's task; the Keychain write and the commit live in a single
  **settlement** task claimed by exactly one caller before any suspension. Every other caller awaits
  that same task's value, so a token is rotated once and written once.
- After a rotation the generation advances, so the old token can never start a second refresh.
- A settlement that is still in flight when a logout lands re-checks the generation **after** the
  store write and undoes it, so a signed-out device cannot keep a live rotated credential.

### Revocation (401)

Local state is dropped immediately and nothing retries: subsequent calls fail with `sessionMissing`
without touching the network. Reads recover from a 401 with **one** rotation and **one** replay; a
second 401 revokes. `GET /v1/me` follows the same one-rotation rule, then ends the session rather than
looping. Reuse of a rotated token is a server security event, so the client never deliberately
presents one twice.

### Transient failure

`offline`, `timedOut`, `transportFailure`, `serverUnavailable` and `keychainUnavailable` never revoke.
The stored record stays and `AuthSessionState.unavailable` is reported when a credential exists but
cannot be validated — never `unauthenticated`.

### Logout

Order: invalidate local authorization state → attempt `DELETE` exactly once → delete local credentials
→ run registered cleanup hooks → report the truthful outcome. Outcomes are `revokedRemotely` (204),
`alreadyInvalidated` (401 / nothing stored), `remoteUnconfirmed(error)` and `localCleanupFailed(error)`.
`registerSignOutCleanup` is the narrow hook for the L4 outbox; no outbox is implemented here.

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
