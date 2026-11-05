import Foundation
import XCTest
@testable import Ember

/// Behaviour of the session coordinator: sign-in, cold start, single-flight rotation, revocation,
/// transient failure, logout and the authenticated transport boundary.
///
/// Every test is deterministic. No wall clock, no network and no Apple account is involved: the clock
/// is fixed, the API is scripted, and the Keychain is in memory.
@MainActor
final class LiveAuthSessionCoordinatorTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []

    private let host = "live-auth.l1.invalid"

    /// `async` so the override runs on the class's main-actor isolation; the synchronous form is
    /// `nonisolated` in XCTest and cannot touch the actor-isolated fixtures.
    override func tearDown() async throws {
        sessions.forEach { $0.invalidateAndCancel() }
        sessions.removeAll()
        registrations.forEach { $0.remove() }
        registrations.removeAll()
        try await super.tearDown()
    }

    // MARK: - Sign in

    func testSignInStoresExactlyOneSession() async throws {
        let built = try makeCoordinator()

        let record = try await built.coordinator.signInWithApple()

        XCTAssertEqual(built.api.createSessionCallCount, 1)
        XCTAssertEqual(record.accessToken, AuthFixture.token("alpha"))
        XCTAssertEqual(record.sessionID, AuthFixture.sessionID)
        XCTAssertEqual(record.consumerID, AuthFixture.consumerID)

        let stored = built.store.currentRecord()
        XCTAssertEqual(stored, record)

        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
    }

    func testSignInSendsTheRawNonceAndTheAppleIdentityToken() async throws {
        let built = try makeCoordinator()

        _ = try await built.coordinator.signInWithApple()

        // The raw nonce, never the hash: Apple received the hash, the backend must receive the raw
        // value for its own hash comparison.
        XCTAssertEqual(built.api.lastCreateSessionNonce, "synthetic-raw-nonce")
        XCTAssertEqual(built.api.lastCreateSessionIdentityToken, "synthetic.apple.jwt")
    }

    func testCancelledAppleSignInStoresNothing() async throws {
        let built = try makeCoordinator(
            apple: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            storedRecord: AuthFixture.record()
        )

        do {
            _ = try await built.coordinator.signInWithApple()
            XCTFail("expected cancellation")
        } catch let error as AuthError {
            XCTAssertEqual(error, .appleCancelled)
        }

        XCTAssertEqual(built.api.createSessionCallCount, 0)
        let stored = built.store.currentRecord()
        // The pre-existing session is untouched: a cancel is not a sign-out.
        XCTAssertEqual(stored, AuthFixture.record())
    }

    func testInvalidAppleAssertionProducesNoAuthenticatedState() async throws {
        let built = try makeCoordinator(configure: { api in
            api.setCreateSessionResult(.failure(.unauthenticated))
        })

        do {
            _ = try await built.coordinator.signInWithApple()
            XCTFail("expected rejection")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        let stored = built.store.currentRecord()
        XCTAssertNil(stored)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    func testSignInFailsHonestlyWhenTheKeychainCannotStore() async throws {
        let built = try makeCoordinator()
        built.store.setUnavailable(true)

        do {
            _ = try await built.coordinator.signInWithApple()
            XCTFail("expected a storage failure")
        } catch let error as AuthError {
            XCTAssertEqual(error, .keychainUnavailable)
        }

        // A locked Keychain cannot prove the absence of a credential, so the honest state is
        // unavailable — never "signed out" and never "authenticated".
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unavailable)
        // A session that cannot be persisted is revoked rather than left dangling on the server.
        XCTAssertEqual(built.api.logoutCallCount, 1)
    }

    // MARK: - Cold start

    func testColdStartRestoresSessionAndBootstrapsMe() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())

        let profile = try await built.coordinator.restoreSession()

        XCTAssertEqual(built.api.bootstrapCallCount, 1)
        XCTAssertEqual(built.api.refreshCallCount, 0)
        XCTAssertEqual(profile.agent.displayName, "Ember")
        XCTAssertEqual(profile.conversation.conversationID, AuthFixture.conversationID)
        XCTAssertEqual(profile.conversation.transcriptEpoch, 0)
    }

    func testColdStartWithExpiredRecordRotatesOnceThenBootstraps() async throws {
        let built = try makeCoordinator(
            storedRecord: AuthFixture.record(tokenSuffix: "expired", expiresIn: -10)
        )

        _ = try await built.coordinator.restoreSession()

        XCTAssertEqual(built.api.refreshCallCount, 1)
        XCTAssertEqual(built.api.bootstrapCallCount, 1)
        let stored = built.store.currentRecord()
        XCTAssertEqual(stored?.accessToken, AuthFixture.token("rotated"))
    }

    func testOfflineBootstrapKeepsTheStoredSessionAndIsRecoverable() async throws {
        let built = try makeCoordinator(
            storedRecord: AuthFixture.record(),
            configure: { api in api.setBootstrapResults([.failure(.offline)]) }
        )

        do {
            _ = try await built.coordinator.restoreSession()
            XCTFail("expected offline")
        } catch let error as AuthError {
            XCTAssertEqual(error, .offline)
        }

        // The credential is untouched: offline is not a sign-out.
        let stored = built.store.currentRecord()
        XCTAssertEqual(stored, AuthFixture.record())
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
    }

    func testMissingSessionNeverFabricatesAuthentication() async throws {
        let built = try makeCoordinator()

        do {
            _ = try await built.coordinator.restoreSession()
            XCTFail("expected a missing session")
        } catch let error as AuthError {
            XCTAssertEqual(error, .sessionMissing)
        }

        XCTAssertEqual(built.api.bootstrapCallCount, 0)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    func testLockedKeychainIsUnavailableRatherThanSignedOut() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        built.store.setUnavailable(true)

        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unavailable)

        // The device is unlocked later in the same launch; the session becomes visible again.
        built.store.setUnavailable(false)
        let recovered = await built.coordinator.currentSession()
        XCTAssertEqual(recovered, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
    }

    // MARK: - Single-flight rotation

    func testConcurrentRefreshesRotateTheTokenExactlyOnce() async throws {
        let gate = AsyncGate()
        let started = expectation(description: "refresh started")
        // A second rotation would be a defect; the explicit call-count assertion below reports it
        // more clearly than an over-fulfilled expectation.
        started.assertForOverFulfill = false
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { started.fulfill() }
            api.setRefreshResults([
                .success(AuthFixture.sessionResponse(tokenSuffix: "rotated1")),
                .success(AuthFixture.sessionResponse(tokenSuffix: "rotated2")),
            ])
        }

        let callers = 6
        let tasks = (0..<callers).map { _ in
            Task { try await built.coordinator.refreshSessionIfNeeded() }
        }

        await fulfillment(of: [started], timeout: 5)
        // Let every caller reach the coordinator's suspension point before the gate opens.
        for _ in 0..<50 { await Task.yield() }
        await gate.open()

        var tokens: [EmberAccessToken] = []
        for task in tasks {
            tokens.append(try await task.value.accessToken)
        }

        // One network rotation, one shared answer, no second token.
        XCTAssertEqual(built.api.refreshCallCount, 1)
        XCTAssertEqual(Set(tokens.map(\.rawValue)), ["ems_rotated1"])
        let stored = built.store.currentRecord()
        XCTAssertEqual(stored?.accessToken, AuthFixture.token("rotated1"))
    }

    func testSerialRefreshesAfterRotationDoNotRotateAgainWhileValid() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10))

        _ = try await built.coordinator.refreshSessionIfNeeded()
        XCTAssertEqual(built.api.refreshCallCount, 1)

        // The rotated token expires in an hour, so the second call is satisfied locally.
        _ = try await built.coordinator.refreshSessionIfNeeded()
        XCTAssertEqual(built.api.refreshCallCount, 1)
    }

    // MARK: - Revocation

    func testRotatedToken401RevokesWithoutRequestStorm() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshResults([.failure(.unauthenticated)])
        }

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected revocation")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        XCTAssertEqual(built.api.refreshCallCount, 1)
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)

        // Every later attempt fails locally: a revoked session must not generate more traffic.
        for _ in 0..<5 {
            do {
                _ = try await built.coordinator.refreshSessionIfNeeded()
                XCTFail("expected no session")
            } catch let error as AuthError {
                XCTAssertEqual(error, .sessionMissing)
            }
        }
        XCTAssertEqual(built.api.refreshCallCount, 1)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    func testSecondBootstrap401EndsTheSessionInsteadOfLooping() async throws {
        let built = try makeCoordinator(
            storedRecord: AuthFixture.record(),
            configure: { api in
                api.setBootstrapResults([.failure(.unauthenticated), .failure(.unauthenticated)])
            }
        )

        do {
            _ = try await built.coordinator.restoreSession()
            XCTFail("expected revocation")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        // Exactly one rotation and two reads: the bounded recovery, not an unbounded loop.
        XCTAssertEqual(built.api.refreshCallCount, 1)
        XCTAssertEqual(built.api.bootstrapCallCount, 2)
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)
    }

    // MARK: - Logout

    func testLogoutClearsLocalCredentialsAndReportsRemoteRevocation() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())

        let outcome = await built.coordinator.logout()

        XCTAssertEqual(outcome, .revokedRemotely)
        XCTAssertEqual(built.api.logoutCallCount, 1)
        XCTAssertEqual(built.api.lastLogoutToken, AuthFixture.token())
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    func testLogoutSurvivesNetworkFailureAndSaysSo() async throws {
        let built = try makeCoordinator(
            storedRecord: AuthFixture.record(),
            configure: { api in api.setLogoutResult(.failure(.offline)) }
        )

        let outcome = await built.coordinator.logout()

        XCTAssertEqual(outcome, .remoteUnconfirmed(.offline))
        XCTAssertFalse(outcome.isFullySignedOut)
        // Local credentials are gone regardless: the device is signed out even if the server
        // could not be told.
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)

        // No automatic retry of logout.
        XCTAssertEqual(built.api.logoutCallCount, 1)
    }

    func testLogoutOfAnAlreadyInvalidTokenIsReportedAsSuch() async throws {
        let built = try makeCoordinator(
            storedRecord: AuthFixture.record(),
            configure: { api in api.setLogoutResult(.failure(.unauthenticated)) }
        )

        let outcome = await built.coordinator.logout()

        // The token no longer authenticates anything, which is what logout wanted.
        XCTAssertEqual(outcome, .alreadyInvalidated)
        XCTAssertTrue(outcome.isFullySignedOut)
    }

    func testLogoutWithNoStoredSessionIsIdempotent() async throws {
        let built = try makeCoordinator()

        let outcome = await built.coordinator.logout()

        XCTAssertEqual(outcome, .alreadyInvalidated)
        XCTAssertEqual(built.api.logoutCallCount, 0)
    }

    func testLogoutReportsAFailureToRemoveLocalCredentials() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        built.store.setDeleteFailure(.keychainUnavailable)

        let outcome = await built.coordinator.logout()

        XCTAssertEqual(outcome, .localCleanupFailed(.keychainUnavailable))
        XCTAssertFalse(outcome.isFullySignedOut)
    }

    func testLogoutRunsCleanupOnlyAfterCredentialsAreGone() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let observedCredentialAtCleanup = Counter()
        let store = built.store

        await built.coordinator.registerSignOutCleanup {
            if store.currentRecord() == nil {
                observedCredentialAtCleanup.increment()
            }
        }

        _ = await built.coordinator.logout()

        XCTAssertEqual(observedCredentialAtCleanup.value, 1)
    }

    // MARK: - Stale completions

    func testASupersededSignInCannotOverwriteANewerSession() async throws {
        let apple = FakeAppleSignInAuthorizer(behavior: .suspended)
        let sheetIsUp = expectation(description: "first authorization started")
        apple.onAuthorizeStarted = { sheetIsUp.fulfill() }

        let built = try makeCoordinator(
            apple: apple,
            configure: { api in
                api.setCreateSessionResult(.success(AuthFixture.sessionResponse(tokenSuffix: "first")))
            }
        )

        let stale = Task { try await built.coordinator.signInWithApple() }
        await fulfillment(of: [sheetIsUp], timeout: 5)
        // The second authorization must not re-fulfil this expectation.
        apple.onAuthorizeStarted = nil

        // A second sign-in starts and finishes while the first is still on Apple's sheet.
        apple.setBehavior(
            .succeed(
                AppleSignInCredential(
                    identityToken: "second.jwt",
                    rawNonce: "second-nonce",
                    attemptID: UUID()
                )
            )
        )
        // The fixture always returns sessionID/consumerID from `sessionResponse`; the suffix differs
        // per configured result, so the newer sign-in is the one that must survive.
        let fresh = try await built.coordinator.signInWithApple()
        XCTAssertEqual(fresh.accessToken, AuthFixture.token("first"))

        // Now the abandoned attempt completes. Its credential must be discarded.
        apple.release(
            with: .success(
                AppleSignInCredential(
                    identityToken: "stale.jwt",
                    rawNonce: "stale-nonce",
                    attemptID: UUID()
                )
            )
        )

        do {
            _ = try await stale.value
            XCTFail("expected the stale sign-in to be superseded")
        } catch let error as AuthError {
            XCTAssertEqual(error, .superseded)
        }

        let stored = built.store.currentRecord()
        XCTAssertEqual(stored?.accessToken, AuthFixture.token("first"))
        XCTAssertEqual(built.api.createSessionCallCount, 1)
    }

    func testLogoutDuringRefreshDoesNotResurrectTheCredential() async throws {
        let gate = AsyncGate()
        let started = expectation(description: "refresh started")
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { started.fulfill() }
        }

        let refreshing = Task { try await built.coordinator.refreshSessionIfNeeded() }
        await fulfillment(of: [started], timeout: 5)

        _ = await built.coordinator.logout()
        await gate.open()

        do {
            _ = try await refreshing.value
            XCTFail("expected the rotation to be superseded")
        } catch let error as AuthError {
            XCTAssertEqual(error, .superseded)
        }

        // The rotated token was never written after the logout.
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    // MARK: - Authenticated transport

    func testAuthorizedReadAttachesBearerAndReplaysOnceAfter401() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let recorder = RequestRecorder()
        let attempts = Counter()

        registrations.append(
            StubURLProtocol.register(
                { request in
                    recorder.record(request)
                    attempts.increment()
                    return attempts.value == 1
                        ? .json(statusCode: 401, body: "{}")
                        : .json(statusCode: 200, body: AuthFixture.meJSON)
                },
                forHost: host
            )
        )

        let response = try await built.coordinator.authorizedRequest(
            .read(pathComponents: ["v1", "me"])
        )

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(attempts.value, 2)
        XCTAssertEqual(built.api.refreshCallCount, 1)
        // The replay used the rotated token, not the rejected one.
        XCTAssertEqual(
            recorder.requests.last?.value(forHTTPHeaderField: "Authorization"),
            "Bearer ems_rotated"
        )
    }

    func testAuthorizedReadStopsAfterASecond401() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        registrations.append(
            StubURLProtocol.register(
                { _ in .json(statusCode: 401, body: "{}") },
                forHost: host
            )
        )

        do {
            _ = try await built.coordinator.authorizedRequest(.read(pathComponents: ["v1", "me"]))
            XCTFail("expected unauthenticated")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        // One rotation, one replay, then revocation — never a loop.
        XCTAssertEqual(built.api.refreshCallCount, 1)
        let stored = built.store.currentRecord()
        XCTAssertNil(stored)
    }

    func testAuthorizedWriteIsNeverReplayedAfter401() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let attempts = Counter()

        registrations.append(
            StubURLProtocol.register(
                { _ in
                    attempts.increment()
                    return .json(statusCode: 401, body: "{}")
                },
                forHost: host
            )
        )

        let request = EmberAuthenticatedRequest(
            method: "POST",
            pathComponents: ["v1", "conversations", "44444444-4444-4444-8444-444444444444", "messages"],
            body: Data("{}".utf8),
            contentType: "application/json",
            idempotency: .nonIdempotent(clientSubmissionID: "submission-1")
        )

        do {
            _ = try await built.coordinator.authorizedRequest(request)
            XCTFail("expected a rejection")
        } catch let error as AuthError {
            XCTAssertEqual(error, .requestRejectedBeforeExecution)
        }

        // Exactly one attempt: a write is not resent behind the caller's back.
        XCTAssertEqual(attempts.value, 1)
    }

    func testAuthorizedWriteWithUnknownOutcomeCarriesTheSubmissionID() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        registrations.append(
            StubURLProtocol.register(
                { _ in .failure(URLError(.timedOut)) },
                forHost: host
            )
        )

        let request = EmberAuthenticatedRequest(
            method: "POST",
            pathComponents: ["v1", "conversations", "44444444-4444-4444-8444-444444444444", "messages"],
            body: Data("{}".utf8),
            contentType: "application/json",
            idempotency: .nonIdempotent(clientSubmissionID: "submission-2")
        )

        do {
            _ = try await built.coordinator.authorizedRequest(request)
            XCTFail("expected an unknown outcome")
        } catch let error as AuthError {
            // The caller keeps the id so L2 can reconcile with GET /v1/message-submissions/{id}.
            XCTAssertEqual(error, .unknownWriteOutcome(clientSubmissionID: "submission-2"))
        }
    }

    func testAuthorizedRequestAfterLogoutIsRefusedWithoutTraffic() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let attempts = Counter()
        registrations.append(
            StubURLProtocol.register(
                { _ in
                    attempts.increment()
                    return .json(statusCode: 200, body: AuthFixture.meJSON)
                },
                forHost: host
            )
        )

        _ = await built.coordinator.logout()

        do {
            _ = try await built.coordinator.authorizedRequest(.read(pathComponents: ["v1", "me"]))
            XCTFail("expected the session to be gone")
        } catch let error as AuthError {
            XCTAssertEqual(error, .sessionMissing)
        }

        XCTAssertEqual(attempts.value, 0)
    }

    func testAuthorizedReadRetriesOnceOnATransientTransportFailure() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let attempts = Counter()
        registrations.append(
            StubURLProtocol.register(
                { _ in
                    attempts.increment()
                    return attempts.value == 1
                        ? .failure(URLError(.networkConnectionLost))
                        : .json(statusCode: 200, body: AuthFixture.meJSON)
                },
                forHost: host
            )
        )

        let response = try await built.coordinator.authorizedRequest(
            .read(pathComponents: ["v1", "me"])
        )

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(attempts.value, 2)
    }

    func testAuthorizedReadDoesNotRetryAFatalFailure() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record())
        let attempts = Counter()
        registrations.append(
            StubURLProtocol.register(
                { _ in
                    attempts.increment()
                    return .json(statusCode: 500, body: "{}")
                },
                forHost: host
            )
        )

        let response = try await built.coordinator.authorizedRequest(
            .read(pathComponents: ["v1", "me"])
        )

        // A 500 is a response, not a transport failure: it is returned to the caller untouched.
        XCTAssertEqual(response.statusCode, 500)
        XCTAssertEqual(attempts.value, 1)
    }

    // MARK: - Interleavings reported in review

    /// A logout that lands while the session exchange is still on the wire must win.
    ///
    /// The credential commit is a single uninterrupted actor step, so the only suspension a logout can
    /// interleave with is the network call — which is exactly what the gate holds open here.
    func testLogoutDuringSignInExchangeLeavesNoCredential() async throws {
        let gate = AsyncGate()
        let exchangeStarted = expectation(description: "session exchange started")
        let built = try makeCoordinator { api in
            api.setCreateSessionGate(gate)
            api.setCreateSessionStartedHandler { exchangeStarted.fulfill() }
        }

        let signIn = Task { try await built.coordinator.signInWithApple() }
        await fulfillment(of: [exchangeStarted], timeout: 5)
        built.api.setCreateSessionStartedHandler(nil)

        // The consumer signs out while the exchange is in flight.
        let outcome = await built.coordinator.logout()
        XCTAssertEqual(outcome, .alreadyInvalidated)

        await gate.open()

        do {
            _ = try await signIn.value
            XCTFail("expected the superseded sign-in to be rejected")
        } catch let error as AuthError {
            XCTAssertEqual(error, .superseded)
        }

        // Nothing survived: no Keychain record, no in-memory credential, no authenticated state.
        XCTAssertNil(built.store.currentRecord())
        XCTAssertEqual(built.store.saveCount, 0)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    /// A rotation that finishes after a newer sign-in must not delete the newer credential.
    ///
    /// Regression: the old settlement path deleted the store "to be safe" when its generation was
    /// stale, which removed the credential the new sign-in had just written.
    func testStaleRefreshDoesNotDeleteANewerSignInsCredential() async throws {
        let gate = AsyncGate()
        let rotationStarted = expectation(description: "rotation started")
        let built = try makeCoordinator(storedRecord: AuthFixture.record(tokenSuffix: "old", expiresIn: 10)) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { rotationStarted.fulfill() }
            api.setCreateSessionResult(.success(AuthFixture.sessionResponse(tokenSuffix: "new")))
        }

        let refreshing = Task { try await built.coordinator.refreshSessionIfNeeded() }
        await fulfillment(of: [rotationStarted], timeout: 5)

        // A fresh sign-in replaces the session while the old rotation is still in flight.
        let signed = try await built.coordinator.signInWithApple()
        XCTAssertEqual(signed.accessToken, AuthFixture.token("new"))

        await gate.open()

        do {
            _ = try await refreshing.value
            XCTFail("expected the stale rotation to be superseded")
        } catch let error as AuthError {
            XCTAssertEqual(error, .superseded)
        }

        // The newer credential is intact, in the store and in memory.
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("new"))
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_new"))))

        // The rotated token of the abandoned session was never written.
        let stored = built.store.currentRecord()
        XCTAssertNotEqual(stored?.accessToken, AuthFixture.token("rotated"))
    }

    /// A 401 that arrives for a replaced token must not revoke the session that replaced it.
    ///
    /// Regression: revocation was unconditional, so a delayed rejection of the old token signed the
    /// new session out locally and deleted its Keychain item.
    func testDelayedUnauthorizedForAnOldTokenDoesNotRevokeANewSession() async throws {
        let gate = AsyncGate()
        let rotationStarted = expectation(description: "rotation started")
        let built = try makeCoordinator(storedRecord: AuthFixture.record(tokenSuffix: "old", expiresIn: 10)) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { rotationStarted.fulfill() }
            api.setRefreshResults([.failure(.unauthenticated)])
            api.setCreateSessionResult(.success(AuthFixture.sessionResponse(tokenSuffix: "new")))
        }

        let refreshing = Task { try await built.coordinator.refreshSessionIfNeeded() }
        await fulfillment(of: [rotationStarted], timeout: 5)

        let signed = try await built.coordinator.signInWithApple()
        XCTAssertEqual(signed.accessToken, AuthFixture.token("new"))

        // Only now does the server reject the *old* token.
        await gate.open()

        do {
            _ = try await refreshing.value
            XCTFail("expected the old rotation to be rejected")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        // The failure belonged to the old credential, so the new session is untouched.
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("new"))
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_new"))))
        XCTAssertEqual(built.store.deleteCount, 0)
    }

    /// The same 401 *is* acted on when the rejected token is still the current one.
    func testUnauthorizedForTheCurrentTokenStillRevokes() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshResults([.failure(.unauthenticated)])
        }

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected revocation")
        } catch let error as AuthError {
            XCTAssertEqual(error, .unauthenticated)
        }

        XCTAssertNil(built.store.currentRecord())
        XCTAssertEqual(built.store.deleteCount, 1)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    // MARK: - Rotation succeeded but could not be persisted (review P1)

    /// A rotation the server accepted but this device could not persist must not become the in-memory
    /// session.
    ///
    /// The defect: the old token dies server-side the moment the rotation commits, so a device that keeps
    /// the *new* token only in memory while the *old* one stays on disk is one force-quit away from
    /// presenting a rotated-away token. The backend answers that with `reuse_detected`, which revokes
    /// every session for the consumer.
    func testRotationThatCannotBePersistedDoesNotAdoptTheNewToken() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(tokenSuffix: "alpha", expiresIn: 10))
        built.store.setReplaceFailure(.keychainUnavailable)

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the unpersistable rotation to end the session")
        } catch let error as AuthError {
            XCTAssertEqual(error, .keychainUnavailable)
        }

        // The rotated token was never adopted, and it is not what the store holds either.
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
        XCTAssertNotEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("rotated"))

        // The stale item was removed, so there is nothing left to present on the next launch.
        XCTAssertNil(built.store.currentRecord())
        XCTAssertFalse(built.fence.isArmed)

        // The replacement this device refused to keep was handed back instead of being left alive.
        XCTAssertEqual(built.api.logoutCallCount, 1)
        XCTAssertEqual(built.api.lastLogoutToken, AuthFixture.token("rotated"))
    }

    /// When the stale item cannot be removed either, the fence is what carries the knowledge across a
    /// relaunch.
    func testUnremovableStaleCredentialArmsTheFence() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(tokenSuffix: "alpha", expiresIn: 10))
        built.store.setReplaceFailure(.keychainUnavailable)
        built.store.setDeleteFailure(.keychainUnavailable)

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the unpersistable rotation to end the session")
        } catch let error as AuthError {
            XCTAssertEqual(error, .keychainUnavailable)
        }

        XCTAssertTrue(built.fence.isArmed)
        // The dead token is still there — which is exactly the situation the fence exists for.
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("alpha"))
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    /// The full path the review asked for: rotation succeeds, the Keychain write fails, the app is
    /// force-quit, and the next launch must not present the rotated-away token.
    ///
    /// A second coordinator over the same store and fence *is* the relaunch: nothing that lived only in
    /// the first coordinator's memory survives it.
    func testColdStartAfterAnUnpersistedRotationNeverPresentsTheRotatedAwayToken() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record(tokenSuffix: "alpha", expiresIn: 10))
        let fence = InMemorySessionRecoveryFence()

        let first = try makeCoordinator(store: store, fence: fence)
        store.setReplaceFailure(.keychainUnavailable)
        store.setDeleteFailure(.keychainUnavailable)

        do {
            _ = try await first.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the unpersistable rotation to end the session")
        } catch {
            // Expected: the rotation is unwelcome and cannot be persisted.
        }

        XCTAssertTrue(fence.isArmed)
        XCTAssertEqual(store.currentRecord()?.accessToken, AuthFixture.token("alpha"))

        // ---- force quit ----

        // The device is unlocked again on the next launch, so storage works — which is precisely why the
        // stale token would have been loaded and presented without the fence.
        store.setReplaceFailure(nil)
        store.setDeleteFailure(nil)

        let relaunched = try makeCoordinator(store: store, fence: fence)

        do {
            _ = try await relaunched.coordinator.restoreSession()
            XCTFail("a fenced cold start must not restore anything")
        } catch let error as AuthError {
            XCTAssertEqual(error, .sessionMissing)
        }

        // The decisive assertions: the dead token was never sent anywhere.
        XCTAssertEqual(relaunched.api.refreshCallCount, 0)
        XCTAssertEqual(relaunched.api.bootstrapCallCount, 0)
        XCTAssertEqual(relaunched.api.logoutCallCount, 0)

        // And the launch cleaned up after itself.
        XCTAssertNil(store.currentRecord())
        XCTAssertFalse(fence.isArmed)
        let state = await relaunched.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    /// A fenced launch whose cleanup fails must stay `unavailable`, not claim a signed-out consumer.
    func testAFencedColdStartWithALockedKeychainIsUnavailableRatherThanSignedOut() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record(tokenSuffix: "alpha"))
        let fence = InMemorySessionRecoveryFence(armed: true)
        store.setUnavailable(true)

        let built = try makeCoordinator(store: store, fence: fence)

        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unavailable)
        XCTAssertTrue(fence.isArmed)
        XCTAssertEqual(built.api.refreshCallCount, 0)
    }

    /// Signing in after a fenced recovery must re-arm nothing: a fresh session is trustworthy, and a
    /// stale fence would delete it on the next launch.
    func testSignInAfterAFencedRecoveryIsNotDeferredToTheFence() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record(tokenSuffix: "alpha"))
        let fence = InMemorySessionRecoveryFence(armed: true)

        let built = try makeCoordinator(store: store, fence: fence)
        _ = try await built.coordinator.signInWithApple()

        XCTAssertFalse(fence.isArmed)
        XCTAssertEqual(store.currentRecord()?.accessToken, AuthFixture.token("alpha"))

        // The next launch keeps the new session instead of treating it as stale.
        let relaunched = try makeCoordinator(store: store, fence: fence)
        let state = await relaunched.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
        XCTAssertNotNil(store.currentRecord())
    }

    /// Logout that cannot remove the departing item fences it, so the next launch does not present a
    /// token the server has already revoked.
    func testLogoutThatCannotRemoveTheItemFencesTheStore() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record())
        let fence = InMemorySessionRecoveryFence()

        let built = try makeCoordinator(store: store, fence: fence)
        store.setDeleteFailure(.keychainUnavailable)

        let outcome = await built.coordinator.logout()
        XCTAssertEqual(outcome, .localCleanupFailed(.keychainUnavailable))
        XCTAssertTrue(fence.isArmed)

        store.setDeleteFailure(nil)
        let relaunched = try makeCoordinator(store: store, fence: fence)
        let state = await relaunched.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
        XCTAssertNil(store.currentRecord())
    }

    // MARK: - Rotation in flight, outcome unknown (review P1, round 3)

    /// The marker must exist before the request does.
    ///
    /// If the app dies at any point after this instant, the next launch has to know that the token on disk
    /// may already be rotated away. Arming after the response would be arming too late: the crash we are
    /// defending against happens precisely while the response is outstanding.
    func testFenceIsArmedBeforeTheRefreshIsSent() async throws {
        let gate = AsyncGate()
        let started = expectation(description: "refresh started")
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { started.fulfill() }
        }

        let refreshing = Task { try await built.coordinator.refreshSessionIfNeeded() }
        await fulfillment(of: [started], timeout: 5)

        // The request is in flight and unanswered, and the marker is already durable.
        XCTAssertTrue(built.fence.isArmed)
        XCTAssertEqual(built.api.refreshCallCount, 1)
        // The old credential is still what the store holds — which is why the marker is required.
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("alpha"))

        await gate.open()
        _ = try await refreshing.value
        // A completed rotation that persisted clears it again.
        XCTAssertFalse(built.fence.isArmed)
    }

    /// Process death while the rotation is outstanding, then a cold start.
    ///
    /// The gate models a response that never arrives: nothing ever resumes the first coordinator, exactly
    /// as a force-quit leaves it. The relaunch must refuse to present the stored token — a replay would
    /// be answered with `reuse_detected`, which revokes every session for the consumer.
    func testProcessDeathDuringRefreshLeavesTheNextLaunchUnableToReplayTheToken() async throws {
        let store = InMemoryEmberSessionStore(initialRecord: AuthFixture.record(tokenSuffix: "alpha", expiresIn: 10))
        let fence = InMemorySessionRecoveryFence()
        let gate = AsyncGate()
        let started = expectation(description: "refresh started")

        let first = try makeCoordinator(store: store, fence: fence) { api in
            api.setRefreshGate(gate)
            api.setRefreshStartedHandler { started.fulfill() }
        }

        let doomed = Task { try await first.coordinator.refreshSessionIfNeeded() }
        await fulfillment(of: [started], timeout: 5)

        XCTAssertTrue(fence.isArmed)
        XCTAssertEqual(store.currentRecord()?.accessToken, AuthFixture.token("alpha"))

        // ---- the process is killed here; the gate is never opened ----

        let relaunched = try makeCoordinator(store: store, fence: fence)

        do {
            _ = try await relaunched.coordinator.restoreSession()
            XCTFail("a fenced cold start must not restore anything")
        } catch let error as AuthError {
            XCTAssertEqual(error, .sessionMissing)
        }

        // Nothing was sent: no rotation, no profile read, no logout.
        XCTAssertEqual(relaunched.api.refreshCallCount, 0)
        XCTAssertEqual(relaunched.api.bootstrapCallCount, 0)
        XCTAssertEqual(relaunched.api.logoutCallCount, 0)

        XCTAssertNil(store.currentRecord())
        XCTAssertFalse(fence.isArmed)
        let state = await relaunched.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)

        // The suspended task is released only after the assertions, so it cannot settle first.
        await gate.open()
        _ = try? await doomed.value
    }

    /// A lost response is not a transient fault for a rotation.
    ///
    /// The token may already be dead, so the session ends and nothing is retried — not immediately, not
    /// on the next call, and not after a relaunch.
    func testLostRefreshResponseEndsTheSessionWithoutReplayingTheToken() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshResults([.failure(.timedOut)])
        }

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the unknown outcome to end the session")
        } catch let error as AuthError {
            // Not `.timedOut`: a caller told "try again when you are online" would be told a lie.
            XCTAssertEqual(error, .rotationOutcomeUnknown)
        }

        XCTAssertEqual(built.api.refreshCallCount, 1)
        XCTAssertEqual(built.api.logoutCallCount, 0)
        XCTAssertNil(built.store.currentRecord())
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)

        // A second attempt finds nothing to rotate, so the dead token is never replayed.
        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the ended session to fail")
        } catch let error as AuthError {
            XCTAssertEqual(error, .sessionMissing)
        }
        XCTAssertEqual(built.api.refreshCallCount, 1)
    }

    /// A read that fails offline keeps the session; a rotation that fails offline does too, because the
    /// request provably never left the device.
    func testPreSendFailureKeepsTheSessionAndClearsTheFence() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshResults([.failure(.offline)])
        }

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the offline rotation to fail")
        } catch let error as AuthError {
            XCTAssertEqual(error, .offline)
        }

        // The token was never put at risk, so it survives and the marker's warning is withdrawn.
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("alpha"))
        XCTAssertFalse(built.fence.isArmed)
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
    }

    /// A 5xx during rotation is an unknown outcome, not a transient fault.
    ///
    /// The client cannot distinguish "the server declined" from "the server committed and then failed to
    /// answer", so it must assume the token may be gone.
    func testServerErrorDuringRotationIsAnUnknownOutcome() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10)) { api in
            api.setRefreshResults([.failure(.serverUnavailable)])
        }

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the unknown outcome to end the session")
        } catch let error as AuthError {
            XCTAssertEqual(error, .rotationOutcomeUnknown)
        }

        XCTAssertNil(built.store.currentRecord())
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .unauthenticated)
    }

    /// If the marker cannot be made durable, the rotation must not be attempted.
    ///
    /// Sending a rotation that cannot be recorded is exactly the window this fence closes, so failing
    /// closed is the only acceptable behaviour.
    func testRotationIsRefusedWhenTheFenceCannotBePersisted() async throws {
        let built = try makeCoordinator(storedRecord: AuthFixture.record(expiresIn: 10))
        built.fence.setArmFailure(.recoveryFenceUnavailable)

        do {
            _ = try await built.coordinator.refreshSessionIfNeeded()
            XCTFail("expected the rotation to be refused")
        } catch let error as AuthError {
            XCTAssertEqual(error, .recoveryFenceUnavailable)
        }

        // No request was sent, and the stored credential was not disturbed.
        XCTAssertEqual(built.api.refreshCallCount, 0)
        XCTAssertEqual(built.store.currentRecord()?.accessToken, AuthFixture.token("alpha"))
        let state = await built.coordinator.currentSession()
        XCTAssertEqual(state, .authenticated(try XCTUnwrap(AuthSession(accessToken: "ems_alpha"))))
    }

    // MARK: - Helpers

    /// `nil` means "the default successful authorizer", constructed in this main-actor context.
    private func makeCoordinator(
        apple: FakeAppleSignInAuthorizer? = nil,
        storedRecord: EmberSessionRecord? = nil,
        store: InMemoryEmberSessionStore? = nil,
        fence: InMemorySessionRecoveryFence? = nil,
        configure: (FakeEmberSessionAPI) -> Void = { _ in }
    ) throws -> CoordinatorFixture.Built {
        let built = try CoordinatorFixture.make(
            apple: apple,
            storedRecord: storedRecord,
            store: store,
            fence: fence,
            configure: configure
        )
        sessions.append(built.session)
        return built
    }
}
