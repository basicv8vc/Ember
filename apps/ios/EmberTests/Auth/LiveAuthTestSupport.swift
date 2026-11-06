import Foundation
@testable import Ember

/// Deterministic fixtures. Every value here is synthetic: no Apple account, no real token and no
/// server is involved in any test in this file's consumers.
enum AuthFixture {
    static let baseURL = URL(string: "https://live-auth.l1.invalid")!

    /// The fixed clock every test uses. Non-isolated so a `@Sendable` clock closure can capture it.
    static let epoch = Date(timeIntervalSince1970: 1_800_000_000)

    static let sessionID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    static let consumerID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    static let agentID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
    static let conversationID = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!

    static func token(_ suffix: String = "alpha") -> EmberAccessToken {
        // Force-unwrap is acceptable in fixtures: a nil here is a broken test, not a product path.
        EmberAccessToken("ems_\(suffix)")!
    }

    static func record(
        tokenSuffix: String = "alpha",
        expiresIn: TimeInterval = 3_600,
        now: Date = AuthFixture.epoch
    ) -> EmberSessionRecord {
        EmberSessionRecord(
            sessionID: sessionID,
            consumerID: consumerID,
            accessToken: token(tokenSuffix),
            expiresAt: now.addingTimeInterval(expiresIn),
            storedAt: now
        )
    }

    static func sessionResponse(
        tokenSuffix: String = "alpha",
        expiresIn: TimeInterval = 3_600,
        now: Date = AuthFixture.epoch
    ) -> EmberSessionResponseDTO {
        EmberSessionResponseDTO(
            sessionID: sessionID,
            consumerID: consumerID,
            accessToken: token(tokenSuffix),
            expiresAt: now.addingTimeInterval(expiresIn)
        )
    }

    static func me(transcriptEpoch: Int = 0) -> EmberMeDTO {
        EmberMeDTO(
            consumerID: consumerID,
            agent: EmberMeDTO.Agent(agentID: agentID, displayName: "Ember"),
            conversation: EmberMeDTO.Conversation(
                conversationID: conversationID,
                transcriptEpoch: transcriptEpoch,
                createdAt: Date(timeIntervalSince1970: 1_799_000_000),
                updatedAt: Date(timeIntervalSince1970: 1_799_500_000)
            )
        )
    }

    static let meJSON = """
        {
          "consumer_id": "22222222-2222-4222-8222-222222222222",
          "agent": { "agent_id": "33333333-3333-4333-8333-333333333333", "display_name": "Ember" },
          "conversation": {
            "conversation_id": "44444444-4444-4444-8444-444444444444",
            "transcript_epoch": 0,
            "created_at": "2026-12-01T10:00:00Z",
            "updated_at": "2026-12-03T10:00:00.250Z"
          }
        }
        """

    static func sessionJSON(tokenSuffix: String = "alpha") -> String {
        """
        {
          "session_id": "11111111-1111-4111-8111-111111111111",
          "consumer_id": "22222222-2222-4222-8222-222222222222",
          "access_token": "ems_\(tokenSuffix)",
          "expires_at": "2026-12-03T10:00:00Z"
        }
        """
    }
}

/// A gate that holds callers until it is opened. Used to make concurrency assertions deterministic
/// instead of timing-based.
actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        for continuation in pending { continuation.resume() }
    }
}

/// Thread-safe counter, so assertions about "how many requests were sent" do not depend on actor hops.
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func increment() {
        lock.lock()
        defer { lock.unlock() }
        storage += 1
    }
}

/// A Sign in with Apple double. `@MainActor` because the real capability is UI-bound.
@MainActor
final class FakeAppleSignInAuthorizer: AppleSignInAuthorizing {
    enum Behavior {
        case succeed(AppleSignInCredential)
        case fail(AuthError)
        /// Resolves only when `release()` is called, so a superseded attempt can be modelled exactly.
        case suspended
    }

    private(set) var authorizeCallCount = 0
    private var behavior: Behavior
    private var suspendedContinuations: [CheckedContinuation<AppleSignInCredential, Error>] = []
    /// Fires as an authorization begins, so a test can wait for "the sheet is up" deterministically.
    var onAuthorizeStarted: (@MainActor () -> Void)?

    init(behavior: Behavior) {
        self.behavior = behavior
    }

    func setBehavior(_ newBehavior: Behavior) {
        behavior = newBehavior
    }

    func authorize() async throws -> AppleSignInCredential {
        authorizeCallCount += 1
        onAuthorizeStarted?()

        switch behavior {
        case .succeed(let credential):
            return credential
        case .fail(let error):
            throw error
        case .suspended:
            return try await withCheckedThrowingContinuation { continuation in
                suspendedContinuations.append(continuation)
            }
        }
    }

    /// Completes the oldest suspended attempt.
    func release(with result: Result<AppleSignInCredential, Error>) {
        guard !suspendedContinuations.isEmpty else { return }
        suspendedContinuations.removeFirst().resume(with: result)
    }

    func releaseAll(with error: AuthError) {
        let pending = suspendedContinuations
        suspendedContinuations.removeAll()
        for continuation in pending { continuation.resume(throwing: error) }
    }
}

/// A scripted Ember session API. Every call is counted so single-flight and no-retry behaviour can be
/// asserted without a network.
///
/// A lock rather than an actor: configuration has to be synchronous from a test's setup, and every
/// assertion below is about exact call counts, which are cheaper to read than to `await`.
final class FakeEmberSessionAPI: EmberSessionAPI, @unchecked Sendable {
    private let lock = NSLock()

    private var createSessionCount = 0
    private var refreshCount = 0
    private var logoutCount = 0
    private var bootstrapCount = 0
    private var storedLastLogoutToken: EmberAccessToken?
    private var storedLastNonce: String?
    private var storedLastIdentityToken: String?

    private var storedCreateSessionResult: Result<EmberSessionResponseDTO, AuthError> = .success(
        AuthFixture.sessionResponse()
    )
    /// Consumed in order; the last entry repeats once the queue is exhausted.
    private var storedRefreshResults: [Result<EmberSessionResponseDTO, AuthError>] = [
        .success(AuthFixture.sessionResponse(tokenSuffix: "rotated"))
    ]
    private var storedLogoutResult: Result<Void, AuthError> = .success(())
    private var storedBootstrapResults: [Result<EmberMeDTO, AuthError>] = [.success(AuthFixture.me())]
    private var storedRefreshGate: AsyncGate?
    /// One gate per call, consumed in order. Lets a test hold two rotations open independently.
    private var storedRefreshGateQueue: [AsyncGate] = []
    private var storedRefreshStarted: (@Sendable () -> Void)?
    private var storedCreateSessionGate: AsyncGate?
    private var storedCreateSessionStarted: (@Sendable () -> Void)?

    var createSessionCallCount: Int { lock.withLock { createSessionCount } }
    var refreshCallCount: Int { lock.withLock { refreshCount } }
    var logoutCallCount: Int { lock.withLock { logoutCount } }
    var bootstrapCallCount: Int { lock.withLock { bootstrapCount } }
    var lastLogoutToken: EmberAccessToken? { lock.withLock { storedLastLogoutToken } }
    var lastCreateSessionNonce: String? { lock.withLock { storedLastNonce } }
    var lastCreateSessionIdentityToken: String? { lock.withLock { storedLastIdentityToken } }

    func setRefreshGate(_ gate: AsyncGate?) { lock.withLock { storedRefreshGate = gate } }

    /// Holds the first N rotations open separately, so a stale one can be failed while a newer one is
    /// still in flight.
    func setRefreshGates(_ gates: [AsyncGate]) {
        lock.withLock { storedRefreshGateQueue = gates }
    }

    /// Called as a refresh enters the API, so a test can wait for "a refresh started" without polling.
    func setRefreshStartedHandler(_ handler: (@Sendable () -> Void)?) {
        lock.withLock { storedRefreshStarted = handler }
    }

    /// Holds a session exchange open, so a logout or a second sign-in can be interleaved deterministically.
    func setCreateSessionGate(_ gate: AsyncGate?) {
        lock.withLock { storedCreateSessionGate = gate }
    }

    func setCreateSessionStartedHandler(_ handler: (@Sendable () -> Void)?) {
        lock.withLock { storedCreateSessionStarted = handler }
    }

    func setLogoutResult(_ result: Result<Void, AuthError>) {
        lock.withLock { storedLogoutResult = result }
    }

    func setBootstrapResults(_ results: [Result<EmberMeDTO, AuthError>]) {
        lock.withLock { storedBootstrapResults = results }
    }

    func setRefreshResults(_ results: [Result<EmberSessionResponseDTO, AuthError>]) {
        lock.withLock { storedRefreshResults = results }
    }

    func setCreateSessionResult(_ result: Result<EmberSessionResponseDTO, AuthError>) {
        lock.withLock { storedCreateSessionResult = result }
    }

    func createSession(identityToken: String, nonce: String) async throws -> EmberSessionResponseDTO {
        let (gate, result, started) = lock.withLock {
            () -> (AsyncGate?, Result<EmberSessionResponseDTO, AuthError>, (@Sendable () -> Void)?) in
            createSessionCount += 1
            storedLastIdentityToken = identityToken
            storedLastNonce = nonce
            return (storedCreateSessionGate, storedCreateSessionResult, storedCreateSessionStarted)
        }

        started?()
        if let gate { await gate.wait() }
        return try result.get()
    }

    func refreshSession(accessToken: EmberAccessToken) async throws -> EmberSessionResponseDTO {
        let (gate, result, started) = lock.withLock {
            () -> (AsyncGate?, Result<EmberSessionResponseDTO, AuthError>, (@Sendable () -> Void)?) in
            refreshCount += 1
            let queued: Result<EmberSessionResponseDTO, AuthError>
            if storedRefreshResults.count > 1 {
                queued = storedRefreshResults.removeFirst()
            } else {
                queued = storedRefreshResults.first ?? .failure(.invalidResponse)
            }
            let gate: AsyncGate?
            if storedRefreshGateQueue.isEmpty {
                gate = storedRefreshGate
            } else {
                gate = storedRefreshGateQueue.removeFirst()
            }
            return (gate, queued, storedRefreshStarted)
        }

        started?()
        if let gate { await gate.wait() }
        return try result.get()
    }

    func logout(accessToken: EmberAccessToken) async throws {
        let result = lock.withLock { () -> Result<Void, AuthError> in
            logoutCount += 1
            storedLastLogoutToken = accessToken
            return storedLogoutResult
        }
        try result.get()
    }

    func bootstrap(accessToken: EmberAccessToken) async throws -> EmberMeDTO {
        let result = lock.withLock { () -> Result<EmberMeDTO, AuthError> in
            bootstrapCount += 1
            if storedBootstrapResults.count > 1 {
                return storedBootstrapResults.removeFirst()
            }
            return storedBootstrapResults.first ?? .failure(.invalidResponse)
        }
        return try result.get()
    }
}

/// Builds a coordinator whose Keychain is in memory and whose clock is fixed.
@MainActor
enum CoordinatorFixture {
    struct Built {
        let coordinator: LiveAuthSessionCoordinator
        let api: FakeEmberSessionAPI
        let store: InMemoryEmberSessionStore
        let apple: FakeAppleSignInAuthorizer
        /// The interception-enabled session behind the authenticated transport, so a test can
        /// register `StubURLProtocol` handlers for authenticated-request assertions.
        let session: URLSession
        let fence: InMemorySessionRecoveryFence
    }

    /// The default authorizer is built inside this main-actor function: a default argument would be
    /// evaluated in a nonisolated context.
    static func make(
        apple: FakeAppleSignInAuthorizer? = nil,
        storedRecord: EmberSessionRecord? = nil,
        store: InMemoryEmberSessionStore? = nil,
        fence: InMemorySessionRecoveryFence? = nil,
        signOutCleanupHooks: [@Sendable () async -> Void] = [],
        now: @escaping @Sendable () -> Date = { AuthFixture.epoch },
        leeway: TimeInterval = 60,
        configure: (FakeEmberSessionAPI) -> Void = { _ in }
    ) throws -> Built {
        let authorizer =
            apple
            ?? FakeAppleSignInAuthorizer(
                behavior: .succeed(
                    AppleSignInCredential(
                        identityToken: "synthetic.apple.jwt",
                        rawNonce: "synthetic-raw-nonce",
                        attemptID: UUID()
                    )
                )
            )

        let api = FakeEmberSessionAPI()
        configure(api)

        let session = StubSession.make()
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let store = store ?? InMemoryEmberSessionStore(initialRecord: storedRecord)
        let fence = fence ?? InMemorySessionRecoveryFence()

        let coordinator = LiveAuthSessionCoordinator(
            dependencies: .init(
                api: api,
                transport: transport,
                store: store,
                appleSignIn: authorizer,
                fence: fence,
                signOutCleanupHooks: signOutCleanupHooks,
                now: now,
                refreshLeeway: leeway
            )
        )

        return Built(
            coordinator: coordinator,
            api: api,
            store: store,
            apple: authorizer,
            session: session,
            fence: fence
        )
    }
}

/// Builds a `URLSession` whose traffic is served by `StubURLProtocol` for `.invalid` hosts.
enum StubSession {
    static func make() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

/// Collects request bodies/headers from a stub handler without data races.
final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URLRequest] = []

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    var count: Int { requests.count }

    func record(_ request: URLRequest) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(request)
    }
}
