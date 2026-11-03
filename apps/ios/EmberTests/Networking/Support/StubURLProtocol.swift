import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A deterministic URLProtocol response used by iOS networking unit tests.
struct URLProtocolStubResponse {
    let statusCode: Int
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body = Data()
    var error: Error?
    var delayNanoseconds: UInt64 = 0

    static func json(
        statusCode: Int,
        body: String = "{}",
        headers: [String: String] = ["Content-Type": "application/json"]
    ) -> Self {
        Self(statusCode: statusCode, headers: headers, body: Data(body.utf8))
    }

    static func failure(_ error: Error) -> Self {
        Self(statusCode: 0, error: error)
    }
}

/// URLProtocol-backed transport fixture. Handlers are scoped by request host so tests
/// using distinct .invalid hosts do not overwrite each other's scripts.
final class StubURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> URLProtocolStubResponse

    private static let handlersLock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    private final class WeakReference: @unchecked Sendable {
        weak var value: StubURLProtocol?
        init(_ value: StubURLProtocol) { self.value = value }
    }

    private let stoppedLock = NSRecursiveLock()
    private var stopped = false

    static func setHandler(_ handler: Handler?, forHost host: String) {
        handlersLock.lock()
        defer { handlersLock.unlock() }
        handlers[host] = handler
    }

    static func removeAllHandlers() {
        handlersLock.lock()
        defer { handlersLock.unlock() }
        handlers.removeAll()
    }

    private static func handler(for request: URLRequest) -> Handler? {
        guard let host = request.url?.host else { return nil }
        handlersLock.lock()
        defer { handlersLock.unlock() }
        return handlers[host]
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".invalid") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let stub = try handler(request)
            if stub.delayNanoseconds > 0 {
                let boundedDelay = Int(min(stub.delayNanoseconds, UInt64(Int.max)))
                let reference = WeakReference(self)
                DispatchQueue.global().asyncAfter(deadline: .now() + .nanoseconds(boundedDelay)) {
                    reference.value?.deliver(stub)
                }
            } else {
                deliver(stub)
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {
        stoppedLock.lock()
        stopped = true
        stoppedLock.unlock()
    }

    private func deliver(_ stub: URLProtocolStubResponse) {
        stoppedLock.lock()
        defer { stoppedLock.unlock() }
        guard !stopped else { return }

        if let error = stub.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }

        guard let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: stub.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: stub.headers
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !stub.body.isEmpty {
            client?.urlProtocol(self, didLoad: stub.body)
        }
        client?.urlProtocolDidFinishLoading(self)
    }
}
