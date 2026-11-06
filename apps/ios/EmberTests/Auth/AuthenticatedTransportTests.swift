import Foundation
import XCTest
@testable import Ember

/// The authenticated request boundary: header construction, path safety and origin validation.
/// It is the only place a bearer token is attached, so it is tested directly as well as through the
/// coordinator.
final class AuthenticatedTransportTests: XCTestCase {
    private var sessions: [URLSession] = []

    override func tearDown() {
        sessions.forEach { $0.invalidateAndCancel() }
        sessions.removeAll()
        super.tearDown()
    }

    func testBearerTokenIsTheOnlyAuthorizationMaterial() throws {
        let transport = try makeTransport()

        let request = try transport.makeRequest(
            .read(pathComponents: ["v1", "me"]),
            accessToken: AuthFixture.token("abc")
        )

        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ems_abc")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertNil(request.httpBody)
        // The token must not leak into the URL or a query item.
        XCTAssertFalse(request.url?.absoluteString.contains("ems_abc") ?? true)
        XCTAssertNil(request.url?.query)
    }

    func testPathIsAssembledFromTheOriginAndSegments() throws {
        let transport = try makeTransport()

        let request = try transport.makeRequest(
            EmberAuthenticatedRequest(
                method: "POST",
                pathComponents: ["v1", "conversations", "abc-123", "messages"],
                body: Data("{}".utf8),
                contentType: "application/json",
                idempotency: .nonIdempotent(clientSubmissionID: "s")
            ),
            accessToken: AuthFixture.token()
        )

        XCTAssertEqual(request.url?.path, "/v1/conversations/abc-123/messages")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.httpBody, Data("{}".utf8))
    }

    func testTrailingSlashOnTheOriginDoesNotDoubleUp() throws {
        let transport = try makeTransport(baseURL: URL(string: "https://live-auth.l1.invalid/")!)

        let request = try transport.makeRequest(
            .read(pathComponents: ["v1", "me"]),
            accessToken: AuthFixture.token()
        )

        XCTAssertEqual(request.url?.path, "/v1/me")
    }

    func testSegmentsThatCouldReshapeTheURLAreRejected() throws {
        let transport = try makeTransport()

        // A server-issued id is never interpolated blindly into a URL. These are the shapes that
        // would otherwise escape their segment.
        for segment in ["..", ".", "a/b", "a?b", "a#b", "", "a b", "a%2Fb"] {
            XCTAssertThrowsError(
                try transport.makeRequest(
                    .read(pathComponents: ["v1", segment]),
                    accessToken: AuthFixture.token()
                ),
                "segment \(segment) must be rejected"
            )
        }
    }

    func testAnEmptyPathIsRejected() throws {
        let transport = try makeTransport()

        XCTAssertThrowsError(
            try transport.makeRequest(.read(pathComponents: []), accessToken: AuthFixture.token())
        )
    }

    func testPlainHTTPOriginIsRejected() {
        XCTAssertThrowsError(
            try EmberAuthenticatedTransport(
                baseURL: URL(string: "http://live-auth.l1.invalid")!,
                client: EmberAPIClient(session: makeSession())
            )
        ) { error in
            XCTAssertEqual(error as? AuthError, .invalidBaseURL)
        }
    }

    func testReadConvenienceUsesGETAndIdempotentSemantics() {
        let request = EmberAuthenticatedRequest.read(pathComponents: ["v1", "me"])

        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.idempotency, .idempotentRead)
        XCTAssertNil(request.body)
    }

    private func makeTransport(baseURL: URL = AuthFixture.baseURL) throws -> EmberAuthenticatedTransport {
        try EmberAuthenticatedTransport(baseURL: baseURL, client: EmberAPIClient(session: makeSession()))
    }

    private func makeSession() -> URLSession {
        let session = StubSession.make()
        sessions.append(session)
        return session
    }
}
