import XCTest
@testable import Ember

final class AuthSessionProviderTests: XCTestCase {
    private let sessionID = UUID(uuidString: "74000000-0000-4000-8000-000000000001")!
    private let consumerID = UUID(uuidString: "74000000-0000-4000-8000-000000000002")!

    func testAuthenticatedSessionCanBeRetrievedWithB1Fields() async throws {
        let session = try makeSession()
        let provider = MockAuthSessionProvider(initialState: .authenticated(session))

        let state = await provider.currentSession()

        XCTAssertEqual(state, .authenticated(session))
        XCTAssertEqual(session.sessionID, sessionID)
        XCTAssertEqual(session.consumerID, consumerID)
        XCTAssertEqual(session.expiresAt, Date(timeIntervalSince1970: 1_800_000_000))
    }

    func testUnauthenticatedStateIsDistinct() async {
        let provider = MockAuthSessionProvider(initialState: .unauthenticated)

        let state = await provider.currentSession()

        XCTAssertEqual(state, .unauthenticated)
    }

    func testUnavailableStateIsDistinctFromUnauthenticated() async {
        let provider = MockAuthSessionProvider(initialState: .unavailable)

        let state = await provider.currentSession()

        XCTAssertEqual(state, .unavailable)
        XCTAssertNotEqual(state, .unauthenticated)
    }

    func testMockProviderCanTransitionSessionState() async throws {
        let provider = MockAuthSessionProvider(initialState: .unauthenticated)
        let session = try makeSession()

        await provider.setState(.authenticated(session))
        let authenticated = await provider.currentSession()
        XCTAssertEqual(authenticated, .authenticated(session))

        await provider.setState(.unavailable)
        let unavailable = await provider.currentSession()
        XCTAssertEqual(unavailable, .unavailable)
    }

    func testEmptyOrWhitespaceOnlyCredentialsAreRejected() {
        XCTAssertNil(
            AuthSession(
                sessionID: sessionID,
                consumerID: consumerID,
                accessToken: "",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            )
        )
        XCTAssertNil(
            AuthSession(
                sessionID: sessionID,
                consumerID: consumerID,
                accessToken: " \n\t ",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            )
        )
    }

    func testCredentialIsRedactedFromStringAndDebugDescriptions() throws {
        let secret = "ems_mock_only_never-log-this-token"
        let session = try XCTUnwrap(
            AuthSession(
                sessionID: sessionID,
                consumerID: consumerID,
                accessToken: secret,
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            )
        )
        let state = AuthSessionState.authenticated(session)

        for representation in [
            String(describing: session),
            String(reflecting: session),
            String(describing: state),
            String(reflecting: state)
        ] {
            XCTAssertFalse(representation.contains(secret))
            XCTAssertTrue(representation.contains("<redacted>"))
        }
    }

    private func makeSession() throws -> AuthSession {
        try XCTUnwrap(
            AuthSession(
                sessionID: sessionID,
                consumerID: consumerID,
                accessToken: "ems_mock_only_synthetic_token",
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            )
        )
    }
}
