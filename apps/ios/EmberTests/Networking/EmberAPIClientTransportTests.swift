import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import Ember

final class EmberAPIClientTransportTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.removeAllHandlers()
        super.tearDown()
    }

    func testClientPreservesRequestAndResponse() async throws {
        let body = Data("{\"ok\":true}".utf8)
        let requests = LockedRequestBox<[URLRequest]>([])
        StubURLProtocol.setHandler({ request in
            requests.update { $0.append(request) }
            return URLProtocolStubResponse(statusCode: 202, body: body)
        }, forHost: "transport.fixture.invalid")
        let client = makeClient()
        var request = URLRequest(url: URL(string: "https://transport.fixture.invalid/v1/chat")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("test-key", forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = Data("{\"message\":\"hello\"}".utf8)

        let response = try await client.send(request)

        XCTAssertEqual(response.statusCode, 202)
        XCTAssertEqual(response.data, body)
        let captured = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Idempotency-Key"), "test-key")
        XCTAssertEqual(captured.httpBody, request.httpBody)
    }

    func testClientPreservesRelevantHTTPStatusesWithoutRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        for status in [401, 403, 429, 500, 502, 503, 504] {
            StubURLProtocol.setHandler({ _ in
                requests.update { $0 += 1 }
                return .json(statusCode: status, body: "{\"status\":\(status)}")
            }, forHost: "status.fixture.invalid")

            let response = try await makeClient().send(
                URLRequest(url: URL(string: "https://status.fixture.invalid/status")!)
            )
            XCTAssertEqual(response.statusCode, status)
            XCTAssertEqual(String(data: response.data, encoding: .utf8), "{\"status\":\(status)}")
        }
        XCTAssertEqual(requests.value, 7)
    }

    func testOfflineErrorPropagatesWithoutRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        StubURLProtocol.setHandler({ _ in
            requests.update { $0 += 1 }
            return .failure(URLError(.notConnectedToInternet))
        }, forHost: "offline.fixture.invalid")

        do {
            _ = try await makeClient().send(
                URLRequest(url: URL(string: "https://offline.fixture.invalid/")!)
            )
            XCTFail("Expected offline transport failure")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .notConnectedToInternet)
        }
        XCTAssertEqual(requests.value, 1)
    }

    func testOtherNetworkErrorsPropagateWithoutRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        let failures: [URLError.Code] = [
            .cannotFindHost, .secureConnectionFailed, .timedOut, .networkConnectionLost
        ]

        for code in failures {
            StubURLProtocol.setHandler({ _ in
                requests.update { $0 += 1 }
                return .failure(URLError(code))
            }, forHost: "failure.fixture.invalid")

            do {
                _ = try await makeClient().send(
                    URLRequest(url: URL(string: "https://failure.fixture.invalid/")!)
                )
                XCTFail("Expected transport failure for \(code)")
            } catch let error as URLError {
                XCTAssertEqual(error.code, code)
            }
        }
        XCTAssertEqual(requests.value, failures.count)
    }

    func testCancellingInFlightRequestStopsDelayedDeliveryAndDoesNotRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        let requestStarted = expectation(description: "URLProtocol received request")
        StubURLProtocol.setHandler({ _ in
            requests.update { $0 += 1 }
            requestStarted.fulfill()
            var response = URLProtocolStubResponse(statusCode: 200, body: Data("late".utf8))
            response.delayNanoseconds = 2_000_000_000
            return response
        }, forHost: "cancel.fixture.invalid")

        let task = Task {
            try await makeClient().send(
                URLRequest(url: URL(string: "https://cancel.fixture.invalid/")!)
            )
        }
        await fulfillment(of: [requestStarted], timeout: 2)
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .cancelled)
        } catch is CancellationError {
            // URLSession implementations may surface task cancellation directly.
        }
        XCTAssertEqual(requests.value, 1)
    }

    private func makeClient() -> EmberAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return EmberAPIClient(session: URLSession(configuration: configuration))
    }
}

private final class LockedRequestBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var valueStorage: Value

    init(_ value: Value) { valueStorage = value }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return valueStorage
    }

    func update(_ body: (inout Value) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        body(&valueStorage)
    }
}
