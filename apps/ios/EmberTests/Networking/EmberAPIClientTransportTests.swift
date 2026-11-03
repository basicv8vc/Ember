import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import Ember

final class EmberAPIClientTransportTests: XCTestCase {
    private var handlerRegistrations: [StubURLProtocol.HandlerRegistration] = []
    private var sessions: [URLSession] = []

    override func tearDown() {
        sessions.forEach { $0.invalidateAndCancel() }
        sessions.removeAll()
        handlerRegistrations.forEach { $0.remove() }
        handlerRegistrations.removeAll()
        super.tearDown()
    }

    func testClientPreservesRequestAndResponse() async throws {
        let body = Data("{\"ok\":true}".utf8)
        let requests = LockedRequestBox<[URLRequest]>([])
        registerHandler({ request in
            requests.update { $0.append(request) }
            return URLProtocolStubResponse(statusCode: 202, body: body)
        }, forHost: "transport.fixture.invalid")

        var request = URLRequest(url: URL(string: "https://transport.fixture.invalid/v1/chat")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("test-key", forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = Data("{\"message\":\"hello\"}".utf8)

        let response = try await makeClient().send(request)

        XCTAssertEqual(response.statusCode, 202)
        XCTAssertEqual(response.data, body)
        let captured = try XCTUnwrap(requests.value.first)
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Idempotency-Key"), "test-key")
        XCTAssertEqual(captured.httpBody, request.httpBody)
    }

    func testHandlersAreScopedToTheirRequestHosts() async throws {
        registerHandler({ _ in .json(statusCode: 201, body: "first") }, forHost: "first.fixture.invalid")
        registerHandler({ _ in .json(statusCode: 202, body: "second") }, forHost: "second.fixture.invalid")
        let client = makeClient()

        async let first = client.send(URLRequest(url: URL(string: "https://first.fixture.invalid/")!))
        async let second = client.send(URLRequest(url: URL(string: "https://second.fixture.invalid/")!))
        let (firstResponse, secondResponse) = try await (first, second)

        XCTAssertEqual(firstResponse.statusCode, 201)
        XCTAssertEqual(String(data: firstResponse.data, encoding: .utf8), "first")
        XCTAssertEqual(secondResponse.statusCode, 202)
        XCTAssertEqual(String(data: secondResponse.data, encoding: .utf8), "second")
    }

    func testRemovingHandlerRegistrationPreventsHandlerReuse() async throws {
        let requests = LockedRequestBox<Int>(0)
        let registration = registerHandler({ _ in
            requests.update { $0 += 1 }
            return .json(statusCode: 200)
        }, forHost: "removed.fixture.invalid")
        registration.remove()

        do {
            _ = try await makeClient().send(
                URLRequest(url: URL(string: "https://removed.fixture.invalid/")!)
            )
            XCTFail("Expected a missing local handler to fail closed")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .badServerResponse)
        }
        XCTAssertEqual(requests.value, 0)
    }

    func testClientPreservesRelevantHTTPStatusesWithoutRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        let client = makeClient()
        for status in [401, 403, 429, 500, 502, 503, 504] {
            registerHandler({ _ in
                requests.update { $0 += 1 }
                return .json(statusCode: status, body: "{\"status\":\(status)}")
            }, forHost: "status.fixture.invalid")

            let response = try await client.send(
                URLRequest(url: URL(string: "https://status.fixture.invalid/status")!)
            )
            XCTAssertEqual(response.statusCode, status)
            XCTAssertEqual(String(data: response.data, encoding: .utf8), "{\"status\":\(status)}")
        }
        XCTAssertEqual(requests.value, 7)
    }

    func testOfflineErrorPropagatesWithoutRetry() async throws {
        let requests = LockedRequestBox<Int>(0)
        registerHandler({ _ in
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
        let client = makeClient()
        let failures: [URLError.Code] = [
            .cannotFindHost, .secureConnectionFailed, .timedOut, .networkConnectionLost
        ]

        for code in failures {
            registerHandler({ _ in
                requests.update { $0 += 1 }
                return .failure(URLError(code))
            }, forHost: "failure.fixture.invalid")

            do {
                _ = try await client.send(
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
        let deliveryProbe = URLProtocolDeliveryProbe()
        let requestStarted = expectation(description: "URLProtocol received request")
        registerHandler({ _ in
            requests.update { $0 += 1 }
            requestStarted.fulfill()
            var response = URLProtocolStubResponse(statusCode: 200, body: Data("late".utf8))
            response.delayNanoseconds = 2_000_000_000
            response.deliveryProbe = deliveryProbe
            return response
        }, forHost: "cancel.fixture.invalid")

        let client = makeClient()
        let task = Task {
            try await client.send(
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

        // Let the scheduled response reach its deadline so the probe catches a late callback.
        try await Task.sleep(nanoseconds: 2_250_000_000)
        XCTAssertEqual(deliveryProbe.count, 0)
        XCTAssertEqual(requests.value, 1)
    }

    @discardableResult
    private func registerHandler(
        _ handler: @escaping StubURLProtocol.Handler,
        forHost host: String
    ) -> StubURLProtocol.HandlerRegistration {
        let registration = StubURLProtocol.register(handler, forHost: host)
        handlerRegistrations.append(registration)
        return registration
    }

    private func makeClient() -> EmberAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)
        sessions.append(session)
        return EmberAPIClient(session: session)
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
