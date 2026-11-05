import XCTest
@testable import Ember

/// Sensitivity checks that are cheap to run and expensive to lose: no token, Apple assertion or raw
/// nonce may appear in a description, a debug description, or a mirror. These are the values that end
/// up in unified logging and crash breadcrumbs (annex §10.6 G-2).
@MainActor
final class LiveAuthDiagnosticsTests: XCTestCase {
    private let tokenSecret = "ems_super_secret_session_token"
    private let identityTokenSecret = "header.payload.apple-signature"
    private let nonceSecret = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"

    func testAccessTokenNeverAppearsInAnyDescription() throws {
        let token = try XCTUnwrap(EmberAccessToken(tokenSecret))

        for representation in [
            String(describing: token),
            String(reflecting: token),
            token.description,
            token.debugDescription,
        ] {
            XCTAssertFalse(representation.contains("super_secret"))
        }
    }

    func testAppleCredentialNeverExposesTheAssertionOrTheNonce() {
        let credential = AppleSignInCredential(
            identityToken: identityTokenSecret,
            rawNonce: nonceSecret,
            attemptID: UUID()
        )

        for representation in [
            String(describing: credential),
            String(reflecting: credential),
            credential.description,
            credential.debugDescription,
        ] {
            XCTAssertFalse(representation.contains("apple-signature"))
            XCTAssertFalse(representation.contains(nonceSecret))
        }

        let mirrored = Mirror(reflecting: credential).children.map { String(describing: $0.value) }
        XCTAssertFalse(mirrored.contains { $0.contains(nonceSecret) })
        XCTAssertFalse(mirrored.contains { $0.contains("apple-signature") })
    }

    func testSessionStateNeverExposesTheToken() throws {
        let session = try XCTUnwrap(AuthSession(accessToken: tokenSecret))
        let state = AuthSessionState.authenticated(session)

        for representation in [
            String(describing: state),
            String(reflecting: state),
            state.description,
            state.debugDescription,
        ] {
            XCTAssertFalse(representation.contains("super_secret"))
        }
    }

    func testAuthenticatedCoordinatorStateNeverExposesTheToken() async throws {
        let built = try CoordinatorFixture.make(
            storedRecord: AuthFixture.record(tokenSuffix: "super_secret_session_token")
        )
        let coordinator = built.coordinator

        let state = await coordinator.currentSession()

        for representation in [String(describing: state), String(reflecting: state)] {
            XCTAssertTrue(representation.contains("authenticated"))
            XCTAssertFalse(representation.contains("super_secret"))
        }
    }

    func testEveryAuthErrorDescriptionIsPayloadFree() {
        // `unexpectedStatus` carries only an integer; `unknownWriteOutcome` only a client-generated
        // submission id. Nothing else has a payload at all, which is the point.
        let errors: [AuthError] = [
            .appleCancelled, .appleAuthorizationFailed, .appleCredentialInvalid, .appleAttemptExpired,
            .appleAuthorizationInProgress, .invalidRequest, .unauthenticated, .notFound, .rateLimited,
            .serverUnavailable, .unexpectedStatus(503), .invalidResponse, .nonHTTPResponse, .offline,
            .timedOut, .transportFailure, .keychainUnavailable, .storedSessionCorrupt,
            .sessionMissing, .superseded, .requestRejectedBeforeExecution,
            .unknownWriteOutcome(clientSubmissionID: "submission-id"), .invalidBaseURL, .sessionEnded,
        ]

        for error in errors {
            let representation = String(describing: error) + String(reflecting: error)
            XCTAssertFalse(representation.contains("super_secret"))
            XCTAssertFalse(representation.contains("apple-signature"))
            XCTAssertFalse(representation.contains(nonceSecret))
        }
    }

    func testUserFacingMessagesDoNotEchoCredentials() async {
        let model = LiveAuthEntryModel { throw AuthError.unauthenticated }
        await model.signIn()

        let message = model.statusMessage
        XCTAssertFalse(message.contains("ems_"))
        XCTAssertFalse(message.contains(nonceSecret))
        XCTAssertFalse(message.lowercased().contains("bearer"))
    }

    func testLogoutOutcomeDescriptionsArePayloadFree() {
        let outcomes: [LogoutOutcome] = [
            .revokedRemotely, .alreadyInvalidated, .remoteUnconfirmed(.offline),
            .localCleanupFailed(.keychainUnavailable),
        ]

        for outcome in outcomes {
            let representation = String(describing: outcome)
            XCTAssertFalse(representation.contains("ems_"))
        }
    }
}
