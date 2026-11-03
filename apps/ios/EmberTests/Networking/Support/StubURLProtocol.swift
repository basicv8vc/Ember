import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A deterministic URLProtocol response used by iOS networking unit tests.
struct URLProtocolStubResponse: @unchecked Sendable {
    // A script is configured before it is returned by a handler, then read-only during delivery.
    let statusCode: Int
    var headers: [String: String] = ["Content-Type": "application/json"]
    var body = Data()
    var error: Error?
    var delayNanoseconds: UInt64 = 0
    var deliveryProbe: URLProtocolDeliveryProbe?

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

/// Thread-safe observation point for asserting that a cancelled script never starts delivery.
final class URLProtocolDeliveryProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var deliveryCount = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return deliveryCount
    }

    func recordDelivery() {
        lock.lock()
        defer { lock.unlock() }
        deliveryCount += 1
    }
}

/// URLProtocol-backed transport fixture. Handlers are scoped by request host so tests
/// using distinct .invalid hosts do not overwrite each other's scripts.
final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (URLRequest) throws -> URLProtocolStubResponse

    private struct RegisteredHandler {
        let id: UUID
        let handler: Handler
    }

    private final class HandlerRegistry: @unchecked Sendable {
        // All access to registered handlers is protected by this lock.
        private let lock = NSLock()
        private var handlers: [String: RegisteredHandler] = [:]

        func register(_ handler: @escaping Handler, forHost host: String) -> UUID {
            let id = UUID()
            lock.lock()
            handlers[host.lowercased()] = RegisteredHandler(id: id, handler: handler)
            lock.unlock()
            return id
        }

        func remove(forHost host: String, id: UUID) {
            lock.lock()
            defer { lock.unlock() }
            let key = host.lowercased()
            guard handlers[key]?.id == id else { return }
            handlers.removeValue(forKey: key)
        }

        func handler(forHost host: String) -> Handler? {
            lock.lock()
            defer { lock.unlock() }
            return handlers[host.lowercased()]?.handler
        }
    }

    /// A lease removes only the handler installed by its owner, so one test cannot
    /// clear a handler installed by another concurrently running test.
    struct HandlerRegistration {
        fileprivate let host: String
        fileprivate let id: UUID

        func remove() {
            handlerRegistry.remove(forHost: host, id: id)
        }
    }

    private final class WeakReference: @unchecked Sendable {
        // This wrapper only transports the weak protocol reference into queued work.
        weak var value: StubURLProtocol?
        init(_ value: StubURLProtocol) { self.value = value }
    }

    private static let handlerRegistry = HandlerRegistry()

    private let lifecycleQueue = DispatchQueue(label: "StubURLProtocol.lifecycle.\(UUID().uuidString)")
    private let stateLock = NSLock()

    // These values are protected by stateLock. No client callback runs while it is held.
    private var stopped = false
    private var deliveryStarted = false

    static func register(
        _ handler: @escaping Handler,
        forHost host: String
    ) -> HandlerRegistration {
        HandlerRegistration(host: host, id: handlerRegistry.register(handler, forHost: host))
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".invalid") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard !isStopped(),
              let host = request.url?.host,
              let handler = Self.handlerRegistry.handler(forHost: host) else {
            deliver(error: URLError(.badServerResponse))
            return
        }

        do {
            let handlerRequest = try requestWithReadableBody(request)
            let stub = try handler(handlerRequest)
            if stub.delayNanoseconds > 0 {
                let boundedDelay = Int(min(stub.delayNanoseconds, UInt64(Int.max)))
                let reference = WeakReference(self)
                DispatchQueue.global().asyncAfter(deadline: .now() + .nanoseconds(boundedDelay)) { [reference, stub] in
                    reference.value?.deliver(stub)
                }
            } else {
                deliver(stub)
            }
        } catch {
            deliver(error: error)
        }
    }

    private func requestWithReadableBody(_ request: URLRequest) throws -> URLRequest {
        guard request.httpBody == nil, let bodyStream = request.httpBodyStream else {
            return request
        }

        bodyStream.open()
        defer { bodyStream.close() }

        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let bytesRead = buffer.withUnsafeMutableBufferPointer { buffer in
                bodyStream.read(buffer.baseAddress!, maxLength: buffer.count)
            }
            if bytesRead < 0 {
                throw bodyStream.streamError ?? URLError(.cannotDecodeContentData)
            }
            guard bytesRead > 0 else { break }
            body.append(contentsOf: buffer[0..<bytesRead])
        }

        var normalizedRequest = request
        normalizedRequest.httpBody = body
        return normalizedRequest
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
    }

    private func claimDelivery() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !stopped, !deliveryStarted else { return false }
        deliveryStarted = true
        return true
    }

    private func isStopped() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    private func deliver(error: Error) {
        let reference = WeakReference(self)
        lifecycleQueue.async { [reference] in
            guard let instance = reference.value, instance.claimDelivery() else { return }
            instance.client?.urlProtocol(instance, didFailWithError: error)
        }
    }

    private func deliver(_ stub: URLProtocolStubResponse) {
        let reference = WeakReference(self)
        lifecycleQueue.async { [reference, stub] in
            guard let instance = reference.value, instance.claimDelivery() else { return }
            stub.deliveryProbe?.recordDelivery()

            if let error = stub.error {
                instance.client?.urlProtocol(instance, didFailWithError: error)
                return
            }

            guard let url = instance.request.url,
                  let response = HTTPURLResponse(
                    url: url,
                    statusCode: stub.statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: stub.headers
                  ) else {
                instance.client?.urlProtocol(instance, didFailWithError: URLError(.badServerResponse))
                return
            }

            guard !instance.isStopped() else { return }
            instance.client?.urlProtocol(instance, didReceive: response, cacheStoragePolicy: .notAllowed)
            guard !instance.isStopped() else { return }

            if !stub.body.isEmpty {
                instance.client?.urlProtocol(instance, didLoad: stub.body)
                guard !instance.isStopped() else { return }
            }

            instance.client?.urlProtocolDidFinishLoading(instance)
        }
    }
}
