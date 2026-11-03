import XCTest
@testable import Ember

final class AuthSessionProviderTests: XCTestCase {
    func testAuthenticatedSessionCanBeRetrieved() async throws {
        let session = try XCTUnwrap(AuthSession(accessToken: "synthetic-access-token"))
        let provider = MockAuthSessionProvider(initialState: .authenticated(session))

        let state = await provider.currentSession()

        XCTAssertEqual(state, .authenticated(session))
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
        let session = try XCTUnwrap(AuthSession(accessToken: "rotated-synthetic-token"))

        await provider.setState(.authenticated(session))
        let authenticated = await provider.currentSession()
        XCTAssertEqual(authenticated, .authenticated(session))

        await provider.setState(.unavailable)
        let unavailable = await provider.currentSession()
        XCTAssertEqual(unavailable, .unavailable)
    }

    func testConcurrentReadsReturnTheSameSessionSnapshot() async throws {
        let session = try XCTUnwrap(AuthSession(accessToken: "concurrent-synthetic-token"))
        let expected = AuthSessionState.authenticated(session)
        let provider = MockAuthSessionProvider(initialState: expected)

        async let firstRead = provider.currentSession()
        async let secondRead = provider.currentSession()
        let (first, second) = await (firstRead, secondRead)

        XCTAssertEqual(first, expected)
        XCTAssertEqual(second, expected)
    }

    func testEmptyOrWhitespaceOnlyCredentialsAreRejected() {
        XCTAssertNil(AuthSession(accessToken: ""))
        XCTAssertNil(AuthSession(accessToken: " \n\t "))
    }

    func testCredentialIsRedactedFromStringAndDebugDescriptions() throws {
        let secret = "never-log-this-synthetic-token"
        let session = try XCTUnwrap(AuthSession(accessToken: secret))
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

        let mirroredCredential = Mirror(reflecting: session).children.first?.value as? String
        XCTAssertEqual(mirroredCredential, "<redacted>")
    }
}
