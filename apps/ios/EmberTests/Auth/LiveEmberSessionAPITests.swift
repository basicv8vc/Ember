import Foundation
import XCTest
@testable import Ember

/// Contract tests for `LiveEmberSessionAPI` over the real `URLSession` stack with a deterministic
/// `URLProtocol`. These pin the four frozen routes, their success statuses, the absence of forbidden
/// identifiers and the closed error mapping. No server is involved.
final class LiveEmberSessionAPITests: XCTestCase {
    private var registrations: [StubURLProtocol.HandlerRegistration] = []
    private var sessions: [URLSession] = []

    private let host = "live-auth.l1.invalid"
    private var baseURL: URL { URL(string: "https://\(host)")! }

    override func tearDown() {
        sessions.forEach { $0.invalidateAndCancel() }
        sessions.removeAll()
        registrations.forEach { $0.remove() }
        registrations.removeAll()
        super.tearDown()
    }

    // MARK: Create session

    func testCreateSessionPostsTheFrozenBodyToTheFrozenPath() async throws {
        let recorder = RequestRecorder()
        register({ request in
            recorder.record(request)
            return .json(statusCode: 201, body: AuthFixture.sessionJSON(tokenSuffix: "first"))
        })

        let dto = try await makeAPI().createSession(
            identityToken: "apple.jwt.value",
            nonce: "raw-nonce-value"
        )

        XCTAssertEqual(dto.accessToken.rawValue, "ems_first")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/auth/session")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(request.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["provider", "identity_token", "nonce"])
        XCTAssertEqual(object["provider"] as? String, "apple")
        XCTAssertEqual(object["identity_token"] as? String, "apple.jwt.value")
        XCTAssertEqual(object["nonce"] as? String, "raw-nonce-value")
    }

    func testCreateSessionRejectsA200BecauseTheContractRequires201() async {
        register({ _ in .json(statusCode: 200, body: AuthFixture.sessionJSON()) })

        await assertError(.unexpectedStatus(200)) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionRejectsAnEmptyIdentityTokenLocally() async {
        register({ _ in .json(statusCode: 201, body: AuthFixture.sessionJSON()) })

        await assertError(.appleCredentialInvalid) {
            _ = try await makeAPI().createSession(identityToken: "", nonce: "nonce")
        }
        await assertError(.appleCredentialInvalid) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "")
        }
    }

    func testCreateSessionMaps400() async {
        register({ _ in .json(statusCode: 400, body: "{\"error_code\":\"INVALID_ARGUMENT\"}") })
        await assertError(.invalidRequest) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionMaps401() async {
        register({ _ in .json(statusCode: 401, body: "{}") })
        await assertError(.unauthenticated) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionMaps403ToAccessDenied() async {
        register({ _ in .json(statusCode: 403, body: "{\"error_code\":\"POLICY_DENIED\"}") })
        await assertError(.accessDenied) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionMaps404() async {
        register({ _ in .json(statusCode: 404, body: "{}") })
        await assertError(.notFound) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionMaps429() async {
        register({ _ in .json(statusCode: 429, body: "{}") })
        await assertError(.rateLimited) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionMaps503() async {
        register({ _ in .json(statusCode: 503, body: "{}") })
        await assertError(.serverUnavailable) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionRejectsMalformedJSON() async {
        register({ _ in .json(statusCode: 201, body: "{\"session_id\": ") })
        await assertError(.invalidResponse) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionRejectsAnEmptyBody() async {
        register({ _ in URLProtocolStubResponse(statusCode: 201, headers: [:], body: Data()) })
        await assertError(.invalidResponse) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    func testCreateSessionRejectsABodyWithAnUnexpectedField() async {
        let body = AuthFixture.sessionJSON().replacingOccurrences(
            of: "\"expires_at\"",
            with: "\"tenant_id\": \"x\", \"expires_at\""
        )
        register({ _ in .json(statusCode: 201, body: body) })
        await assertError(.invalidResponse) {
            _ = try await makeAPI().createSession(identityToken: "jwt", nonce: "nonce")
        }
    }

    // MARK: Refresh

    func testRefreshSendsOnlyTheBearerTokenAndNoBody() async throws {
        let recorder = RequestRecorder()
        register({ request in
            recorder.record(request)
            return .json(statusCode: 200, body: AuthFixture.sessionJSON(tokenSuffix: "rotated"))
        })

        let dto = try await makeAPI().refreshSession(accessToken: AuthFixture.token("current"))

        XCTAssertEqual(dto.accessToken.rawValue, "ems_rotated")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/auth/session/refresh")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ems_current")
        // I-7: no Apple assertion and no nonce on refresh.
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(recorder.requests.count, 1)
    }

    func testRefreshMaps401ToUnauthenticated() async {
        register({ _ in .json(statusCode: 401, body: "{}") })
        await assertError(.unauthenticated) {
            _ = try await makeAPI().refreshSession(accessToken: AuthFixture.token())
        }
    }

    func testRefreshRejectsANonRotatedResponseBody() async {
        register({ _ in .json(statusCode: 200, body: "{\"rotated\":true}") })
        await assertError(.invalidResponse) {
            _ = try await makeAPI().refreshSession(accessToken: AuthFixture.token())
        }
    }

    // MARK: Logout

    func testLogoutDeletesWithoutABody() async {
        let recorder = RequestRecorder()
        register({ request in
            recorder.record(request)
            return URLProtocolStubResponse(statusCode: 204, headers: [:], body: Data())
        })

        try? await makeAPI().logout(accessToken: AuthFixture.token("departing"))

        let request = try? XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request?.httpMethod, "DELETE")
        XCTAssertEqual(request?.url?.path, "/v1/auth/session")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer ems_departing")
        XCTAssertNil(request?.httpBody)
    }

    func testLogoutAccepts204Only() async {
        register({ _ in .json(statusCode: 200, body: "{}") })
        await assertError(.unexpectedStatus(200)) {
            try await makeAPI().logout(accessToken: AuthFixture.token())
        }
    }

    // MARK: Bootstrap

    func testBootstrapReadsMeWithTheBearerToken() async throws {
        let recorder = RequestRecorder()
        register({ request in
            recorder.record(request)
            return .json(statusCode: 200, body: AuthFixture.meJSON)
        })

        let dto = try await makeAPI().bootstrap(accessToken: AuthFixture.token("live"))

        XCTAssertEqual(dto.conversation.transcriptEpoch, 0)
        XCTAssertEqual(dto.agent.displayName, "Ember")
        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/v1/me")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ems_live")
        XCTAssertNil(request.url?.query)
    }

    func testBootstrapMaps404ToNotFoundWithoutFabricatingAnything() async {
        register({ _ in .json(statusCode: 404, body: "{\"error_code\":\"NOT_FOUND\"}") })
        await assertError(.notFound) {
            _ = try await makeAPI().bootstrap(accessToken: AuthFixture.token())
        }
    }

    func testBootstrapRejectsUnknownNestedFields() async {
        let body = AuthFixture.meJSON.replacingOccurrences(
            of: "\"transcript_epoch\": 0",
            with: "\"transcript_epoch\": 0, \"tenant_id\": \"leak\""
        )
        register({ _ in .json(statusCode: 200, body: body) })
        await assertError(.invalidResponse) {
            _ = try await makeAPI().bootstrap(accessToken: AuthFixture.token())
        }
    }

    // MARK: Transport failures

    func testOfflineIsDistinctFromServerFailure() async {
        register({ _ in .failure(URLError(.notConnectedToInternet)) })
        await assertError(.offline) {
            _ = try await makeAPI().bootstrap(accessToken: AuthFixture.token())
        }
    }

    func testTimeoutIsReportedAsTimeout() async {
        register({ _ in .failure(URLError(.timedOut)) })
        await assertError(.timedOut) {
            _ = try await makeAPI().bootstrap(accessToken: AuthFixture.token())
        }
    }

    func testUnexpectedStatusIsCarriedButNotDecoded() async {
        register({ _ in .json(statusCode: 418, body: "{\"teapot\":true}") })
        await assertError(.unexpectedStatus(418)) {
            _ = try await makeAPI().bootstrap(accessToken: AuthFixture.token())
        }
    }

    // MARK: Configuration

    func testPlainHTTPOriginIsRefused() {
        XCTAssertThrowsError(
            try LiveEmberSessionAPI(
                baseURL: URL(string: "http://live-auth.l1.invalid")!,
                client: EmberAPIClient(session: stubSession())
            )
        ) { error in
            XCTAssertEqual(error as? AuthError, .invalidBaseURL)
        }
    }

    func testOriginWithCredentialsQueryOrFragmentIsRefused() {
        for raw in [
            "https://user:pass@live-auth.l1.invalid",
            "https://live-auth.l1.invalid?tenant_id=x",
            "https://live-auth.l1.invalid#fragment",
        ] {
            XCTAssertThrowsError(
                try LiveEmberSessionAPI(
                    baseURL: URL(string: raw)!,
                    client: EmberAPIClient(session: stubSession())
                ),
                raw
            )
        }
    }

    // MARK: Helpers

    private func makeAPI() -> LiveEmberSessionAPI {
        // Force-try is acceptable here: a rejected test origin would fail every assertion anyway.
        try! LiveEmberSessionAPI(
            baseURL: baseURL,
            client: EmberAPIClient(session: stubSession())
        )
    }

    private func stubSession() -> URLSession {
        let session = StubSession.make()
        sessions.append(session)
        return session
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: host))
    }

    private func assertError(
        _ expected: AuthError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch let error as AuthError {
            XCTAssertEqual(error, expected, file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }
}
